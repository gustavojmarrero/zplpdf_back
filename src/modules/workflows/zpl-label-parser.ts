import { createHash } from 'node:crypto';
import { WORKFLOW_LIMITS } from './workflows.constants.js';

export interface ParsedLabel {
  /** Posición original 1..N. Inmutable: reordenar no la cambia. */
  sequence: number;
  /** Contenido normalizado, SIN `^PQ`. Es exactamente lo que consume el conversor. */
  zpl: string;
  /** Copias declaradas por `^PQ`, preservadas tal cual. */
  copies: number;
  contentHash: string;
  /** Mismo contenido ⇒ mismo grupo. Permite seleccionar el grupo de copias completo. */
  groupId: string;
  byteSize: number;
  /** Valores `^FD`/`^FV` legibles, con clave `fdN`. No se inventan campos. */
  fields: Record<string, string>;
  /**
   * La etiqueta usa serialización (`^SN` o `^SF`): la impresora genera un valor
   * distinto por copia. Cambiarle el número de copias cambiaría la secuencia
   * impresa, así que el override de copias se rechaza sobre estas etiquetas.
   */
  serialized: boolean;
}

/**
 * Normaliza un bloque igual que `ZplService.normalizeZplBlock`.
 *
 * Esta paridad es obligatoria, no estética: el lote guarda el contenido que el
 * conversor va a recibir, y su `contentHash` es la misma clave con la que el
 * conversor deduplica. Si la normalización del conversor cambia, el orden y el
 * recuento del PDF podrían dejar de coincidir con el lote.
 */
function normalizeBlock(block: string): string {
  let normalized = block
    .replace(/[\r\n]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized.startsWith('^XA')) {
    normalized = '^XA' + normalized;
  }
  if (!normalized.endsWith('^XZ')) {
    normalized = normalized + '^XZ';
  }

  return normalized;
}

/**
 * Igual que `ZplService.blockProducesOutput`: un bloque de pura configuración no
 * genera página. Descartarlo aquí también es lo que mantiene alineados los
 * índices del lote con las páginas del PDF.
 */
function blockProducesOutput(block: string): boolean {
  return /\^(FD|FV|SN|GB|GC|GD|GE|GF|GS|XG|IM|B(?!Y)[0-9A-Z])/i.test(block);
}

function extractFields(normalizedBlock: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const matches = normalizedBlock.matchAll(/\^F(?:D|V)([^\^]*)/gi);
  let index = 0;

  for (const match of matches) {
    const value = (match[1] ?? '').trim();
    if (!value) continue;
    if (index >= WORKFLOW_LIMITS.maxFieldsPerLabel) break;
    index += 1;
    fields[`fd${index}`] = value.slice(0, WORKFLOW_LIMITS.maxFieldValueLength);
  }

  return fields;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Identidad estable de una etiqueta dentro de su lote.
 *
 * Se deriva del lote, de la posición original y del contenido: reordenar,
 * seleccionar, cotejar o reexportar no la cambian nunca. Dos bloques idénticos
 * en posiciones distintas siguen siendo dos etiquetas distintas (una repetición
 * legítima no se borra), y comparten `groupId`.
 */
export function buildLabelId(
  workflowId: string,
  sequence: number,
  contentHash: string,
): string {
  return `lbl_${sha256Hex(`${workflowId}:${sequence}:${contentHash}`).slice(0, 24)}`;
}

/**
 * Divide el ZPL en etiquetas preservando el orden y las copias `^PQ`.
 *
 * A diferencia de `ZplService.extractUniqueLabels`, aquí NO se deduplica: el
 * lote es la lista real de etiquetas que el operador va a empacar.
 */
export function parseZplLabels(zplContent: string): ParsedLabel[] {
  const blocks = zplContent.match(/\^XA.*?\^XZ/gs) || [];
  const labels: ParsedLabel[] = [];

  for (const rawBlock of blocks) {
    const normalized = normalizeBlock(rawBlock);
    if (!blockProducesOutput(normalized)) continue;

    const pqMatch = normalized.match(/\^PQ(\d+)/i);
    const copies = pqMatch && pqMatch[1] ? parseInt(pqMatch[1], 10) || 1 : 1;
    const zpl = normalized.replace(/\^PQ[^\^]+/i, '').trim();
    const contentHash = sha256Hex(zpl);

    labels.push({
      sequence: labels.length + 1,
      zpl,
      copies,
      contentHash,
      groupId: `grp_${contentHash.slice(0, 16)}`,
      byteSize: Buffer.byteLength(zpl, 'utf8'),
      fields: extractFields(zpl),
      serialized: /\^S[NF]/i.test(zpl),
    });
  }

  return labels;
}

/**
 * Reconstruye el ZPL de una selección ya ordenada, devolviendo `^PQ` al bloque
 * cuando tiene copias. El conversor lo vuelve a leer con las mismas reglas, así
 * que las copias sobreviven el viaje de ida y vuelta.
 */
export function buildExportZpl(
  labels: { zpl: string; copies: number }[],
): string {
  return labels
    .map(({ zpl, copies }) =>
      copies > 1 ? zpl.replace(/\^XZ$/, `^PQ${copies}^XZ`) : zpl,
    )
    .join('\n');
}
