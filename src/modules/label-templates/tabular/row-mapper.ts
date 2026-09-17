import { RowErrorCodes } from '../template-error-codes.js';
import { TEMPLATE_LIMITS } from '../label-templates.constants.js';
import type {
  ColumnMapping,
  RowDiagnostic,
  TemplateField,
} from '../label-templates.types.js';
import type { TabularCell } from './workbook-reader.port.js';

export interface MappedRow {
  /** 1 = primera fila de datos. */
  rowNumber: number;
  values: Record<string, string>;
  copies: number;
}

export interface MapRowsResult {
  rows: MappedRow[];
  diagnostics: RowDiagnostic[];
  emptyRowCount: number;
  invalidRowCount: number;
  mapping: ColumnMapping;
}

export class MappingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const CHARSETS: Record<string, RegExp> = {
  digits: /^[0-9]*$/,
  alnum: /^[A-Za-z0-9]*$/,
  alnum_dash: /^[A-Za-z0-9._-]*$/,
  any: /^[\s\S]*$/,
};

/** Simbolos admitidos por simbologia, para no imprimir un codigo ilegible. */
const BARCODE_RULES: Record<
  string,
  { pattern: RegExp; length?: (value: string) => boolean; hint: string }
> = {
  code128: { pattern: /^[ -~]+$/, hint: 'ASCII imprimible' },
  code39: {
    pattern: /^[0-9A-Z\-. $/+%]+$/,
    hint: '0-9 A-Z y - . espacio $ / + %',
  },
  ean13: {
    pattern: /^[0-9]+$/,
    length: (value) => value.length === 12 || value.length === 13,
    hint: '12 o 13 dígitos',
  },
  upca: {
    pattern: /^[0-9]+$/,
    length: (value) => value.length === 11 || value.length === 12,
    hint: '11 o 12 dígitos',
  },
  qr: { pattern: /^[\s\S]+$/, hint: 'cualquier texto' },
  datamatrix: { pattern: /^[\s\S]+$/, hint: 'cualquier texto' },
};

/** Caracteres de control: todo ASCII < 0x20 salvo tabulador, mas DEL. */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u0008\\u000B-\\u001F\\u007F]');

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Resuelve el mapeo columna -> campo. Si el cliente no envía uno, se intenta por
 * coincidencia exacta con la clave o con la etiqueta del campo; nunca por
 * parecido, que es la vía rápida a imprimir la columna equivocada.
 */
export function resolveMapping(
  fields: TemplateField[],
  header: string[],
  provided?: ColumnMapping,
): ColumnMapping {
  if (provided?.fields && Object.keys(provided.fields).length > 0) {
    return provided;
  }

  const byName = new Map(header.map((name) => [normalizeHeader(name), name]));
  const resolved: Record<string, string> = {};

  for (const field of fields) {
    const match =
      byName.get(normalizeHeader(field.key)) ??
      byName.get(normalizeHeader(field.label));
    if (match) resolved[field.key] = match;
  }

  const quantityColumn =
    byName.get('quantity') ?? byName.get('cantidad') ?? undefined;

  return { fields: resolved, quantityColumn };
}

function columnIndexes(
  fields: TemplateField[],
  mapping: ColumnMapping,
  header: string[],
): { indexes: Map<string, number>; quantityIndex?: number } {
  const byName = new Map(
    header.map((name, index) => [normalizeHeader(name), index]),
  );
  const indexes = new Map<string, number>();
  const missing: string[] = [];

  for (const field of fields) {
    const column = mapping.fields?.[field.key];
    if (!column) {
      // Un campo opcional puede quedar sin columna: se renderiza vacío.
      if (field.required) missing.push(field.key);
      continue;
    }
    const index = byName.get(normalizeHeader(column));
    if (index === undefined) {
      missing.push(field.key);
      continue;
    }
    indexes.set(field.key, index);
  }

  let quantityIndex: number | undefined;
  if (mapping.quantityColumn) {
    quantityIndex = byName.get(normalizeHeader(mapping.quantityColumn));
    if (quantityIndex === undefined) {
      throw new MappingError(
        'COLUMN_MISSING',
        'La columna de cantidad no existe en el archivo',
        { column: mapping.quantityColumn, header },
      );
    }
  }

  if (missing.length > 0) {
    throw new MappingError(
      'COLUMN_MISSING',
      'Faltan columnas para campos obligatorios de la plantilla',
      { fields: missing, header },
    );
  }

  return { indexes, quantityIndex };
}

interface CellOutcome {
  value?: string;
  diagnostic?: Omit<RowDiagnostic, 'rowNumber'>;
}

