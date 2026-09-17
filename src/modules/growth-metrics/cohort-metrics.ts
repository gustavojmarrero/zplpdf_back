export interface CohortEvent {
  accountId: string;
  featureId: string;
  occurredAt: string;
  eventName: string;
  isSynthetic?: boolean;
}
export interface Assignment {
  accountId: string;
  assignedAt: string;
  /**
   * Estado de pago en el momento de asignar. **No admite `undefined`**: sin
   * este dato la cuenta no puede entrar ni salir del denominador de intención
   * de tratar, así que se cuenta aparte como estado desconocido en vez de
   * asumir «no pagaba», que es lo que inflaba la conversión.
   */
  initiallyPaid?: boolean;
}
export interface PaymentFact {
  accountId: string;
  paidAt: string;
  amountMinor: number;
}
const DAY = 86400000;
const SUCCESS = new Set([
  'packing_export_succeeded',
  'template_run_succeeded',
  'api_job_succeeded',
  'pdf_preparation_export_succeeded',
  'folder_run_succeeded',
  'print_job_acknowledged',
  'regression_run_completed',
]);
function ratio(numerator: number, denominator: number) {
  return {
    numerator,
    denominator,
    value: denominator ? numerator / denominator : null,
    // Sin denominador no hay cero: hay ausencia de observación.
    status: denominator ? 'observed' : 'insufficient_data',
  };
}

/** Añade al acumulador si quien llama aportó uno. */
function collectAccount(collector: Set<string> | undefined, value: string) {
  collector?.add(value);
}

