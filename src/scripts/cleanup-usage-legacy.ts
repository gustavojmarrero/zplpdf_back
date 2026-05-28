/**
 * Cleanup script para la colección `usage`.
 *
 * Borra docs basura acumulados tras la convivencia de dos esquemas de período:
 *   - Legacy `_YYYYMM` (mes calendario, generado por el ya-eliminado getOrCreateUsage)
 *   - Moderno `_YYYYMMDD` (aniversario del usuario / Stripe, generado por
 *     getOrCreateUsageWithPeriod)
 *
 * Reglas de borrado:
 *   1. Cualquier doc `_YYYYMM` con pdfCount=0 y labelCount=0 → borrar (residuo).
 *   2. Cualquier doc `_YYYYMMDD` con pdfCount=0 y labelCount=0 cuyo periodEnd
 *      ya pasó → borrar (período cerrado sin uso real).
 *   3. Docs `_YYYYMM` con datos reales → NO borrar; loggear para migración manual.
 *   4. Docs `_YYYYMMDD` del período actual (incluso si están en 0) → conservar.
 *
 * Uso:
 *   npx tsx src/scripts/cleanup-usage-legacy.ts            # dry-run (default)
 *   npx tsx src/scripts/cleanup-usage-legacy.ts --execute  # aplica borrados
 */

import admin from 'firebase-admin';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const execute = process.argv.includes('--execute');

const credentialsPath = path.join(process.cwd(), 'firebase-credentials.json');
if (!process.env.FIREBASE_CREDENTIALS && fs.existsSync(credentialsPath)) {
  process.env.FIREBASE_CREDENTIALS = fs.readFileSync(credentialsPath, 'utf8');
}

async function main(): Promise<void> {
  const raw = process.env.FIREBASE_CREDENTIALS || process.env.GOOGLE_CREDENTIALS;
  if (!raw) {
    console.error('No Firebase credentials found');
    process.exit(1);
  }
  const parsed = JSON.parse(raw);
  if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');

  admin.initializeApp({
    credential: admin.credential.cert(parsed),
    projectId: process.env.FIREBASE_PROJECT_ID || parsed.project_id,
  });
  const db = admin.firestore();

  console.log(`Mode: ${execute ? 'EXECUTE (will delete docs)' : 'DRY-RUN (no writes)'}`);
  console.log('Reading usage collection...');

  const snap = await db.collection('usage').get();
  console.log(`Total docs: ${snap.size}`);

  const now = new Date();
  const toDelete: string[] = [];
  const preserveLegacyWithData: Array<{ id: string; pdf: number; labels: number; userId: string }> = [];
  let legacyEmptyDeleted = 0;
  let modernExpiredEmptyDeleted = 0;
  let modernCurrentPreserved = 0;
  let modernExpiredWithDataPreserved = 0;

  for (const doc of snap.docs) {
    const id = doc.id;
    const data = doc.data();
    const lastPart = id.split('_').pop() || '';
    const pdf = data.pdfCount || 0;
    const labels = data.labelCount || 0;
    const isEmpty = pdf === 0 && labels === 0;
    const periodEnd: Date | null = data.periodEnd?.toDate?.()
      || (data.periodEnd ? new Date(data.periodEnd) : null);

    if (/^\d{6}$/.test(lastPart)) {
      if (isEmpty) {
        toDelete.push(id);
        legacyEmptyDeleted++;
      } else {
        preserveLegacyWithData.push({ id, pdf, labels, userId: data.userId });
      }
    } else if (/^\d{8}$/.test(lastPart)) {
      const isCurrent = !!periodEnd && periodEnd >= now;
      if (isCurrent) {
        modernCurrentPreserved++;
      } else if (isEmpty) {
        toDelete.push(id);
        modernExpiredEmptyDeleted++;
      } else {
        modernExpiredWithDataPreserved++;
      }
    } else {
      console.warn(`Skipping unknown id format: ${id}`);
    }
  }

  console.log('\n=== Plan ===');
  console.log(`Legacy _YYYYMM empty (delete): ${legacyEmptyDeleted}`);
  console.log(`Legacy _YYYYMM with data (PRESERVE, manual migration needed): ${preserveLegacyWithData.length}`);
  console.log(`Modern _YYYYMMDD expired empty (delete): ${modernExpiredEmptyDeleted}`);
  console.log(`Modern _YYYYMMDD expired with data (preserve as history): ${modernExpiredWithDataPreserved}`);
  console.log(`Modern _YYYYMMDD current period (preserve): ${modernCurrentPreserved}`);
  console.log(`Total to delete: ${toDelete.length}`);

  if (preserveLegacyWithData.length > 0) {
    console.log('\n--- Legacy docs WITH data (manual review) ---');
    for (const d of preserveLegacyWithData) {
      console.log(`  ${d.id}  pdf=${d.pdf} labels=${d.labels} userId=${d.userId}`);
    }
  }

  if (!execute) {
    console.log('\nDry-run done. Re-run with --execute to delete.');
    process.exit(0);
  }

  if (toDelete.length === 0) {
    console.log('\nNothing to delete.');
    process.exit(0);
  }

  console.log(`\nDeleting ${toDelete.length} docs in batches of 500...`);
  let deleted = 0;
  for (let i = 0; i < toDelete.length; i += 500) {
    const batch = db.batch();
    const chunk = toDelete.slice(i, i + 500);
    for (const id of chunk) {
      batch.delete(db.collection('usage').doc(id));
    }
    await batch.commit();
    deleted += chunk.length;
    console.log(`  Deleted ${deleted}/${toDelete.length}`);
  }

  console.log(`\nDone. Deleted ${deleted} docs.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
