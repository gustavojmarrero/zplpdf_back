import { GoneException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { LabelServerEvent } from './ports/label-event-recorder.port.js';

export const LABEL_EVENT_OUTBOX_COLLECTION = 'label_event_retries';

/** Lápida de cuenta borrada. Mismo nombre que usa `FirestoreService`. */
export const DELETED_ACCOUNTS_COLLECTION = 'deleted_accounts';

/**
 * Intentos antes de dar el hecho por muerto. Un `dead` no se borra: es la
 * evidencia de algo que ocurrió y no se pudo registrar.
 */
export const MAX_EVENT_ATTEMPTS = 8;

/** Ventana en la que un consumidor tiene reclamado el hecho. */
export const EVENT_LEASE_MS = 60_000;

/**
 * Códigos de fallo. Son un enumerado cerrado **a propósito**: el mensaje de la
 * excepción original puede arrastrar ids de documento, contenido de la etiqueta
 * o detalles internos de Firestore, y este documento se lee desde paneles de
 * operación. Lo que hace falta para decidir es la clase de fallo, no el texto.
 */
export const EventFailureCodes = {
  /** El registro rechazó el evento (validación): reintentar no va a arreglarlo solo. */
  RECORDER_REJECTED: 'recorder_rejected',
  /** El registro no respondió o falló por causas transitorias. */
  RECORDER_UNAVAILABLE: 'recorder_unavailable',
  /** No hay adaptador de registro enlazado en este despliegue. */
  NO_RECORDER_CONFIGURED: 'no_recorder_configured',
} as const;

export type EventFailureCode =
  (typeof EventFailureCodes)[keyof typeof EventFailureCodes];

export type OutboxStatus = 'pending' | 'dead';

/**
 * Hecho pendiente de entregar.
 *
 * Se escribe **en la misma transacción** que la transición de negocio que lo
 * produce (exportación completada, ejecución completada, plantilla guardada,
 * cotejo). Por eso no hay ningún camino en el que la operación quede hecha y el
 * hecho no exista: o se guardan los dos o no se guarda ninguno.
 */
export interface OutboxEventRecord {
  /** Id del documento = `eventId` del hecho: una entrega, un documento. */
  id: string;
  /** Duplicado en la raíz para poder filtrar y barrer por cuenta sin abrir `event`. */
  accountId: string;
  eventName: LabelServerEvent['eventName'];
  operationId: string;
  event: LabelServerEvent;
  status: OutboxStatus;
  attempts: number;
  /** Dead facts have no automatic TTL; explicit admin requeue preserves identity. */
  manualRetries?: number;
  previousAttempts?: number;
  lastManualRetryAt?: string;
  lastErrorCode?: EventFailureCode;
  createdAt: string;
  updatedAt: string;
  /**
   * Cuándo vuelve a estar disponible. **Ausente cuando el estado es `dead`**:
   * así la consulta por `availableAt` los deja fuera sola, sin fecha centinela
   * y sin índice compuesto.
   */
  availableAt?: string;
  /** Fencing: solo quien trae este token puede confirmar o fallar la entrega. */
  leaseToken?: string;
  leaseExpiresAt?: string;
}

export interface ClaimedOutboxEvent {
  record: OutboxEventRecord;
  token: string;
}

/**
 * Espera creciente entre intentos, con tope de una hora. El primer reintento
 * llega pronto porque la causa habitual es un fallo transitorio.
 */
export function nextAttemptAt(attempts: number, now: Date): string {
  const minutes = Math.min(2 ** attempts, 60);
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

/**
 * Construye el hecho y su documento de salida en el momento del negocio.
 *
 * `eventId` y `occurredAt` se fijan **aquí**, antes de escribir: si se
 * generaran en la entrega, un reintento produciría otro `eventId` y el registro
 * no podría deduplicar la entrega.
 */
export function buildOutboxRecord(
  input: Omit<LabelServerEvent, 'eventId' | 'schemaVersion' | 'occurredAt'>,
  now: Date = new Date(),
): OutboxEventRecord {
  const event: LabelServerEvent = {
    eventId: randomUUID(),
    schemaVersion: 1,
    occurredAt: now.toISOString(),
    ...input,
  };

  return {
    id: event.eventId,
    accountId: event.accountId,
    eventName: event.eventName,
    operationId: event.operationId,
    event,
    status: 'pending',
    attempts: 0,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    // Disponible de inmediato: la entrega se intenta justo después de la
    // confirmación, y si falla la recoge el drenado.
    availableAt: now.toISOString(),
  };
}

/** Se lanza cuando la cuenta está marcada como borrada. */
export class AccountDeletedError extends Error {
  constructor(readonly accountId: string) {
    super(`Account ${accountId} is marked as deleted`);
  }
}

/**
 * Traduce la lápida a `410 Gone` en cualquier punto del flujo. Se usa en los
 * caminos que no pasan por el traductor de errores del repositorio, para que la
 * baja de cuenta no salga nunca como un 500.
 */
export function asAccountDeletedResponse(
  error: unknown,
  errorCode: string,
): GoneException | null {
  return error instanceof AccountDeletedError
    ? new GoneException({ error: errorCode, message: 'La cuenta ya no existe' })
    : null;
}