function validateCell(
  field: TemplateField,
  cell: TabularCell | undefined,
  column: string,
  decimalSeparator: '.' | ',',
): CellOutcome {
  const raw = cell ?? { text: '', kind: 'empty' as const };

  if (raw.kind === 'formula') {
    return {
      diagnostic: {
        column,
        field: field.key,
        code: RowErrorCodes.ROW_FORMULA_NOT_ALLOWED,
        message:
          'La celda contiene una fórmula. No se evalúa: pega el valor como texto o número.',
      },
    };
  }

  if (raw.kind === 'error') {
    return {
      diagnostic: {
        column,
        field: field.key,
        code: RowErrorCodes.ROW_CELL_ERROR,
        message: 'La celda tiene un error de la hoja de cálculo',
      },
    };
  }

  const text = raw.kind === 'empty' ? '' : raw.text;

  if (text.trim() === '') {
    if (field.required) {
      return {
        diagnostic: {
          column,
          field: field.key,
          code: RowErrorCodes.ROW_REQUIRED_MISSING,
          message: `El campo ${field.label} es obligatorio`,
        },
      };
    }
    return { value: '' };
  }

  if (CONTROL_CHARS.test(text)) {
    // No se limpian por lo bajo: un carácter de control en el dato significa
    // que la columna no es la que se cree.
    return {
      diagnostic: {
        column,
        field: field.key,
        code: RowErrorCodes.ROW_CONTROL_CHAR,
        message: 'La celda tiene caracteres de control',
      },
    };
  }

  // Una celda NUMÉRICA para un identificador es ambigua: si el original tenía
  // ceros a la izquierda, ya se perdieron al guardarse como número y no hay
  // forma de recuperarlos. Se rechaza en vez de imprimir otro código.
  if (
    (field.type === 'code' || field.type === 'barcode') &&
    raw.kind === 'number'
  ) {
    return {
      diagnostic: {
        column,
        field: field.key,
        code: RowErrorCodes.ROW_AMBIGUOUS_LEADING_ZERO,
        message: `La columna ${column} llega como número; formatéala como texto para conservar los ceros iniciales`,
      },
    };
  }

  const value = field.type === 'text' ? text : text.trim();

  if (field.maxLength !== undefined && value.length > field.maxLength) {
    return {
      diagnostic: {
        column,
        field: field.key,
        code: RowErrorCodes.ROW_TOO_LONG,
        message: `${field.label} admite ${field.maxLength} caracteres`,
      },
    };
  }

  if (Buffer.byteLength(value, 'utf8') > TEMPLATE_LIMITS.maxCellBytes) {
    return {
      diagnostic: {
        column,
        field: field.key,
        code: RowErrorCodes.ROW_CELL_TOO_LARGE,
        message: 'La celda es demasiado grande',
      },
    };
  }

  if (field.charset && !CHARSETS[field.charset].test(value)) {
    return {
      diagnostic: {
        column,
        field: field.key,
        code: RowErrorCodes.ROW_CHARSET,
        message: `${field.label} admite solo ${field.charset}`,
      },
    };
  }

  switch (field.type) {
    case 'integer': {
      if (raw.kind === 'number') {
        if (!Number.isInteger(raw.numeric)) {
          return {
            diagnostic: {
              column,
              field: field.key,
              code: RowErrorCodes.ROW_INVALID_INTEGER,
              message: `${field.label} debe ser un entero`,
            },
          };
        }
        return { value: String(raw.numeric) };
      }
      if (!/^[+-]?\d+$/.test(value)) {
        return {
          diagnostic: {
            column,
            field: field.key,
            code: RowErrorCodes.ROW_INVALID_INTEGER,
            message: `${field.label} debe ser un entero`,
          },
        };
      }
      return { value };
    }

    case 'decimal': {
      if (raw.kind === 'number') {
        return { value: String(raw.numeric) };
      }
      const other = decimalSeparator === '.' ? ',' : '.';
      if (value.includes(other)) {
        // "1,234" puede ser mil doscientos treinta y cuatro o uno con coma:
        // no se elige por el usuario.
        return {
          diagnostic: {
            column,
            field: field.key,
            code: RowErrorCodes.ROW_AMBIGUOUS_NUMBER,
            message: `${field.label} usa "${other}", que con el separador decimal "${decimalSeparator}" es ambiguo`,
          },
        };
      }
      const pattern =
        decimalSeparator === '.' ? /^[+-]?\d+(\.\d+)?$/ : /^[+-]?\d+(,\d+)?$/;
      if (!pattern.test(value)) {
        return {
          diagnostic: {
            column,
            field: field.key,
            code: RowErrorCodes.ROW_INVALID_DECIMAL,
            message: `${field.label} debe ser un número con separador decimal "${decimalSeparator}"`,
          },
        };
      }
      return { value: value.replace(',', '.') };
    }

    case 'date': {
      if (raw.kind === 'date' && raw.iso) {
        return { value: raw.iso.slice(0, 10) };
      }
      // "03/04/2026" es 3 de abril o 4 de marzo según el país: se pide ISO.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return {
          diagnostic: {
            column,
            field: field.key,
            code: RowErrorCodes.ROW_INVALID_DATE,
            message: `${field.label} debe venir como AAAA-MM-DD`,
          },
        };
      }
      const parsed = new Date(`${value}T00:00:00.000Z`);
      if (
        Number.isNaN(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== value
      ) {
        return {
          diagnostic: {
            column,
            field: field.key,
            code: RowErrorCodes.ROW_INVALID_DATE,
            message: `${field.label} no es una fecha válida`,
          },
        };
      }
      return { value };
    }

    case 'barcode': {
      const rule = BARCODE_RULES[field.barcodeSymbology ?? 'code128'];
      if (!rule.pattern.test(value) || (rule.length && !rule.length(value))) {
        return {
          diagnostic: {
            column,
            field: field.key,
            code: RowErrorCodes.ROW_CHARSET,
            message: `${field.label} no cumple ${field.barcodeSymbology}: ${rule.hint}`,
          },
        };
      }
      return { value };
    }

    default:
      return { value };
  }
}

