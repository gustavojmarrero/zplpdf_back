import type { Firestore, Transaction } from '@google-cloud/firestore';

/**
 * Piezas compartidas de BE02/BE03: qué se excluye del recuento, hasta dónde se
 * puede afirmar que los datos están completos, y cómo se impide que un job con
 * el lease vencido publique un resultado.
 */

export type Coverage = 'complete' | 'partial' | 'missing_data';

/**
 * Motivos por los que un snapshot no puede afirmar cobertura. Son códigos
 * cerrados: el panel decide con ellos y no con texto libre.
 */
export const CoverageBlockers = {
  EVENT_BACKLOG: 'event_backlog',
  LABEL_EVENT_BACKLOG: 'label_event_backlog',
  DEAD_EVENTS: 'dead_events',
  SCAN_LIMIT: 'scan_limit',
  BILLING_INCOMPLETE: 'billing_incomplete',
  BILLING_STALE: 'billing_stale',
  BILLING_ATTRIBUTION_PENDING: 'billing_attribution_pending',
  FIRST_PAYMENT_COVERAGE: 'first_payment_coverage_partial',
  INVENTORY_MISSING: 'inventory_missing',
  INVENTORY_AFTER_CUTOFF: 'inventory_after_cutoff',
  COHORT_START_MISSING: 'cohort_start_not_configured',
  NO_EVENT_WATERMARK: 'no_event_watermark',
} as const;

export type CoverageBlocker =
  (typeof CoverageBlockers)[keyof typeof CoverageBlockers];

// ============== exclusiones ==============

/**
 * Cuentas que no cuentan como crecimiento comercial: simuladas, de prueba, de
 * QA y administradores.
 *
 * El plan (§5) lo pide explícitamente para «suscriptores pagos activos», y vale
 * igual para cohortes: una activación de una cuenta de QA no es adopción. La
 * lista viva está en `growth_excluded_accounts` para poder añadir una cuenta sin
 * desplegar; `GROWTH_EXCLUDED_ACCOUNT_IDS` cubre el arranque y las pruebas.
 */
export const EXCLUDED_ACCOUNTS_COLLECTION = 'growth_excluded_accounts';

export interface ExclusionPolicy {
  /** true si la cuenta no debe contarse como uso ni como pago comercial. */
  isExcluded(accountId: string): boolean;
  readonly size: number;
  readonly source: 'configured' | 'empty';
}

