import {
  calculateCurrentPeriod,
  calculateFreePeriod,
  generatePeriodId,
  UserForPeriod,
} from './period-calculator.util';

describe('period-calculator.util', () => {
  describe('calculateFreePeriod (usuario Free registrado a mitad de mes)', () => {
    // Usuario registrado el 15 de enero. El período mensual debe correr del día 15
    // al día 15 del mes siguiente, NO del 1 al 31 (mes calendario).
    const userId = 'user-free-1';
    const createdAt = new Date(2026, 0, 15); // 15 ene 2026

    it('ancla periodStart al día de registro del período que contiene "now"', () => {
      const now = new Date(2026, 4, 20); // 20 may 2026
      const period = calculateFreePeriod(userId, createdAt, now);

      expect(period.periodStart).toEqual(new Date(2026, 4, 15)); // 15 may
      expect(period.periodStart.getTime()).toBeLessThanOrEqual(now.getTime());
      expect(period.periodEnd.getTime()).toBeGreaterThan(now.getTime());
      expect(period.periodId).toBe(`${userId}_20260515`);
    });

    it('retrocede un mes cuando "now" es anterior al día de registro del mes actual', () => {
      const now = new Date(2026, 4, 10); // 10 may (antes del día 15)
      const period = calculateFreePeriod(userId, createdAt, now);

      // El período vigente arrancó el 15 de abril, no el 15 de mayo (que es futuro).
      expect(period.periodStart).toEqual(new Date(2026, 3, 15)); // 15 abr
      expect(period.periodId).toBe(`${userId}_20260415`);
    });

    it('es determinista: el mismo usuario y "now" producen el mismo periodId', () => {
      const now = new Date(2026, 4, 20);
      const a = calculateFreePeriod(userId, createdAt, now);
      const b = calculateFreePeriod(userId, createdAt, now);
      expect(a.periodId).toBe(b.periodId);
    });
  });

  describe('calculateCurrentPeriod (unificación bloqueo ↔ emails)', () => {
    // Garantía central del issue #46: el bloqueo de conversiones y los emails de
    // límite deben usar EXACTAMENTE el mismo periodId. Como ambos flujos llaman a
    // calculateCurrentPeriod(user), basta probar que para un mismo usuario Free
    // registrado a mitad de mes la función devuelve un periodId estable.
    const freeUser: UserForPeriod = {
      id: 'user-mid-month',
      plan: 'free',
      createdAt: new Date(2026, 0, 17), // registrado el 17
    };

    it('Free deriva el período de createdAt (no de mes calendario)', () => {
      const now = new Date(2026, 4, 25); // 25 may
      const period = calculateCurrentPeriod(freeUser, now);

      expect(period.periodStart).toEqual(new Date(2026, 4, 17)); // 17 may
      expect(period.periodId).toBe('user-mid-month_20260517');
    });

    it('bloqueo y emails obtienen el mismo periodId para el mismo usuario y momento', () => {
      const now = new Date(2026, 4, 25);

      // Simula los dos call sites independientes: checkCanConvert (bloqueo) y
      // checkAndTriggerLimitEmails / triggerBlockedEmail (emails).
      const periodEnBloqueo = calculateCurrentPeriod(freeUser, now);
      const periodEnEmail = calculateCurrentPeriod(freeUser, now);

      expect(periodEnEmail.periodId).toBe(periodEnBloqueo.periodId);
      expect(periodEnEmail.periodStart).toEqual(periodEnBloqueo.periodStart);
      expect(periodEnEmail.periodEnd).toEqual(periodEnBloqueo.periodEnd);
    });

    it('Lite sin suscripción de Stripe también deriva el período de createdAt', () => {
      const liteUser: UserForPeriod = { ...freeUser, plan: 'lite' };
      const now = new Date(2026, 4, 25);
      const period = calculateCurrentPeriod(liteUser, now);

      expect(period.periodStart).toEqual(new Date(2026, 4, 17));
      expect(period.periodId).toBe('user-mid-month_20260517');
    });

    it('Pro con período de Stripe usa esas fechas, no createdAt', () => {
      const proUser: UserForPeriod = {
        id: 'user-pro',
        plan: 'pro',
        createdAt: new Date(2026, 0, 17),
        subscriptionPeriodStart: new Date(2026, 4, 3),
        subscriptionPeriodEnd: new Date(2026, 5, 3),
      };
      const now = new Date(2026, 4, 25);
      const period = calculateCurrentPeriod(proUser, now);

      expect(period.periodStart).toEqual(new Date(2026, 4, 3));
      expect(period.periodId).toBe('user-pro_20260503');
    });
  });

  describe('generatePeriodId', () => {
    it('formatea como userId_YYYYMMDD con padding', () => {
      expect(generatePeriodId('u1', new Date(2026, 2, 5))).toBe('u1_20260305');
    });
  });
});
