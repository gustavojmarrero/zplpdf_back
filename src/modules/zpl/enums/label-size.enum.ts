import { Logger } from '@nestjs/common';

const logger = new Logger('LabelSize');

export enum LabelSize {
  TWO_BY_ONE = '2x1',
  TWO_BY_FOUR = '2x4',
  FOUR_BY_TWO = '4x2',
  FOUR_BY_SIX = '4x6',
  // Rollo de catálogo de las impresoras térmicas portátiles Phomemo M110 (y
  // compatibles M120/M150/M200/M220/M221). El id es legible a propósito
  // (issue #101, opción B): es lo que viaja por la API pública y se guarda en
  // conversion_history. La dimensión real que entiende Labelary vive en
  // `LABEL_SIZE_DIMENSIONS`, no aquí.
  FIFTY_BY_EIGHTY_MM = '50x80mm',
}

/**
 * Alias aceptados al pedir una conversión. `small` y `large` vienen de la API
 * antigua y siguen admitiéndose.
 *
 * Exportado (a diferencia del resto de tablas internas) porque `zpl.service.ts`
 * lo reutiliza para el segmento de tamaño del nombre de descarga: antes existía
 * un segundo mapa (`LABEL_SIZE_NORMALIZE_MAP`) con las mismas entradas que este,
 * y mantenerlos en sincronía a mano es exactamente el tipo de duplicación que
 * se olvida actualizar al añadir un tamaño nuevo.
 */
export const LABEL_SIZE_ALIASES: Record<string, LabelSize> = {
  small: LabelSize.TWO_BY_ONE,
  '2x1': LabelSize.TWO_BY_ONE,
  '2x4': LabelSize.TWO_BY_FOUR,
  '4x2': LabelSize.FOUR_BY_TWO,
  large: LabelSize.FOUR_BY_SIX,
  '4x6': LabelSize.FOUR_BY_SIX,
  '50x80mm': LabelSize.FIFTY_BY_EIGHTY_MM,
};

/**
 * Traduce cada id de `LabelSize` al fragmento de dimensiones que entiende la
 * URL de Labelary (`.../printers/8dpmm/labels/{dimensiones}/...`).
 *
 * Separado del enum a propósito (issue #101, opción B): antes el valor del
 * enum SE INTERPOLABA tal cual en la URL, así que el id público y la
 * dimensión eran la misma cosa. Eso funcionaba mientras todos los tamaños
 * fueran pulgadas exactas, pero deja de servir en cuanto el id es legible
 * (`50x80mm`) y la dimensión real que hay que mandarle a Labelary es decimal.
 *
 * Para los cuatro tamaños de catálogo original, id y dimensión coinciden (ya
 * eran pulgadas legibles). Para el resto del catálogo métrico que se vaya
 * añadiendo, no tienen por qué coincidir nunca más.
 *
 * El valor de 50×80mm es `1.9705x3.1528`, no la conversión ingenua
 * `50/25.4 x 80/25.4` (`1.9685x3.1496`): Labelary trunca a dots usando 203 dpi
 * (8 dots/mm), y solo `1.9705x3.1528` cae exacto en la rejilla 400×640 dots,
 * que es sobre la que está diseñado el ZPL de estas etiquetas. La conversión
 * ingenua pierde el último dot de cada eje y recorta cualquier `^FO` pegado al
 * borde derecho o inferior. Medido contra la API real de Labelary — ver
 * issue #101.
 */
export const LABEL_SIZE_DIMENSIONS: Record<LabelSize, string> = {
  [LabelSize.TWO_BY_ONE]: '2x1',
  [LabelSize.TWO_BY_FOUR]: '2x4',
  [LabelSize.FOUR_BY_TWO]: '4x2',
  [LabelSize.FOUR_BY_SIX]: '4x6',
  [LabelSize.FIFTY_BY_EIGHTY_MM]: '1.9705x3.1528',
};

/**
 * Lookup seguro en `LABEL_SIZE_ALIASES`. `constructor` y `__proto__` ya están
 * en minúsculas, así que `.toLowerCase()` no los cambia, y un acceso directo
 * por corchete (`LABEL_SIZE_ALIASES['constructor']`) encuentra la propiedad
 * HEREDADA de `Object.prototype` en vez de `undefined` — cualquiera de los
 * dos "cuela" como tamaño reconocido y `normalizeLabelSize` acabaría
 * devolviendo, en tiempo de ejecución, el constructor `Object` en vez de un
 * `LabelSize`. `Object.prototype.hasOwnProperty.call` descarta esa herencia
 * (no se usa `Object.hasOwn`: el `target` de tsconfig es ES2021, anterior a
 * su tipado). Hallazgo del review de Codex en el PR #104.
 *
 * Exportado para que cualquier otro lookup directo sobre `LABEL_SIZE_ALIASES`
 * (p. ej. el segmento de tamaño del nombre de descarga en `zpl.service.ts`)
 * pase por el mismo guard en vez de reintroducir el bug con un acceso crudo.
 */
export function resolveLabelSizeAlias(
  labelSize: string | undefined,
): LabelSize | undefined {
  const key = labelSize?.toLowerCase() ?? '';
  return Object.prototype.hasOwnProperty.call(LABEL_SIZE_ALIASES, key)
    ? LABEL_SIZE_ALIASES[key]
    : undefined;
}

/**
 * true si el valor (case-insensitive) es un tamaño o alias reconocido, es
 * decir si `normalizeLabelSize` lo resolvería sin caer en el fallback.
 *
 * Pensado para validar ANTES de aceptar una entrada (p. ej. el batch, que no
 * tiene `@IsEnum` porque históricamente acepta alias libres). El chequeo en sí
 * no registra nada: quien lo llama decide cómo rechazar el valor inválido.
 */
export function isKnownLabelSize(labelSize: string | undefined): boolean {
  return resolveLabelSizeAlias(labelSize) !== undefined;
}

/**
 * Traduce cualquier tamaño de entrada al valor del enum con el que se convierte
 * de verdad. Un valor desconocido cae en 2x1, igual que la conversión.
 *
 * Es compartida porque el historial guarda el tamaño **sin normalizar**: el
 * batch lo acepta como string libre, mientras que `POST /zpl/convert` lo valida
 * con `@IsEnum(LabelSize)`. Devolver el valor crudo al reconvertir haría que el
 * frontend recibiera un 400 con el mismo tamaño con el que la conversión
 * original funcionó.
 *
 * El fallback a 2x1 se queda (no lanza): romperlo dejaría sin reconvertir
 * cualquier registro histórico con un tamaño ya no reconocido. Pero deja de
 * ser silencioso — se registra en el logger para poder detectar en producción
 * un frontend desplegado antes que el backend (issue #101). Quien pueda
 * permitirse rechazar la entrada en vez de absorberla (p. ej. el batch, antes
 * de aceptar la conversión) debe validar con `isKnownLabelSize` primero en
 * lugar de confiar en este fallback.
 */
export function normalizeLabelSize(labelSize: string | undefined): LabelSize {
  const resolved = resolveLabelSizeAlias(labelSize);
  if (resolved === undefined) {
    logger.warn(
      `Tamaño de etiqueta no reconocido ("${labelSize}"), usando 2x1 por defecto`,
    );
    return LabelSize.TWO_BY_ONE;
  }
  return resolved;
}
