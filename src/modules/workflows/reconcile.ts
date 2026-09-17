import { randomUUID } from 'node:crypto';
import {
  inferDelimiter,
  isEmptyRecord,
  parseDelimitedText,
} from '../label-templates/tabular/csv.js';
import type { CsvDelimiter } from '../label-templates/tabular/csv.js';
import { WORKFLOW_LIMITS } from './workflows.constants.js';
import type {
  ReconcileFormat,
  ReconcileLabelOutcome,
  WorkflowLabelRecord,
  WorkflowReconcileState,
} from './workflows.types.js';

/**
 * Los dos únicos formatos aceptados, declarados por el cliente. No se adivina
 * el formato: un archivo cuya cabecera no coincida se rechaza en vez de
 * interpretarse a la ligera.
 */
export const RECONCILE_FORMATS: Record<
  ReconcileFormat,
  { orderColumn: string; trackingColumn: string }
> = {
  pedido_id_guia_v1: { orderColumn: 'pedido_id', trackingColumn: 'guia' },
  order_id_tracking_v1: { orderColumn: 'order_id', trackingColumn: 'tracking' },
};

export interface ReconcileRowDiagnostic {
  rowNumber: number;
  column?: string;
  code: string;
  message: string;
}

export class ReconcileInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface ReconcileInput {
  format: ReconcileFormat;
  csvContent: string;
  delimiter?: CsvDelimiter;
  labels: WorkflowLabelRecord[];
}

/** Clave de comparación: recorte de espacios y sin distinguir mayúsculas. */
function matchKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}

interface ParsedRow {
  rowNumber: number;
  orderId: string;
  tracking?: string;
  labelIds: string[];
}