function validateQuantity(
  cell: TabularCell | undefined,
  column: string,
): { copies?: number; diagnostic?: Omit<RowDiagnostic, 'rowNumber'> } {
  // El orden importa: una celda de fórmula llega con el texto vacío —su
  // resultado cacheado se descarta—, así que comprobar «vacía» antes la
  // dejaría pasar como una copia.
  if (cell?.kind === 'formula') {
    return {
      diagnostic: {
        column,
        code: RowErrorCodes.ROW_FORMULA_NOT_ALLOWED,
        message: 'La cantidad no puede venir de una fórmula',
      },
    };
  }
  if (cell?.kind === 'error') {
    return {
      diagnostic: {
        column,
        code: RowErrorCodes.ROW_CELL_ERROR,
        message: 'La celda de cantidad tiene un error de la hoja de cálculo',
      },
    };
  }
  if (!cell || cell.kind === 'empty' || cell.text.trim() === '') {
    return { copies: 1 };
  }

  const text = cell.text.trim();
  const numeric =
    cell.kind === 'number'
      ? cell.numeric
      : /^\d+$/.test(text)
        ? Number(text)
        : NaN;

  if (
    !Number.isInteger(numeric) ||
    numeric < 1 ||
    numeric > TEMPLATE_LIMITS.maxCopiesPerRow
  ) {
    return {
      diagnostic: {
        column,
        code: RowErrorCodes.ROW_INVALID_QUANTITY,
        message: `La cantidad debe ser un entero entre 1 y ${TEMPLATE_LIMITS.maxCopiesPerRow}`,
      },
    };
  }

  return { copies: numeric };
}

export function mapRows(input: {
  fields: TemplateField[];
  mapping: ColumnMapping;
  header: string[];
  rows: { rowNumber: number; cells: TabularCell[] }[];
  decimalSeparator: '.' | ',';
  emptyRowNumbers?: number[];
}): MapRowsResult {
  const { indexes, quantityIndex } = columnIndexes(
    input.fields,
    input.mapping,
    input.header,
  );

  const diagnostics: RowDiagnostic[] = [];
  const rows: MappedRow[] = [];
  let emptyRowCount = 0;
  let invalidRowCount = 0;

  const pushDiagnostic = (diagnostic: RowDiagnostic) => {
    if (diagnostics.length < TEMPLATE_LIMITS.maxDiagnostics) {
      diagnostics.push(diagnostic);
    }
  };

  for (const rowNumber of input.emptyRowNumbers ?? []) {
    emptyRowCount += 1;
    pushDiagnostic({
      rowNumber,
      code: RowErrorCodes.ROW_EMPTY,
      message: 'Fila vacía: no genera etiqueta',
    });
  }

  for (const row of input.rows) {
    const isEmpty = row.cells.every(
      (cell) => !cell || cell.kind === 'empty' || cell.text.trim() === '',
    );
    if (isEmpty) {
      // Una fila en blanco no es un error, pero tampoco se calla: se informa
      // para que se vea por qué salen menos etiquetas que filas.
      emptyRowCount += 1;
      pushDiagnostic({
        rowNumber: row.rowNumber,
        code: RowErrorCodes.ROW_EMPTY,
        message: 'Fila vacía: no genera etiqueta',
      });
      continue;
    }

    const values: Record<string, string> = {};
    let rowValid = true;

    for (const field of input.fields) {
      const index = indexes.get(field.key);
      const column = input.mapping.fields?.[field.key] ?? field.key;

      if (index === undefined) {
        values[field.key] = '';
        continue;
      }

      const outcome = validateCell(
        field,
        row.cells[index],
        column,
        input.decimalSeparator,
      );

      if (outcome.diagnostic) {
        rowValid = false;
        pushDiagnostic({ rowNumber: row.rowNumber, ...outcome.diagnostic });
        continue;
      }
      values[field.key] = outcome.value ?? '';
    }

    const quantity =
      quantityIndex === undefined
        ? { copies: 1 }
        : validateQuantity(
            row.cells[quantityIndex],
            input.mapping.quantityColumn as string,
          );

    if (quantity.diagnostic) {
      rowValid = false;
      pushDiagnostic({ rowNumber: row.rowNumber, ...quantity.diagnostic });
    }

    if (!rowValid) {
      invalidRowCount += 1;
      continue;
    }

    rows.push({
      rowNumber: row.rowNumber,
      values,
      copies: quantity.copies ?? 1,
    });
  }

  return {
    rows,
    diagnostics,
    emptyRowCount,
    invalidRowCount,
    mapping: input.mapping,
  };
}
