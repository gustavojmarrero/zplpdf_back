export const DATA_TEMPLATES_FEATURE_ID = 'data_templates' as const;
export const DATA_TEMPLATES_FEATURE_VERSION = '1';

export const TEMPLATES_COLLECTION = 'label_templates';
export const TEMPLATE_VERSIONS_COLLECTION = 'label_template_versions';
export const TEMPLATE_RUNS_COLLECTION = 'label_template_runs';

export const TEMPLATE_LIMITS = {
  maxTemplatesPerAccount: 100,
  maxVersionsPerTemplate: 200,
  /** Tamaño del ZPL de la plantilla. */
  maxZplBytes: 16 * 1024,
  maxFields: 32,
  maxNameLength: 120,
  /** Archivo de datos (CSV o XLSX ya decodificado). */
  maxDataBytes: 5 * 1024 * 1024,
  maxDataRows: 5000,
  maxDataColumns: 64,
  maxCellBytes: 4 * 1024,
  /** Hojas que se admite recorrer antes de rendirse. */
  maxSheets: 20,
  maxCopiesPerRow: 999,
  maxLabelsPerRun: 1000,
  maxPreviewRows: 5,
  defaultPreviewRows: 3,
  maxDiagnostics: 200,
} as const;

/**
 * Ventana en la que una ejecución reservada se considera en vuelo. Igual que en
 * BE04: si la reserva ya anotó su jobId, se reutiliza en vez de convertir otra
 * vez.
 */
export const RUN_LEASE_MS = 12 * 60 * 1000;
