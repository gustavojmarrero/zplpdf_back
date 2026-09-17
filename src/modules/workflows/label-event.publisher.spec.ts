import { BadRequestException } from '@nestjs/common';
import { validate as isUuid, version as uuidVersion } from 'uuid';
import { LabelEventPublisher } from './label-event.publisher.js';
import { InMemoryLabelEventOutbox } from './label-event.store.js';
import {
  MAX_EVENT_ATTEMPTS,
  buildOutboxRecord,
  nextAttemptAt,
} from './label-event.outbox.js';
import type { LabelEventRecorderPort } from './ports/label-event-recorder.port.js';

const EVENT = {
  eventName: 'packing_export_succeeded' as const,
  accountId: 'alice',
  featureId: 'packing_workflow' as const,
  featureVersion: '1',
  operationId: '0f1ad1ca-0000-4000-8000-000000000001',
  source: 'api' as const,
};

function okRecorder(seen: unknown[] = []): LabelEventRecorderPort {
  return {
    async recordServerEvent(event) {
      seen.push(event);
      return { duplicate: false };
    },
  };
}

function failingRecorder(error: Error): LabelEventRecorderPort {
  return {
    async recordServerEvent() {
      throw error;
    },
  };
}

/** Escribe el hecho como haría la transacción de negocio. */
function commitEvent(outbox: InMemoryLabelEventOutbox) {
  const record = buildOutboxRecord(EVENT);
  outbox.write(record);
  return record;
}

describe('buildOutboxRecord', () => {
  it('fija eventId y occurredAt antes de escribir, con accountId en la raíz', () => {
    const record = buildOutboxRecord(EVENT, new Date('2026-09-17T10:00:00Z'));

    expect(isUuid(record.id)).toBe(true);
    expect(uuidVersion(record.id)).toBe(4);
    expect(record.id).toBe(record.event.eventId);
    expect(record.event.occurredAt).toBe('2026-09-17T10:00:00.000Z');
    // Duplicados en la raíz: permiten filtrar y barrer sin abrir `event`.
    expect(record.accountId).toBe('alice');
    expect(record.eventName).toBe('packing_export_succeeded');
    expect(record.operationId).toBe(EVENT.operationId);
    expect(record.status).toBe('pending');
    expect(record.attempts).toBe(0);
    expect(record.availableAt).toBe('2026-09-17T10:00:00.000Z');
  });
});

