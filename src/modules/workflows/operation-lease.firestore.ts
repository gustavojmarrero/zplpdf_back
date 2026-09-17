import { Timestamp } from '@google-cloud/firestore';
import type { LeasedOperation } from './operation-lease.js';

/** Keep transport/storage timestamps out of domain snapshots and public DTOs. */
export function operationFromFirestore<T extends LeasedOperation>(
  data: Record<string, any>,
): T {
  return {
    ...data,
    ...(data.expiresAt
      ? {
          expiresAt:
            data.expiresAt instanceof Timestamp
              ? data.expiresAt.toDate().toISOString()
              : data.expiresAt,
        }
      : {}),
  } as T;
}

export function operationToFirestore<T extends LeasedOperation>(record: T) {
  return {
    ...record,
    ...(record.expiresAt
      ? { expiresAt: Timestamp.fromDate(new Date(record.expiresAt)) }
      : {}),
  };
}
