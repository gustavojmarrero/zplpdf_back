export enum LabelSize {
  TWO_BY_ONE = '2x1',
  TWO_BY_FOUR = '2x4',
  FOUR_BY_TWO = '4x2',
  FOUR_BY_SIX = '4x6',
}

/**
 * Alias aceptados al pedir una conversión. `small` y `large` vienen de la API
 * antigua y siguen admitiéndose.
 */
const LABEL_SIZE_ALIASES: Record<string, LabelSize> = {
  small: LabelSize.TWO_BY_ONE,
  '2x1': LabelSize.TWO_BY_ONE,
  '2x4': LabelSize.TWO_BY_FOUR,
  '4x2': LabelSize.FOUR_BY_TWO,
  large: LabelSize.FOUR_BY_SIX,
  '4x6': LabelSize.FOUR_BY_SIX,
};

/**
 * Traduce cualquier tamaño de entrada al valor del enum con el que se convierte
 * de verdad. Un valor desconocido cae en 2x1, igual que la conversión.
 *
 * Es compartida porque el historial guarda el tamaño **sin normalizar**: el
 * batch lo acepta como string libre, mientras que `POST /zpl/convert` lo valida
 * con `@IsEnum(LabelSize)`. Devolver el valor crudo al reconvertir haría que el
 * frontend recibiera un 400 con el mismo tamaño con el que la conversión
 * original funcionó.
 */
export function normalizeLabelSize(labelSize: string | undefined): LabelSize {
  return (
    LABEL_SIZE_ALIASES[labelSize?.toLowerCase() ?? ''] ?? LabelSize.TWO_BY_ONE
  );
}