describe('LabelEventPublisher — entrega', () => {
  it('entrega el hecho ya confirmado y lo saca de la cola', async () => {
    const seen: unknown[] = [];
    const outbox = new InMemoryLabelEventOutbox();
    const publisher = new LabelEventPublisher(okRecorder(seen), outbox);
    const record = commitEvent(outbox);

    expect(await publisher.deliverAfterCommit(record)).toEqual({
      delivered: true,
    });
    expect(seen).toHaveLength(1);
    expect(await outbox.get(record.id)).toBeNull();
  });

  it('un fallo de entrega deja el hecho en la cola con código genérico', async () => {
    const outbox = new InMemoryLabelEventOutbox();
    const publisher = new LabelEventPublisher(
      failingRecorder(new Error('firestore: doc users/alice no accesible')),
      outbox,
    );
    const record = commitEvent(outbox);

    expect(await publisher.deliverAfterCommit(record)).toEqual({
      delivered: false,
    });

    const pending = await outbox.get(record.id);
    expect(pending.status).toBe('pending');
    expect(pending.attempts).toBe(1);
    expect(pending.lastErrorCode).toBe('recorder_unavailable');
    // El texto del error no entra en el documento: podría arrastrar contenido.
    expect(JSON.stringify(pending)).not.toContain('firestore:');
    expect(JSON.stringify(pending)).not.toContain('users/alice');
    // El lease se libera para que otro consumidor pueda retomarlo.
    expect(pending.leaseToken).toBeUndefined();
  });

  it('distingue un rechazo de validación de una caída', async () => {
    const outbox = new InMemoryLabelEventOutbox();
    const publisher = new LabelEventPublisher(
      failingRecorder(new BadRequestException('Invalid server event')),
      outbox,
    );
    const record = commitEvent(outbox);

    await publisher.deliverAfterCommit(record);

    expect((await outbox.get(record.id)).lastErrorCode).toBe(
      'recorder_rejected',
    );
  });

  it('sin registro enlazado el hecho se conserva con su propio código', async () => {
    const outbox = new InMemoryLabelEventOutbox();
    const publisher = new LabelEventPublisher(undefined, outbox);
    const record = commitEvent(outbox);

    await publisher.deliverAfterCommit(record);

    const pending = await outbox.get(record.id);
    expect(pending.status).toBe('pending');
    expect(pending.lastErrorCode).toBe('no_recorder_configured');
  });

  it('el drenado recupera lo que la entrega inmediata no pudo entregar', async () => {
    const outbox = new InMemoryLabelEventOutbox();
    const seen: unknown[] = [];
    let down = true;
    const recorder: LabelEventRecorderPort = {
      async recordServerEvent(event) {
        if (down) throw new Error('caído');
        seen.push(event);
        return { duplicate: false };
      },
    };
    const publisher = new LabelEventPublisher(recorder, outbox);
    const record = commitEvent(outbox);

    await publisher.deliverAfterCommit(record);
    down = false;

    // Antes de su turno no se toca.
    expect(await publisher.retryPending()).toMatchObject({
      claimed: 0,
      delivered: 0,
    });

    jest.useFakeTimers().setSystemTime(Date.now() + 10 * 60_000);
    try {
      expect(await publisher.retryPending()).toMatchObject({
        claimed: 1,
        delivered: 1,
      });
    } finally {
      jest.useRealTimers();
    }

    expect(seen).toHaveLength(1);
    expect(await outbox.get(record.id)).toBeNull();
  });

  it('reintentar el mismo hecho no lo duplica ni lo pierde', async () => {
    const seen: any[] = [];
    const outbox = new InMemoryLabelEventOutbox();
    const publisher = new LabelEventPublisher(okRecorder(seen), outbox);
    const record = commitEvent(outbox);

    await publisher.deliverAfterCommit(record);
    // Segunda entrega del mismo hecho: ya no hay documento que reclamar.
    await publisher.deliverAfterCommit(record);
    await publisher.retryPending();

    expect(seen).toHaveLength(1);
    expect(seen[0].eventId).toBe(record.id);
    expect(outbox.all()).toEqual([]);
  });

  it('la reentrega conserva el mismo eventId, que es lo que deduplica', async () => {
    const seen: any[] = [];
    const outbox = new InMemoryLabelEventOutbox();
    let down = true;
    const recorder: LabelEventRecorderPort = {
      async recordServerEvent(event) {
        seen.push(event);
        if (down) throw new Error('caído');
        return { duplicate: true };
      },
    };
    const publisher = new LabelEventPublisher(recorder, outbox);
    const record = commitEvent(outbox);

    await publisher.deliverAfterCommit(record);
    down = false;

    jest.useFakeTimers().setSystemTime(Date.now() + 10 * 60_000);
    try {
      await publisher.retryPending();
    } finally {
      jest.useRealTimers();
    }

    expect(seen).toHaveLength(2);
    expect(seen[0].eventId).toBe(seen[1].eventId);
    expect(seen[0].occurredAt).toBe(seen[1].occurredAt);
  });
});

