import { Timestamp } from '@google-cloud/firestore';
import {
  operationFromFirestore,
  operationToFirestore,
} from './operation-lease.firestore.js';
import { OPERATION_RETENTION_MS, reserveOperation } from './operation-lease.js';

it('persists 90-day retention as a native Firestore Timestamp and restores the domain ISO value', () => {
  const now = new Date();
  const candidate = {
    accountId: 'alice',
    intentHash: 'intent',
    status: 'pending' as const,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  const first = reserveOperation(candidate, undefined, now, 60_000).record;
  const persisted = operationToFirestore(first);
  expect(persisted.expiresAt).toBeInstanceOf(Timestamp);
  expect((persisted.expiresAt as Timestamp).toMillis()).toBe(
    now.getTime() + OPERATION_RETENTION_MS,
  );
  expect(operationFromFirestore(persisted)).toEqual(first);
});
