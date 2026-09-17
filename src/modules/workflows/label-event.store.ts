import { Inject, Injectable } from '@nestjs/common';
import type { Provider } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { FieldValue, Firestore, Transaction } from '@google-cloud/firestore';
import { FirestoreService } from '../cache/firestore.service.js';
import {
  AccountDeletedError,
  DELETED_ACCOUNTS_COLLECTION,
  EVENT_LEASE_MS,
  LABEL_EVENT_OUTBOX_COLLECTION,
  MAX_EVENT_ATTEMPTS,
  nextAttemptAt,
} from './label-event.outbox.js';
import type {
  ClaimedOutboxEvent,
  EventFailureCode,
  OutboxEventRecord,
} from './label-event.outbox.js';

/**
 * Cola de salida de hechos canónicos.
 *
 * Solo gestiona la **entrega**: los documentos los escribe la transacción de
 * negocio que produjo el hecho (ver `writeOutboxRecord`). Aquí no se crea nada
 * nuevo, solo se reclama, se confirma y se falla.
 */
export interface LabelEventOutboxPort {
  /** Reclama hasta `limit` hechos disponibles, con lease y token. */
  claimBatch(limit: number, now: Date): Promise<ClaimedOutboxEvent[]>;
  /** Reclama uno concreto; null si no existe, está muerto o lo tiene otro. */
  claimOne(id: string, now: Date): Promise<ClaimedOutboxEvent | null>;
  /** Entrega confirmada: borra el documento. `false` si el lease ya no es suyo. */
  ack(id: string, token: string): Promise<boolean>;
  /** Entrega fallida: reprograma o marca muerto. `lost` si el lease ya no es suyo. */
  fail(
    id: string,
    token: string,
    errorCode: EventFailureCode,
    now: Date,
  ): Promise<'pending' | 'dead' | 'lost'>;
  get(id: string): Promise<OutboxEventRecord | null>;
  /** Internal admin port only: requeue an owned dead fact without changing its event. */
  requeueDead(accountId: string, id: string, now: Date): Promise<boolean>;
}

export const LABEL_EVENT_OUTBOX = Symbol('LABEL_EVENT_OUTBOX');

function claimable(record: OutboxEventRecord, now: Date): boolean {
  if (record.status !== 'pending') return false;
  if (!record.availableAt || record.availableAt > now.toISOString()) {
    return false;
  }
  // Un lease vivo de otro consumidor bloquea; uno vencido se puede robar.
  return (
    !record.leaseExpiresAt ||
    new Date(record.leaseExpiresAt).getTime() <= now.getTime()
  );
}

function manuallyRequeued(
  record: OutboxEventRecord,
  now: Date,
): OutboxEventRecord {
  const {
    leaseToken: _token,
    leaseExpiresAt: _lease,
    lastErrorCode: _error,
    ...rest
  } = record;
  return {
    ...rest,
    status: 'pending',
    attempts: 0,
    previousAttempts: (record.previousAttempts ?? 0) + record.attempts,
    manualRetries: (record.manualRetries ?? 0) + 1,
    lastManualRetryAt: now.toISOString(),
    updatedAt: now.toISOString(),
    availableAt: now.toISOString(),
  };
}

function leased(
  record: OutboxEventRecord,
  token: string,
  now: Date,
): OutboxEventRecord {
  return {
    ...record,
    leaseToken: token,
    leaseExpiresAt: new Date(now.getTime() + EVENT_LEASE_MS).toISOString(),
    updatedAt: now.toISOString(),
  };
}

@Injectable()
export class FirestoreLabelEventOutbox implements LabelEventOutboxPort {
  constructor(
    @Inject('LABEL_EVENT_FIRESTORE') private readonly db: Firestore,
  ) {}

  private ref(id: string) {
    return this.db.collection(LABEL_EVENT_OUTBOX_COLLECTION).doc(id);
  }

