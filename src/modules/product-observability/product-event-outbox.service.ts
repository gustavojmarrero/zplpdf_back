import { Firestore, FieldValue } from '@google-cloud/firestore';
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PRODUCT_OBSERVABILITY_FIRESTORE } from './firestore.provider.js';
import type { ProductEvent } from './observability.types.js';

const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 8;
export interface OutboxLease {
  key: string;
  token: string;
  attempts: number;
}
@Injectable()
export class ProductEventOutboxService {
  constructor(
    @Inject(PRODUCT_OBSERVABILITY_FIRESTORE) private readonly db: Firestore,
  ) {}

  async claim(key: string): Promise<OutboxLease | null> {
    return this.db.runTransaction(async (tx) => {
      const ref = this.db.collection('event_outbox').doc(key);
      const snapshot = await tx.get(ref);
      const row = snapshot.data();
      const now = Date.now();
      if (
        !row ||
        !['pending', 'leased'].includes(row.state) ||
        !row.availableAt ||
        Date.parse(row.availableAt) > now
      )
        return null;
      if (row.expiresAt.toMillis() <= now || row.attempts >= MAX_ATTEMPTS) {
        tx.update(ref, {
          state: 'dead',
          lastErrorCode:
            row.attempts >= MAX_ATTEMPTS
              ? 'ATTEMPTS_EXHAUSTED'
              : 'EVENT_EXPIRED',
          availableAt: FieldValue.delete(),
          leaseToken: FieldValue.delete(),
        });
        return null;
      }
      const token = randomUUID();
      const attempts = row.attempts + 1;
      tx.update(ref, {
        state: 'leased',
        attempts,
        leaseToken: token,
        availableAt: new Date(now + LEASE_MS).toISOString(),
      });
      return { key, token, attempts };
    });
  }

  async settle(lease: OutboxLease, success: boolean) {
    return this.db.runTransaction(async (tx) => {
      const ref = this.db.collection('event_outbox').doc(lease.key);
      const snapshot = await tx.get(ref);
      const row = snapshot.data();
      if (
        !row ||
        row.state !== 'leased' ||
        row.leaseToken !== lease.token ||
        Date.parse(row.availableAt) <= Date.now()
      )
        return false;
      const dead = row.attempts >= MAX_ATTEMPTS;
      tx.update(ref, {
        state: success ? 'delivered' : dead ? 'dead' : 'pending',
        leaseToken: FieldValue.delete(),
        availableAt:
          success || dead
            ? FieldValue.delete()
            : new Date(
                Date.now() + Math.min(3600000, 1000 * 2 ** row.attempts),
              ).toISOString(),
        ...(success
          ? {
              deliveredAt: new Date().toISOString(),
              lastErrorCode: FieldValue.delete(),
            }
          : { lastErrorCode: 'DELIVERY_FAILED' }),
      });
      return true;
    });
  }

  async retryDead(key: string) {
    return this.db.runTransaction(async (tx) => {
      const ref = this.db.collection('event_outbox').doc(key);
      const row = (await tx.get(ref)).data();
      if (
        !row ||
        row.state !== 'dead' ||
        row.expiresAt.toMillis() <= Date.now()
      )
        return false;
      const deleted = await tx.get(
        this.db.collection('deleted_accounts').doc(row.accountId),
      );
      const event = await tx.get(this.db.collection('product_events').doc(key));
      if (
        deleted.exists ||
        !event.exists ||
        event.get('expiresAt').toMillis() <= Date.now()
      )
        return false;
      tx.update(ref, {
        state: 'pending',
        attempts: 0,
        availableAt: new Date().toISOString(),
        lastErrorCode: FieldValue.delete(),
        leaseToken: FieldValue.delete(),
        manualRetries: (row.manualRetries ?? 0) + 1,
        lastManualRetryAt: new Date().toISOString(),
      });
      return true;
    });
  }

  async dispatch(
    deliver: (event: ProductEvent, idempotencyKey: string) => Promise<void>,
    limit = 20,
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Invalid outbox limit');
    const due = await this.db
      .collection('event_outbox')
      .where('availableAt', '<=', new Date().toISOString())
      .orderBy('availableAt')
      .limit(limit)
      .get();
    let delivered = 0;
    let failed = 0;
    for (const row of due.docs) {
      const lease = await this.claim(row.id);
      if (!lease) continue;
      try {
        const snapshot = await this.db
          .collection('product_events')
          .doc(lease.key)
          .get();
        if (
          !snapshot.exists ||
          snapshot.get('expiresAt').toMillis() <= Date.now()
        )
          throw new Error('Event unavailable');
        const {
          fingerprint: _fingerprint,
          expiresAt: _expiresAt,
          ...event
        } = snapshot.data();
        await deliver(event as ProductEvent, lease.key);
        if (await this.settle(lease, true)) delivered++;
      } catch {
        // Do not retain raw transport errors: they can contain payloads/secrets.
        if (await this.settle(lease, false)) failed++;
      }
    }
    return { scanned: due.size, delivered, failed };
  }
}