describe('LabelEventPublisher — lease, fencing y muerte', () => {
  it('un lease vivo impide que otro consumidor reclame el mismo hecho', async () => {
    const outbox = new InMemoryLabelEventOutbox();
    const record = commitEvent(outbox);
    const now = new Date();

    const first = await outbox.claimOne(record.id, now);
    const second = await outbox.claimOne(record.id, now);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('un lease vencido se puede robar, y el token viejo ya no confirma', async () => {
    const outbox = new InMemoryLabelEventOutbox();
    const record = commitEvent(outbox);
    const now = new Date();

    const stale = await outbox.claimOne(record.id, now);
    const later = new Date(now.getTime() + 120_000);
    const fresh = await outbox.claimOne(record.id, later);

    expect(fresh).not.toBeNull();
    expect(fresh.token).not.toBe(stale.token);

    // El consumidor lento no puede borrar el trabajo del que se lo quitó.
    expect(await outbox.ack(record.id, stale.token)).toBe(false);
    expect(await outbox.get(record.id)).not.toBeNull();
    expect(
      await outbox.fail(record.id, stale.token, 'recorder_unavailable', later),
    ).toBe('lost');
    // El nuevo dueño sí.
    expect(await outbox.ack(record.id, fresh.token)).toBe(true);
    expect(await outbox.get(record.id)).toBeNull();
  });

  it('dos drenados concurrentes entregan el hecho una sola vez', async () => {
    const seen: unknown[] = [];
    const outbox = new InMemoryLabelEventOutbox();
    const recorder = okRecorder(seen);
    const a = new LabelEventPublisher(recorder, outbox);
    const b = new LabelEventPublisher(recorder, outbox);
    commitEvent(outbox);

    const [first, second] = await Promise.all([
      a.retryPending(),
      b.retryPending(),
    ]);

    expect(seen).toHaveLength(1);
    expect(first.delivered + second.delivered).toBe(1);
    expect(outbox.all()).toEqual([]);
  });

  it('tras agotar los intentos queda muerto, sin availableAt y sin borrarse', async () => {
    const outbox = new InMemoryLabelEventOutbox();
    const publisher = new LabelEventPublisher(
      failingRecorder(new Error('sigue caído')),
      outbox,
    );
    const record = commitEvent(outbox);

    jest.useFakeTimers();
    try {
      await publisher.deliverAfterCommit(record);
      for (let attempt = 1; attempt < MAX_EVENT_ATTEMPTS; attempt += 1) {
        jest.setSystemTime(Date.now() + 61 * 60_000);
        await publisher.retryPending();
      }

      const dead = await outbox.get(record.id);
      expect(dead.status).toBe('dead');
      expect(dead.attempts).toBe(MAX_EVENT_ATTEMPTS);
      // Sin fecha centinela: el campo desaparece, y por eso la consulta por
      // `availableAt` ya no lo devuelve.
      expect('availableAt' in dead).toBe(false);
      expect(dead.lastErrorCode).toBe('recorder_unavailable');

      jest.setSystemTime(Date.now() + 365 * 24 * 60 * 60_000);
      expect(await publisher.retryPending()).toMatchObject({ claimed: 0 });
    } finally {
      jest.useRealTimers();
    }

    // No se borra: es la evidencia de un hecho que ocurrió y no se registró.
    expect(outbox.all()).toHaveLength(1);
  });

  it('la espera entre intentos crece y se corta en una hora', () => {
    const now = new Date('2026-09-17T00:00:00.000Z');
    expect(nextAttemptAt(1, now)).toBe('2026-09-17T00:02:00.000Z');
    expect(nextAttemptAt(3, now)).toBe('2026-09-17T00:08:00.000Z');
    expect(nextAttemptAt(20, now)).toBe('2026-09-17T01:00:00.000Z');
  });
});

describe('Manual dead-event recovery port', () => {
  it('requeues once, preserves canonical identity, and cannot be acknowledged by an old consumer', async () => {
    const outbox = new InMemoryLabelEventOutbox();
    const original = buildOutboxRecord(EVENT);
    outbox.write({
      ...original,
      status: 'dead',
      attempts: MAX_EVENT_ATTEMPTS,
      availableAt: undefined,
      leaseToken: 'stale-token',
    });
    expect(await outbox.requeueDead('bob', original.id, new Date())).toBe(
      false,
    );
    expect(await outbox.requeueDead('alice', original.id, new Date())).toBe(
      true,
    );
    expect(await outbox.requeueDead('alice', original.id, new Date())).toBe(
      false,
    );
    expect(await outbox.ack(original.id, 'stale-token')).toBe(false);
    const pending = await outbox.get(original.id);
    expect(pending?.event).toEqual(original.event);
    expect(pending).toMatchObject({
      id: original.id,
      attempts: 0,
      previousAttempts: MAX_EVENT_ATTEMPTS,
      manualRetries: 1,
      status: 'pending',
    });
    const seen: unknown[] = [];
    await new LabelEventPublisher(okRecorder(seen), outbox).retryPending();
    expect(seen).toEqual([original.event]);
    expect(outbox.all()).toEqual([]);
  });

  it('refuses to recreate a dead fact for a tombstoned account', async () => {
    const outbox = new InMemoryLabelEventOutbox();
    const original = {
      ...buildOutboxRecord(EVENT),
      status: 'dead' as const,
      attempts: MAX_EVENT_ATTEMPTS,
      availableAt: undefined,
    };
    outbox.write(original);
    outbox.markAccountDeleted('alice');
    await expect(
      outbox.requeueDead('alice', original.id, new Date()),
    ).rejects.toThrow('marked as deleted');
    expect(await outbox.get(original.id)).toEqual(original);
  });
});
