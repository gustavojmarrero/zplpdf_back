import {
  calculateRenewals,
  resolveSubscriptionPeriod,
} from './renewal-cohorts.js';
import type { CycleInvoice, RenewalSubscription } from './renewal-cohorts.js';
import { buildEnterpriseSegment } from './enterprise-segment.js';
import { buildCostLedger } from './cost-ledger.js';
import { summarizeOperationalSignals } from './operational-signals.js';
import type { OperationalSignal } from './operational-signals.js';

const DAY = 86400000;
const NOW = Date.parse('2026-09-17T00:00:00.000Z');
const at = (days: number) => new Date(NOW + days * DAY).toISOString();

function subscription(
  overrides: Partial<RenewalSubscription> = {},
): RenewalSubscription {
  return {
    subscriptionId: 'sub_1',
    accountId: 'cuenta-1',
    billingInterval: 'month',
    currentPeriodEnd: at(-30),
    status: 'active',
    ...overrides,
  };
}

function cycleInvoice(overrides: Partial<CycleInvoice> = {}): CycleInvoice {
  return {
    invoiceId: 'in_1',
    subscriptionId: 'sub_1',
    accountId: 'cuenta-1',
    billingReason: 'subscription_cycle',
    paidAt: at(-29),
    amountMinor: 50000,
    currency: 'mxn',
    ...overrides,
  };
}

describe('renovación — cohortes maduras por intervalo', () => {
  it('separa mensual y anual y solo cuenta las vencidas con gracia cumplida', () => {
    const report = calculateRenewals({
      subscriptions: [
        // Mensual vencida hace 30 días: madura.
        subscription(),
        // Anual vencida hace 40 días: madura, sin factura de ciclo.
        subscription({
          subscriptionId: 'sub_year',
          accountId: 'cuenta-2',
          billingInterval: 'year',
          currentPeriodEnd: at(-40),
        }),
        // Mensual que vence mañana: no le toca todavía.
        subscription({
          subscriptionId: 'sub_future',
          accountId: 'cuenta-3',
          currentPeriodEnd: at(1),
        }),
      ],
      invoices: [cycleInvoice()],
      watermark: at(0),
      graceDays: 7,
      invoiceCoverage: 'complete',
    });

    const month = report.byInterval.find((row) => row.interval === 'month');
    const year = report.byInterval.find((row) => row.interval === 'year');

    // La que vence mañana no entra al denominador: no es una no-renovación.
    expect(month).toMatchObject({ numerator: 1, denominator: 1, value: 1 });
    expect(year).toMatchObject({ numerator: 0, denominator: 1, value: 0 });
    expect(report.coverage).toBe('complete');
  });

  it('una vencida dentro de la gracia se informa aparte, no como perdida', () => {
    const report = calculateRenewals({
      subscriptions: [subscription({ currentPeriodEnd: at(-2) })],
      invoices: [],
      watermark: at(0),
      graceDays: 7,
      invoiceCoverage: 'complete',
    });

    const month = report.byInterval.find((row) => row.interval === 'month');
    expect(month.denominator).toBe(0);
    expect(month.status).toBe('insufficient_data');
    expect(month.pendingGrace).toBe(1);
  });

  it('un primer pago no cuenta como renovación', () => {
    const report = calculateRenewals({
      subscriptions: [subscription()],
      invoices: [
        // `subscription_create` es el alta, no una renovación.
        cycleInvoice({ billingReason: 'subscription_create' }),
      ],
      watermark: at(0),
      graceDays: 7,
      invoiceCoverage: 'complete',
    });

    expect(
      report.byInterval.find((row) => row.interval === 'month'),
    ).toMatchObject({ numerator: 0, denominator: 1, value: 0 });
  });

  it('cero renovaciones y ausencia de cohorte son estados distintos', () => {
    const sinCohorte = calculateRenewals({
      subscriptions: [],
      invoices: [],
      watermark: at(0),
      graceDays: 7,
      invoiceCoverage: 'complete',
    });
    const ceroRenovadas = calculateRenewals({
      subscriptions: [subscription()],
      invoices: [],
      watermark: at(0),
      graceDays: 7,
      invoiceCoverage: 'complete',
    });

    expect(
      sinCohorte.byInterval.find((row) => row.interval === 'month'),
    ).toMatchObject({
      denominator: 0,
      value: null,
      status: 'insufficient_data',
    });
    expect(
      ceroRenovadas.byInterval.find((row) => row.interval === 'month'),
    ).toMatchObject({ denominator: 1, value: 0, status: 'observed' });
  });

  it('sin cobertura de facturas no publica tasa', () => {
    const report = calculateRenewals({
      subscriptions: [subscription()],
      invoices: [cycleInvoice()],
      watermark: at(0),
      graceDays: 7,
      invoiceCoverage: 'missing_data',
    });

    expect(
      report.byInterval.every((row) => row.status === 'missing_data'),
    ).toBe(true);
    expect(report.coverage).toBe('missing_data');
  });

  it('suscripciones sin período observado degradan la cobertura', () => {
    const report = calculateRenewals({
      subscriptions: [subscription(), subscription({ currentPeriodEnd: null })],
      invoices: [cycleInvoice()],
      watermark: at(0),
      graceDays: 7,
      invoiceCoverage: 'complete',
    });

    expect(report.withoutPeriod).toBe(1);
    expect(report.coverage).toBe('partial');
  });

  it('excluye cuentas de QA del numerador y del denominador', () => {
    const report = calculateRenewals({
      subscriptions: [subscription({ accountId: 'qa-1' })],
      invoices: [cycleInvoice({ accountId: 'qa-1' })],
      watermark: at(0),
      graceDays: 7,
      invoiceCoverage: 'complete',
      isExcluded: (accountId) => accountId === 'qa-1',
    });

    expect(
      report.byInterval.find((row) => row.interval === 'month').denominator,
    ).toBe(0);
  });
});

