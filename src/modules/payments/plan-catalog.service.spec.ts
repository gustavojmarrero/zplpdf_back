import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { PlanCatalogService, formatDisplay } from './plan-catalog.service.js';

type PrecioFixture = {
  amount?: number | null;
  currency?: string;
  interval?: string | null;
  count?: number;
  active?: boolean;
};

function precio(id: string, opts: PrecioFixture = {}) {
  const interval = opts.interval === undefined ? 'month' : opts.interval;
  return {
    id,
    active: opts.active ?? true,
    currency: opts.currency ?? 'usd',
    unit_amount: opts.amount === undefined ? 500 : opts.amount,
    recurring: interval ? { interval, interval_count: opts.count ?? 1 } : null,
  };
}

function errorStripe(statusCode: number, code?: string) {
  return Object.assign(new Error(`stripe ${statusCode}`), { statusCode, code });
}

/**
 * Catálogo de pruebas: mensuales completos en las dos monedas y solo Pro con
 * anual. Los importes reproducen el ejemplo del issue #95 (99/950 MXN).
 */
const ENV_BASE: Record<string, string> = {
  STRIPE_SECRET_KEY: 'sk_test_123',
  STRIPE_LITE_PRICE_ID: 'price_lite',
  STRIPE_LITE_PRICE_ID_MXN: 'price_lite_mxn',
  STRIPE_PRO_PRICE_ID: 'price_pro',
  STRIPE_PRO_PRICE_ID_MXN: 'price_pro_mxn',
  STRIPE_PROMAX_PRICE_ID: 'price_promax',
  STRIPE_PROMAX_PRICE_ID_MXN: 'price_promax_mxn',
  STRIPE_PRO_PRICE_ID_YEARLY: 'price_pro_y',
  STRIPE_PRO_PRICE_ID_YEARLY_MXN: 'price_pro_y_mxn',
};

const PRECIOS_BASE: Record<string, ReturnType<typeof precio>> = {
  price_lite: precio('price_lite', { amount: 500 }),
  price_lite_mxn: precio('price_lite_mxn', { amount: 9900, currency: 'mxn' }),
  price_pro: precio('price_pro', { amount: 1000 }),
  price_pro_mxn: precio('price_pro_mxn', { amount: 19900, currency: 'mxn' }),
  price_promax: precio('price_promax', { amount: 2500 }),
  price_promax_mxn: precio('price_promax_mxn', {
    amount: 49900,
    currency: 'mxn',
  }),
  price_pro_y: precio('price_pro_y', { amount: 10000, interval: 'year' }),
  price_pro_y_mxn: precio('price_pro_y_mxn', {
    amount: 95000,
    currency: 'mxn',
    interval: 'year',
  }),
};

