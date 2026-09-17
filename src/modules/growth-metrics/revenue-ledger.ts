import type { Coverage } from './growth-sources.js';

/**
 * Libro de ingresos y reembolsos, por moneda.
 *
 * Dos reglas que no son de estilo:
 *
 * 1. **Nunca se suma entre monedas.** Un total «MXN + USD» no es dinero: sin
 *    tipo de cambio de la fecha del cobro es un número inventado. Aquí cada
 *    moneda es una fila y no existe el total.
 * 2. **Un reembolso no borra el cobro.** El cobro ocurrió y el reembolso
 *    también; los dos conservan su identidad y su fecha. El neto se calcula, no
 *    se guarda machacando el bruto. Así un reembolso de un mes anterior no
 *    reescribe el mes en que se cobró.
 *
 * Semántica de Stripe usada (documentación oficial, no se ejecuta nada contra
 * la API): `invoice.amount_paid` es el importe realmente cobrado de la factura,
 * en la unidad mínima de `invoice.currency`; un reembolso viaja como
 * `charge.refunded` con `charge.amount_refunded` acumulado sobre ese cargo.
 * Ojo: en la versión Basil de la API el cargo ya **no** expone `invoice`, así
 * que la ligadura con la factura pasa por el PaymentIntent y aquí no se asume.
 * Un `credit_note` reduce el importe adeudado y no es dinero devuelto, por eso
 * no entra en este libro.
 */

export interface RevenueFact {
  /** Identidad del objeto Stripe: factura para el cobro, cargo para el reembolso. */
  objectId: string;
  kind: 'payment' | 'refund';
  currency: string;
  /** Unidad mínima de la moneda. Siempre positivo; el signo lo pone `kind`. */
  amountMinor: number;
  occurredAt: string;
  livemode: boolean;
  accountId?: string | null;
}

export interface CurrencyRevenue {
  currency: string;
  grossMinor: number;
  refundedMinor: number;
  netMinor: number;
  payments: number;
  refunds: number;
}

export interface RevenueLedger {
  schemaVersion: 1;
  window: { start: string; end: string };
  byCurrency: CurrencyRevenue[];
  /** No hay total: sumar monedas distintas exigiría un tipo de cambio que no se tiene. */
  totalsOmittedReason: 'mixed_currencies_require_dated_fx';
  coverage: Coverage;
  /** Reembolsos observados cuyo cobro cae fuera de la ventana: no se netean aquí. */
  refundsOutsideWindow: number;
  excludedAccounts: number;
}

function bucket(
  buckets: Map<string, CurrencyRevenue>,
  currency: string,
): CurrencyRevenue {
  const key = currency.toLowerCase();
  if (!buckets.has(key))
    buckets.set(key, {
      currency: key,
      grossMinor: 0,
      refundedMinor: 0,
      netMinor: 0,
      payments: 0,
      refunds: 0,
    });
  return buckets.get(key);
}

export function buildRevenueLedger(input: {
  facts: RevenueFact[];
  window: { start: string; end: string };
  coverage: Coverage;
  isExcluded?: (accountId: string) => boolean;
}): RevenueLedger {
  const buckets = new Map<string, CurrencyRevenue>();
  let refundsOutsideWindow = 0;
  let excludedAccounts = 0;

  for (const fact of input.facts) {
    if (
      !fact.currency ||
      !Number.isSafeInteger(fact.amountMinor) ||
      fact.amountMinor <= 0
    )
      continue;

    if (fact.accountId && input.isExcluded?.(fact.accountId)) {
      excludedAccounts += 1;
      continue;
    }

    const inWindow =
      fact.occurredAt >= input.window.start &&
      fact.occurredAt <= input.window.end;
    if (!inWindow) {
      // Un reembolso de un cobro anterior se cuenta aparte en vez de restarse
      // de un bruto que no incluye ese cobro.
      if (fact.kind === 'refund') refundsOutsideWindow += 1;
      continue;
    }

    const row = bucket(buckets, fact.currency);
    if (fact.kind === 'payment') {
      row.grossMinor += fact.amountMinor;
      row.payments += 1;
    } else {
      row.refundedMinor += fact.amountMinor;
      row.refunds += 1;
    }
    row.netMinor = row.grossMinor - row.refundedMinor;
  }

  return {
    schemaVersion: 1,
    window: input.window,
    byCurrency: [...buckets.values()].sort((a, b) =>
      a.currency.localeCompare(b.currency),
    ),
    totalsOmittedReason: 'mixed_currencies_require_dated_fx',
    coverage: input.coverage,
    refundsOutsideWindow,
    excludedAccounts,
  };
}

/**
 * Importe reembolsado que aporta un `charge.refunded`.
 *
 * `amount_refunded` es **acumulado** sobre el cargo, así que dos reembolsos
 * parciales del mismo cargo llegan como 30 y luego 50, no como 30 y 20. Guardar
 * el acumulado y quedarse con el mayor evita contar 80 donde hubo 50.
 */
export function refundDelta(
  previousCumulativeMinor: number,
  cumulativeMinor: number,
): number {
  if (!Number.isSafeInteger(cumulativeMinor) || cumulativeMinor <= 0) return 0;
  const previous = Number.isSafeInteger(previousCumulativeMinor)
    ? previousCumulativeMinor
    : 0;
  return Math.max(0, cumulativeMinor - Math.max(0, previous));
}
