import { ConflictException, GoneException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { OutboxEventRecord } from './label-event.outbox.js';

export const MAX_OPERATION_ATTEMPTS = 8;
export const OPERATION_RETENTION_MS = 90 * 24 * 60 * 60_000;
export const OPERATION_RENEW_MS = 30_000;

export interface LeasedOperation {
  accountId: string;
  intentHash: string;
  status: 'pending' | 'accepted' | 'failed' | 'validated';
  leaseToken?: string;
  leaseExpiresAt?: string;
  attempts?: number;
  errorCode?: string;
  completionEvent?: OutboxEventRecord;
  createdAt: string;
  updatedAt: string;
  /** ISO internally; native Timestamp in Firestore. Requires status-aware cleanup. */
  expiresAt?: string;
}

/** Pure decision shared by Firestore transactions and the memory repository. */
export function reserveOperation<T extends LeasedOperation>(
  candidate: T,
  existing: T | undefined,
  now: Date,
  leaseMs: number,
): {
  outcome: 'reserved' | 'existing' | 'in_progress' | 'key_reused';
  record: T;
} {
  if (existing) {
    assertOperationUnexpired(existing, now);
    if (
      existing.accountId !== candidate.accountId ||
      existing.intentHash !== candidate.intentHash
    )
      return { outcome: 'key_reused', record: existing };
    if (existing.status === 'accepted')
      return { outcome: 'existing', record: existing };
    if (
      existing.status === 'pending' &&
      Date.parse(existing.leaseExpiresAt ?? '') > now.getTime()
    )
      return { outcome: 'in_progress', record: existing };
    if ((existing.attempts ?? 1) >= MAX_OPERATION_ATTEMPTS)
      throw new ConflictException({
        error: 'OPERATION_ATTEMPTS_EXHAUSTED',
        message: 'La operación agotó sus intentos de recuperación',
      });
  }
  return {
    outcome: 'reserved',
    record: {
      // A retry must never replace the input pinned by the first reservation.
      ...(existing ?? candidate),
      status: 'pending',
      expiresAt:
        (existing ?? candidate).expiresAt ??
        new Date(
          Date.parse((existing ?? candidate).createdAt) +
            OPERATION_RETENTION_MS,
        ).toISOString(),
      errorCode: undefined,
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
      attempts: (existing?.attempts ?? (existing ? 1 : 0)) + 1,
      updatedAt: now.toISOString(),
    },
  };
}

export function assertOperationUnexpired(
  record: LeasedOperation,
  now = new Date(),
): void {
  const expiresAt = record.expiresAt
    ? Date.parse(record.expiresAt)
    : Date.parse(record.createdAt) + OPERATION_RETENTION_MS;
  if (!(expiresAt > now.getTime()))
    throw new GoneException({
      error: 'OPERATION_EXPIRED',
      message: 'La operación superó su período de retención',
    });
}

export function assertOperationLease(
  record: LeasedOperation,
  token: string,
): void {
  assertOperationUnexpired(record);
  if (
    record.status !== 'pending' ||
    !token ||
    record.leaseToken !== token ||
    !(Date.parse(record.leaseExpiresAt ?? '') > Date.now())
  ) {
    throw new ConflictException({
      error: 'OPERATION_LEASE_LOST',
      message: 'La reserva de la operación ya no pertenece a este intento',
    });
  }
}

/** Keep ownership during conversion; stop and join renewal before settling. */
export async function withOperationLease<T>(
  renew: () => Promise<void>,
  work: () => Promise<T>,
): Promise<T> {
  let failure: unknown;
  let renewing: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (!renewing)
      renewing = renew()
        .catch((error) => {
          failure = error;
        })
        .finally(() => {
          renewing = undefined;
        });
  }, OPERATION_RENEW_MS);
  timer.unref();
  try {
    const result = await work();
    clearInterval(timer);
    await renewing;
    if (failure) throw failure;
    return result;
  } finally {
    clearInterval(timer);
    await renewing;
  }
}
