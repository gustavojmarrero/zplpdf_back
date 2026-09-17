import type { LeasedOperation } from '../workflows/operation-lease.js';
import type { OutboxEventRecord } from '../workflows/label-event.outbox.js';
export type TemplateKind = 'product' | 'location' | 'lot';
export type TemplateStatus = 'active' | 'archived';
export type TabularFormat = 'csv' | 'xlsx';
export type TemplateOutputFormat = 'pdf' | 'png' | 'jpeg';

export type TemplateFieldType =
  | 'text'
  | 'code'
  | 'integer'
  | 'decimal'
  | 'date'
  | 'barcode';

export type TemplateFieldCharset = 'digits' | 'alnum' | 'alnum_dash' | 'any';

export type BarcodeSymbology =
  | 'code128'
  | 'code39'
  | 'ean13'
  | 'upca'
  | 'qr'
  | 'datamatrix';

export interface TemplateField {
  key: string;
  label: string;
  /**
   * `code` es un identificador textual: conserva los ceros iniciales y no se
   * convierte a número en ningún punto.
   */
  type: TemplateFieldType;
  required: boolean;
  maxLength?: number;
  /**
   * Conjunto de caracteres admitido, como enumerado cerrado. No se acepta una
   * expresión regular del usuario a propósito: sería una vía directa a un
   * ReDoS sobre un endpoint autenticado.
   */
  charset?: TemplateFieldCharset;
  barcodeSymbology?: BarcodeSymbology;
}

export interface ColumnMapping {
  /** clave de campo -> nombre de columna del archivo. */
  fields: Record<string, string>;
  /** Columna con las copias. Si falta, una copia por fila. */
  quantityColumn?: string;
}

export interface LabelTemplateRecord {
  id: string;
  accountId: string;
  ownerId: string;
  kind: TemplateKind;
  name: string;
  status: TemplateStatus;
  currentVersion: number;
  /** CAS de la metadata. Las versiones son inmutables y no llevan CAS. */
  version: number;
  savedMapping?: ColumnMapping;
  createdAt: string;
  updatedAt: string;
}

/** Inmutable: se crea y no se modifica nunca. */
export interface TemplateVersionRecord {
  id: string;
  templateId: string;
  accountId: string;
  ownerId: string;
  versionNumber: number;
  labelSize: string;
  fields: TemplateField[];
  zplTemplate: string;
  checksum: string;
  createdAt: string;
}

export type TemplateRunStatus = 'pending' | 'validated' | 'accepted' | 'failed';

export interface RowDiagnostic {
  /** 1 = primera fila de datos. La cabecera es la línea 1 del archivo. */
  rowNumber: number;
  column?: string;
  field?: string;
  code: string;
  message: string;
}

export interface TemplateRunRecord extends LeasedOperation {
  runId: string;
  accountId: string;
  ownerId: string;
  templateId: string;
  templateVersion: number;
  status: TemplateRunStatus;
  format: TabularFormat;
  labelSize: string;
  outputFormat: TemplateOutputFormat;
  idempotencyKey: string;
  intentHash: string;
  rowCount: number;
  validRowCount: number;
  emptyRowCount: number;
  invalidRowCount: number;
  labelCount: number;
  diagnostics: RowDiagnostic[];
  sourceChecksum: string;
  /** Private replay context; raw tabular input is never persisted here. */
  requestHash?: string;
  resolvedMapping?: ColumnMapping;
  originalFilename?: string;
  jobId?: string;
  errorCode?: string;
  leaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type ReserveRunResult =
  | { outcome: 'reserved'; record: TemplateRunRecord }
  | { outcome: 'existing'; record: TemplateRunRecord }
  | { outcome: 'in_progress'; record: TemplateRunRecord }
  | { outcome: 'key_reused'; record: TemplateRunRecord };

/** Hecho canónico que se escribe en la misma transacción que la transición. */
export type BusinessOutboxEvent = OutboxEventRecord | undefined;

export interface TemplateRepositoryPort {
  assertAccountActive(accountId: string): Promise<void>;
  createTemplate(
    template: LabelTemplateRecord,
    version: TemplateVersionRecord,
    outbox?: BusinessOutboxEvent,
  ): Promise<LabelTemplateRecord>;

  getTemplate(
    accountId: string,
    templateId: string,
  ): Promise<LabelTemplateRecord | null>;

  listTemplates(accountId: string): Promise<LabelTemplateRecord[]>;

  countTemplates(accountId: string): Promise<number>;

  /** Mutación de metadata con compare-and-set sobre `version`. */
  updateTemplate(
    accountId: string,
    templateId: string,
    expectedVersion: number,
    mutate: (current: LabelTemplateRecord) => Partial<LabelTemplateRecord>,
  ): Promise<LabelTemplateRecord>;

  /**
   * Añade una versión nueva. La versión anterior no se toca: una ejecución
   * pasada tiene que seguir siendo explicable con el ZPL exacto que usó.
   */
  addVersion(
    accountId: string,
    templateId: string,
    expectedVersion: number,
    build: (currentVersionNumber: number) => TemplateVersionRecord,
    outbox?: BusinessOutboxEvent,
  ): Promise<{
    template: LabelTemplateRecord;
    version: TemplateVersionRecord;
  }>;

  getVersion(
    accountId: string,
    templateId: string,
    versionNumber: number,
  ): Promise<TemplateVersionRecord | null>;

  listVersions(
    accountId: string,
    templateId: string,
  ): Promise<TemplateVersionRecord[]>;

  reserveRun(
    candidate: TemplateRunRecord,
    now: Date,
  ): Promise<ReserveRunResult>;

  renewRun(runId: string, token: string): Promise<void>;

  completeRun(
    runId: string,
    token: string,
    patch: { jobId: string },
    outbox?: BusinessOutboxEvent,
  ): Promise<TemplateRunRecord>;

  failRun(
    runId: string,
    token: string,
    errorCode: string,
  ): Promise<TemplateRunRecord>;

  getRun(accountId: string, runId: string): Promise<TemplateRunRecord | null>;

  listRuns(
    accountId: string,
    templateId?: string,
  ): Promise<TemplateRunRecord[]>;
}

export const TEMPLATE_REPOSITORY = Symbol('TEMPLATE_REPOSITORY');

export class TemplateVersionConflictError extends Error {
  constructor(
    readonly expectedVersion: number,
    readonly currentVersion: number,
  ) {
    super(
      `Version conflict: expected ${expectedVersion}, current ${currentVersion}`,
    );
  }
}

export class TemplateMissingError extends Error {
  constructor(readonly templateId: string) {
    super(`Template ${templateId} not found`);
  }
}
