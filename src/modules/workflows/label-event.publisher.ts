import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { LABEL_EVENT_RECORDER } from './ports/label-event-recorder.port.js';
import type { LabelEventRecorderPort } from './ports/label-event-recorder.port.js';
import { EventFailureCodes, buildOutboxRecord } from './label-event.outbox.js';
import type {
  ClaimedOutboxEvent,
  EventFailureCode,
  OutboxEventRecord,
} from './label-event.outbox.js';
import { LABEL_EVENT_OUTBOX } from './label-event.store.js';
import type { LabelEventOutboxPort } from './label-event.store.js';
import type { LabelServerEvent } from './ports/label-event-recorder.port.js';

export interface DrainResult {
  claimed: number;
  delivered: number;
  pending: number;
  dead: number;
  lost: number;
}

/**
 * Entrega los hechos canónicos de BE04/BE05 que la transacción de negocio ya
 * dejó escritos.
 *
 * El orden importa y es lo que distingue esto de un `try/catch` alrededor del
 * registro: **primero** el hecho se guarda en la misma transacción que la
 * transición de negocio (`prepare` construye el documento, el repositorio lo
 * escribe), y solo **después** se intenta entregarlo. Un fallo o una caída en
 * la entrega no pierde nada, porque el documento ya está confirmado junto con
 * la operación que lo produjo. Si la transacción de negocio no llega a
 * confirmar, tampoco existe el hecho: no hay estado en el que la exportación
 * esté cobrada y su hecho no exista, ni al revés.
 *
 * La entrega usa lease con token: dos consumidores a la vez no entregan dos
 * veces, y un consumidor que perdió su lease no puede borrar el trabajo del
 * que se lo quitó.
 */
@Injectable()
export class LabelEventPublisher {
  private readonly logger = new Logger(LabelEventPublisher.name);

  constructor(
    @Optional()
    @Inject(LABEL_EVENT_RECORDER)
    private readonly recorder?: LabelEventRecorderPort,
    @Optional()
    @Inject(LABEL_EVENT_OUTBOX)
    private readonly outbox?: LabelEventOutboxPort,
  ) {}

  /**
   * Construye el hecho con su `eventId` y su `occurredAt` definitivos. Se llama
   * **antes** de la transacción de negocio, y el documento que devuelve se
   * escribe dentro de ella.
   */
  prepare(
    input: Omit<LabelServerEvent, 'eventId' | 'schemaVersion' | 'occurredAt'>,
    now: Date = new Date(),
  ): OutboxEventRecord {
    return buildOutboxRecord(input, now);
  }

  /**
   * Intento de entrega inmediata, justo después de confirmar el negocio.
   *
   * Nunca lanza: llegados aquí la conversión ya terminó y la cuota ya se
   * consumió, así que un fallo de la analítica no puede convertirse en un error
   * para el cliente. Lo que no se entregue queda en la cola con su reintento.
   */
  async deliverAfterCommit(
    record: OutboxEventRecord,
  ): Promise<{ delivered: boolean }> {
    if (!this.outbox) {
      this.logger.error(
        `Sin cola de salida configurada: ${record.eventName} operationId=${record.operationId} no se puede entregar`,
      );
      return { delivered: false };
    }

    try {
      const claimed = await this.outbox.claimOne(record.id, new Date());
      if (!claimed) return { delivered: false };
      return { delivered: (await this.deliver(claimed)) === 'delivered' };
    } catch (_error: any) {
      // El hecho sigue en la cola: el drenado lo recogerá.
      this.logger.warn(
        `Entrega inmediata fallida de ${record.eventName} eventId=${record.id}; queda en la cola`,
      );
      return { delivered: false };
    }
  }

  /**
   * Drena la cola. Lo llama quien la opere (tarea programada con OIDC o
   * endpoint de administración): este módulo no programa nada por su cuenta.
   */
  async retryPending(limit = 20): Promise<DrainResult> {
    const result: DrainResult = {
      claimed: 0,
      delivered: 0,
      pending: 0,
      dead: 0,
      lost: 0,
    };
    if (!this.outbox) return result;

    const batch = await this.outbox.claimBatch(limit, new Date());
    result.claimed = batch.length;

    for (const claimed of batch) {
      const outcome = await this.deliver(claimed);
      if (outcome === 'delivered') result.delivered += 1;
      else if (outcome === 'dead') result.dead += 1;
      else if (outcome === 'lost') result.lost += 1;
      else result.pending += 1;
    }

    return result;
  }

  private async deliver(
    claimed: ClaimedOutboxEvent,
  ): Promise<'delivered' | 'pending' | 'dead' | 'lost'> {
    const { record, token } = claimed;

    if (!this.recorder) {
      return this.registerFailure(
        record,
        token,
        EventFailureCodes.NO_RECORDER_CONFIGURED,
      );
    }

    try {
      // El registro deduplica por `eventId` y por operación semántica, así que
      // reentregar el mismo documento no duplica el hecho.
      await this.recorder.recordServerEvent(record.event);
    } catch (error: any) {
      const code =
        error?.status === 400
          ? EventFailureCodes.RECORDER_REJECTED
          : EventFailureCodes.RECORDER_UNAVAILABLE;
      // El mensaje original no entra en el documento: puede arrastrar contenido
      // de la etiqueta o detalles internos, y este estado se lee desde paneles.
      return this.registerFailure(record, token, code);
    }

    const acked = await this.outbox.ack(record.id, token);
    if (!acked) {
      // El lease era de otro: no se borra su trabajo. El hecho ya está
      // registrado y la deduplicación del registro cubre la reentrega.
      this.logger.warn(
        `Lease perdido al confirmar ${record.eventName} eventId=${record.id}`,
      );
      return 'lost';
    }

    return 'delivered';
  }

  private async registerFailure(
    record: OutboxEventRecord,
    token: string,
    code: EventFailureCode,
  ): Promise<'pending' | 'dead' | 'lost'> {
    const outcome = await this.outbox.fail(record.id, token, code, new Date());

    if (outcome === 'dead') {
      this.logger.error(
        `Hecho agotado tras los reintentos: ${record.eventName} eventId=${record.id} operationId=${record.operationId} motivo=${code}`,
      );
    } else if (outcome === 'pending') {
      this.logger.warn(
        `Entrega fallida de ${record.eventName} eventId=${record.id} motivo=${code}; se reintentará`,
      );
    }

    return outcome;
  }
}