export async function loadExclusionPolicy(
  db: Firestore,
  configured: string | undefined,
  limit = 2000,
): Promise<ExclusionPolicy> {
  const ids = new Set(
    (configured ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );

  const rows = await db
    .collection(EXCLUDED_ACCOUNTS_COLLECTION)
    .limit(limit)
    .get();
  for (const doc of rows.docs) {
    const accountId = doc.get('accountId') ?? doc.id;
    if (typeof accountId === 'string' && accountId) ids.add(accountId);
  }

  return {
    isExcluded: (accountId: string) => ids.has(accountId),
    size: ids.size,
    source: ids.size > 0 ? 'configured' : 'empty',
  };
}

// ============== marcas de agua ==============

export interface SourceWatermarkInput {
  /** Fin de la ventana del planificador. Es un tope, no una fuente. */
  cutoff: string;
  /** Mayor `receivedAt` realmente ingerido, o null si no hay hechos. */
  maxEventReceivedAt: string | null;
  /** Hay entregas pendientes o muertas en cualquiera de las dos colas. */
  eventBacklog: boolean;
  labelEventBacklog: boolean;
  deadEvents: boolean;
  /** Marca de la conciliación de facturación, o null si no está completa. */
  billingWatermark: string | null;
  billingCompletedAt: string | null;
  truncated: boolean;
}

export interface SourceWatermarkResult {
  /**
   * Punto hasta el que **todas** las fuentes están completas. Es el mínimo de
   * las marcas reales, nunca la hora del planificador: publicar la hora del
   * reloj como marca de agua afirma que se sabe algo que no se sabe.
   */
  sourceWatermark: string | null;
  eventWatermark: string | null;
  billingWatermark: string | null;
  /** Último hecho realmente ingerido. Evidencia, no cota del conocimiento. */
  lastIngestedAt: string | null;
  blockers: CoverageBlocker[];
  coverage: Coverage;
}

function min(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

export function resolveSourceWatermark(
  input: SourceWatermarkInput,
): SourceWatermarkResult {
  const blockers: CoverageBlocker[] = [];

  if (input.eventBacklog) blockers.push(CoverageBlockers.EVENT_BACKLOG);
  if (input.labelEventBacklog)
    blockers.push(CoverageBlockers.LABEL_EVENT_BACKLOG);
  if (input.deadEvents) blockers.push(CoverageBlockers.DEAD_EVENTS);
  if (input.truncated) blockers.push(CoverageBlockers.SCAN_LIMIT);

  /**
   * Lo que acota el conocimiento de eventos no es el último hecho que llegó
   * —un sistema tranquilo no deja de saber— sino que la cola esté drenada: con
   * cola pendiente falta por llegar material cuyo `occurredAt` cae dentro de la
   * ventana. Sin ningún hecho ingerido tampoco hay marca: no se puede afirmar
   * que un canal esté drenado si nunca se ha visto pasar nada por él.
   */
  const eventWatermark =
    input.eventBacklog ||
    input.labelEventBacklog ||
    input.deadEvents ||
    !input.maxEventReceivedAt
      ? null
      : input.cutoff;

  if (!eventWatermark && blockers.length === 0)
    blockers.push(CoverageBlockers.NO_EVENT_WATERMARK);

  // La facturación solo aporta marca si su conciliación terminó **antes** del
  // corte: una conciliación posterior sabe cosas que ese día no se sabían.
  const billingUsable =
    input.billingWatermark &&
    input.billingCompletedAt &&
    input.billingCompletedAt <= input.cutoff;
  const billingWatermark =
    billingUsable && input.billingWatermark
      ? min(input.billingWatermark, input.cutoff)
      : null;
  if (!billingWatermark) blockers.push(CoverageBlockers.BILLING_INCOMPLETE);

  const sourceWatermark =
    eventWatermark && billingWatermark
      ? min(eventWatermark, billingWatermark)
      : null;

  return {
    sourceWatermark,
    eventWatermark,
    billingWatermark,
    lastIngestedAt: input.maxEventReceivedAt,
    blockers,
    coverage: sourceWatermark
      ? 'complete'
      : eventWatermark || billingWatermark
        ? 'partial'
        : 'missing_data',
  };
}

/**
 * ¿Puede un observable externo entrar en un snapshot con este corte?
 *
 * Exige que se haya observado **antes** del corte y dentro de la ventana de
 * frescura. El `<` por sí solo no basta: una observación posterior al corte da
 * una diferencia negativa, que también es menor que la frescura, y así el
 * inventario de hoy acababa sellado dentro del snapshot de hace seis días.
 */
export function observationUsableAt(
  observedAt: string | null | undefined,
  cutoff: string,
  freshnessMs: number,
): boolean {
  if (!observedAt) return false;
  const observed = Date.parse(observedAt);
  const end = Date.parse(cutoff);
  if (!Number.isFinite(observed) || !Number.isFinite(end)) return false;
  const age = end - observed;
  return age >= 0 && age < freshnessMs;
}

// ============== fencing de publicación ==============

export class LeaseLostError extends Error {
  constructor() {
    super('Growth job lease lost');
  }
}

/**
 * Comprobación de lease **dentro** de la transacción que publica.
 *
 * Antes el job escribía el snapshot y `latest`, y solo después comprobaba el
 * token: un proceso con el lease vencido llegaba a publicar su resultado y
 * podía hacer retroceder `latest`. Al leer el documento de ejecución en la
 * misma transacción que la escritura, la publicación y la propiedad del lease
 * se deciden juntas: si otro proceso tomó el relevo, la transacción no escribe
 * nada.
 */
export class LeaseFence {
  constructor(
    private readonly runRef: FirebaseFirestore.DocumentReference,
    private readonly token: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Se llama como primera lectura de la transacción que va a publicar. */
  async assert(tx: Transaction): Promise<void> {
    const snapshot = await tx.get(this.runRef);
    const data = snapshot.data();
    if (!data || data.token !== this.token) throw new LeaseLostError();
    if (!(data.leaseUntil > this.now())) throw new LeaseLostError();
  }
}