describe('PlanCatalogService', () => {
  let ahora: number;

  beforeEach(() => {
    ahora = Date.UTC(2026, 8, 17, 12, 0, 0);
    jest.spyOn(Date, 'now').mockImplementation(() => ahora);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function build(
    opts: {
      env?: Record<string, string | undefined>;
      precios?: Record<string, unknown>;
    } = {},
  ) {
    const env = { ...ENV_BASE, ...opts.env };
    const precios = { ...PRECIOS_BASE, ...opts.precios };
    const retrieve = jest.fn().mockImplementation(async (id: string) => {
      const valor = precios[id];
      if (valor instanceof Error) throw valor;
      if (!valor) throw errorStripe(404, 'resource_missing');
      return valor;
    });

    const service = new PlanCatalogService({
      get: (key: string) => env[key],
    } as any);
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    (service as any).logger = logger;
    if ((service as any).stripe) {
      (service as any).stripe = { prices: { retrieve } };
    }

    return { service, retrieve, logger };
  }

  it('publica importes reales de Stripe en MXN con el ahorro anual calculado', async () => {
    const { service } = build();

    const result = await service.getPlans('MX');

    expect(result).toEqual({
      currency: 'MXN',
      plans: [
        {
          plan: 'lite',
          monthly: { priceId: 'price_lite_mxn', amount: 9900, display: '$99' },
          yearly: null,
        },
        {
          plan: 'pro',
          monthly: { priceId: 'price_pro_mxn', amount: 19900, display: '$199' },
          yearly: {
            priceId: 'price_pro_y_mxn',
            amount: 95000,
            display: '$950',
            monthlyEquivalent: 7917,
            discountPercent: 60,
          },
        },
        {
          plan: 'promax',
          monthly: {
            priceId: 'price_promax_mxn',
            amount: 49900,
            display: '$499',
          },
          yearly: null,
        },
      ],
    });
  });

  it('calcula monthlyEquivalent y discountPercent del ejemplo del issue (99 → 950)', async () => {
    const { service } = build({
      precios: {
        price_pro_mxn: precio('price_pro_mxn', {
          amount: 9900,
          currency: 'mxn',
        }),
      },
    });

    const pro = (await service.getPlans('MX')).plans.find(
      (p) => p.plan === 'pro',
    );

    expect(pro.yearly).toMatchObject({
      monthlyEquivalent: 7917,
      discountPercent: 20,
    });
  });

  it.each([['US'], [undefined], ['ES']])(
    'usa USD para country=%s',
    async (country) => {
      const { service } = build();

      const result = await service.getPlans(country);

      expect(result.currency).toBe('USD');
      expect(result.plans[0].monthly).toEqual({
        priceId: 'price_lite',
        amount: 500,
        display: 'US$5',
      });
      expect(result.plans[1].yearly).toMatchObject({
        priceId: 'price_pro_y',
        display: 'US$100',
        monthlyEquivalent: 833,
        discountPercent: 17,
      });
    },
  );

  it('el descuento nunca es negativo si el anual sale más caro que doce mensualidades', async () => {
    const { service } = build({
      precios: {
        price_pro_y: precio('price_pro_y', { amount: 13000, interval: 'year' }),
      },
    });

    const pro = (await service.getPlans('US')).plans[1];

    expect(pro.yearly.discountPercent).toBe(0);
  });

  it('deja yearly en null cuando la variable anual no está configurada', async () => {
    const { service, retrieve } = build({
      env: {
        STRIPE_PRO_PRICE_ID_YEARLY: undefined,
        STRIPE_PRO_PRICE_ID_YEARLY_MXN: undefined,
      },
    });

    const result = await service.getPlans('MX');

    expect(result.plans.map((p) => p.yearly)).toEqual([null, null, null]);
    expect(retrieve).toHaveBeenCalledTimes(6);
  });

  it.each([
    [
      'periodicidad mensual en la variable anual',
      precio('price_pro_y_mxn', { amount: 9900, currency: 'mxn' }),
      /periodicidad 'month'/,
    ],
    [
      'moneda USD en la variable MXN',
      precio('price_pro_y_mxn', { amount: 95000, interval: 'year' }),
      /moneda 'usd'/,
    ],
    [
      'precio archivado',
      precio('price_pro_y_mxn', {
        amount: 95000,
        currency: 'mxn',
        interval: 'year',
        active: false,
      }),
      /inactivo/,
    ],
    [
      'cobro cada dos años',
      precio('price_pro_y_mxn', {
        amount: 95000,
        currency: 'mxn',
        interval: 'year',
        count: 2,
      }),
      /interval_count 2/,
    ],
    [
      'sin unit_amount (precio escalonado)',
      precio('price_pro_y_mxn', {
        amount: null,
        currency: 'mxn',
        interval: 'year',
      }),
      /sin unit_amount/,
    ],
    [
      'precio de pago único',
      precio('price_pro_y_mxn', {
        amount: 95000,
        currency: 'mxn',
        interval: null,
      }),
      /no recurrente/,
    ],
  ])(
    'no publica el anual y registra CRITICAL con %s',
    async (_caso, precioMalo, detalle) => {
      const { service, logger } = build({
        precios: { price_pro_y_mxn: precioMalo },
      });

      const pro = (await service.getPlans('MX')).plans[1];

      expect(pro.yearly).toBeNull();
      expect(pro.monthly.amount).toBe(19900);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringMatching(/CRITICAL.*STRIPE_PRO_PRICE_ID_YEARLY_MXN/),
      );
      expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(detalle));
    },
  );

  it('el mismo ID en la variable mensual y en la anual no publica el anual', async () => {
    const { service } = build({
      env: { STRIPE_PRO_PRICE_ID_YEARLY_MXN: 'price_pro_mxn' },
    });

    const pro = (await service.getPlans('MX')).plans[1];

    expect(pro.monthly.priceId).toBe('price_pro_mxn');
    expect(pro.yearly).toBeNull();
  });

  it('un price ID que Stripe no conoce se omite sin tumbar el resto', async () => {
    const { service, logger } = build({
      env: { STRIPE_PRO_PRICE_ID_YEARLY_MXN: 'price_no_existe' },
    });

    const result = await service.getPlans('MX');

    expect(result.plans[1].yearly).toBeNull();
    expect(result.plans).toHaveLength(3);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/CRITICAL.*price_no_existe/),
    );
  });

  it('omite el plan cuyo precio mensual no es válido', async () => {
    const { service } = build({
      precios: {
        price_lite_mxn: precio('price_lite_mxn', {
          amount: 9900,
          currency: 'mxn',
          active: false,
        }),
      },
    });

    const result = await service.getPlans('MX');

    expect(result.plans.map((p) => p.plan)).toEqual(['pro', 'promax']);
  });

  it('responde 503 si no queda ningún plan publicable', async () => {
    const { service } = build({
      env: {
        STRIPE_LITE_PRICE_ID_MXN: undefined,
        STRIPE_PRO_PRICE_ID_MXN: undefined,
        STRIPE_PROMAX_PRICE_ID_MXN: undefined,
      },
    });

    await expect(service.getPlans('MX')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  describe('caché', () => {
    it('lee Stripe una sola vez durante la hora de vigencia', async () => {
      const { service, retrieve } = build();

      await service.getPlans('MX');
      ahora += 59 * 60 * 1000;
      await service.getPlans('US');

      expect(retrieve).toHaveBeenCalledTimes(8);

      ahora += 2 * 60 * 1000;
      await service.getPlans('MX');

      expect(retrieve).toHaveBeenCalledTimes(16);
    });

    it('las visitas simultáneas comparten una sola ronda de lecturas', async () => {
      const { service, retrieve } = build();

      await Promise.all([
        service.getPlans('MX'),
        service.getPlans('US'),
        service.getPlans(undefined),
      ]);

      expect(retrieve).toHaveBeenCalledTimes(8);
    });

    it('si Stripe falla sirve la última copia buena y no reintenta durante un minuto', async () => {
      const { service, retrieve, logger } = build();

      const buena = await service.getPlans('MX');
      ahora += 61 * 60 * 1000;
      retrieve.mockImplementation(async (id: string) => {
        if (id === 'price_pro') throw errorStripe(500);
        return PRECIOS_BASE[id];
      });

      await expect(service.getPlans('MX')).resolves.toEqual(buena);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringMatching(/última lectura buena/),
      );
      const llamadas = retrieve.mock.calls.length;

      ahora += 30 * 1000;
      await expect(service.getPlans('MX')).resolves.toEqual(buena);
      expect(retrieve).toHaveBeenCalledTimes(llamadas);

      ahora += 31 * 1000;
      retrieve.mockImplementation(async (id: string) => PRECIOS_BASE[id]);
      await service.getPlans('MX');
      expect(retrieve.mock.calls.length).toBeGreaterThan(llamadas);
    });

    it('sin copia previa responde 503 y respeta el mismo minuto de espera', async () => {
      const { service, retrieve } = build();
      retrieve.mockRejectedValue(errorStripe(500));

      await expect(service.getPlans('MX')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      const llamadas = retrieve.mock.calls.length;

      ahora += 59 * 1000;
      await expect(service.getPlans('MX')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(retrieve).toHaveBeenCalledTimes(llamadas);

      ahora += 2 * 1000;
      retrieve.mockImplementation(async (id: string) => PRECIOS_BASE[id]);
      await expect(service.getPlans('MX')).resolves.toMatchObject({
        currency: 'MXN',
      });
    });

    it('un 403 de Stripe se registra como falta de permiso en la key', async () => {
      const { service, retrieve, logger } = build();
      retrieve.mockRejectedValue(errorStripe(403));

      await expect(service.getPlans('MX')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringMatching(/CRITICAL.*HTTP 403.*permiso de lectura/),
      );
    });
  });

  describe('arranque', () => {
    it('precalienta la caché sin bloquear ni propagar fallos', async () => {
      const { service, retrieve } = build();
      retrieve.mockRejectedValue(errorStripe(500));

      expect(() => service.onModuleInit()).not.toThrow();
      // Deja que la ronda en vuelo termine: si rechazara sin manejar, Jest
      // fallaría el test.
      await new Promise((resolve) => setImmediate(resolve));

      expect(retrieve).toHaveBeenCalled();
    });

    it('con la caché precalentada la primera visita no espera a Stripe', async () => {
      const { service, retrieve } = build();

      service.onModuleInit();
      await new Promise((resolve) => setImmediate(resolve));
      await service.getPlans('MX');

      expect(retrieve).toHaveBeenCalledTimes(8);
    });

    it('sin STRIPE_SECRET_KEY arranca y la ruta responde 503', async () => {
      // El aviso sale en el constructor, antes de poder sustituir el logger.
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { service, retrieve } = build({
        env: { STRIPE_SECRET_KEY: undefined },
      });

      expect(() => service.onModuleInit()).not.toThrow();
      await expect(service.getPlans('MX')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(retrieve).not.toHaveBeenCalled();
    });
  });

  it('formatea importes enteros sin decimales y el resto con dos', () => {
    expect(formatDisplay(9900, 'mxn')).toBe('$99');
    expect(formatDisplay(500, 'usd')).toBe('US$5');
    expect(formatDisplay(499, 'usd')).toBe('US$4.99');
    expect(formatDisplay(499000, 'mxn')).toBe('$4,990');
    expect(formatDisplay(95050, 'mxn')).toBe('$950.50');
  });
});
