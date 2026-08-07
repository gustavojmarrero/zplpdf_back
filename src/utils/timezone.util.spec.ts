import {
  getStartOfDateInTimezone,
  getEndOfDateInTimezone,
} from './timezone.util.js';

/**
 * El dashboard opera en GMT-6 (Mérida). Estos helpers convierten un string de
 * fecha (YYYY-MM-DD) en los límites de ese día en GMT-6 para acotar métricas
 * de error_logs. El riesgo principal es un off-by-one al cruzar el offset.
 */
describe('timezone.util — límites de día en GMT-6', () => {
  describe('getStartOfDateInTimezone', () => {
    it('inicio del día = 06:00:00 UTC (00:00 GMT-6)', () => {
      expect(getStartOfDateInTimezone('2026-06-11').toISOString()).toBe(
        '2026-06-11T06:00:00.000Z',
      );
    });

    it('ignora la parte horaria si viene un ISO completo', () => {
      expect(
        getStartOfDateInTimezone('2026-06-11T15:30:00Z').toISOString(),
      ).toBe('2026-06-11T06:00:00.000Z');
    });
  });

  describe('getEndOfDateInTimezone', () => {
    it('fin del día = 05:59:59.999 UTC del día siguiente (23:59:59.999 GMT-6)', () => {
      expect(getEndOfDateInTimezone('2026-06-11').toISOString()).toBe(
        '2026-06-12T05:59:59.999Z',
      );
    });

    it('normaliza correctamente el cruce de mes', () => {
      expect(getEndOfDateInTimezone('2026-06-30').toISOString()).toBe(
        '2026-07-01T05:59:59.999Z',
      );
    });

    it('normaliza correctamente el cruce de año', () => {
      expect(getEndOfDateInTimezone('2026-12-31').toISOString()).toBe(
        '2027-01-01T05:59:59.999Z',
      );
    });
  });

  it('un rango de un solo día cubre 24h exactas', () => {
    const start = getStartOfDateInTimezone('2026-06-11');
    const end = getEndOfDateInTimezone('2026-06-11');
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000 - 1);
  });
});
