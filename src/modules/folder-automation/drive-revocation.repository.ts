import { ConflictException } from '@nestjs/common';
import { FieldValue, Firestore, Transaction } from '@google-cloud/firestore';

/** Caller must finish all transaction reads before invoking this writer. */
export function queueDriveRevocation(
  tx: Transaction,
  db: Firestore,
  connection: FirebaseFirestore.DocumentData,
  existing: FirebaseFirestore.DocumentData | undefined,
) {
  if (!connection.secret || existing) return;
  tx.create(db.collection('drive_revocations').doc(connection.id), {
    id: connection.id,
    accountId: connection.accountId,
    // Preserve original AES-GCM AAD: drive:{accountId}:{connectionId}.
    secret: connection.secret,
    status: 'queued',
    attempts: 0,
    availableAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  });
}

/** Call after account tombstone, BEFORE deleting drive_connections. No service DI needed. */
export async function enqueueAccountDriveRevocations(
  db: Firestore,
  accountId: string,
) {
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  let queued = 0;
  for (let page = 0; page < 100; page++) {
    let query = db
      .collection('drive_connections')
      .where('accountId', '==', accountId)
      .orderBy('__name__')
      .limit(100);
    if (cursor) query = query.startAfter(cursor);
    const rows = await query.get();
    for (const doc of rows.docs) {
      await db.runTransaction(async (tx) => {
        const row = (await tx.get(doc.ref)).data();
        const receipt = (
          await tx.get(db.collection('drive_revocations').doc(doc.id))
        ).data();
        if (!row || row.accountId !== accountId) return;
        queueDriveRevocation(tx, db, row, receipt);
        tx.update(doc.ref, {
          status: 'disconnecting',
          revokedAt: row.revokedAt ?? new Date().toISOString(),
          version: row.version + 1,
          nextScanAt: FieldValue.delete(),
          leaseToken: FieldValue.delete(),
        });
      });
      queued++;
    }
    if (rows.size < 100) return { connections: queued };
    cursor = rows.docs[rows.docs.length - 1];
  }
  // Do not permit a caller to delete unvisited secrets when the cleanup budget is exceeded.
  throw new ConflictException('DRIVE_REVOCATION_CLEANUP_BUDGET_EXCEEDED');
}

/** Operator retry for a terminal revocation after fixing provider/config; never recreates secrets. */
export async function retryDriveRevocation(db: Firestore, id: string) {
  await db.runTransaction(async (tx) => {
    const ref = db.collection('drive_revocations').doc(id);
    const row = (await tx.get(ref)).data();
    if (!row || row.status !== 'failed' || !row.secret)
      throw new ConflictException('REVOCATION_NOT_RETRYABLE');
    tx.update(ref, {
      status: 'queued',
      attempts: 0,
      availableAt: new Date().toISOString(),
      errorCode: FieldValue.delete(),
    });
  });
}
