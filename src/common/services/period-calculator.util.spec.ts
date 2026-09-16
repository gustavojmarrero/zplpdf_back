import {
  calculateCurrentPeriod,
  calculateFreePeriod,
  generatePeriodId,
  PeriodInfo,
  UserForPeriod,
} from './period-calculator.util.js';

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

  // Fechas en UTC con mes 1-based. Las 12:00 UTC hacen que el día local (que es
  // lo que lee generatePeriodId) coincida con el UTC en cualquier TZ de -11 a +11,
  // así los periodId esperados no dependen de la máquina que corre los tests.
  const utc = (y: number, m: number, d: number, h = 12, min = 0): Date =>
    new Date(Date.UTC(y, m - 1, d, h, min));
  const MS_DAY = 24 * 60 * 60 * 1000;

  describe('calculateCurrentPeriod con suscripción anual (cuota mensual)', () => {
    const annualUser = (start: Date, end: Date): UserForPeriod => ({
      id: 'user-annual',
      plan: 'pro',
      createdAt: new Date(2025, 5, 3),
      subscriptionPeriodStart: start,
      subscriptionPeriodEnd: end,
    });

    /** Recorre la suscripción encadenando periodEnd → siguiente periodStart. */
    const walkSubperiods = (user: UserForPeriod) => {
      const periods: PeriodInfo[] = [];
      let cursor = user.subscriptionPeriodStart as Date;
      const end = user.subscriptionPeriodEnd as Date;
      while (cursor.getTime() < end.getTime() && periods.length < 20) {
        const period = calculateCurrentPeriod(user, cursor);
        periods.push(period);
        cursor = period.periodEnd;
      }
      return periods;
    };

    it('reparte un año anclado al día 31 en 12 subperiodos consecutivos, sin huecos ni solapes', () => {
      const start = utc(2026, 1, 31);
      const end = utc(2027, 1, 31);
      const user = annualUser(start, end);

      const periods = walkSubperiods(user);

      expect(periods.map((p) => p.periodStart.toISOString())).toEqual(
        [
          utc(2026, 1, 31),
          utc(2026, 2, 28), // febrero no bisiesto: último día del mes
          utc(2026, 3, 31), // vuelve al 31: no se arrastra el 28
          utc(2026, 4, 30),
          utc(2026, 5, 31),
          utc(2026, 6, 30),
          utc(2026, 7, 31),
          utc(2026, 8, 31),
          utc(2026, 9, 30),
          utc(2026, 10, 31),
          utc(2026, 11, 30),
          utc(2026, 12, 31),
        ].map((d) => d.toISOString()),
      );

      // El primero empieza donde Stripe y el último termina donde Stripe.
      expect(periods[0].periodStart.getTime()).toBe(start.getTime());
      expect(periods[11].periodEnd.getTime()).toBe(end.getTime());

      for (let i = 0; i < periods.length; i++) {
        const length =
          periods[i].periodEnd.getTime() - periods[i].periodStart.getTime();
        expect(length).toBeGreaterThanOrEqual(28 * MS_DAY);
        expect(length).toBeLessThanOrEqual(31 * MS_DAY);
        if (i > 0) {
          // Fin exclusivo = inicio del siguiente: ni hueco ni solape.
          expect(periods[i].periodStart.getTime()).toBe(
            periods[i - 1].periodEnd.getTime(),
          );
        }
      }

      // Un documento de uso por mes.
      expect(periods.map((p) => p.periodId)).toEqual([
        'user-annual_20260131',
        'user-annual_20260228',
        'user-annual_20260331',
        'user-annual_20260430',
        'user-annual_20260531',
        'user-annual_20260630',
        'user-annual_20260731',
        'user-annual_20260831',
        'user-annual_20260930',
        'user-annual_20261031',
        'user-annual_20261130',
        'user-annual_20261231',
      ]);
    });

    it('cualquier instante dentro de un subperiodo devuelve ese mismo subperiodo', () => {
      const user = annualUser(utc(2026, 1, 31), utc(2027, 1, 31));
      const periods = walkSubperiods(user);

      for (const period of periods) {
        const middle = new Date(
          (period.periodStart.getTime() + period.periodEnd.getTime()) / 2,
        );
        const lastMs = new Date(period.periodEnd.getTime() - 1);
        expect(calculateCurrentPeriod(user, middle)).toEqual(period);
        expect(calculateCurrentPeriod(user, lastMs)).toEqual(period);
      }

      // Barrido del año cada 5 h (desfasado respecto de la hora del ancla): todo
      // instante cae en un subperiodo que lo contiene, y solo hay 12 ids.
      const ids = new Set<string>();
      const sweepEnd = user.subscriptionPeriodEnd as Date;
      for (
        let t = (user.subscriptionPeriodStart as Date).getTime();
        t < sweepEnd.getTime();
        t += 5 * 60 * 60 * 1000
      ) {
        const period = calculateCurrentPeriod(user, new Date(t));
        expect(period.periodStart.getTime()).toBeLessThanOrEqual(t);
        expect(period.periodEnd.getTime()).toBeGreaterThan(t);
        ids.add(period.periodId);
      }
      expect([...ids]).toEqual(periods.map((p) => p.periodId));
    });

    it('anclaje 31 atravesando febrero bisiesto: 31 ene → 29 feb → 31 mar', () => {
      const user = annualUser(utc(2027, 10, 31), utc(2028, 10, 31));

      const jan = calculateCurrentPeriod(user, utc(2028, 2, 15));
      expect(jan.periodStart.toISOString()).toBe(
        utc(2028, 1, 31).toISOString(),
      );
      expect(jan.periodEnd.toISOString()).toBe(utc(2028, 2, 29).toISOString());

      const feb = calculateCurrentPeriod(user, utc(2028, 3, 15));
      expect(feb.periodStart.toISOString()).toBe(
        utc(2028, 2, 29).toISOString(),
      );
      expect(feb.periodEnd.toISOString()).toBe(utc(2028, 3, 31).toISOString());
      expect(feb.periodId).toBe('user-annual_20280229');

      expect(walkSubperiods(user)).toHaveLength(12);
    });

    it('anclaje 31 atravesando febrero no bisiesto: 31 ene → 28 feb → 31 mar', () => {
      const user = annualUser(utc(2026, 10, 31), utc(2027, 10, 31));

      const jan = calculateCurrentPeriod(user, utc(2027, 2, 15));
      expect(jan.periodStart.toISOString()).toBe(
        utc(2027, 1, 31).toISOString(),
      );
      expect(jan.periodEnd.toISOString()).toBe(utc(2027, 2, 28).toISOString());

      const feb = calculateCurrentPeriod(user, utc(2027, 3, 1));
      expect(feb.periodStart.toISOString()).toBe(
        utc(2027, 2, 28).toISOString(),
      );
      expect(feb.periodEnd.toISOString()).toBe(utc(2027, 3, 31).toISOString());
      expect(feb.periodId).toBe('user-annual_20270228');

      expect(walkSubperiods(user)).toHaveLength(12);
    });

    it('"now" justo en el borde pertenece al subperiodo nuevo; 1 ms antes, al anterior', () => {
      const user = annualUser(utc(2026, 1, 31), utc(2027, 1, 31));
      const border = utc(2026, 3, 31);

      const atBorder = calculateCurrentPeriod(user, border);
      expect(atBorder.periodStart.getTime()).toBe(border.getTime());
      expect(atBorder.periodId).toBe('user-annual_20260331');

      const justBefore = calculateCurrentPeriod(
        user,
        new Date(border.getTime() - 1),
      );
      expect(justBefore.periodStart.toISOString()).toBe(
        utc(2026, 2, 28).toISOString(),
      );
      expect(justBefore.periodEnd.getTime()).toBe(border.getTime());
    });

    it('trabaja en UTC y conserva la hora de Stripe, aunque el día local sea otro', () => {
      // 23:30 UTC: en TZ positivas ya es el día siguiente en hora local.
      const user = annualUser(
        utc(2026, 1, 31, 23, 30),
        utc(2027, 1, 31, 23, 30),
      );

      const period = calculateCurrentPeriod(user, utc(2026, 5, 1));
      expect(period.periodStart.toISOString()).toBe('2026-04-30T23:30:00.000Z');
      expect(period.periodEnd.toISOString()).toBe('2026-05-31T23:30:00.000Z');
    });

    it('"now" fuera del periodo de Stripe se acota al primer o al último subperiodo', () => {
      const start = utc(2026, 1, 31);
      const end = utc(2027, 1, 31);
      const user = annualUser(start, end);

      const before = calculateCurrentPeriod(user, utc(2025, 12, 1));
      expect(before.periodStart.getTime()).toBe(start.getTime());
      expect(before.periodEnd.toISOString()).toBe(
        utc(2026, 2, 28).toISOString(),
      );

      // Webhook de renovación tardío: igual que el camino mensual, se mantiene el
      // último periodo conocido en vez de abrir una cuota que Stripe no confirmó.
      for (const now of [end, utc(2027, 3, 15)]) {
        const after = calculateCurrentPeriod(user, now);
        expect(after.periodStart.toISOString()).toBe(
          utc(2026, 12, 31).toISOString(),
        );
        expect(after.periodEnd.getTime()).toBe(end.getTime());
      }
    });

    it('un resto final de menos de 7 días se absorbe en el último subperiodo', () => {
      // Renovación anual con ancla original el 29 de febrero: Stripe va del 28 de
      // febrero al 29 del año bisiesto siguiente. Anclado al 28 sobra un día.
      const end = utc(2028, 2, 29);
      const user = annualUser(utc(2027, 2, 28), end);

      const periods = walkSubperiods(user);
      expect(periods).toHaveLength(12);
      expect(periods[11].periodStart.toISOString()).toBe(
        utc(2028, 1, 28).toISOString(),
      );
      expect(periods[11].periodEnd.getTime()).toBe(end.getTime());

      // El día sobrante no abre una cuota nueva.
      expect(calculateCurrentPeriod(user, utc(2028, 2, 28, 18)).periodId).toBe(
        'user-annual_20280128',
      );
    });

    it('un resto final de 7 días o más es un subperiodo propio', () => {
      // Primer periodo prorrateado hasta un ancla de facturación el 1 de enero.
      const end = new Date(Date.UTC(2027, 0, 1));
      const user = annualUser(utc(2026, 9, 16), end);

      const periods = walkSubperiods(user);
      expect(periods.map((p) => p.periodStart.toISOString())).toEqual(
        [
          utc(2026, 9, 16),
          utc(2026, 10, 16),
          utc(2026, 11, 16),
          utc(2026, 12, 16),
        ].map((d) => d.toISOString()),
      );
      expect(periods[3].periodEnd.getTime()).toBe(end.getTime());
    });

    it('el umbral es estricto: 35 días exactos se usan tal cual y 35 días + 1 ms se reparten', () => {
      const start = utc(2026, 5, 1);

      const exactly35 = annualUser(
        start,
        new Date(start.getTime() + 35 * MS_DAY),
      );
      const p35 = calculateCurrentPeriod(exactly35, utc(2026, 6, 4));
      expect(p35.periodStart).toBe(exactly35.subscriptionPeriodStart);
      expect(p35.periodEnd).toBe(exactly35.subscriptionPeriodEnd);

      // 35 días + 1 ms desde el 1 de febrero: 28 días + resto de 7 días → 2 subperiodos.
      const febStart = utc(2026, 2, 1);
      const over35 = annualUser(
        febStart,
        new Date(febStart.getTime() + 35 * MS_DAY + 1),
      );
      expect(walkSubperiods(over35).map((p) => p.periodId)).toEqual([
        'user-annual_20260201',
        'user-annual_20260301',
      ]);
    });
  });

  describe('calculateCurrentPeriod: mensual y Free sin cambios', () => {
    /** Copia literal del camino de pago anterior a la cuota mensual para anuales. */
    const legacyCalculateCurrentPeriod = (
      user: UserForPeriod,
      now: Date,
    ): PeriodInfo => {
      if (user.plan === 'free') {
        return calculateFreePeriod(user.id, user.createdAt, now);
      }
      if (user.subscriptionPeriodStart && user.subscriptionPeriodEnd) {
        const periodStart =
          user.subscriptionPeriodStart instanceof Date
            ? user.subscriptionPeriodStart
            : new Date(user.subscriptionPeriodStart);
        const periodEnd =
          user.subscriptionPeriodEnd instanceof Date
            ? user.subscriptionPeriodEnd
            : new Date(user.subscriptionPeriodEnd);
        return {
          periodStart,
          periodEnd,
          periodId: generatePeriodId(user.id, periodStart),
        };
      }
      return calculateFreePeriod(user.id, user.createdAt, now);
    };

    const monthlyPeriods: Array<[string, Date, Date]> = [
      ['febrero no bisiesto (28 días)', utc(2026, 2, 3), utc(2026, 3, 3)],
      ['febrero bisiesto (29 días)', utc(2028, 2, 3), utc(2028, 3, 3)],
      ['mes de 30 días', utc(2026, 4, 17), utc(2026, 5, 17)],
      ['mes de 31 días', utc(2026, 5, 3), utc(2026, 6, 3)],
      ['ancla 31 → 28 feb', utc(2026, 1, 31, 7, 45), utc(2026, 2, 28, 7, 45)],
      [
        '35 días exactos',
        utc(2026, 7, 1),
        new Date(utc(2026, 7, 1).getTime() + 35 * MS_DAY),
      ],
    ];

    it.each(monthlyPeriods)(
      'mensual (%s): mismo resultado que antes para cualquier "now"',
      (_label, start, end) => {
        for (const plan of ['lite', 'pro', 'promax', 'enterprise'] as const) {
          const user: UserForPeriod = {
            id: `user-${plan}`,
            plan,
            createdAt: new Date(2025, 0, 17),
            subscriptionPeriodStart: start,
            subscriptionPeriodEnd: end,
          };
          const nows = [
            new Date(start.getTime() - 5 * MS_DAY),
            start,
            new Date((start.getTime() + end.getTime()) / 2),
            new Date(end.getTime() - 1),
            end,
            new Date(end.getTime() + 40 * MS_DAY),
          ];

          for (const now of nows) {
            const period = calculateCurrentPeriod(user, now);
            expect(period).toEqual(legacyCalculateCurrentPeriod(user, now));
            // Incluso las mismas instancias de Date que llegaron de Firestore.
            expect(period.periodStart).toBe(start);
            expect(period.periodEnd).toBe(end);
          }
        }
      },
    );

    it('mensual con fechas serializadas (no Date) sigue igual', () => {
      const user = {
        id: 'user-raw',
        plan: 'pro',
        createdAt: new Date(2025, 0, 17),
        subscriptionPeriodStart: '2026-05-03T10:00:00.000Z',
        subscriptionPeriodEnd: '2026-06-03T10:00:00.000Z',
      } as unknown as UserForPeriod;
      const now = utc(2026, 5, 20);

      expect(calculateCurrentPeriod(user, now)).toEqual(
        legacyCalculateCurrentPeriod(user, now),
      );
    });

    it('Free con fechas anuales residuales de Stripe sigue anclado a createdAt', () => {
      const user: UserForPeriod = {
        id: 'user-downgraded',
        plan: 'free',
        createdAt: new Date(2025, 0, 17),
        subscriptionPeriodStart: utc(2026, 1, 31),
        subscriptionPeriodEnd: utc(2027, 1, 31),
      };

      for (const now of [
        new Date(2026, 1, 16),
        new Date(2026, 1, 17),
        new Date(2026, 4, 25),
        new Date(2026, 11, 31, 23, 59),
      ]) {
        const period = calculateCurrentPeriod(user, now);
        expect(period).toEqual(
          calculateFreePeriod(user.id, user.createdAt, now),
        );
        expect(period).toEqual(legacyCalculateCurrentPeriod(user, now));
      }
    });

    it('plan de pago sin las dos fechas de Stripe sigue usando createdAt', () => {
      const now = new Date(2026, 4, 25);
      const base: UserForPeriod = {
        id: 'user-partial',
        plan: 'pro',
        createdAt: new Date(2025, 0, 17),
      };

      for (const user of [
        base,
        { ...base, subscriptionPeriodStart: utc(2026, 1, 31) },
        { ...base, subscriptionPeriodEnd: utc(2027, 1, 31) },
      ]) {
        expect(calculateCurrentPeriod(user, now)).toEqual(
          legacyCalculateCurrentPeriod(user, now),
        );
      }
    });
  });

  describe('generatePeriodId', () => {
    it('formatea como userId_YYYYMMDD con padding', () => {
      expect(generatePeriodId('u1', new Date(2026, 2, 5))).toBe('u1_20260305');
    });
  });
});
