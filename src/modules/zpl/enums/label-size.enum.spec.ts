import {
  LabelSize,
  LABEL_SIZE_ALIASES,
  LABEL_SIZE_DIMENSIONS,
  isKnownLabelSize,
  normalizeLabelSize,
} from './label-size.enum.js';

/**
 * issue #101 (50x80mm, Phomemo M110): el id que viaja por la API pública
 * (`LabelSize`) y la dimensión que entiende Labelary son cosas separadas a
 * propósito (opción B). Este mapeo es el contrato con Labelary: si alguien lo
 * toca sin querer, el PDF sale con el tamaño equivocado sin que ningún tipo lo
 * detecte (la clave es un string).
 */
describe('label-size.enum — LABEL_SIZE_DIMENSIONS', () => {
  it('fija el mapeo completo id -> dimensión de Labelary', () => {
    expect(LABEL_SIZE_DIMENSIONS).toEqual({
      [LabelSize.TWO_BY_ONE]: '2x1',
      [LabelSize.TWO_BY_FOUR]: '2x4',
      [LabelSize.FOUR_BY_TWO]: '4x2',
      [LabelSize.FOUR_BY_SIX]: '4x6',
      [LabelSize.FIFTY_BY_EIGHTY_MM]: '1.9705x3.1528',
    });
  });

  it('usa 1.9705x3.1528 para 50x80mm: 400x640 dots exactos a 8dpmm, no la conversión ingenua mm/25.4 (1.9685x3.1496)', () => {
    expect(LABEL_SIZE_DIMENSIONS[LabelSize.FIFTY_BY_EIGHTY_MM]).toBe(
      '1.9705x3.1528',
    );
  });

  it('para los cuatro tamaños de catálogo original, el id y la dimensión coinciden', () => {
    expect(LABEL_SIZE_DIMENSIONS[LabelSize.TWO_BY_ONE]).toBe(
      LabelSize.TWO_BY_ONE,
    );
    expect(LABEL_SIZE_DIMENSIONS[LabelSize.TWO_BY_FOUR]).toBe(
      LabelSize.TWO_BY_FOUR,
    );
    expect(LABEL_SIZE_DIMENSIONS[LabelSize.FOUR_BY_TWO]).toBe(
      LabelSize.FOUR_BY_TWO,
    );
    expect(LABEL_SIZE_DIMENSIONS[LabelSize.FOUR_BY_SIX]).toBe(
      LabelSize.FOUR_BY_SIX,
    );
  });
});

describe('label-size.enum — isKnownLabelSize', () => {
  it.each([
    '2x1',
    '2x4',
    '4x2',
    '4x6',
    '50x80mm',
    'small',
    'large',
    'SMALL',
    '50X80MM',
  ])('reconoce "%s" como tamaño o alias válido', (value) => {
    expect(isKnownLabelSize(value)).toBe(true);
  });

  it.each([undefined, '', '4x4', 'sdfsdf', 'toString'])(
    'no reconoce "%s" (protege el batch de valores no soportados)',
    (value) => {
      expect(isKnownLabelSize(value)).toBe(false);
    },
  );
});

describe('label-size.enum — normalizeLabelSize', () => {
  it('resuelve el nuevo alias 50x80mm al enum correspondiente', () => {
    expect(normalizeLabelSize('50x80mm')).toBe(LabelSize.FIFTY_BY_EIGHTY_MM);
  });

  it('sigue resolviendo los alias existentes sin romper la API pública ni el historial', () => {
    expect(normalizeLabelSize('small')).toBe(LabelSize.TWO_BY_ONE);
    expect(normalizeLabelSize('2x1')).toBe(LabelSize.TWO_BY_ONE);
    expect(normalizeLabelSize('2x4')).toBe(LabelSize.TWO_BY_FOUR);
    expect(normalizeLabelSize('4x2')).toBe(LabelSize.FOUR_BY_TWO);
    expect(normalizeLabelSize('large')).toBe(LabelSize.FOUR_BY_SIX);
    expect(normalizeLabelSize('4x6')).toBe(LabelSize.FOUR_BY_SIX);
  });

  it('es case-insensitive', () => {
    expect(normalizeLabelSize('50X80MM')).toBe(LabelSize.FIFTY_BY_EIGHTY_MM);
    expect(normalizeLabelSize('LARGE')).toBe(LabelSize.FOUR_BY_SIX);
  });

  // Contrato bloqueado también por users.service.spec.ts (getHistoryZpl): el
  // fallback a 2x1 para valores no reconocidos no puede cambiar de valor de
  // retorno, solo dejar de ser silencioso (se registra con logger.warn).
  it('cae en 2x1 para un valor no reconocido, sin lanzar', () => {
    expect(normalizeLabelSize('4x4')).toBe(LabelSize.TWO_BY_ONE);
    expect(normalizeLabelSize(undefined)).toBe(LabelSize.TWO_BY_ONE);
  });
});

describe('label-size.enum — LABEL_SIZE_ALIASES', () => {
  it('incluye el alias del tamaño nuevo, para no mantener un segundo mapa duplicado en zpl.service.ts', () => {
    expect(LABEL_SIZE_ALIASES['50x80mm']).toBe(LabelSize.FIFTY_BY_EIGHTY_MM);
  });
});
