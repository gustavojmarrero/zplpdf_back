import {
  APPLIED_EVENT_WINDOW,
  emptyProgress,
  tourEventFingerprint,
} from './product-updates.types.js';
import type { TourProgressRecord } from './product-updates.types.js';
import { applyTourAction } from './tour-progress.js';

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minutes: number) =>
  new Date(Date.parse('2026-09-18T10:00:00.000Z') + minutes * 60_000);

const start = () => emptyProgress('acct', 'growth-2026-09', '1');

const apply = (
  record: TourProgressRecord,
  action: Parameters<typeof applyTourAction>[1]['action'],
  options: { event: number; stepId?: string; minutes?: number } = {
    event: 1,
  },
) =>
  applyTourAction(
    record,
    {
      eventId: uuid(options.event),
      expectedRevision: record.revision,
      action,
      stepId: options.stepId,
    },
    at(options.minutes ?? 0),
  );

const applied = (
  record: TourProgressRecord,
  action: Parameters<typeof applyTourAction>[1]['action'],
  options: { event: number; stepId?: string; minutes?: number } = { event: 1 },
): TourProgressRecord => {
  const outcome = apply(record, action, options);
  if (outcome.kind !== 'applied') throw new Error(`unexpected ${outcome.kind}`);
  return outcome.record;
};