describe('resolveSubscriptionPeriod (API Basil)', () => {
  it('lee el período de los items, no de la suscripción', () => {
    // `Subscription.current_period_end` ya no existe en Basil: leerlo del
    // objeto raíz devolvería undefined y vaciaría la cohorte para siempre.
    expect(
      resolveSubscriptionPeriod([{ current_period_end: 1789000000 }]),
    ).toEqual({
      currentPeriodEnd: new Date(1789000000 * 1000).toISOString(),
      mixedPeriods: false,
    });
  });

  it('con items de períodos distintos toma el más temprano y lo marca', () => {
    const result = resolveSubscriptionPeriod([
      { current_period_end: 1789000000 },
      { current_period_end: 1790000000 },
    ]);

    expect(result.currentPeriodEnd).toBe(
      new Date(1789000000 * 1000).toISOString(),
    );
    expect(result.mixedPeriods).toBe(true);
  });

  it('sin items utilizables devuelve ausencia, no una fecha inventada', () => {
    expect(resolveSubscriptionPeriod([])).toEqual({
      currentPeriodEnd: null,
      mixedPeriods: false,
    });
    expect(resolveSubscriptionPeriod([{}])).toEqual({
      currentPeriodEnd: null,
      mixedPeriods: false,
    });
  });
});

describe('Enterprise manual — segmento separado', () => {
  const internal = [
    { accountId: 'ent-manual', plan: 'enterprise', observedAt: at(0) },
    { accountId: 'ent-stripe', plan: 'enterprise', observedAt: at(0) },
    { accountId: 'pro-1', plan: 'pro', observedAt: at(0) },
  ];

  it('no cuenta como manual a quien ya está en el inventario de Stripe', () => {
    const segment = buildEnterpriseSegment({
      period: '2026-09',
      internalAccounts: internal,
      stripeInventoryAccounts: ['ent-stripe'],
      contracts: [],
      inventoryCoverage: 'complete',
    });

    expect(segment.manualAccounts).toBe(1);
    expect(segment.accountsAlreadyInStripe).toBe(1);
    expect(segment.doNotSumWithStripe).toBe(true);
    expect(segment).not.toHaveProperty('sources');
  });

  it('sin importe declarado cuenta la cuenta pero no inventa ingreso', () => {
    const segment = buildEnterpriseSegment({
      period: '2026-09',
      internalAccounts: internal,
      stripeInventoryAccounts: ['ent-stripe'],
      contracts: [],
      inventoryCoverage: 'complete',
    });

    expect(segment.revenueByCurrency).toEqual([]);
    expect(segment.accountsWithoutRevenue).toBe(1);
    expect(segment.coverage).toBe('partial');
    expect(segment.reason).toBe('manual_accounts_without_declared_revenue');
  });

  it('con contrato declarado publica ingreso por moneda y su base', () => {
    const segment = buildEnterpriseSegment({
      period: '2026-09',
      internalAccounts: internal,
      stripeInventoryAccounts: ['ent-stripe'],
      contracts: [
        {
          accountId: 'ent-manual',
          period: '2026-09',
          currency: 'MXN',
          amountMinor: 1200000,
          source: 'contrato-firmado',
          basis: 'invoiced',
        },
        // Contrato de otro período: no entra.
        {
          accountId: 'ent-manual',
          period: '2026-08',
          currency: 'mxn',
          amountMinor: 999,
          source: 'contrato-firmado',
          basis: 'invoiced',
        },
      ],
      inventoryCoverage: 'complete',
    });

    expect(segment.revenueByCurrency).toEqual([
      {
        currency: 'mxn',
        amountMinor: 1200000,
        accounts: 1,
        basis: ['invoiced'],
      },
    ]);
    expect(segment.coverage).toBe('complete');
    // Solo el recuento de fuentes: la etiqueta no se publica.
    expect(segment.sourceCount).toBe(1);
    expect(segment).not.toHaveProperty('sources');
  });

  it('sin inventario no publica segmento: no se sabe quién ya está contado', () => {
    const segment = buildEnterpriseSegment({
      period: '2026-09',
      internalAccounts: internal,
      stripeInventoryAccounts: [],
      contracts: [],
      inventoryCoverage: 'missing_data',
    });

    expect(segment.coverage).toBe('missing_data');
    expect(segment.manualAccounts).toBe(0);
    expect(segment.reason).toBe('inventory_coverage_missing_data');
  });
});

