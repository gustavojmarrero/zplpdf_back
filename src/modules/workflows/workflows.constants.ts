/** Versión del contrato de la funcionalidad; viaja en los eventos canónicos. */
export const PACKING_FEATURE_VERSION = '1';
export const PACKING_FEATURE_ID = 'packing_workflow' as const;

/** Colecciones de Firestore. Nombres nuevos: no reutilizan ninguna existente. */
export const WORKFLOWS_COLLECTION = 'label_workflows';
export const WORKFLOW_LABELS_SUBCOLLECTION = 'labels';
export const WORKFLOW_EXPORTS_COLLECTION = 'label_workflow_exports';

/**
 * Topes absolutos del servidor. El tope por plan
 * (`DEFAULT_PLAN_LIMITS[plan].maxLabelsPerPdf`) se aplica además de estos, y el
 * conversor lo vuelve a comprobar al aceptar la exportación.
 */
export const WORKFLOW_LIMITS = {
  /** Bloques ^XA..^XZ distintos en un lote. */
  maxLabelsPerWorkflow: 1000,
  /** Copias declaradas por ^PQ en una sola etiqueta. */
  maxCopiesPerLabel: 999,
  /** Tamaño del ZPL de origen. Alineado con MAX_RECONVERTIBLE_ZPL_SIZE_BYTES. */
  maxSourceBytes: 4 * 1024 * 1024,
  /** Lotes no archivados por cuenta. */
  maxActiveWorkflowsPerAccount: 50,
  maxExportsPerWorkflow: 100,
  maxReconcileBytes: 2 * 1024 * 1024,
  maxReconcileRows: 5000,
  maxNameLength: 120,
  /** Valores ^FD que se guardan por etiqueta (para cotejo y para mostrar). */
  maxFieldsPerLabel: 24,
  maxFieldValueLength: 200,
  defaultPageSize: 25,
  maxPageSize: 100,
} as const;

/**
 * Retención del ZPL de origen: 15 días, igual que la del original declarada por
 * el historial. Las plantillas (BE05) no caducan.
 */
export const WORKFLOW_SOURCE_RETENTION_MS = 15 * 24 * 60 * 60 * 1000;

/**
 * Ventana en la que una exportación reservada se considera en vuelo. Pasada la
 * ventana otra petición con la misma intención puede retomarla; si la reserva ya
 * tiene `jobId`, se reutiliza ese trabajo en vez de crear otro (no se vuelve a
 * consumir cuota).
 */
export const EXPORT_LEASE_MS = 12 * 60 * 1000;
