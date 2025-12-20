/**
 * Migration script to populate daily_stats and global_totals from conversion_history
 *
 * Run with: npx ts-node -r tsconfig-paths/register src/scripts/migrate-daily-stats.ts
 */

import { Firestore } from '@google-cloud/firestore';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

// Try to load credentials from file if env var not set
const credentialsPath = path.join(process.cwd(), 'firebase-credentials.json');
if (!process.env.FIREBASE_CREDENTIALS && fs.existsSync(credentialsPath)) {
  process.env.FIREBASE_CREDENTIALS = fs.readFileSync(credentialsPath, 'utf8');
}

interface DailyStats {
  date: string;
  totalConversions: number;
  totalLabels: number;
  totalPdfs: number;
  activeUserIds: string[];
  errorCount: number;
  successCount: number;
  failureCount: number;
  conversionsByPlan: {
    free: { pdfs: number; labels: number };
    pro: { pdfs: number; labels: number };
    enterprise: { pdfs: number; labels: number };
  };
}

// GMT-6 timezone offset (Mérida, México)
const TIMEZONE_OFFSET = -6 * 60;

function getDateStringInTimezone(date: Date): string {
  const utcTime = date.getTime() + date.getTimezoneOffset() * 60 * 1000;
  const localTime = new Date(utcTime + TIMEZONE_OFFSET * 60 * 1000);
  const year = localTime.getFullYear();
  const month = String(localTime.getMonth() + 1).padStart(2, '0');
  const day = String(localTime.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function main() {
  console.log('Starting daily_stats migration...\n');

  // Initialize Firestore
  let credentials: any = null;
  const firebaseCredentials = process.env.FIREBASE_CREDENTIALS;

  if (firebaseCredentials) {
    try {
      credentials = JSON.parse(firebaseCredentials);
      if (credentials.private_key) {
        credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
      }
      console.log(`Using Firebase project: ${credentials.project_id}`);
    } catch (error) {
      console.error('Error parsing FIREBASE_CREDENTIALS:', error);
      process.exit(1);
    }
  }

  const firestoreOptions: any = {};
  if (credentials) {
    firestoreOptions.credentials = credentials;
    firestoreOptions.projectId = credentials.project_id;
  }

  const firestore = new Firestore(firestoreOptions);

  // 1. Load all users to get their plans
  console.log('\n1. Loading users...');
  const usersSnapshot = await firestore.collection('users').get();
  const userPlanMap: Record<string, string> = {};
  usersSnapshot.docs.forEach((doc) => {
    userPlanMap[doc.id] = doc.data().plan || 'free';
  });
  console.log(`   Loaded ${usersSnapshot.size} users`);

  // 2. Load all conversion_history
  console.log('\n2. Loading conversion_history...');
  const historySnapshot = await firestore.collection('conversion_history').get();
  console.log(`   Loaded ${historySnapshot.size} conversions`);

  // 3. Aggregate by date
  console.log('\n3. Aggregating by date...');
  const dailyStatsMap: Record<string, DailyStats> = {};
  let globalPdfsTotal = 0;
  let globalLabelsTotal = 0;

  historySnapshot.docs.forEach((doc) => {
    const data = doc.data();
    const createdAt = data.createdAt?.toDate?.() || new Date(data.createdAt);
    const dateKey = getDateStringInTimezone(createdAt);
    const userId = data.userId || 'unknown';
    const userPlan = (userPlanMap[userId] || 'free') as 'free' | 'pro' | 'enterprise';
    const labelCount = data.labelCount || 0;
    const status = data.status || 'completed';

    // Initialize day if needed
    if (!dailyStatsMap[dateKey]) {
      dailyStatsMap[dateKey] = {
        date: dateKey,
        totalConversions: 0,
        totalLabels: 0,
        totalPdfs: 0,
        activeUserIds: [],
        errorCount: 0,
        successCount: 0,
        failureCount: 0,
        conversionsByPlan: {
          free: { pdfs: 0, labels: 0 },
          pro: { pdfs: 0, labels: 0 },
          enterprise: { pdfs: 0, labels: 0 },
        },
      };
    }

    const stats = dailyStatsMap[dateKey];

    // Update counters
    stats.totalConversions++;
    stats.totalLabels += labelCount;
    stats.totalPdfs++;

    if (!stats.activeUserIds.includes(userId)) {
      stats.activeUserIds.push(userId);
    }

    if (status === 'completed') {
      stats.successCount++;
      globalPdfsTotal++;
      globalLabelsTotal += labelCount;
    } else if (status === 'failed') {
      stats.failureCount++;
    }

    // Update by plan
    stats.conversionsByPlan[userPlan].pdfs++;
    stats.conversionsByPlan[userPlan].labels += labelCount;
  });

  const dates = Object.keys(dailyStatsMap).sort();
  console.log(`   Aggregated into ${dates.length} days`);
  console.log(`   Date range: ${dates[0]} to ${dates[dates.length - 1]}`);

  // 4. Write daily_stats documents
  console.log('\n4. Writing daily_stats documents...');
  const batchSize = 500;
  let batch = firestore.batch();
  let batchCount = 0;
  let totalWritten = 0;

  for (const dateKey of dates) {
    const stats = dailyStatsMap[dateKey];
    const docRef = firestore.collection('daily_stats').doc(dateKey);
    batch.set(docRef, stats);
    batchCount++;
    totalWritten++;

    if (batchCount >= batchSize) {
      await batch.commit();
      console.log(`   Written ${totalWritten} documents...`);
      batch = firestore.batch();
      batchCount = 0;
    }
  }

  // Commit remaining
  if (batchCount > 0) {
    await batch.commit();
  }
  console.log(`   Total written: ${totalWritten} daily_stats documents`);

  // 5. Write global_totals
  console.log('\n5. Writing global_totals...');
  await firestore.doc('global_totals/totals').set({
    pdfsTotal: globalPdfsTotal,
    labelsTotal: globalLabelsTotal,
    lastUpdated: new Date(),
  });
  console.log(`   Global totals: ${globalPdfsTotal} PDFs, ${globalLabelsTotal} labels`);

  // 6. Summary
  console.log('\n========== Migration Complete ==========');
  console.log(`Total days migrated: ${dates.length}`);
  console.log(`Total conversions processed: ${historySnapshot.size}`);
  console.log(`Global PDFs: ${globalPdfsTotal}`);
  console.log(`Global Labels: ${globalLabelsTotal}`);
  console.log('=========================================\n');
}

main().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
