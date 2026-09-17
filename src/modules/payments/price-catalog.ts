import { PLAN_ORDER } from '../../common/interfaces/user.interface.js';
import type { PlanType } from '../../common/interfaces/user.interface.js';

/** Planes de pago vendibles por checkout/upgrade (excluye enterprise, que es manual). */
export type SellablePlan = 'lite' | 'pro' | 'promax';

/**
 * Periodicidad de cobro tal como la expone la API (`billingPeriod`).
 *
 * No se llama `BillingPeriod` porque ese nombre ya es el tramo `{ start, end }`
 * de `stripe-billing-period.util.ts`, que el servicio de pagos importa también.
 */
export type BillingInterval = 'monthly' | 'yearly';

export type PriceCurrency = 'usd' | 'mxn';

export const SELLABLE_PLANS: readonly SellablePlan[] = [
  'lite',
  'pro',
  'promax',
];
export const BILLING_INTERVALS: readonly BillingInterval[] = [
  'monthly',
  'yearly',
];
const CURRENCIES: readonly PriceCurrency[] = ['usd', 'mxn'];

const INTERVAL_ORDER: Record<BillingInterval, number> = {
  monthly: 0,
  yearly: 1,
};

/** Un price ID configurado y lo que vende. */
export interface PriceRef {
  plan: SellablePlan;
  currency: PriceCurrency;
  interval: BillingInterval;
  priceId: string;
  envVar: string;
}

/** `STRIPE_PRO_PRICE_ID`, `STRIPE_PRO_PRICE_ID_MXN`, `STRIPE_PRO_PRICE_ID_YEARLY_MXN`... */
export function priceEnvVar(
  plan: SellablePlan,
  currency: PriceCurrency,
  interval: BillingInterval,
): string {
  return (
    `STRIPE_${plan.toUpperCase()}_PRICE_ID` +
    (interval === 'yearly' ? '_YEARLY' : '') +
    (currency === 'mxn' ? '_MXN' : '')
  );
}

/**
 * Mapa bidireccional entre price IDs de Stripe y lo que venden.
 *
 * Es la única fuente para las dos preguntas que antes vivían en ramas sueltas:
 * qué precio cobrar para un (plan, moneda, periodicidad) y qué plan concede un
 * precio que llega de Stripe. Un precio sin configurar no existe para el
 * catálogo: nunca se cae a otro (ni a mensual ni a Pro).
 */
export class PriceCatalog {
  private readonly byId = new Map<string, PriceRef>();

  constructor(private readonly refs: readonly PriceRef[] = []) {
    for (const ref of refs) {
      // Si el mismo ID está en dos variables, gana la primera: el plan que
      // concede es el mismo y no vale la pena tumbar el arranque por ello.
      if (!this.byId.has(ref.priceId)) {
        this.byId.set(ref.priceId, ref);
      }
    }
  }

  static fromConfig(get: (key: string) => string | undefined): PriceCatalog {
    const refs: PriceRef[] = [];
    for (const plan of SELLABLE_PLANS) {
      for (const interval of BILLING_INTERVALS) {
        for (const currency of CURRENCIES) {
          const envVar = priceEnvVar(plan, currency, interval);
          const priceId = get(envVar)?.trim();
          if (priceId) {
            refs.push({ plan, currency, interval, priceId, envVar });
          }
        }
      }
    }
    return new PriceCatalog(refs);
  }

  /** Price ID para el destino pedido, o `undefined` si no está configurado. */
  find(
    plan: SellablePlan,
    currency: PriceCurrency,
    interval: BillingInterval,
  ): string | undefined {
    return this.refs.find(
      (ref) =>
        ref.plan === plan &&
        ref.currency === currency &&
        ref.interval === interval,
    )?.priceId;
  }

  /** Qué vende un price ID, o `undefined` si no está mapeado. */
  resolve(priceId: string | undefined | null): PriceRef | undefined {
    return priceId ? this.byId.get(priceId) : undefined;
  }

  all(): readonly PriceRef[] {
    return this.refs;
  }

  /** Variables de entorno de precio que no están configuradas. */
  missing(interval: BillingInterval): string[] {
    const faltan: string[] = [];
    for (const plan of SELLABLE_PLANS) {
      for (const currency of CURRENCIES) {
        if (!this.find(plan, currency, interval)) {
          faltan.push(priceEnvVar(plan, currency, interval));
        }
      }
    }
    return faltan;
  }
}

/** Moneda de cobro según el país, con el mismo criterio que ya aplicaba el checkout. */
export function currencyForCountry(country?: string): PriceCurrency {
  return country === 'MX' ? 'mxn' : 'usd';
}

/**
 * Cómo se mueve un cambio de contrato.
 *
 * Solo es `upgrade` cuando plan y periodicidad son iguales o mayores, y al
 * menos uno sube. Cualquier bajada —de plan o de periodicidad— se remite al
 * portal, que la aplica a fin de periodo. Pro anual → Pro Max mensual es una
 * bajada de periodicidad aunque suba el plan: permitirla en la app dejaría un
 * crédito grande que Stripe iría consumiendo durante meses sin cobrar.
 *
 * La bajada de plan manda sobre la de periodicidad para el motivo.
 */
export type PlanTransition =
  | 'same'
  | 'upgrade'
  | 'plan_downgrade'
  | 'interval_downgrade';

export function classifyTransition(
  from: { plan: PlanType; interval: BillingInterval },
  to: { plan: PlanType; interval: BillingInterval },
): PlanTransition {
  const deltaPlan = PLAN_ORDER[to.plan] - PLAN_ORDER[from.plan];
  const deltaInterval =
    INTERVAL_ORDER[to.interval] - INTERVAL_ORDER[from.interval];

  if (deltaPlan < 0) return 'plan_downgrade';
  if (deltaInterval < 0) return 'interval_downgrade';
  if (deltaPlan === 0 && deltaInterval === 0) return 'same';
  return 'upgrade';
}

/** Periodicidad de la API a partir del `recurring.interval` de Stripe. */
export function intervalFromStripe(
  interval: string | undefined | null,
): BillingInterval | undefined {
  if (interval === 'month') return 'monthly';
  if (interval === 'year') return 'yearly';
  return undefined;
}

/** Meses que cubre un cobro de esta periodicidad. */
export function mesesDePeriodicidad(interval: BillingInterval): number {
  return interval === 'yearly' ? 12 : 1;
}

/**
 * Meses que cubre un cobro con este `recurring` de Stripe.
 *
 * El MRR de los eventos es siempre mensual: un cobro anual contado entero
 * multiplicaría por doce el ingreso recurrente del mes en que entra. Lo que no
 * es mes ni año se cuenta como un mes, igual que se contaba todo hasta ahora.
 */
export function mesesDelCobro(
  interval: string | undefined | null,
  intervalCount?: number | null,
): number {
  const count = intervalCount && intervalCount > 0 ? intervalCount : 1;
  if (interval === 'year') return 12 * count;
  if (interval === 'month') return count;
  return 1;
}
