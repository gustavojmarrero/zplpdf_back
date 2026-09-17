import {
  PriceCatalog,
  classifyTransition,
  currencyForCountry,
  intervalFromStripe,
  mesesDelCobro,
  mesesDePeriodicidad,
  priceEnvVar,
} from './price-catalog.js';
import type { BillingInterval, SellablePlan } from './price-catalog.js';

describe('price-catalog', () => {
  const env: Record<string, string> = {
    STRIPE_LITE_PRICE_ID: 'price_lite',
    STRIPE_LITE_PRICE_ID_MXN: 'price_lite_mxn',
    STRIPE_PRO_PRICE_ID: 'price_pro',
    STRIPE_PRO_PRICE_ID_MXN: 'price_pro_mxn',
    STRIPE_PROMAX_PRICE_ID: 'price_promax',
    STRIPE_PROMAX_PRICE_ID_MXN: 'price_promax_mxn',
    STRIPE_PRO_PRICE_ID_YEARLY_MXN: ' price_pro_y_mxn ',
  };
  const catalog = PriceCatalog.fromConfig((key) => env[key]);

  it('construye el nombre de cada variable de entorno', () => {
    expect(priceEnvVar('pro', 'usd', 'monthly')).toBe('STRIPE_PRO_PRICE_ID');
    expect(priceEnvVar('lite', 'mxn', 'monthly')).toBe(
      'STRIPE_LITE_PRICE_ID_MXN',
    );
    expect(priceEnvVar('promax', 'usd', 'yearly')).toBe(
      'STRIPE_PROMAX_PRICE_ID_YEARLY',
    );
    expect(priceEnvVar('promax', 'mxn', 'yearly')).toBe(
      'STRIPE_PROMAX_PRICE_ID_YEARLY_MXN',
    );
  });

  it('resuelve el precio por plan, moneda y periodicidad', () => {
    expect(catalog.find('pro', 'usd', 'monthly')).toBe('price_pro');
    expect(catalog.find('pro', 'mxn', 'yearly')).toBe('price_pro_y_mxn');
  });

  it('no cae al precio mensual cuando falta el anual', () => {
    expect(catalog.find('pro', 'usd', 'yearly')).toBeUndefined();
    expect(catalog.find('lite', 'mxn', 'yearly')).toBeUndefined();
  });

  it('dice qué vende cada price ID, anuales incluidos', () => {
    expect(catalog.resolve('price_promax_mxn')).toMatchObject({
      plan: 'promax',
      currency: 'mxn',
      interval: 'monthly',
    });
    expect(catalog.resolve('price_pro_y_mxn')).toMatchObject({
      plan: 'pro',
      currency: 'mxn',
      interval: 'yearly',
      envVar: 'STRIPE_PRO_PRICE_ID_YEARLY_MXN',
    });
  });

  it('no inventa plan para un price ID desconocido o vacío', () => {
    expect(catalog.resolve('price_desconocido')).toBeUndefined();
    expect(catalog.resolve(undefined)).toBeUndefined();
    expect(catalog.resolve('')).toBeUndefined();
  });

  it('lista las variables sin configurar por periodicidad', () => {
    expect(catalog.missing('monthly')).toEqual([]);
    expect(catalog.missing('yearly')).toEqual([
      'STRIPE_LITE_PRICE_ID_YEARLY',
      'STRIPE_LITE_PRICE_ID_YEARLY_MXN',
      'STRIPE_PRO_PRICE_ID_YEARLY',
      'STRIPE_PROMAX_PRICE_ID_YEARLY',
      'STRIPE_PROMAX_PRICE_ID_YEARLY_MXN',
    ]);
  });

  it('con el mismo ID en dos variables se queda con la primera', () => {
    const duplicado = new PriceCatalog([
      {
        plan: 'pro',
        currency: 'usd',
        interval: 'monthly',
        priceId: 'price_x',
        envVar: 'A',
      },
      {
        plan: 'pro',
        currency: 'mxn',
        interval: 'monthly',
        priceId: 'price_x',
        envVar: 'B',
      },
    ]);
    expect(duplicado.resolve('price_x')?.envVar).toBe('A');
  });

  it('elige MXN solo para México', () => {
    expect(currencyForCountry('MX')).toBe('mxn');
    expect(currencyForCountry('US')).toBe('usd');
    expect(currencyForCountry(undefined)).toBe('usd');
  });

  describe('classifyTransition', () => {
    const planes: SellablePlan[] = ['lite', 'pro', 'promax'];
    const periodos: BillingInterval[] = ['monthly', 'yearly'];
    const orden = { lite: 1, pro: 2, promax: 3 };

    it.each(
      planes.flatMap((fromPlan) =>
        periodos.flatMap((fromInterval) =>
          planes.flatMap((toPlan) =>
            periodos.map((toInterval) => [
              fromPlan,
              fromInterval,
              toPlan,
              toInterval,
            ]),
          ),
        ),
      ),
    )('%s %s → %s %s', (fromPlan, fromInterval, toPlan, toInterval) => {
      const dPlan = orden[toPlan] - orden[fromPlan];
      const dInterval =
        (toInterval === 'yearly' ? 1 : 0) - (fromInterval === 'yearly' ? 1 : 0);
      const esperado =
        dPlan < 0
          ? 'plan_downgrade'
          : dInterval < 0
            ? 'interval_downgrade'
            : dPlan === 0 && dInterval === 0
              ? 'same'
              : 'upgrade';

      expect(
        classifyTransition(
          {
            plan: fromPlan as SellablePlan,
            interval: fromInterval as BillingInterval,
          },
          {
            plan: toPlan as SellablePlan,
            interval: toInterval as BillingInterval,
          },
        ),
      ).toBe(esperado);
    });

    it('casos que fija el negocio', () => {
      expect(
        classifyTransition(
          { plan: 'pro', interval: 'monthly' },
          { plan: 'pro', interval: 'yearly' },
        ),
      ).toBe('upgrade');
      // Sube el plan pero baja la periodicidad: va por el portal.
      expect(
        classifyTransition(
          { plan: 'pro', interval: 'yearly' },
          { plan: 'promax', interval: 'monthly' },
        ),
      ).toBe('interval_downgrade');
      // Baja las dos cosas: el motivo es el plan.
      expect(
        classifyTransition(
          { plan: 'promax', interval: 'yearly' },
          { plan: 'pro', interval: 'monthly' },
        ),
      ).toBe('plan_downgrade');
    });
  });

  it('traduce la periodicidad de Stripe y falla cerrado con el resto', () => {
    expect(intervalFromStripe('month')).toBe('monthly');
    expect(intervalFromStripe('year')).toBe('yearly');
    expect(intervalFromStripe('week')).toBeUndefined();
    expect(intervalFromStripe(undefined)).toBeUndefined();
  });

  it('cuenta los meses que cubre cada cobro', () => {
    expect(mesesDePeriodicidad('monthly')).toBe(1);
    expect(mesesDePeriodicidad('yearly')).toBe(12);
    expect(mesesDelCobro('month')).toBe(1);
    expect(mesesDelCobro('month', 3)).toBe(3);
    expect(mesesDelCobro('year')).toBe(12);
    expect(mesesDelCobro('year', 2)).toBe(24);
    expect(mesesDelCobro('week')).toBe(1);
    expect(mesesDelCobro(undefined, 0)).toBe(1);
  });
});