  async claimBatch(limit: number, now: Date): Promise<ClaimedOutboxEvent[]> {
    // La consulta solo mira `availableAt`, que es un campo único: no hace falta
    // índice compuesto. Los muertos no tienen el campo, así que quedan fuera
    // sin necesidad de una fecha centinela.
    const snapshot = await this.db
      .collection(LABEL_EVENT_OUTBOX_COLLECTION)
      .where('availableAt', '<=', now.toISOString())
      .orderBy('availableAt', 'asc')
      .limit(limit)
      .get();

    const claimed: ClaimedOutboxEvent[] = [];
    for (const doc of snapshot.docs) {
      const result = await this.claimOne(doc.id, now);
      if (result) claimed.push(result);
    }
    return claimed;
  }

  async claimOne(id: string, now: Date): Promise<ClaimedOutboxEvent | null> {
    const ref = this.ref(id);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return null;

      const record = snapshot.data() as OutboxEventRecord;
      if (!claimable(record, now)) return null;

      const token = randomUUID();
      const next = leased(record, token, now);
      transaction.set(ref, next);
      return { record: next, token };
    });
  }

  async ack(id: string, token: string): Promise<boolean> {
    const ref = this.ref(id);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      // Ya no está: otro consumidor lo confirmó. Tratarlo como éxito evita que
      // un ack tardío reviva nada.
      if (!snapshot.exists) return true;

      const record = snapshot.data() as OutboxEventRecord;
      if (record.leaseToken !== token) return false;

      transaction.delete(ref);
      return true;
    });
  }

  async fail(
    id: string,
    token: string,
    errorCode: EventFailureCode,
    now: Date,
  ): Promise<'pending' | 'dead' | 'lost'> {
    const ref = this.ref(id);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return 'lost';

      const record = snapshot.data() as OutboxEventRecord;
      if (record.leaseToken !== token) return 'lost';

      const attempts = record.attempts + 1;
      const dead = attempts >= MAX_EVENT_ATTEMPTS;

      transaction.update(ref, {
        attempts,
        lastErrorCode: errorCode,
        status: dead ? 'dead' : 'pending',
        updatedAt: now.toISOString(),
        // Un muerto pierde el campo entero: así no aparece en la consulta ni
        // hace falta inventarle una fecha imposible.
        availableAt: dead ? FieldValue.delete() : nextAttemptAt(attempts, now),
        leaseToken: FieldValue.delete(),
        leaseExpiresAt: FieldValue.delete(),
      });

      return dead ? 'dead' : 'pending';
    });
  }

  async requeueDead(
    accountId: string,
    id: string,
    now: Date,
  ): Promise<boolean> {
    const ref = this.ref(id);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return false;
      const record = snapshot.data() as OutboxEventRecord;
      if (record.accountId !== accountId || record.status !== 'dead')
        return false;
      await assertAccountAlive(transaction, this.db, accountId);
      transaction.set(ref, manuallyRequeued(record, now));
      return true;
    });
  }

  async get(id: string): Promise<OutboxEventRecord | null> {
    const snapshot = await this.ref(id).get();
    return snapshot.exists ? (snapshot.data() as OutboxEventRecord) : null;
  }
}

export const LabelEventOutboxProviders: Provider[] = [
  {
    provide: 'LABEL_EVENT_FIRESTORE',
    inject: [FirestoreService],
    useFactory: (store: FirestoreService) => store.getClient(),
  },
  { provide: LABEL_EVENT_OUTBOX, useClass: FirestoreLabelEventOutbox },
];

/**
 * Cola en memoria con la misma semántica de lease, token y muerte explícita.
 * La usan las pruebas y el arranque local sin credenciales.
 */
export class InMemoryLabelEventOutbox implements LabelEventOutboxPort {
  private readonly records = new Map<string, OutboxEventRecord>();

  constructor(private readonly deletedAccounts: Set<string> = new Set()) {}

  markAccountDeleted(accountId: string): void {
    this.deletedAccounts.add(accountId);
  }

