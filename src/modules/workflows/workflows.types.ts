import type { LeasedOperation } from '../workflows/operation-lease.js';
import type { OutboxEventRecord } from './label-event.outbox.js';
export type WorkflowStatus = 'draft' | 'ready' | 'archived';
export type WorkflowOutputFormat = 'pdf' | 'png' | 'jpeg';
export type ReconcileLabelStatus =
  | 'matched'
  | 'duplicate'
  | 'unidentified'
  | 'extra';
export type ReconcileRowStatus = 'matched' | 'missing' | 'duplicate';
export type ReconcileFormat = 'pedido_id_guia_v1' | 'order_id_tracking_v1';

export interface WorkflowSourceRef {
  kind: 'inline_zpl' | 'history';
  historyId?: string;
  originalFilename?: string;
  sha256: string;
  byteSize: number;
}

export interface WorkflowJobRef {
  exportId: string;
  jobId: string;
  createdAt: string;
  labelCount: number;
  reexportOf?: string;
}

export interface ReconcileLabelOutcome {
  status: ReconcileLabelStatus;
  orderId?: string;
  tracking?: string;
}

export interface ReconcileSummary {
  reconcileId: string;
  format: ReconcileFormat;
  completedAt: string;
  rowCount: number;
  counts: {
    matched: number;
    duplicate: number;
    unidentified: number;
    extra: number;
    missing: number;
  };
  missingRows: { rowNumber: number; orderId: string; tracking?: string }[];
  duplicateRows: { rowNumber: number; orderId: string; labelIds: string[] }[];
}

export interface WorkflowReconcileState extends ReconcileSummary {
  /**
   * Resultado por etiqueta. Vive en el documento padre (y no en cada etiqueta)
   * para que toda mutación del lote siga siendo una sola escritura con CAS.
   */
  byLabel: Record<string, ReconcileLabelOutcome>;
}

/** Contenido de una etiqueta: inmutable desde su creación. */
export interface WorkflowLabelRecord {
  labelId: string;
  workflowId: string;
  accountId: string;
  sequence: number;
  zpl: string;
  copies: number;
  contentHash: string;
  groupId: string;
  byteSize: number;
  fields: Record<string, string>;
  /** Usa `^SN`/`^SF`: no admite override de copias. */
  serialized: boolean;
}

export interface WorkflowRecord {
  id: string;
  accountId: string;
  ownerId: string;
  featureId: 'packing_workflow';
  featureVersion: string;
  status: WorkflowStatus;
  name?: string;
  labelSize: string;
  outputFormat: WorkflowOutputFormat;
  /** CAS. Empieza en 1 y sube en cada mutación aceptada. */
  version: number;
  totalLabels: number;
  totalCopies: number;
  /** Orden actual: permutación completa de los labelIds. */
  orderIds: string[];
  selectedIds: string[];
  /**
   * Copias fijadas a mano, por etiqueta. Vive en el documento padre para que el
   * override siga siendo una sola escritura con CAS y para no perder el valor
   * original declarado por `^PQ`, que sigue en la etiqueta.
   */
  copiesOverrides?: Record<string, number>;
  sourceRefs: WorkflowSourceRef[];
  jobRefs: WorkflowJobRef[];
  reconcile?: WorkflowReconcileState;
  createdAt: string;
  updatedAt: string;
  sourceExpiresAt: string;
}

export type ExportStatus = 'pending' | 'accepted' | 'failed';

/**
 * Reserva + resultado de una exportación. El id del documento es la identidad
 * de la intención, así que crear el documento ES reservar la operación.
 */
export interface ExportRecord extends LeasedOperation {
  exportId: string;
  accountId: string;
  workflowId: string;
  idempotencyKey: string;
  intentHash: string;
  status: ExportStatus;
  workflowVersion: number;
  /** Frozen metadata; label content is immutable in the child collection. */
  workflowSnapshot?: WorkflowRecord;
  outputFormat: WorkflowOutputFormat;
  labelIds: string[];
  labelCount: number;
  uniqueLabelCount: number;
  reexportOf?: string;
  jobId?: string;
  errorCode?: string;
  leaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
  workflowDeleted?: boolean;
}

export interface ListWorkflowsOptions {
  limit: number;
  cursor?: string;
  status?: WorkflowStatus;
}

