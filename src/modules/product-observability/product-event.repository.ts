import { Firestore, Timestamp } from '@google-cloud/firestore';
import type { Transaction } from '@google-cloud/firestore';
import {
  ConflictException,
  GoneException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PRODUCT_OBSERVABILITY_FIRESTORE } from './firestore.provider.js';
import { RETENTION_MS } from './observability.types.js';
import type { ProductEvent } from './observability.types.js';

export function eventKey(...parts: string[]) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
export function exposureDay(occurredAt: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Merida',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(occurredAt));
}
export interface EventWrite {
  event: ProductEvent;
  fingerprint: string;
}
@Injectable()
export class ProductEventRepository {
  constructor(
    @Inject(PRODUCT_OBSERVABILITY_FIRESTORE) private readonly db: Firestore,
  ) {}

  async readQuality() {
    const [quality, panel] = await Promise.all([
      this.db.collection('growth_quality').doc('latest').get(),
      this.db.collection('growth_panel_receipts').doc('latest').get(),
    ]);
    return { quality: quality.data(), panel: panel.data() };
  }

  async record(writes: EventWrite[], transaction?: Transaction) {
    const run = async (tx: Transaction) => {
      for (const accountId of new Set(writes.map((w) => w.event.accountId)))
        if (
          (await tx.get(this.db.collection('deleted_accounts').doc(accountId)))
            .exists
        )
          throw new GoneException('Account unavailable');
      const entries = writes.map((write) => {
        const event = write.event;
        const key = eventKey(event.accountId, event.eventId);
        const semanticKey = event.operationId
          ? eventKey(
              'operation',
              event.accountId,
              event.eventName,
              event.operationId,
            )
          : event.eventName === 'feature_exposed'
            ? eventKey(
                'exposure',
                event.accountId,
                event.featureId,
                event.featureVersion,
                event.surface,
                event.assignmentVersion ?? 'none',
                event.variant ?? 'none',
                exposureDay(event.occurredAt),
              )
            : null;
        return {
          ...write,
          key,
          ref: this.db.collection('product_events').doc(key),
          receipt: this.db
            .collection('product_event_dedup')
            .doc(eventKey('delivery', event.accountId, event.eventId)),
          semantic: semanticKey
            ? this.db.collection('product_event_dedup').doc(semanticKey)
            : null,
        };
      });
      // Every delivery has a receipt, including deliveries suppressed by semantic dedup.
      // Read all keys first: Firestore forbids reads after a transaction write.
      const existing = await Promise.all(
        entries.map(async (entry) => ({
          receipt: await tx.get(entry.receipt),
          semantic: entry.semantic ? await tx.get(entry.semantic) : null,
        })),
      );
      const receipts = new Map<
        string,
        { fingerprint: string; eventKey: string }
      >();
      const semanticEvents = new Map<string, string>();
      return entries.map((entry, i) => {
        const prior = existing[i].receipt.exists
          ? existing[i].receipt.data()
          : receipts.get(entry.receipt.path);
        if (prior && prior.fingerprint !== entry.fingerprint)
          throw new ConflictException('Event ID already used');
        if (prior)
          return {
            eventId: entry.event.eventId,
            key: prior.eventKey as string,
            duplicate: true,
          };
        const canonicalKey =
          existing[i].semantic?.get('eventKey') ??
          semanticEvents.get(entry.semantic?.path);
        const expiresAt = Timestamp.fromMillis(
          Date.parse(entry.event.receivedAt) + RETENTION_MS,
        );
        const receipt = {
          eventKey: canonicalKey ?? entry.key,
          fingerprint: entry.fingerprint,
          accountId: entry.event.accountId,
          expiresAt,
        };
        tx.create(entry.receipt, receipt);
        receipts.set(entry.receipt.path, receipt);
        if (canonicalKey)
          return {
            eventId: entry.event.eventId,
            key: canonicalKey as string,
            duplicate: true,
          };
        tx.create(entry.ref, {
          ...entry.event,
          fingerprint: entry.fingerprint,
          expiresAt,
        });
        tx.create(this.db.collection('event_outbox').doc(entry.key), {
          eventKey: entry.key,
          accountId: entry.event.accountId,
          state: 'pending',
          attempts: 0,
          availableAt: entry.event.receivedAt,
          createdAt: entry.event.receivedAt,
          expiresAt,
        });
        if (entry.semantic) {
          tx.create(entry.semantic, {
            eventKey: entry.key,
            accountId: entry.event.accountId,
            expiresAt,
          });
          semanticEvents.set(entry.semantic.path, entry.key);
        }
        return {
          eventId: entry.event.eventId,
          key: entry.key,
          duplicate: false,
        };
      });
    };
    return transaction ? run(transaction) : this.db.runTransaction(run);
  }
}
