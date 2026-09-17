/**
 * Lector de texto delimitado (RFC 4180 con tolerancias): comillas dobles,
 * `""` como comilla escapada, saltos CRLF/LF/CR y BOM inicial.
 *
 * Todos los valores salen como **texto tal cual**. Aquí no se convierte nada a
 * número, no se recortan ceros iniciales ni se normalizan acentos: un `007`
 * sigue siendo `007` y un `Ñoño` sigue siendo `Ñoño`. Las conversiones ocurren
 * después, campo a campo y con el tipo declarado por la plantilla.
 *
 * Lo usan BE05 (datos de plantilla) y el cotejo de BE04.
 */
export type CsvDelimiter = ',' | ';' | '\t';

export const CSV_DELIMITERS: CsvDelimiter[] = [',', ';', '\t'];

export interface CsvRecord {
  /** Índice 1..N sobre los registros del archivo, cabecera incluida. */
  index: number;
  /** Primera línea física del registro (un campo entrecomillado puede ocupar varias). */
  line: number;
  values: string[];
}

export interface CsvParseResult {
  records: CsvRecord[];
  delimiter: CsvDelimiter;
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function splitRecords(text: string, delimiter: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let values: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let hasContent = false;

  const pushField = () => {
    values.push(field);
    field = '';
  };

  const pushRecord = () => {
    pushField();
    records.push({ index: records.length + 1, line: recordLine, values });
    values = [];
    hasContent = false;
    recordLine = line;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === '\n') line += 1;
        field += char;
      }
      continue;
    }

    if (char === '"' && field === '') {
      inQuotes = true;
      hasContent = true;
      continue;
    }

    if (char === delimiter) {
      pushField();
      hasContent = true;
      continue;
    }

    if (char === '\r') {
      // CRLF y CR suelto cierran registro igual.
      if (text[i + 1] === '\n') i += 1;
      line += 1;
      pushRecord();
      continue;
    }

    if (char === '\n') {
      line += 1;
      pushRecord();
      continue;
    }

    field += char;
    hasContent = true;
  }

  // Último registro sin salto de línea final.
  if (field !== '' || values.length > 0 || hasContent) {
    pushRecord();
  }

  return records;
}

/**
 * Infiere el delimitador **solo** cuando es inequívoco: exactamente un
 * candidato parte la cabecera en más de una columna. En cualquier otro caso
 * devuelve null y quien llama debe rechazar la entrada pidiendo el delimitador
 * explícito; adivinar aquí es lo que descoloca un archivo con `;` y decimales
 * con coma.
 */
export function inferDelimiter(text: string): CsvDelimiter | null {
  const firstLine = stripBom(text).split(/\r\n|\r|\n/)[0] ?? '';
  const candidates = CSV_DELIMITERS.filter(
    (delimiter) => splitRecords(firstLine, delimiter)[0]?.values.length > 1,
  );
  return candidates.length === 1 ? candidates[0] : null;
}

export function parseDelimitedText(
  text: string,
  delimiter: CsvDelimiter,
): CsvParseResult {
  return { records: splitRecords(stripBom(text), delimiter), delimiter };
}

/** Un registro cuenta como vacío cuando todos sus campos están en blanco. */
export function isEmptyRecord(record: CsvRecord): boolean {
  return record.values.every((value) => value.trim() === '');
}