describe('economía — costes declarados y contribución', () => {
  const entries = (['renderer', 'cloud', 'connector', 'support'] as const).map(
    (category) => ({
      period: '2026-09',
      category,
      currency: 'mxn',
      amountMinor: 10000,
      source: `factura-${category}`,
      basis: 'invoiced' as const,
      observedAt: at(0),
    }),
  );

  it('con las cuatro categorías y cobertura completa publica contribución', () => {
    const ledger = buildCostLedger({
      period: '2026-09',
      entries,
      netRevenueByCurrency: [{ currency: 'mxn', netMinor: 100000 }],
      revenueCoverage: 'complete',
    });

    expect(ledger.byCurrency[0]).toMatchObject({
      costTotalMinor: 40000,
      netRevenueMinor: 100000,
      contributionMinor: 60000,
      status: 'observed',
    });
    expect(ledger.coverage).toBe('complete');
  });

  it('falta una categoría: no hay contribución ni coste total', () => {
    const ledger = buildCostLedger({
      period: '2026-09',
      entries: entries.filter((entry) => entry.category !== 'support'),
      netRevenueByCurrency: [{ currency: 'mxn', netMinor: 100000 }],
      revenueCoverage: 'complete',
    });

    // Un neto con tres de cuatro categorías parece completo y no lo es.
    expect(ledger.byCurrency[0].contributionMinor).toBeNull();
    expect(ledger.byCurrency[0].costTotalMinor).toBeNull();
    expect(ledger.byCurrency[0].reason).toBe('missing_cost_categories:support');
    expect(ledger.missingCategories).toEqual([
      { currency: 'mxn', missing: ['support'] },
    ]);
  });

  it('una categoría sin entradas es ausencia, no coste cero', () => {
    const ledger = buildCostLedger({
      period: '2026-09',
      entries: entries.filter((entry) => entry.category === 'cloud'),
      netRevenueByCurrency: [],
      revenueCoverage: 'complete',
    });

    const renderer = ledger.byCurrency[0].costByCategory.find(
      (row) => row.category === 'renderer',
    );
    expect(renderer).toMatchObject({
      amountMinor: null,
      status: 'missing_data',
    });
  });

  it('no mezcla monedas: cada una tiene su propia contribución', () => {
    const ledger = buildCostLedger({
      period: '2026-09',
      entries: [
        ...entries,
        {
          period: '2026-09',
          category: 'cloud' as const,
          currency: 'usd',
          amountMinor: 500,
          source: 'factura-cloud-usd',
          basis: 'invoiced' as const,
          observedAt: at(0),
        },
      ],
      netRevenueByCurrency: [
        { currency: 'mxn', netMinor: 100000 },
        { currency: 'usd', netMinor: 3000 },
      ],
      revenueCoverage: 'complete',
    });

    expect(ledger.byCurrency.map((row) => row.currency)).toEqual([
      'mxn',
      'usd',
    ]);
    // USD solo tiene nube: sin las otras tres no hay contribución en USD.
    expect(
      ledger.byCurrency.find((row) => row.currency === 'usd').contributionMinor,
    ).toBeNull();
    expect(ledger.totalsOmittedReason).toBe(
      'mixed_currencies_require_dated_fx',
    );
    expect(ledger.coverage).toBe('partial');
  });

  it('sin cobertura de ingreso no hay economía, aunque haya costes', () => {
    const ledger = buildCostLedger({
      period: '2026-09',
      entries,
      netRevenueByCurrency: [{ currency: 'mxn', netMinor: 100000 }],
      revenueCoverage: 'partial',
    });

    expect(ledger.byCurrency[0].contributionMinor).toBeNull();
    expect(ledger.byCurrency[0].reason).toBe('revenue_coverage_partial');
  });

  it('sin ninguna fuente el libro entero es missing_data', () => {
    const ledger = buildCostLedger({
      period: '2026-09',
      entries: [],
      netRevenueByCurrency: [],
      revenueCoverage: 'complete',
    });

    expect(ledger.coverage).toBe('missing_data');
    expect(ledger.byCurrency).toEqual([]);
    expect(ledger.estimatedCostsExcluded).toBe(true);
  });
});

