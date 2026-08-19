import {
  getStartOfDateInTimezone,
  getEndOfDateInTimezone,
  getDateStringInTimezone,
  getTimeStringInTimezone,
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

/**
 * issue #100: `generateFilenames` armaba el timestamp del nombre de descarga
 * recortando un ISO en UTC a ciegas (`slice(0, 14)`), lo que dejaba la hora
 * cortada a la mitad y encima en UTC en vez de GMT-6. `getTimeStringInTimezone`
 * es la mitad "hora" del reemplazo explícito: se combina con
 * `getDateStringInTimezone` para armar `YYYYMMDDTHHmm`.
 */
describe('timezone.util — getTimeStringInTimezone', () => {
  it('resta el offset sin tocar los minutos (offset de horas completas)', () => {
    // 21:42 UTC - 6h = 15:42 GMT-6
    expect(getTimeStringInTimezone(new Date('2026-08-19T21:42:16.123Z'))).toBe(
      '1542',
    );
  });

  it('hace acarreo circular de hora cuando UTC cae en la madrugada', () => {
    // 03:15 UTC - 6h = 21:15 GMT-6 del día anterior (el día no importa aquí)
    expect(getTimeStringInTimezone(new Date('2026-08-19T03:15:00.000Z'))).toBe(
      '2115',
    );
  });

  it('rellena con ceros horas y minutos de un dígito', () => {
    expect(getTimeStringInTimezone(new Date('2026-08-19T06:05:00.000Z'))).toBe(
      '0005',
    );
  });

  it('combinado con getDateStringInTimezone reproduce GMT-6 y no UTC (issue #100)', () => {
    // A las 19:00 hora local (01:00 UTC del día siguiente) el nombre debe
    // fechar el día de Mérida, no el de UTC.
    const localEvening = new Date('2026-08-20T01:00:00.000Z'); // 19:00 GMT-6 del 19
    const compact =
      getDateStringInTimezone(localEvening).replace(/-/g, '') +
      'T' +
      getTimeStringInTimezone(localEvening);
    expect(compact).toBe('20260819T1900');
  });
});