export interface ListWorkflowsResult {
  items: WorkflowRecord[];
  nextCursor?: string;
}

export type ReserveExportResult =
  | { outcome: 'reserved'; record: ExportRecord }
  | { outcome: 'existing'; record: ExportRecord }
  | { outcome: 'in_progress'; record: ExportRecord }
  | { outcome: 'key_reused'; record: ExportRecord };

/**
 * Persistencia del lote. La implementación de producción es Firestore (misma
 * conexión, mismo proyecto y mismas credenciales que `FirestoreService`); las
 * pruebas usan una implementación en memoria con el mismo contrato de CAS e
 * idempotencia.
 */
/**
 * Hecho canónico que la transición de negocio debe escribir **en su misma
 * transacción**. Opcional solo porque no todas las transiciones producen uno.
 */
export type BusinessOutboxEvent = OutboxEventRecord | undefined;

export interface WorkflowRepositoryPort {
  assertAccountActive(accountId: string): Promise<void>;
  createWorkflow(
    workflow: WorkflowRecord,
    labels: WorkflowLabelRecord[],
  ): Promise<WorkflowRecord>;

  /** Devuelve null si no existe o si no pertenece a la cuenta. */
  getWorkflow(
    accountId: string,
    workflowId: string,
  ): Promise<WorkflowRecord | null>;

  listWorkflows(
    accountId: string,
    options: ListWorkflowsOptions,
  ): Promise<ListWorkflowsResult>;

  countActiveWorkflows(accountId: string): Promise<number>;

  getLabels(
    accountId: string,
    workflowId: string,
  ): Promise<WorkflowLabelRecord[]>;

  /**
   * Mutación con compare-and-set. `mutate` recibe el estado actual y devuelve el
   * parche; la escritura solo ocurre si `version` sigue siendo
   * `expectedVersion`, y la nueva versión es `expectedVersion + 1`.
   */
  updateWorkflow(
    accountId: string,
    workflowId: string,
    expectedVersion: number,
    mutate: (current: WorkflowRecord) => Partial<WorkflowRecord>,
    outbox?: BusinessOutboxEvent,
  ): Promise<WorkflowRecord>;

  /**
   * Añade el trabajo generado por una exportación aceptada. No lleva CAS a
   * propósito: cuando llega aquí el conversor ya admitió el trabajo y ya se
   * consumió cuota, así que un conflicto de versión no puede convertirse en un
   * error para el cliente. Es una escritura de solo-añadir.
   */
  appendJobRef(
    accountId: string,
    workflowId: string,
    jobRef: WorkflowJobRef,
  ): Promise<WorkflowRecord>;

  deleteWorkflow(accountId: string, workflowId: string): Promise<void>;

  reserveExport(
    candidate: ExportRecord,
    now: Date,
  ): Promise<ReserveExportResult>;

  renewExport(exportId: string, token: string): Promise<void>;

  completeExport(
    exportId: string,
    token: string,
    patch: {
      jobId: string;
      labelIds: string[];
      labelCount: number;
      uniqueLabelCount: number;
    },
    outbox?: BusinessOutboxEvent,
  ): Promise<ExportRecord>;

  failExport(
    exportId: string,
    token: string,
    errorCode: string,
  ): Promise<ExportRecord>;

  getExport(accountId: string, exportId: string): Promise<ExportRecord | null>;

  listExports(accountId: string, workflowId: string): Promise<ExportRecord[]>;

  countExports(accountId: string, workflowId: string): Promise<number>;

  markExportsWorkflowDeleted(
    accountId: string,
    workflowId: string,
  ): Promise<void>;
}

export const WORKFLOW_REPOSITORY = Symbol('WORKFLOW_REPOSITORY');

/** Se lanza cuando el CAS falla; el servicio la traduce a 409. */
export class WorkflowVersionConflictError extends Error {
  constructor(
    readonly expectedVersion: number,
    readonly currentVersion: number,
  ) {
    super(
      `Version conflict: expected ${expectedVersion}, current ${currentVersion}`,
    );
  }
}

export class WorkflowMissingError extends Error {
  constructor(readonly workflowId: string) {
    super(`Workflow ${workflowId} not found`);
  }
}
