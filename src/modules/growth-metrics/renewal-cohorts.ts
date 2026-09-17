import type { Coverage } from './growth-sources.js';

/**
 * Renovación por intervalo, con cohortes maduras.
 *
 * El plan (§5) define renovación como «suscripciones que renuevan con pago
 * confirmado / suscripciones elegibles cuyo siguiente vencimiento ya pasó más
 * la ventana de gracia definida», mensual y anual separados. Las tres partes
 * difíciles son el denominador, el numerador y la diferencia entre cero y
 * ausencia:
 *
 * - **Denominador:** solo entran las suscripciones cuyo período venció y cuya
 *   gracia también pasó **antes de la marca de agua**. Una suscripción que
 *   vence mañana no es que no haya renovado: es que todavía no le toca.
 * - **Numerador:** solo facturas de ciclo (`subscription_cycle`) pagadas. Un
 *   `subscription_create` es el primer pago, no una renovación; contarlo
 *   convertiría cada alta nueva en una renovación perfecta.
 * - **Cero vs ausencia:** sin suscripciones maduras el resultado es
 *   `insufficient_data`; sin datos de período es `missing_data`. Ninguno de los
 *   dos es «0% de renovación».
 */

export type BillingInterval = 'month' | 'year' | 'mixed' | 'unknown';

export interface RenewalSubscription {
  subscriptionId: string;
  accountId: string;
  billingInterval: BillingInterval;
  /**
   * Fin del período vigente observado. En la versión Basil de la API vive en
   * `subscription.items.data[].current_period_end`, no en la suscripción.
   */
  currentPeriodEnd: string | null;
  status: string;
  cancellationScheduled?: boolean;
}

export interface CycleInvoice {
  invoiceId: string;
  subscriptionId?: string | null;
  accountId?: string | null;
  /** `subscription_cycle`, `subscription_create`, `subscription_update`… */
  billingReason: string | null;
  paidAt: string;
  amountMinor: number;
  currency: string;
}

export interface RenewalRate {
  interval: BillingInterval;
  numerator: number | null;
  denominator: number | null;
  value: number | null;
  status: 'observed' | 'insufficient_data' | 'missing_data';
  reason?: string;
  /** Vencidas cuya gracia todavía no ha pasado: ni renovadas ni perdidas. */
  pendingGrace: number;
  /** Bajas programadas dentro de la cohorte: indicador anticipado, no baja. */
  cancellationScheduled: number;
}

export interface RenewalReport {
  schemaVersion: 1;
  watermark: string;
  graceDays: number;
  coverage: Coverage;
  byInterval: RenewalRate[];
  /** Suscripciones sin período observado: no se pueden madurar. */
  withoutPeriod: number;
  /** Intervalos mezclados o desconocidos: se informan, no se reparten. */
  unclassified: number;
  semantics: 'mature_period_end_plus_grace_cycle_invoice_only';
}

const DAY = 86400000;

function missing(interval: BillingInterval, reason: string): RenewalRate {
  return {
    interval,
    numerator: null,
    denominator: null,
    value: null,
    status: 'missing_data',
    reason,
    pendingGrace: 0,
    cancellationScheduled: 0,
  };
}

