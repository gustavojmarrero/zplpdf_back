/**
 * Puerto de lectura de libros de cálculo.
 *
 * Existe para que el módulo no dependa de una librería concreta y, sobre todo,
 * para que un despliegue sin lector **rechace** la entrada en vez de fabricar
 * una salida: sin adaptador registrado, `POST /template-runs` con `format:
 * 'xlsx'` devuelve 422 FEATURE_UNSUPPORTED.
 */
export type TabularCellKind =
  | 'empty'
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'formula'
  | 'error';

export interface TabularCell {
  /** Representación textual. Para una celda de fórmula NO se usa. */
  text: string;
  kind: TabularCellKind;
  /** Presente solo en celdas numéricas. */
  numeric?: number;
  /** Presente solo en celdas de fecha, en ISO UTC. */
  iso?: string;
}

export interface TabularRow {
  /** Número de fila real de la hoja (1 = cabecera). */
  sheetRow: number;
  cells: TabularCell[];
}

export interface TabularSheet {
  name: string;
  rows: TabularRow[];
  /** Filas que la hoja se salta por estar vacías. */
  skippedEmptySheetRows: number[];
  /** Nombres de todas las hojas del libro, en orden, para poder elegir. */
  availableSheets: string[];
}

export interface WorkbookReadOptions {
  sheet?: string | number;
  maxRows: number;
  maxColumns: number;
  maxCellBytes: number;
  maxSheets: number;
}

export interface WorkbookReaderPort {
  read(buffer: Buffer, options: WorkbookReadOptions): Promise<TabularSheet>;
}

export const XLSX_WORKBOOK_READER = Symbol('XLSX_WORKBOOK_READER');

/** Motivos por los que un libro se rechaza antes de leer una sola fila. */
export type WorkbookErrorCode =
  | 'XLSX_MACROS_NOT_ALLOWED'
  | 'XLSX_SHEET_NOT_FOUND'
  | 'DATA_INVALID'
  | 'DATA_TOO_LARGE';

export class WorkbookReadError extends Error {
  constructor(
    readonly code: WorkbookErrorCode,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
}