export function reconcileWorkflow(input: ReconcileInput): {
  state: WorkflowReconcileState;
  ignoredColumns: string[];
} {
  const { format, csvContent } = input;
  const spec = RECONCILE_FORMATS[format];

  if (
    Buffer.byteLength(csvContent, 'utf8') > WORKFLOW_LIMITS.maxReconcileBytes
  ) {
    throw new ReconcileInputError(
      'RECONCILE_TOO_LARGE',
      'El archivo de cotejo supera el tamaño admitido',
      { maxBytes: WORKFLOW_LIMITS.maxReconcileBytes },
    );
  }

  const delimiter = input.delimiter ?? inferDelimiter(csvContent);
  if (!delimiter) {
    throw new ReconcileInputError(
      'RECONCILE_AMBIGUOUS_DELIMITER',
      'No se puede determinar el separador; indícalo explícitamente',
      { candidates: [',', ';', '\\t'] },
    );
  }

  const { records } = parseDelimitedText(csvContent, delimiter);
  if (records.length === 0) {
    throw new ReconcileInputError(
      'RECONCILE_EMPTY',
      'El archivo de cotejo no tiene contenido',
    );
  }

  const header = records[0].values.map((value) => value.trim().toLowerCase());
  if (header[0] !== spec.orderColumn || header[1] !== spec.trackingColumn) {
    throw new ReconcileInputError(
      'RECONCILE_HEADER_MISMATCH',
      'La cabecera no corresponde al formato declarado',
      {
        expected: [spec.orderColumn, spec.trackingColumn],
        found: header.slice(0, 4),
        format,
      },
    );
  }

  const ignoredColumns = records[0].values
    .slice(2)
    .map((value) => value.trim());
  const dataRecords = records.slice(1);

  if (dataRecords.length > WORKFLOW_LIMITS.maxReconcileRows) {
    throw new ReconcileInputError(
      'RECONCILE_TOO_LARGE',
      'El archivo de cotejo tiene demasiadas filas',
      { maxRows: WORKFLOW_LIMITS.maxReconcileRows, rows: dataRecords.length },
    );
  }

  const diagnostics: ReconcileRowDiagnostic[] = [];
  const rows: ParsedRow[] = [];
  const seenOrderIds = new Map<string, number>();

  dataRecords.forEach((record, position) => {
    const rowNumber = position + 1;

    // Una fila en blanco no es un error: se informa y no participa del cotejo.
    if (isEmptyRecord(record)) {
      diagnostics.push({
        rowNumber,
        code: 'ROW_EMPTY',
        message: 'Fila vacía: no se cotejó',
      });
      return;
    }

    const orderId = (record.values[0] ?? '').trim();
    const tracking = (record.values[1] ?? '').trim();

    if (!orderId) {
      diagnostics.push({
        rowNumber,
        column: spec.orderColumn,
        code: 'ROW_REQUIRED_MISSING',
        message: `La columna ${spec.orderColumn} es obligatoria`,
      });
      return;
    }

    const key = matchKey(orderId);
    const previous = seenOrderIds.get(key);
    if (previous !== undefined) {
      diagnostics.push({
        rowNumber,
        column: spec.orderColumn,
        code: 'ROW_DUPLICATE_KEY',
        message: `El pedido ya aparece en la fila ${previous}`,
      });
      return;
    }

    seenOrderIds.set(key, rowNumber);
    rows.push({
      rowNumber,
      orderId,
      tracking: tracking || undefined,
      labelIds: [],
    });
  });

  const blocking = diagnostics.filter((item) => item.code !== 'ROW_EMPTY');
  if (blocking.length > 0) {
    throw new ReconcileInputError(
      'RECONCILE_ROW_ERRORS',
      'El archivo de cotejo tiene filas que no se pueden interpretar',
      { rows: diagnostics },
    );
  }

  if (rows.length === 0) {
    throw new ReconcileInputError(
      'RECONCILE_EMPTY',
      'El archivo de cotejo no tiene filas con datos',
    );
  }

  // Índice de búsqueda: el pedido y la guía apuntan a la misma fila.
  const rowByKey = new Map<string, ParsedRow>();
  for (const row of rows) {
    rowByKey.set(matchKey(row.orderId), row);
    if (row.tracking) {
      const trackingKey = matchKey(row.tracking);
      if (!rowByKey.has(trackingKey)) rowByKey.set(trackingKey, row);
    }
  }

  const byLabel: Record<string, ReconcileLabelOutcome> = {};
  const counts = {
    matched: 0,
    duplicate: 0,
    unidentified: 0,
    extra: 0,
    missing: 0,
  };

  // Se recorre por posición original (`sequence`), no por el orden actual: así
  // reordenar el lote no cambia quién quedó como `matched` y quién como
  // `duplicate`.
  const labels = [...input.labels].sort((a, b) => a.sequence - b.sequence);

  for (const label of labels) {
    const candidates = Object.values(label.fields ?? {})
      .map(matchKey)
      .filter((value) => value.length > 0);

    if (candidates.length === 0) {
      byLabel[label.labelId] = { status: 'unidentified' };
      counts.unidentified += 1;
      continue;
    }

    const hit = candidates
      .map((candidate) => rowByKey.get(candidate))
      .find((row) => row !== undefined);

    if (!hit) {
      // Tiene valores legibles pero ninguno está en el archivo: sobrante.
      byLabel[label.labelId] = { status: 'extra' };
      counts.extra += 1;
      continue;
    }

    const isFirst = hit.labelIds.length === 0;
    hit.labelIds.push(label.labelId);

    // Las copias `^PQ` de una etiqueta NO son una repetición: una etiqueta con
    // copies: 3 sigue siendo un solo `matched`.
    byLabel[label.labelId] = {
      status: isFirst ? 'matched' : 'duplicate',
      orderId: hit.orderId,
      tracking: hit.tracking,
    };
    if (isFirst) counts.matched += 1;
    else counts.duplicate += 1;
  }

  const missingRows = rows
    .filter((row) => row.labelIds.length === 0)
    .map((row) => ({
      rowNumber: row.rowNumber,
      orderId: row.orderId,
      tracking: row.tracking,
    }));
  counts.missing = missingRows.length;

  const duplicateRows = rows
    .filter((row) => row.labelIds.length > 1)
    .map((row) => ({
      rowNumber: row.rowNumber,
      orderId: row.orderId,
      labelIds: row.labelIds,
    }));

  return {
    state: {
      // UUIDv4: es el operationId del hecho `packing_reconcile_completed`.
      reconcileId: randomUUID(),
      format,
      completedAt: new Date().toISOString(),
      rowCount: rows.length,
      counts,
      missingRows,
      duplicateRows,
      byLabel,
    },
    ignoredColumns,
  };
}
