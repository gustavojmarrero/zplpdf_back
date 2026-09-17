import {
  APPLIED_EVENT_WINDOW,
  TERMINAL_HISTORY_MAX,
  TERMINAL_TOUR_STATES,
  TOUR_STATE_RANK,
  tourEventFingerprint,
} from './product-updates.types.js';
import type {
  AppliedTourEvent,
  TourAction,
  TourProgressRecord,
  TourState,
} from './product-updates.types.js';

export interface TourProgressCommand {
  eventId: string;
  expectedRevision: number;
  action: TourAction;
  stepId?: string;
}

export type TourProgressOutcome =
  | { kind: 'duplicate'; record: TourProgressRecord }
  | { kind: 'conflict'; record: TourProgressRecord }
  /** Mismo `eventId` con otro cuerpo: reutilización, no reintento. */
  | { kind: 'event_conflict'; record: TourProgressRecord }
  | { kind: 'applied'; record: TourProgressRecord; changed: boolean };

const atLeast = (current: TourState, target: TourState): TourState =>
  TOUR_STATE_RANK[current] < TOUR_STATE_RANK[target] ? target : current;

const withEvent = (
  record: TourProgressRecord,
  entry: AppliedTourEvent,
): AppliedTourEvent[] => {
  const events = record.appliedEvents.concat(entry);
  return events.length > APPLIED_EVENT_WINDOW
    ? events.slice(events.length - APPLIED_EVENT_WINDOW)
    : events;
};

const pushTerminal = (
  history: { state: TourState; at: string }[],
  entry: { state: TourState; at: string },
): { state: TourState; at: string }[] => {
  const next = history.concat(entry);
  return next.length > TERMINAL_HISTORY_MAX
    ? next.slice(next.length - TERMINAL_HISTORY_MAX)
    : next;
};

/**
 * Reductor puro del progreso. El duplicado se resuelve antes del CAS: un
 * reintento cuya respuesta se perdió debe confirmar, no chocar.
 */
export function applyTourAction(
  current: TourProgressRecord,
  command: TourProgressCommand,
  now: Date,
): TourProgressOutcome {
  const fingerprint = tourEventFingerprint(command);
  const seen = current.appliedEvents.find(
    (entry) => entry.eventId === command.eventId,
  );
  if (seen)
    return seen.fingerprint === fingerprint
      ? { kind: 'duplicate', record: current }
      : { kind: 'event_conflict', record: current };
  if (command.expectedRevision !== current.revision)
    return { kind: 'conflict', record: current };

  const iso = now.toISOString();
  const next: TourProgressRecord = {
    ...current,
    visitedStepIds: current.visitedStepIds.slice(),
    terminalHistory: current.terminalHistory.slice(),
    appliedEvents: withEvent(current, {
      eventId: command.eventId,
      fingerprint,
    }),
    revision: current.revision + 1,
    updatedAt: iso,
  };
  const wasTerminal = TERMINAL_TOUR_STATES.includes(current.state);
  let changed = false;

  const markStarted = () => {
    if (next.startedAt === null) next.startedAt = iso;
    const state = atLeast(next.state, 'started');
    if (state !== next.state) {
      next.state = state;
      changed = true;
    }
  };

  switch (command.action) {
    case 'start':
      // Un estado terminal no se rebaja: la invitación sigue suprimida.
      if (!wasTerminal) markStarted();
      break;
    case 'view_step': {
      const stepId = command.stepId;
      if (!next.visitedStepIds.includes(stepId)) {
        next.visitedStepIds.push(stepId);
        changed = true;
      }
      if (next.lastStepId !== stepId) {
        next.lastStepId = stepId;
        changed = true;
      }
      // El paso visto se registra incluso tras cerrar o terminar, pero no
      // reabre el tour ni resucita un estado terminal.
      if (!wasTerminal) markStarted();
      break;
    }
    case 'close': {
      if (wasTerminal) break;
      const state = atLeast(next.state, 'closed');
      if (state !== next.state) {
        next.state = state;
        next.closedAt = iso;
        changed = true;
      }
      // `lastStepId` intacto: cerrar conserva la posición.
      break;
    }
    case 'skip': {
      const state = atLeast(next.state, 'skipped');
      if (state !== next.state) {
        next.state = state;
        next.skippedAt = iso;
        changed = true;
      }
      // Supresión terminal: sobrevive a repetir, no solo al estado.
      if (!next.invitationSuppressed) {
        next.invitationSuppressed = true;
        changed = true;
      }
      break;
    }
    case 'complete': {
      const state = atLeast(next.state, 'completed');
      if (state !== next.state) {
        next.state = state;
        next.completedAt = iso;
        changed = true;
      }
      if (!next.invitationSuppressed) {
        next.invitationSuppressed = true;
        changed = true;
      }
      break;
    }
    case 'replay': {
      // Repetir es explícito: abre sesión, no borra el historial terminal ni
      // restablece la invitación automática (`invitationSuppressed` intacto).
      if (TOUR_STATE_RANK[current.state] >= TOUR_STATE_RANK.closed) {
        next.terminalHistory = pushTerminal(next.terminalHistory, {
          state: current.state,
          at: current.updatedAt ?? iso,
        });
        next.replays = current.replays + 1;
        next.state = 'started';
        changed = true;
      }
      if (next.startedAt === null) next.startedAt = iso;
      if (next.state === 'pending') {
        next.state = 'started';
        changed = true;
      }
      break;
    }
  }

  return { kind: 'applied', record: next, changed };
}
