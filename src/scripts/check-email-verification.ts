/**
 * Script to check email verification status of recent users
 *
 * Run with: npx tsx src/scripts/check-email-verification.ts
 */

import admin from 'firebase-admin';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

// Load credentials
const credentialsPath = path.join(process.cwd(), 'firebase-credentials.json');
if (!process.env.FIREBASE_CREDENTIALS && fs.existsSync(credentialsPath)) {
  process.env.FIREBASE_CREDENTIALS = fs.readFileSync(credentialsPath, 'utf8');
}

async function main() {
  console.log('Checking email verification status...\n');

  // Initialize Firebase Admin
  let credentials: admin.ServiceAccount | null = null;
  const firebaseCredentials = process.env.FIREBASE_CREDENTIALS;

  if (firebaseCredentials) {
    try {
      const parsed = JSON.parse(firebaseCredentials);
      if (parsed.private_key) {
        parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
      }
      credentials = parsed as admin.ServiceAccount;
      console.log(`Using Firebase project: ${parsed.project_id}\n`);
    } catch (error) {
      console.error('Error parsing FIREBASE_CREDENTIALS:', error);
      process.exit(1);
    }
  }

  if (!credentials) {
    console.error('No Firebase credentials found');
    process.exit(1);
  }

  admin.initializeApp({
    credential: admin.credential.cert(credentials),
  });

  // List users
  const listUsersResult = await admin.auth().listUsers(100);

  // Filter users with email/password provider and sort by creation date
  const emailPasswordUsers = listUsersResult.users
    .filter(user => {
      const hasEmailProvider = user.providerData.some(
        provider => provider.providerId === 'password'
      );
      return hasEmailProvider;
    })
    .sort((a, b) => {
      const dateA = new Date(a.metadata.creationTime || 0);
      const dateB = new Date(b.metadata.creationTime || 0);
      return dateB.getTime() - dateA.getTime(); // Most recent first
    });

  console.log('='.repeat(100));
  console.log('USUARIOS REGISTRADOS CON EMAIL/PASSWORD (más recientes primero)');
  console.log('='.repeat(100));
  console.log('');
  console.log(
    'Email'.padEnd(40) +
    'Verificado'.padEnd(12) +
    'Fecha Creación'.padEnd(25) +
    'Último Acceso'
  );
  console.log('-'.repeat(100));

  let unverifiedCount = 0;
  let verifiedCount = 0;

  for (const user of emailPasswordUsers) {
    const email = user.email || 'N/A';
    const verified = user.emailVerified ? 'SI' : 'NO';
    const createdAt = user.metadata.creationTime
      ? new Date(user.metadata.creationTime).toLocaleString('es-MX', { timeZone: 'America/Merida' })
      : 'N/A';
    const lastSignIn = user.metadata.lastSignInTime
      ? new Date(user.metadata.lastSignInTime).toLocaleString('es-MX', { timeZone: 'America/Merida' })
      : 'Nunca';

    if (user.emailVerified) {
      verifiedCount++;
    } else {
      unverifiedCount++;
    }

    // Highlight unverified users
    const verifiedDisplay = user.emailVerified ? 'SI' : '\x1b[31mNO\x1b[0m';

    console.log(
      email.padEnd(40) +
      (user.emailVerified ? 'SI' : 'NO').padEnd(12) +
      createdAt.padEnd(25) +
      lastSignIn
    );
  }

  console.log('-'.repeat(100));
  console.log('');
  console.log('RESUMEN:');
  console.log(`  Total usuarios email/password: ${emailPasswordUsers.length}`);
  console.log(`  Verificados: ${verifiedCount}`);
  console.log(`  NO verificados: ${unverifiedCount}`);
  console.log('');

  process.exit(0);
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
