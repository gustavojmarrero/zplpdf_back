/**
 * Puerto de eventos canónicos de producto.
 *
 * Es el espejo de `ProductObservabilityService.recordServerEvent` descrito en
 * `docs/growth/observability-contract.md`. No se importa ese módulo a propósito:
 * se integra por separado y un fallo suyo no debe poder tumbar una exportación
 * ya cobrada.
 *
 * `source` es `api` para estos hechos: `web` está reservado a los eventos de
 * exposición que emite el frontend, y el registro canónico rechaza `web` en un
 * hecho de servidor. `eventId` y `operationId` deben ser UUIDv4; `operationId`
 * identifica la operación semántica y por eso es **estable** entre reintentos.
 */
export type LabelServerEventName =
  | 'packing_export_succeeded'
  | 'packing_reexport_succeeded'
  | 'packing_reconcile_completed'
  | 'template_saved'
  | 'template_run_succeeded';

export interface LabelServerEvent {
  eventId: string;
  schemaVersion: 1;
  eventName: LabelServerEventName;
  accountId: string;
  featureId: 'packing_workflow' | 'data_templates';
  featureVersion: string;
  /** Identidad de la operación semántica: deduplica efectos, no entregas. */
  operationId: string;
  occurredAt: string;
  source: 'api' | 'folder' | 'print';
  workflowId?: string;
  jobId?: string;
  durationMs?: number;
  labelCount?: number;
  isSynthetic?: boolean;
}

export interface LabelEventRecorderPort {
  recordServerEvent(
    event: LabelServerEvent,
  ): Promise<{ duplicate: boolean } | void>;
}

export const LABEL_EVENT_RECORDER = Symbol('LABEL_EVENT_RECORDER');