describe('fricciones operativas — cuota y errores', () => {
  const signal = (
    overrides: Partial<OperationalSignal> = {},
  ): OperationalSignal => ({
    id: 'sig-1',
    accountId: 'cuenta-1',
    featureId: 'packing_workflow',
    kind: 'quota_rejected',
    code: 'MONTHLY_LIMIT_EXCEEDED',
    statusCode: 403,
    environment: 'test',
    isSynthetic: false,
    occurredAt: at(-1),
    ...overrides,
  });

  const window = { start: at(-7), end: at(0) };

  it('agrupa por función, clase y código con cuentas distintas', () => {
    const report = summarizeOperationalSignals({
      signals: [
        signal(),
        signal({ id: 'sig-2', accountId: 'cuenta-2' }),
        signal({
          id: 'sig-3',
          kind: 'http_error',
          code: 'SERVER_FAILURE',
          statusCode: 500,
        }),
      ],
      window,
      environment: 'test',
      coverageStartedAt: at(-30),
      truncated: false,
    });

    expect(report.quotaRejections).toBe(2);
    expect(report.httpErrors).toBe(1);
    expect(report.accountsAffected).toBe(2);
    expect(report.byCode[0]).toMatchObject({
      code: 'MONTHLY_LIMIT_EXCEEDED',
      attempts: 2,
      accounts: 2,
    });
  });

  it('la cobertura máxima es de mejor esfuerzo, nunca completa', () => {
    const report = summarizeOperationalSignals({
      signals: [signal()],
      window,
      environment: 'test',
      coverageStartedAt: at(-30),
      truncated: false,
    });

    // La anotación puede fallar sin romper la petición del usuario: afirmar
    // cobertura completa sería prometer un ledger exhaustivo que no existe.
    expect(report.coverage).toBe('best_effort');
    expect(report.semantics).toBe(
      'failed_authenticated_http_attempts_not_operations',
    );
    expect(report.excludedByDesign).toEqual([
      'guard_failures',
      'async_worker_failures',
    ]);
  });

  it('sin fecha de instrumentación no hay cobertura, y cero no es cero', () => {
    const report = summarizeOperationalSignals({
      signals: [signal()],
      window,
      environment: 'test',
      coverageStartedAt: undefined,
      truncated: false,
    });

    expect(report.coverage).toBe('missing_data');
    expect(report.quotaRejections).toBeNull();
    expect(report.httpErrors).toBeNull();
    expect(report.reason).toBe('operational_signals_start_not_configured');
  });

  it('una ventana anterior a la instrumentación no se imputa', () => {
    const report = summarizeOperationalSignals({
      signals: [signal()],
      window,
      environment: 'test',
      // Se instrumentó ayer: la ventana de siete días no está cubierta.
      coverageStartedAt: at(-1),
      truncated: false,
    });

    expect(report.coverage).toBe('missing_data');
    expect(report.reason).toBe('window_precedes_instrumentation');
    expect(report.quotaRejections).toBeNull();
  });

  it('descarta sintéticos, otro entorno, fuera de ventana y excluidos', () => {
    const report = summarizeOperationalSignals({
      signals: [
        signal(),
        signal({ id: 'sig-syn', isSynthetic: true }),
        signal({ id: 'sig-env', environment: 'production' }),
        signal({ id: 'sig-old', occurredAt: at(-30) }),
        signal({ id: 'sig-qa', accountId: 'qa-1' }),
      ],
      window,
      environment: 'test',
      coverageStartedAt: at(-30),
      truncated: false,
      isExcluded: (accountId) => accountId === 'qa-1',
    });

    expect(report.quotaRejections).toBe(1);
    expect(report.excludedAccounts).toBe(1);
  });

  it('el truncado por límite de escaneo se declara como parcial', () => {
    const report = summarizeOperationalSignals({
      signals: [signal()],
      window,
      environment: 'test',
      coverageStartedAt: at(-30),
      truncated: true,
    });

    expect(report.coverage).toBe('partial');
    expect(report.reason).toBe('scan_limit');
  });
});