function missing(reason: string) {
  return {
    numerator: null,
    denominator: null,
    value: null,
    status: 'missing_data',
    reason,
  };
}
/** Descriptive account cohorts, not a claim of causal lift. Cutoff must be a verified source watermark. */
export function calculateFeatureCohorts(
  events: CohortEvent[],
  featureId: string,
  cutoff: string,
  /**
   * Cuentas con la función realmente disponible. El plan pide mostrar el
   * alcance (expuestas/elegibles) junto a la activación: sin él, una activación
   * alta puede ser solo que casi nadie vio la función.
   */
  eligibleAccounts?: string[],
) {
  const end = Date.parse(cutoff);
  if (!Number.isFinite(end)) throw new Error('Invalid source watermark');
  const valid = events.filter(
    (e) =>
      !e.isSynthetic &&
      e.featureId === featureId &&
      Number.isFinite(Date.parse(e.occurredAt)) &&
      Date.parse(e.occurredAt) <= end,
  );
  const exposures = new Map<string, number>();
  const successes = new Map<string, number[]>();
  for (const event of valid) {
    const time = Date.parse(event.occurredAt);
    if (event.eventName === 'feature_exposed')
      exposures.set(
        event.accountId,
        Math.min(exposures.get(event.accountId) ?? Infinity, time),
      );
    if (SUCCESS.has(event.eventName))
      successes.set(event.accountId, [
        ...(successes.get(event.accountId) ?? []),
        time,
      ]);
  }
  const productSuccesses = new Map<string, number[]>();
  for (const e of events) {
    const time = Date.parse(e.occurredAt);
    if (
      !e.isSynthetic &&
      SUCCESS.has(e.eventName) &&
      Number.isFinite(time) &&
      time <= end
    )
      productSuccesses.set(e.accountId, [
        ...(productSuccesses.get(e.accountId) ?? []),
        time,
      ]);
  }
  let productW2 = 0,
    productD30 = 0;
  let eligible7 = 0,
    active7 = 0,
    eligibleW2 = 0,
    retainedW2 = 0,
    eligible30 = 0,
    retained30 = 0;
  for (const [account, exposedAt] of exposures) {
    const times = (successes.get(account) ?? [])
      .filter((t) => t >= exposedAt)
      .sort((a, b) => a - b);
    if (exposedAt + 7 * DAY <= end) {
      eligible7++;
      if (times.some((t) => t < exposedAt + 7 * DAY)) active7++;
    }
    const activatedAt = times[0];
    if (activatedAt === undefined) continue;
    if (activatedAt + 14 * DAY <= end) {
      eligibleW2++;
      if (
        (productSuccesses.get(account) ?? []).some(
          (t) => t >= activatedAt + 7 * DAY && t < activatedAt + 14 * DAY,
        )
      )
        productW2++;
      if (
        times.some(
          (t) => t >= activatedAt + 7 * DAY && t < activatedAt + 14 * DAY,
        )
      )
        retainedW2++;
    }
    if (activatedAt + 31 * DAY <= end) {
      eligible30++;
      if (
        (productSuccesses.get(account) ?? []).some(
          (t) => t >= activatedAt + 23 * DAY && t < activatedAt + 31 * DAY,
        )
      )
        productD30++;
      if (
        times.some(
          (t) => t >= activatedAt + 23 * DAY && t < activatedAt + 31 * DAY,
        )
      )
        retained30++;
    }
  }
  const eligible = eligibleAccounts ? new Set(eligibleAccounts) : null;
  const reach = eligible
    ? ratio(
        [...exposures.keys()].filter((account) => eligible.has(account)).length,
        eligible.size,
      )
    : missing('eligible_population_unknown');

  return {
    featureId,
    sourceWatermark: cutoff,
    /** Expuestas / elegibles. Contexto obligatorio de la activación. */
    reach,
    activation7d: ratio(active7, eligible7),
    retentionW2: ratio(retainedW2, eligibleW2),
    retentionD30: ratio(retained30, eligible30),
    productRetentionW2: ratio(productW2, eligibleW2),
    productRetentionD30: ratio(productD30, eligible30),
  };
}
/** Intent-to-treat denominator includes every initially-unpaid mature assignment, even without web consent/exposure. */
export function calculatePaid30d(
  assignments: Assignment[],
  payments: PaymentFact[],
  cutoff: string,
  /**
   * Cobertura del primer pago. Con cobertura parcial el «primer pago» observado
   * puede ser en realidad el segundo, y una cuenta que ya pagaba antes de la
   * asignación se contaría como conversión. En ese caso no se devuelve tasa.
   */
  firstPaymentCoverage: 'complete' | 'partial' | 'missing_data' = 'complete',
  /**
   * Acumulador **en memoria** de las cuentas convertidas.
   *
   * Existe para poder contar cuentas distintas entre funcionalidades sin que
   * los UID salgan del proceso: quien llama es dueño del `Set`, publica su
   * tamaño y nunca su contenido. Antes esta función devolvía el array de UID y
   * acababa serializado dentro del snapshot, que es un documento que leen
   * paneles y exportadores.
   */
  convertedCollector?: Set<string>,
) {
  const end = Date.parse(cutoff);
  if (!Number.isFinite(end)) throw new Error('Invalid source watermark');
  if (firstPaymentCoverage !== 'complete')
    return missing(`first_payment_coverage_${firstPaymentCoverage}`);
  const unique = new Map<string, Assignment>();
  for (const a of assignments) {
    if (!Number.isFinite(Date.parse(a.assignedAt)))
      throw new Error('Invalid assignment');
    if (
      !unique.has(a.accountId) ||
      a.assignedAt < unique.get(a.accountId).assignedAt
    )
      unique.set(a.accountId, a);
  }
  const firstPayment = new Map<string, number>();
  for (const payment of payments) {
    const time = Date.parse(payment.paidAt);
    if (
      Number.isSafeInteger(payment.amountMinor) &&
      payment.amountMinor > 0 &&
      Number.isFinite(time) &&
      time <= end
    )
      firstPayment.set(
        payment.accountId,
        Math.min(firstPayment.get(payment.accountId) ?? Infinity, time),
      );
  }
  const all = [...unique.values()];
  // Estado inicial desconocido: fuera del denominador y contado aparte.
  const unknownInitialState = all.filter(
    (a) => typeof a.initiallyPaid !== 'boolean',
  ).length;
  const mature = all.filter(
    (a) =>
      a.initiallyPaid === false &&
      Date.parse(a.assignedAt) + 30 * DAY <= end &&
      (firstPayment.get(a.accountId) ?? Infinity) >= Date.parse(a.assignedAt),
  );
  const converted = mature.filter(
    (a) =>
      (firstPayment.get(a.accountId) ?? Infinity) <
      Date.parse(a.assignedAt) + 30 * DAY,
  );
  for (const account of converted)
    collectAccount(convertedCollector, account.accountId);

  return {
    ...ratio(converted.length, mature.length),
    excludedUnknownInitialState: unknownInitialState,
    /**
     * Solo el recuento. Los identificadores de cuenta no se publican: este
     * objeto acaba dentro de `growth_snapshots`, que es de lectura para el
     * panel y el exportador.
     */
    convertedAccountCount: converted.length,
    semantics: 'intent_to_treat_initially_unpaid',
  };
}

/** Boundary stock bridge. Both inputs must be complete, attributed, distinct-account inventories.
 * Membership changes inside the window that net to zero are deliberately not gross churn counts.
 */
export function calculatePaidAccountBridge(
  start: string[],
  end: string[],
  previouslyPaid: string[],
) {
  const opening = new Set(start),
    closing = new Set(end),
    historic = new Set(previouslyPaid);
  const added = [...closing].filter((id) => !opening.has(id));
  const effectiveChurn = [...opening].filter((id) => !closing.has(id)).length;
  const reactivated = added.filter((id) => historic.has(id)).length;
  const newPaid = added.length - reactivated;
  return {
    opening: opening.size,
    closing: closing.size,
    newPaid,
    reactivated,
    effectiveChurn,
    adjustment: 0,
    net: closing.size - opening.size,
    reconciled:
      opening.size + newPaid + reactivated - effectiveChurn === closing.size,
    semantics: 'distinct_account_boundary_membership',
  };
}