describe('tour progress reducer', () => {
  it('unions visited steps and keeps the last position', () => {
    let record = applied(start(), 'start', { event: 1 });
    expect(record.state).toBe('started');
    expect(record.revision).toBe(1);
    record = applied(record, 'view_step', { event: 2, stepId: 'a' });
    record = applied(record, 'view_step', { event: 3, stepId: 'b' });
    record = applied(record, 'view_step', { event: 4, stepId: 'a' });
    expect(record.visitedStepIds).toEqual(['a', 'b']);
    expect(record.lastStepId).toBe('a');
    expect(record.revision).toBe(4);
  });

  it('keeps the position when the tour is closed', () => {
    let record = applied(start(), 'view_step', { event: 1, stepId: 'b' });
    record = applied(record, 'close', { event: 2, minutes: 5 });
    expect(record.state).toBe('closed');
    expect(record.lastStepId).toBe('b');
    expect(record.visitedStepIds).toEqual(['b']);
    expect(record.closedAt).toBe(at(5).toISOString());
  });

  it('resolves a duplicate event before the revision check', () => {
    const record = applied(start(), 'start', { event: 1 });
    // Reintento de una respuesta perdida: el cliente aún cree estar en 0.
    const retry = applyTourAction(
      record,
      {
        eventId: uuid(1),
        expectedRevision: 0,
        action: 'start',
        stepId: undefined,
      },
      at(1),
    );
    expect(retry.kind).toBe('duplicate');
    expect(retry.record.revision).toBe(1);
  });

  it('rejects a stale revision without touching the record', () => {
    const record = applied(start(), 'start', { event: 1 });
    const outcome = applyTourAction(
      record,
      {
        eventId: uuid(2),
        expectedRevision: 0,
        action: 'complete',
        stepId: undefined,
      },
      at(1),
    );
    expect(outcome.kind).toBe('conflict');
    expect(outcome.record).toBe(record);
    expect(outcome.record.state).toBe('started');
  });

  it('never downgrades a terminal state', () => {
    const completed = applied(start(), 'complete', { event: 1, minutes: 1 });
    expect(completed.state).toBe('completed');
    for (const action of ['start', 'close', 'skip'] as const) {
      const outcome = applied(completed, action, { event: 5, minutes: 2 });
      expect(outcome.state).toBe('completed');
      expect(outcome.closedAt).toBeNull();
      expect(outcome.skippedAt).toBeNull();
      // Bookkeeping avanza, el estado no: la acción quedó suprimida.
      expect(outcome.revision).toBe(completed.revision + 1);
    }
    const skipped = applied(start(), 'skip', { event: 2, minutes: 1 });
    expect(applied(skipped, 'close', { event: 6 }).state).toBe('skipped');
    expect(applied(skipped, 'start', { event: 7 }).state).toBe('skipped');
    // Completar sí es progreso frente a omitir.
    expect(applied(skipped, 'complete', { event: 8, minutes: 3 }).state).toBe(
      'completed',
    );
  });

  it('records a step seen after the tour ended without reopening it', () => {
    const completed = applied(start(), 'complete', { event: 1 });
    const outcome = applied(completed, 'view_step', { event: 2, stepId: 'c' });
    expect(outcome.state).toBe('completed');
    expect(outcome.visitedStepIds).toEqual(['c']);
    expect(outcome.lastStepId).toBe('c');
  });

  it('replays explicitly and stacks the terminal history instead of erasing it', () => {
    let record = applied(start(), 'view_step', { event: 1, stepId: 'a' });
    record = applied(record, 'complete', { event: 2, minutes: 4 });
    const firstCompletion = record.completedAt;
    record = applied(record, 'replay', { event: 3, minutes: 9 });
    expect(record.state).toBe('started');
    expect(record.replays).toBe(1);
    expect(record.terminalHistory).toEqual([
      { state: 'completed', at: at(4).toISOString() },
    ]);
    expect(record.completedAt).toBe(firstCompletion);
    expect(record.visitedStepIds).toEqual(['a']);
    record = applied(record, 'skip', { event: 4, minutes: 10 });
    record = applied(record, 'replay', { event: 5, minutes: 11 });
    expect(record.replays).toBe(2);
    expect(record.terminalHistory.map((entry) => entry.state)).toEqual([
      'completed',
      'skipped',
    ]);
  });

  it('treats replay on a fresh tour as a plain start', () => {
    const record = applied(start(), 'replay', { event: 1 });
    expect(record.state).toBe('started');
    expect(record.replays).toBe(0);
    expect(record.terminalHistory).toEqual([]);
  });

  it('rejects a reused event id that carries a different body', () => {
    const record = applied(start(), 'view_step', { event: 1, stepId: 'a' });
    for (const different of [
      { action: 'skip' as const, stepId: 'a', expectedRevision: 0 },
      { action: 'view_step' as const, stepId: 'b', expectedRevision: 0 },
      { action: 'view_step' as const, stepId: 'a', expectedRevision: 1 },
    ]) {
      const outcome = applyTourAction(
        record,
        { eventId: uuid(1), ...different },
        at(1),
      );
      // Reutilización, no reintento: nunca se confirma en silencio.
      expect(outcome.kind).toBe('event_conflict');
      expect(outcome.record).toBe(record);
    }
    const sameBody = applyTourAction(
      record,
      {
        eventId: uuid(1),
        action: 'view_step',
        stepId: 'a',
        expectedRevision: 0,
      },
      at(1),
    );
    expect(sameBody.kind).toBe('duplicate');
    expect(record.appliedEvents).toEqual([
      {
        eventId: uuid(1),
        fingerprint: tourEventFingerprint({
          action: 'view_step',
          stepId: 'a',
          expectedRevision: 0,
        }),
      },
    ]);
  });

  it('keeps the invitation suppressed after an explicit replay', () => {
    let record = applied(start(), 'skip', { event: 1, minutes: 1 });
    expect(record.invitationSuppressed).toBe(true);
    record = applied(record, 'replay', { event: 2, minutes: 2 });
    expect(record.state).toBe('started');
    // Repetir abre sesión; la invitación automática no vuelve.
    expect(record.invitationSuppressed).toBe(true);
    record = applied(record, 'close', { event: 3, minutes: 3 });
    expect(record.invitationSuppressed).toBe(true);
    const completed = applied(start(), 'complete', { event: 4, minutes: 1 });
    expect(completed.invitationSuppressed).toBe(true);
    expect(
      applied(completed, 'replay', { event: 5, minutes: 2 })
        .invitationSuppressed,
    ).toBe(true);
    // Ni empezar ni cerrar suprimen: cerrar conserva la posición para retomar.
    const closed = applied(applied(start(), 'start', { event: 6 }), 'close', {
      event: 7,
    });
    expect(closed.invitationSuppressed).toBe(false);
  });

  it('bounds the idempotency window so the document cannot grow forever', () => {
    let record = start();
    for (let i = 0; i < APPLIED_EVENT_WINDOW + 5; i += 1)
      record = applied(record, 'view_step', {
        event: i + 1,
        stepId: `step-${i}`,
      });
    const ids = record.appliedEvents.map((entry) => entry.eventId);
    expect(ids).toHaveLength(APPLIED_EVENT_WINDOW);
    expect(ids).toContain(uuid(APPLIED_EVENT_WINDOW + 5));
    expect(ids).not.toContain(uuid(1));
    // Un duplicado fuera de la ventana ya no se reconoce, pero el CAS protege.
    const outcome = applyTourAction(
      record,
      {
        eventId: uuid(1),
        expectedRevision: 0,
        action: 'start',
        stepId: undefined,
      },
      at(1),
    );
    expect(outcome.kind).toBe('conflict');
  });
});