  async requeueDead(
    accountId: string,
    id: string,
    now: Date,
  ): Promise<boolean> {
    const record = this.records.get(id);
    if (!record || record.accountId !== accountId || record.status !== 'dead')
      return false;
    if (this.deletedAccounts.has(accountId))
      throw new AccountDeletedError(accountId);
    this.records.set(id, manuallyRequeued(record, now));
    return true;
  }

  /** Escritura que hace la «transacción de negocio» del repositorio en memoria. */
  write(record: OutboxEventRecord): void {
    this.records.set(record.id, { ...record });
  }

  async claimBatch(limit: number, now: Date): Promise<ClaimedOutboxEvent[]> {
    const candidates = [...this.records.values()]
      .filter((record) => claimable(record, now))
      .sort((a, b) => (a.availableAt ?? '').localeCompare(b.availableAt ?? ''))
      .slice(0, limit);

    const claimed: ClaimedOutboxEvent[] = [];
    for (const candidate of candidates) {
      const result = await this.claimOne(candidate.id, now);
      if (result) claimed.push(result);
    }
    return claimed;
  }

  async claimOne(id: string, now: Date): Promise<ClaimedOutboxEvent | null> {
    const record = this.records.get(id);
    if (!record || !claimable(record, now)) return null;

    const token = randomUUID();
    const next = leased(record, token, now);
    this.records.set(id, next);
    return { record: { ...next }, token };
  }

  async ack(id: string, token: string): Promise<boolean> {
    const record = this.records.get(id);
    if (!record) return true;
    if (record.leaseToken !== token) return false;
    this.records.delete(id);
    return true;
  }

  async fail(
    id: string,
    token: string,
    errorCode: EventFailureCode,
    now: Date,
  ): Promise<'pending' | 'dead' | 'lost'> {
    const record = this.records.get(id);
    if (!record || record.leaseToken !== token) return 'lost';

    const attempts = record.attempts + 1;
    const dead = attempts >= MAX_EVENT_ATTEMPTS;
    const { availableAt, leaseToken, leaseExpiresAt, ...rest } = record;

    this.records.set(id, {
      ...rest,
      attempts,
      lastErrorCode: errorCode,
      status: dead ? 'dead' : 'pending',
      updatedAt: now.toISOString(),
      ...(dead ? {} : { availableAt: nextAttemptAt(attempts, now) }),
    });

    return dead ? 'dead' : 'pending';
  }

  async get(id: string): Promise<OutboxEventRecord | null> {
    const record = this.records.get(id);
    return record ? { ...record } : null;
  }

  /** Solo para pruebas. */
  all(): OutboxEventRecord[] {
    return [...this.records.values()];
  }
}

// ============== helpers de la transacción de negocio ==============

/**
 * Comprueba la lápida de cuenta borrada **dentro** de la transacción de
 * negocio.
 *
 * Tiene que ser la misma transacción y no una consulta previa: entre un
 * chequeo suelto y la escritura cabe una baja de cuenta, y el resultado sería
 * material nuevo creado para una cuenta que ya no existe. Es una lectura, así
 * que va antes de cualquier escritura.
 */
export async function assertAccountAlive(
  transaction: Transaction,
  db: Firestore,
  accountId: string,
): Promise<void> {
  const snapshot = await transaction.get(
    db.collection(DELETED_ACCOUNTS_COLLECTION).doc(accountId),
  );
  if (snapshot.exists) throw new AccountDeletedError(accountId);
}

/**
 * Añade el hecho a la misma transacción que la transición de negocio. `create`
 * y no `set`: si el documento ya existiera, algo habría reusado un `eventId`.
 */
export function writeOutboxRecord(
  transaction: Transaction,
  db: Firestore,
  record?: OutboxEventRecord,
): void {
  if (!record) return;
  transaction.create(
    db.collection(LABEL_EVENT_OUTBOX_COLLECTION).doc(record.id),
    record,
  );
}