export function calculateRenewals(input: {
  subscriptions: RenewalSubscription[];
  invoices: CycleInvoice[];
  watermark: string;
  graceDays: number;
  /** Cobertura de la fuente de facturas: sin ella no se publica tasa. */
  invoiceCoverage: Coverage;
  isExcluded?: (accountId: string) => boolean;
}): RenewalReport {
  const end = Date.parse(input.watermark);
  if (!Number.isFinite(end)) throw new Error('Invalid renewal watermark');
  const grace = Math.max(0, input.graceDays) * DAY;

  const eligible = input.subscriptions.filter(
    (subscription) => !input.isExcluded?.(subscription.accountId),
  );
  const withoutPeriod = eligible.filter(
    (subscription) =>
      !subscription.currentPeriodEnd ||
      !Number.isFinite(Date.parse(subscription.currentPeriodEnd)),
  ).length;

  // Solo las facturas de ciclo pagadas cuentan como renovación.
  const renewedSubscriptions = new Set(
    input.invoices
      .filter(
        (invoice) =>
          invoice.billingReason === 'subscription_cycle' &&
          invoice.amountMinor > 0 &&
          Number.isFinite(Date.parse(invoice.paidAt)) &&
          Date.parse(invoice.paidAt) <= end &&
          !!invoice.subscriptionId &&
          !input.isExcluded?.(invoice.accountId ?? ''),
      )
      .map((invoice) => invoice.subscriptionId),
  );

  const intervals: BillingInterval[] = ['month', 'year'];
  const byInterval = intervals.map<RenewalRate>((interval) => {
    if (input.invoiceCoverage !== 'complete')
      return missing(interval, `invoice_coverage_${input.invoiceCoverage}`);

    const cohort = eligible.filter(
      (subscription) => subscription.billingInterval === interval,
    );
    const withPeriod = cohort.filter(
      (subscription) =>
        subscription.currentPeriodEnd &&
        Number.isFinite(Date.parse(subscription.currentPeriodEnd)),
    );

    const mature = withPeriod.filter(
      (subscription) =>
        Date.parse(subscription.currentPeriodEnd) + grace <= end,
    );
    // Vencidas pero dentro de la gracia: se informan aparte para que no parezca
    // que no renovaron.
    const pendingGrace = withPeriod.filter((subscription) => {
      const periodEnd = Date.parse(subscription.currentPeriodEnd);
      return periodEnd <= end && periodEnd + grace > end;
    }).length;

    const renewed = mature.filter((subscription) =>
      renewedSubscriptions.has(subscription.subscriptionId),
    );

    return {
      interval,
      numerator: mature.length ? renewed.length : null,
      denominator: mature.length,
      value: mature.length ? renewed.length / mature.length : null,
      // Sin cohorte madura no hay 0%: hay ausencia de observación.
      status: mature.length ? 'observed' : 'insufficient_data',
      ...(mature.length ? {} : { reason: 'no_mature_subscriptions' }),
      pendingGrace,
      cancellationScheduled: mature.filter(
        (subscription) => subscription.cancellationScheduled,
      ).length,
    };
  });

  return {
    schemaVersion: 1,
    watermark: input.watermark,
    graceDays: input.graceDays,
    coverage:
      input.invoiceCoverage !== 'complete'
        ? input.invoiceCoverage
        : withoutPeriod > 0
          ? 'partial'
          : 'complete',
    byInterval,
    withoutPeriod,
    unclassified: eligible.filter(
      (subscription) =>
        subscription.billingInterval === 'mixed' ||
        subscription.billingInterval === 'unknown',
    ).length,
    semantics: 'mature_period_end_plus_grace_cycle_invoice_only',
  };
}

/**
 * Período vigente de una suscripción en la API Basil.
 *
 * `Subscription.current_period_end` **ya no existe**: cada item lleva el suyo.
 * Con varios items que no coinciden no se elige uno: se devuelve el más
 * temprano y se marca como mezclado, porque el vencimiento que manda para
 * madurar la cohorte es el primero que llega.
 */
export function resolveSubscriptionPeriod(
  items: { current_period_end?: number }[],
): {
  currentPeriodEnd: string | null;
  mixedPeriods: boolean;
} {
  const ends = (items ?? [])
    .map((item) => item?.current_period_end)
    .filter(
      (value): value is number => Number.isSafeInteger(value) && value > 0,
    );

  if (ends.length === 0) return { currentPeriodEnd: null, mixedPeriods: false };

  return {
    currentPeriodEnd: new Date(Math.min(...ends) * 1000).toISOString(),
    mixedPeriods: new Set(ends).size > 1,
  };
}
