import { BillingReconciliationService } from './billing-reconciliation.service.js';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Timestamp } from '@google-cloud/firestore';
import { createHash, randomUUID } from 'node:crypto';
import { FirestoreService } from '../cache/firestore.service.js';
import { ProductEventOutboxService } from '../product-observability/product-event-outbox.service.js';
import {
  FEATURE_IDS,
  SERVER_EVENTS,
} from '../product-observability/observability.types.js';
import {
  calculateFeatureCohorts,
  calculatePaid30d,
  Assignment,
  CohortEvent,
  PaymentFact,
} from './cohort-metrics.js';
import {
  CoverageBlockers,
  LeaseFence,
  LeaseLostError,
  loadExclusionPolicy,
  observationUsableAt,
  resolveSourceWatermark,
} from './growth-sources.js';
import type { CoverageBlocker } from './growth-sources.js';
import { calculateRenewals } from './renewal-cohorts.js';
import type { CycleInvoice, RenewalSubscription } from './renewal-cohorts.js';
import { buildEnterpriseSegment } from './enterprise-segment.js';
import { buildCostLedger } from './cost-ledger.js';
import { summarizeOperationalSignals } from './operational-signals.js';
import { GrowthRetentionService } from '../growth-operations/growth-retention.service.js';
import { summarizeTourEvents } from './tour-metrics.js';
import type { OperationalSignal } from './operational-signals.js';
const DAY = 86400000;
const CALCULATION_VERSION = 'growth-v2';
/** Frescura máxima de una observación externa para entrar en un snapshot. */
const OBSERVATION_FRESHNESS_MS = 36 * 3600000;
/** Cola de salida de los hechos de BE04/BE05: su atraso también invalida cobertura. */
const LABEL_EVENT_OUTBOX = 'label_event_retries';
/** Gracia por defecto para madurar una renovación, en días. */
const DEFAULT_RENEWAL_GRACE_DAYS = 7;
@Injectable()
export class GrowthJobsService {
  constructor(
    private readonly firestore: FirestoreService,
    private readonly outbox: ProductEventOutboxService,
    private readonly config: ConfigService,
    private readonly billing: BillingReconciliationService,
  ) {}

  /** Scheduler retries share a durable bucket identity and a fencing token. */
  async run(
    job:
      | 'outbox'
      | 'quality'
      | 'aggregate'
      | 'billing-reconcile'
      | 'retention'
      | 'feedback'
      | 'panel',
    scheduledAt?: string,
  ) {
    const now = Date.now();
    const scheduled = scheduledAt ? Date.parse(scheduledAt) : now;
    if (
      !Number.isFinite(scheduled) ||
      scheduled > now + 60000 ||
      scheduled < now - 90 * DAY
    )
      throw new Error('Invalid scheduler window');
    const interval =
      job === 'outbox' ? 300000 : job === 'quality' ? 900000 : DAY;
    const offset = interval === DAY ? 6 * 3600000 : 0;
    const end = Math.floor((scheduled - offset) / interval) * interval + offset;
    const windowStartUtc = new Date(end - interval).toISOString();
    const windowEndUtc = new Date(end).toISOString();
    const id = `${job}_${end - interval}_${end}_${CALCULATION_VERSION}`;
    const db = this.firestore.getClient();
    const ref = db.collection('growth_job_runs').doc(id);
    const token = randomUUID();
    const claim = await db.runTransaction(async (tx) => {
      const current = (await tx.get(ref)).data();
      if (current?.status === 'completed' || current?.leaseUntil > now)
        return false;
      if ((current?.attempts ?? 0) >= 8) {
        tx.update(ref, { status: 'dead', errorCode: 'ATTEMPTS_EXHAUSTED' });
        return false;
      }
      tx.set(
        ref,
        {
          job,
          windowStartUtc,
          windowEndUtc,
          timezone: 'America/Merida',
          cursor: current?.cursor ?? null,
          token,
          status: 'running',
          leaseUntil: now + 10 * 60000,
          startedAt: new Date(now).toISOString(),
          calculationVersion: CALCULATION_VERSION,
          attempts: (current?.attempts ?? 0) + 1,
        },
        { merge: true },
      );
      return true;
    });
    if (!claim) return { status: 'already_claimed', runId: id };
    // Todo lo que publique un resultado lo hace con este fence: la comprobación
    // del token ocurre DENTRO de la transacción que escribe, no después.
    const fence = new LeaseFence(ref, token);
    try {
      const result =
        job === 'outbox'
          ? await this.dispatch()
          : job === 'aggregate'
            ? await this.aggregateRecent(windowEndUtc, fence)
            : job === 'billing-reconcile'
              ? {
                  attribution: await this.reconcileBilling(),
                  stripe: await this.billing.run(10, fence),
                }
              : job === 'retention'
                ? await this.retention(fence)
                : job === 'feedback'
                  ? await this.prepareFeedbackCandidates(fence)
                  : job === 'panel'
                    ? await this.publishPanel(fence)
                    : await this.quality(fence);
      await db.runTransaction(async (tx) => {
        const lease = (await tx.get(ref)).data();
        if (lease?.token !== token || lease.leaseUntil <= Date.now())
          throw new Error('Job lease lost');
        tx.update(ref, {
          status: 'completed',
          completedAt: new Date().toISOString(),
          leaseUntil: 0,
          result,
          sourceWatermark: (result as any).sourceWatermark ?? null,
          checksum: createHash('sha256')
            .update(JSON.stringify(result))
            .digest('hex'),
        });
      });
      return { status: 'completed', runId: id, result };
    } catch (error) {
      const lost = error instanceof LeaseLostError;
      await db.runTransaction(async (tx) => {
        if ((await tx.get(ref)).get('token') === token)
          tx.update(ref, {
            status: 'failed',
            leaseUntil: 0,
            // Un lease perdido no es un fallo del cálculo: otro proceso tomó el
            // relevo de esta misma ventana y es el que debe publicar.
            errorCode: lost ? 'LEASE_LOST' : 'JOB_FAILED',
          });
      });
      throw new Error(
        lost
          ? 'Growth job lease lost; another worker owns this scheduler window'
          : 'Growth job failed; retry the same scheduler window',
      );
    }
  }

  private async dispatch() {
    const db = this.firestore.getClient();
    return this.outbox.dispatch(async (event, key) => {
      const ref = db.collection('growth_event_facts').doc(key);
      await db.runTransaction(async (tx) => {
        const prior = await tx.get(ref);
        const deleted = await tx.get(
          db.collection('deleted_accounts').doc(event.accountId),
        );
        const anchorRef = db.collection('growth_account_feature_firsts').doc(
          createHash('sha256')
            .update(
              JSON.stringify([
                event.environment,
                event.accountId,
                event.featureId,
              ]),
            )
            .digest('hex'),
        );
        const anchor = (await tx.get(anchorRef)).data();
        if (prior.exists || deleted.exists) return;
        if (event.eventName === 'feature_exposed') {
          tx.set(
            anchorRef,
            {
              accountId: event.accountId,
              featureId: event.featureId,
              environment: event.environment,
              isSynthetic: event.isSynthetic,
              firstExposureAt:
                anchor?.firstExposureAt &&
                anchor.firstExposureAt < event.occurredAt
                  ? anchor.firstExposureAt
                  : event.occurredAt,
            },
            { merge: true },
          );
        }
        tx.create(ref, {
          ...event,
          expiresAt: Timestamp.fromMillis(
            Date.parse(event.receivedAt) + 90 * DAY,
          ),
        });
      });
    }, 100);
  }

  async quality(fence?: LeaseFence) {
    const db = this.firestore.getClient();
    const now = new Date().toISOString();
    const [pending, dead, labelPending, labelDead] = await Promise.all([
      db
        .collection('event_outbox')
        .where('availableAt', '<=', now)
        .limit(1001)
        .get(),
      db
        .collection('event_outbox')
        .where('state', '==', 'dead')
        .limit(1001)
        .get(),
      // La cola de BE04/BE05 cuenta igual: un hecho de exportación sin entregar
      // es medición que falta, aunque la otra cola esté vacía.
      db
        .collection(LABEL_EVENT_OUTBOX)
        .where('availableAt', '<=', now)
        .limit(1001)
        .get(),
      db
        .collection(LABEL_EVENT_OUTBOX)
        .where('status', '==', 'dead')
        .limit(1001)
        .get(),
    ]);
    const backlog =
      pending.size + dead.size + labelPending.size + labelDead.size;
    const result = {
      schemaVersion: 1,
      status: backlog ? 'degraded' : 'observed',
      generatedAt: now,
      pending: pending.size,
      dead: dead.size,
      labelEventPending: labelPending.size,
      labelEventDead: labelDead.size,
      countsTruncated: [pending, dead, labelPending, labelDead].some(
        (snapshot) => snapshot.size > 1000,
      ),
      // La calidad de la medición no autoriza a concluir nada de negocio.
      canEvaluateGrowth: false,
    };
    await this.publish(
      db.collection('growth_quality').doc('latest'),
      result,
      fence,
    );
    return result;
  }

  /**
   * Publica un documento comprobando el lease en la MISMA transacción.
   *
   * Sin esto, un proceso cuyo lease ya había vencido escribía `latest` y solo
   * después descubría que había perdido la ventana: el panel podía retroceder a
   * un resultado calculado con datos viejos.
   */
  private async publish(
    ref: FirebaseFirestore.DocumentReference,
    value: Record<string, unknown>,
    fence?: LeaseFence,
    extra?: (tx: FirebaseFirestore.Transaction) => void,
  ) {
    const db = this.firestore.getClient();
    await db.runTransaction(async (tx) => {
      if (fence) await fence.assert(tx);
      tx.set(ref, value);
      extra?.(tx);
    });
  }

  private async aggregateRecent(cutoff: string, fence?: LeaseFence) {
    const results = [];
    // El día más reciente se publica al final, así que un backfill histórico no
    // puede hacer retroceder `latest`.
    for (let days = 6; days >= 0; days--)
      results.push(
        await this.aggregate(
          new Date(Date.parse(cutoff) - days * DAY).toISOString(),
          days === 0,
          fence,
        ),
      );
    return { ...results.at(-1), backfilledDays: results.length };
  }

  private async aggregate(
    cutoff: string,
    publishLatest = true,
    fence?: LeaseFence,
  ) {
    const db = this.firestore.getClient();
    const start = new Date(Date.parse(cutoff) - 89 * DAY).toISOString();
    const now = new Date().toISOString();
    const environment =
      this.config.get<string>('PRODUCT_ENVIRONMENT') ??
      this.config.get<string>('NODE_ENV') ??
      'development';
    const live = environment === 'production';
    const [
      eventRows,
      assignmentRows,
      paymentRows,
      backlog,
      deadOutbox,
      labelBacklog,
      labelDead,
      billingSync,
      pendingBilling,
      anchors,
    ] = await Promise.all([
      db
        .collection('growth_event_facts')
        .where('receivedAt', '>=', start)
        .orderBy('receivedAt')
        .limit(10001)
        .get(),
      db
        .collection('growth_assignments')
        .where('assignedAt', '>=', start)
        .orderBy('assignedAt')
        .limit(10001)
        .get(),
      db
        .collection('growth_first_payments')
        .where('livemode', '==', live)
        .limit(10001)
        .get(),
      db
        .collection('event_outbox')
        .where('state', 'in', ['pending', 'leased'])
        .limit(1)
        .get(),
      db.collection('event_outbox').where('state', '==', 'dead').limit(1).get(),
      db
        .collection(LABEL_EVENT_OUTBOX)
        .where('availableAt', '<=', now)
        .limit(1)
        .get(),
      db
        .collection(LABEL_EVENT_OUTBOX)
        .where('status', '==', 'dead')
        .limit(1)
        .get(),
      db
        .collection('growth_billing_sync')
        .doc(live ? 'live' : 'test')
        .get(),
      db
        .collection('billing_facts')
        .where('attributionStatus', '==', 'pending')
        .limit(1)
        .get(),
      db
        .collection('growth_account_feature_firsts')
        .where('firstExposureAt', '>=', start)
        .limit(10001)
        .get(),
    ]);

    const exclusions = await loadExclusionPolicy(
      db,
      this.config.get<string>('GROWTH_EXCLUDED_ACCOUNT_IDS'),
    );
    const truncated = [eventRows, assignmentRows, paymentRows, anchors].some(
      (snapshot) => snapshot.size > 10000,
    );
    const history = billingSync.data();
    const financialStock = (
      await db
        .collection('growth_paid_stocks')
        .doc(live ? 'live_latest' : 'test_latest')
        .get()
    ).data();
    const period = cutoff.slice(0, 7);
    const runId = financialStock?.runId;
    const [
      inventoryMembers,
      cycleInvoiceRows,
      enterpriseRows,
      contractRows,
      costRows,
      signalRows,
    ] = await Promise.all([
      // Miembros del inventario publicado: de ahí salen los períodos de
      // suscripción y quién ya está contado en Stripe.
      runId
        ? db
            .collection('growth_paid_inventory_members')
            .where('runId', '==', runId)
            .limit(10001)
            .get()
        : null,
      db
        .collection('billing_facts')
        .where('livemode', '==', live)
        .where('type', '==', 'invoice_paid')
        .where('occurredAt', '>=', start)
        .limit(10001)
        .get(),
      // Fuente interna observada de Enterprise: el plan del perfil, no Stripe.
      db
        .collection('users')
        .where('plan', '==', 'enterprise')
        .limit(1001)
        .get(),
      db
        .collection('growth_enterprise_contracts')
        .where('period', '==', period)
        .limit(1001)
        .get(),
      db
        .collection('growth_cost_entries')
        .where('period', '==', period)
        .limit(1001)
        .get(),
      db
        .collection('growth_operational_signals')
        .where('occurredAt', '>=', start)
        .limit(10001)
        .get(),
    ]);

    const blockers: CoverageBlocker[] = [];

    // La conciliación solo aporta si terminó ANTES del corte: una conciliación
    // posterior conoce cobros que ese día no se conocían, y meterla en un
    // snapshot histórico lo convierte en una predicción.
    const billingUsable =
      history?.status === 'complete' &&
      history.unresolved === 0 &&
      observationUsableAt(
        history.completedAt,
        cutoff,
        OBSERVATION_FRESHNESS_MS,
      );
    if (history?.status === 'complete' && !billingUsable)
      blockers.push(CoverageBlockers.BILLING_STALE);
    if (!pendingBilling.empty)
      blockers.push(CoverageBlockers.BILLING_ATTRIBUTION_PENDING);

    const watermarks = resolveSourceWatermark({
      cutoff,
      // Los hechos vienen ordenados por `receivedAt`: el último es el máximo
      // realmente ingerido. La marca sale de ahí, no del reloj del planificador.
      maxEventReceivedAt: eventRows.docs.at(-1)?.get('receivedAt') ?? null,
      eventBacklog: !backlog.empty,
      labelEventBacklog: !labelBacklog.empty,
      deadEvents: !deadOutbox.empty || !labelDead.empty,
      billingWatermark: billingUsable ? history.sourceWatermark : null,
      billingCompletedAt: billingUsable ? history.completedAt : null,
      truncated,
    });
    blockers.push(...watermarks.blockers);

    const cohortStart = this.config.get<string>('GROWTH_COHORT_START');
    const validCohortStart =
      Number.isFinite(Date.parse(cohortStart ?? '')) &&
      Date.parse(cohortStart) <= Date.parse(cutoff);
    if (!validCohortStart) blockers.push(CoverageBlockers.COHORT_START_MISSING);

    const usable = (accountId: string) => !exclusions.isExcluded(accountId);
    const cohortAnchors = new Set(
      anchors.docs
        .map((d) => d.data())
        .filter(
          (a) =>
            a.environment === environment &&
            !a.isSynthetic &&
            usable(a.accountId) &&
            validCohortStart &&
            a.firstExposureAt >= cohortStart,
        )
        .map((a) => JSON.stringify([a.accountId, a.featureId])),
    );
    const eventDocs = eventRows.docs.map((d) => d.data());
    const events = eventDocs.filter(
      (e) =>
        e.environment === environment && !e.isSynthetic && usable(e.accountId),
    ) as CohortEvent[];
    // Hechos que llegaron después del corte pero ocurrieron antes: este
    // snapshot es una revisión, y se dice.
    const lateEventCount = eventDocs.filter(
      (e) => e.receivedAt > cutoff && e.occurredAt <= cutoff,
    ).length;
    const assignments = assignmentRows.docs
      .map((d) => d.data())
      .filter(
        (a) =>
          a.environment === environment &&
          !a.isSynthetic &&
          usable(a.accountId),
      );
    const paymentDocs = paymentRows.docs
      .map((d) => d.data())
      .filter((p) => usable(p.accountId));
    const payments = paymentDocs.map((p) => ({
      accountId: p.accountId,
      paidAt: p.firstPaidAt,
      amountMinor: p.amountMinor,
    })) as PaymentFact[];

    // «Primer pago» solo es primero si se leyó el histórico completo de
    // facturas. Con cobertura de webhook el mínimo observado puede ser el
    // segundo pago, y entonces una cuenta que ya pagaba parecería conversión.
    const partialFirstPayments = paymentDocs.filter(
      (p) => p.coverage !== 'reconciled_history',
    ).length;
    const firstPaymentCoverage: 'complete' | 'partial' | 'missing_data' =
      !billingUsable
        ? 'missing_data'
        : partialFirstPayments > 0
          ? 'partial'
          : 'complete';
    if (firstPaymentCoverage === 'partial')
      blockers.push(CoverageBlockers.FIRST_PAYMENT_COVERAGE);

    const financialStockRow = financialStock;
    // El inventario tiene su propia ventana. Exigir que se observara antes del
    // corte es lo que impide sellar el inventario de hoy dentro del snapshot de
    // hace seis días: una observación posterior da una edad negativa, que
    // también es «menor que la frescura».
    const inventoryUsable = observationUsableAt(
      financialStockRow?.observedAt,
      cutoff,
      OBSERVATION_FRESHNESS_MS,
    );
    if (!financialStockRow) blockers.push(CoverageBlockers.INVENTORY_MISSING);
    else if (!inventoryUsable)
      blockers.push(CoverageBlockers.INVENTORY_AFTER_CUTOFF);

    // ============== renovación por intervalo ==============
    const members = (inventoryMembers?.docs ?? [])
      .map((doc) => doc.data())
      .filter((row) => row.livemode === live);
    const renewalSubscriptions = members
      .filter((row) => row.subscriptionId)
      .map<RenewalSubscription>((row) => ({
        subscriptionId: row.subscriptionId,
        accountId: row.accountId,
        billingInterval: row.billingInterval ?? 'unknown',
        currentPeriodEnd: row.currentPeriodEnd ?? null,
        status: row.status,
        cancellationScheduled: row.cancellationScheduled === true,
      }));
    const cycleInvoices = cycleInvoiceRows.docs
      .map((doc) => doc.data())
      .filter((row) => row.positivePayment && row.occurredAt <= cutoff)
      .map<CycleInvoice>((row) => ({
        invoiceId: row.objectId,
        subscriptionId: row.subscriptionId ?? null,
        accountId: row.accountId ?? null,
        billingReason: row.billingReason ?? null,
        paidAt: row.occurredAt,
        amountMinor: row.amountMinor,
        currency: row.currency,
      }));
    const graceDays = Number.parseInt(
      this.config.get<string>('GROWTH_RENEWAL_GRACE_DAYS') ?? '',
      10,
    );
    const renewals = calculateRenewals({
      subscriptions: renewalSubscriptions,
      invoices: cycleInvoices,
      // La renovación se madura contra la marca de agua real, no contra el
      // corte: sin cobertura de facturación no hay renovación que afirmar.
      watermark: watermarks.sourceWatermark ?? cutoff,
      graceDays: Number.isFinite(graceDays)
        ? graceDays
        : DEFAULT_RENEWAL_GRACE_DAYS,
      invoiceCoverage:
        billingUsable && !truncated && cycleInvoiceRows.size <= 10000
          ? 'complete'
          : 'missing_data',
      isExcluded: (accountId) => exclusions.isExcluded(accountId),
    });

    // ============== Enterprise manual ==============
    const enterpriseSegment = buildEnterpriseSegment({
      period,
      internalAccounts: enterpriseRows.docs.map((doc) => ({
        accountId: doc.id,
        plan: doc.get('plan'),
        observedAt: now,
      })),
      stripeInventoryAccounts: members.map((row) => row.accountId),
      contracts: contractRows.docs.map((doc) => doc.data() as any),
      inventoryCoverage:
        inventoryUsable && financialStock?.status === 'complete'
          ? 'complete'
          : 'missing_data',
      isExcluded: (accountId) => exclusions.isExcluded(accountId),
    });

    // ============== economía ==============
    const revenueLedger = financialStock?.revenueLedger;
    const costLedger = buildCostLedger({
      period,
      entries: costRows.docs.map((doc) => doc.data() as any),
      netRevenueByCurrency: (revenueLedger?.byCurrency ?? []).map(
        (row: any) => ({ currency: row.currency, netMinor: row.netMinor }),
      ),
      revenueCoverage:
        inventoryUsable && revenueLedger?.coverage === 'complete'
          ? 'complete'
          : 'missing_data',
    });

    // ============== fricciones operativas ==============
    const operationalSignals = summarizeOperationalSignals({
      signals: signalRows.docs.map((doc) => doc.data() as OperationalSignal),
      window: { start, end: cutoff },
      environment,
      coverageStartedAt: this.config.get<string>(
        'GROWTH_OPERATIONAL_SIGNALS_START',
      ),
      truncated: signalRows.size > 10000,
      isExcluded: (accountId) => exclusions.isExcluded(accountId),
    });

    /**
     * Acumulador de cuentas convertidas. Vive solo en memoria y su contenido
     * nunca entra en el snapshot: del cruce entre funcionalidades se publica el
     * tamaño, que es lo que hace falta para no contar la misma cuenta como
     * varios clientes.
     */
    const convertedCollector = new Set<string>();

    const uniqueBlockers = [...new Set(blockers)];
    const complete =
      uniqueBlockers.length === 0 && !!watermarks.sourceWatermark;

    const snapshot = {
      schemaVersion: 2,
      calculationVersion: CALCULATION_VERSION,
      generatedAt: now,
      /** Momento del conocimiento usado; con datos tardíos esto es una revisión. */
      knowledgeAsOf: now,
      isRevision: lateEventCount > 0,
      lateEventCount,
      paidAccountStock: inventoryUsable
        ? financialStockRow
        : {
            status: 'missing_data',
            reason: financialStockRow
              ? 'inventory_outside_snapshot_window'
              : 'no_inventory',
          },
      /**
       * El inventario es existencias de suscripciones pagas en un instante.
       * No es conversión ni actividad: una cuenta puede estar en el inventario
       * sin haber generado un solo evento de uso.
       */
      paidAccountStockSemantics: 'point_in_time_stock_not_conversion',
      billingCoverage: billingUsable ? 'complete' : 'missing_data',
      billingWatermark: watermarks.billingWatermark,
      eventWatermark: watermarks.eventWatermark,
      lastIngestedAt: watermarks.lastIngestedAt,
      firstPaymentCoverage,
      partialFirstPayments,
      cohortStart: validCohortStart ? cohortStart : null,
      sourceWatermark: watermarks.sourceWatermark,
      coverage: complete ? 'complete' : watermarks.coverage,
      blockers: uniqueBlockers,
      excludedAccountsConfigured: exclusions.size,
      window: { start, end: cutoff },
      environment,
      status: !complete
        ? 'incomplete'
        : events.length
          ? 'observed'
          : 'insufficient_data',
      // Tour activity depends on event ingestion, not Stripe reconciliation.
      tour: summarizeTourEvents(
        events,
        { start, end: cutoff },
        eventRows.size <= 10000 && backlog.empty && deadOutbox.empty,
      ),
      reason: !complete
        ? (uniqueBlockers[0] ?? 'coverage_incomplete')
        : events.length
          ? 'descriptive_not_causal'
          : 'no_events',
      features: !complete
        ? []
        : FEATURE_IDS.map((featureId) => ({
            ...calculateFeatureCohorts(
              events.filter(
                (e) =>
                  e.eventName !== 'feature_exposed' ||
                  cohortAnchors.has(JSON.stringify([e.accountId, e.featureId])),
              ),
              featureId,
              cutoff,
              // Población elegible conocida: las cuentas asignadas a la
              // funcionalidad. Sin asignaciones el alcance queda missing_data.
              [
                ...new Set(
                  assignments
                    .filter((a) => a.featureId === featureId)
                    .map((a) => a.accountId),
                ),
              ],
            ),
            paid30dByAssignment: [
              ...new Set(
                assignments
                  .filter((a) => a.featureId === featureId)
                  .map((a) =>
                    JSON.stringify([
                      a.experimentId,
                      a.assignmentVersion,
                      a.variant,
                    ]),
                  ),
              ),
            ].map((key) => {
              const [experimentId, assignmentVersion, variant] =
                JSON.parse(key);
              const group = assignments.filter(
                (a) =>
                  a.featureId === featureId &&
                  a.experimentId === experimentId &&
                  a.assignmentVersion === assignmentVersion &&
                  a.variant === variant,
              );
              return {
                experimentId,
                assignmentVersion,
                variant,
                ...calculatePaid30d(
                  group as Assignment[],
                  payments,
                  cutoff,
                  firstPaymentCoverage,
                  convertedCollector,
                ),
              };
            }),
          })),
      /** Renovación mensual y anual, con cohortes maduras. */
      renewals,
      /** Enterprise gestionado a mano: segmento aparte, nunca sumado a Stripe. */
      enterpriseSegment,
      /** Ingreso menos costes declarados, solo con cobertura completa. */
      economics: costLedger,
      /**
       * Contraseñales. No son crecimiento y no se restan de él: son la razón
       * por la que una tasa puede no significar lo que parece.
       */
      counterSignals: {
        eventBacklog: !backlog.empty,
        eventsDead: !deadOutbox.empty,
        labelEventBacklog: !labelBacklog.empty,
        labelEventsDead: !labelDead.empty,
        billingAttributionPending: !pendingBilling.empty,
        billingUnresolved: history?.unresolved ?? null,
        scanTruncated: truncated,
        /**
         * Intentos HTTP autenticados que fallaron. No son operaciones: no se
         * suman ni se restan de los éxitos, y su cobertura máxima es de mejor
         * esfuerzo porque la anotación puede fallar sin romper la petición.
         */
        operational: operationalSignals,
      },
      accountEventCount: events.length,
      accountsCounted: new Set(events.map((e) => e.accountId)).size,
      /**
       * Cuentas distintas convertidas en todas las funcionalidades. Es un
       * recuento: los identificadores no salen del proceso.
       */
      distinctConvertedAccounts: convertedCollector.size,
      crossFeatureSemantics: 'do_not_sum_converted_accounts_across_features',
    };

    const dayRef = db
      .collection('growth_snapshots')
      .doc(`${cutoff.slice(0, 10)}_${CALCULATION_VERSION}`);
    const latestRef = db.collection('growth_snapshots').doc('latest');
    await this.publish(dayRef, snapshot, fence, (tx) => {
      if (publishLatest) tx.set(latestRef, snapshot);
    });

    return {
      status: snapshot.status,
      sourceWatermark: snapshot.sourceWatermark,
      reason: snapshot.reason,
      coverage: snapshot.coverage,
      blockers: uniqueBlockers,
    };
  }

  /** Reconciles local verified Stripe facts only; never changes subscriptions or charges. */
  private async reconcileBilling() {
    const db = this.firestore.getClient();
    const live =
      (this.config.get('PRODUCT_ENVIRONMENT') ??
        this.config.get('NODE_ENV')) === 'production';
    // Atribución dentro del mismo modo: un hecho de prueba no resuelve contra
    // una cuenta de producción ni al contrario.
    const rows = await db
      .collection('billing_facts')
      .where('attributionStatus', '==', 'pending')
      .where('livemode', '==', live)
      .limit(100)
      .get();
    let resolved = 0;
    for (const row of rows.docs) {
      const user = await this.firestore.getUserByStripeCustomerId(
        row.get('customerId'),
      );
      if (!user || (await this.firestore.isAccountDeletionMarked(user.id)))
        continue;
      await db.runTransaction(async (tx) => {
        const current = await tx.get(row.ref);
        const tombstone = await tx.get(
          db.collection('deleted_accounts').doc(user.id),
        );
        if (tombstone.exists || current.get('attributionStatus') !== 'pending')
          return;
        tx.update(row.ref, {
          accountId: user.id,
          attributionStatus: 'resolved',
        });
      });
      resolved++;
    }
    return {
      scanned: rows.size,
      resolved,
      // Quedan pendientes los que no tienen cuenta local: no se inventa
      // atribución y el snapshot lo trata como cobertura incompleta.
      stillPending: rows.size - resolved,
      truncated: rows.size === 100,
      scope: 'local_verified_facts',
      stripeBackfill: 'not_run',
    };
  }

  private async publishPanel(fence?: LeaseFence) {
    const db = this.firestore.getClient();
    const source = (
      await db.collection('growth_snapshots').doc('latest').get()
    ).data();
    const quality = (
      await db.collection('growth_quality').doc('latest').get()
    ).data();
    // Una recomendación comercial exige las tres cosas: uso completo,
    // facturación conciliada y medición sana. Cualquier hueco la bloquea.
    const blockers: string[] = [];
    if (source?.status !== 'observed')
      blockers.push('usage_snapshot_incomplete');
    if (source?.coverage !== 'complete')
      blockers.push('usage_coverage_incomplete');
    if (source?.billingCoverage !== 'complete')
      blockers.push('billing_coverage_incomplete');
    if (source?.firstPaymentCoverage !== 'complete')
      blockers.push('first_payment_coverage_incomplete');
    if (quality?.status !== 'observed') blockers.push('measurement_degraded');
    if (!source?.sourceWatermark) blockers.push('no_source_watermark');
    if (
      !source?.generatedAt ||
      Date.now() - Date.parse(source.generatedAt) >= OBSERVATION_FRESHNESS_MS
    )
      blockers.push('usage_snapshot_stale');
    if (
      !quality?.generatedAt ||
      Date.now() - Date.parse(quality.generatedAt) >= 3600000
    )
      blockers.push('quality_stale');

    const complete = blockers.length === 0;
    const panel = {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      status: complete ? 'observed' : 'incomplete',
      sourceWatermark: complete ? source.sourceWatermark : null,
      canEvaluateGrowth: complete,
      sourceCalculationVersion: source?.calculationVersion ?? null,
      blockers,
      counterSignals: source?.counterSignals ?? {
        status: 'missing_data',
        reason: 'no_usage_snapshot',
      },
      /** Asociación descriptiva; nunca una afirmación de causalidad. */
      reason: complete ? 'descriptive_not_causal' : 'dependencies_incomplete',
    };
    await this.publish(
      db.collection('growth_panel_receipts').doc('latest'),
      panel,
      fence,
    );
    return panel;
  }

  private async prepareFeedbackCandidates(fence?: LeaseFence) {
    const db = this.firestore.getClient();
    const facts = await db
      .collection('growth_event_facts')
      .where('receivedAt', '>=', new Date(Date.now() - 7 * DAY).toISOString())
      .limit(1001)
      .get();
    if (facts.size > 1000)
      return { status: 'incomplete', reason: 'scan_limit', created: 0 };
    const environment =
      this.config.get('PRODUCT_ENVIRONMENT') ??
      this.config.get('NODE_ENV') ??
      'development';
    const exclusions = await loadExclusionPolicy(
      db,
      this.config.get<string>('GROWTH_EXCLUDED_ACCOUNT_IDS'),
    );
    const candidates = new Map<string, any>();
    for (const doc of facts.docs) {
      const e = doc.data();
      if (
        !e.isSynthetic &&
        e.environment === environment &&
        !exclusions.isExcluded(e.accountId) &&
        e.source !== 'web' &&
        SERVER_EVENTS.includes(e.eventName) &&
        /(_succeeded|_acknowledged|_completed)$/.test(e.eventName)
      )
        candidates.set(e.accountId, e);
    }
    let created = 0;
    for (const [accountId, event] of candidates) {
      const last = await this.firestore.getLastFeedbackByUser(accountId);
      const saved = await db.runTransaction(async (tx) => {
        // El fence entra aquí también: un job con el lease vencido no debe
        // sembrar invitaciones que otro proceso ya está calculando.
        if (fence) await fence.assert(tx);
        const ref = db.collection('in_app_feedback_candidates').doc(accountId);
        const prior = await tx.get(ref),
          cadence = await tx.get(
            db.collection('feedback_cadence').doc(accountId),
          );
        const deleted = await tx.get(
          db.collection('deleted_accounts').doc(accountId),
        );
        if (
          deleted.exists ||
          (prior.exists && prior.get('expiresAt').toMillis() > Date.now())
        )
          return false;
        const recent = Math.max(
          last ? new Date(last.createdAt).getTime() : 0,
          Date.parse(cadence.get('lastInvitedAt') ?? '') || 0,
          Date.parse(cadence.get('lastSubmittedAt') ?? '') || 0,
        );
        if (Date.now() - recent < 30 * DAY) return false;
        tx.set(ref, {
          accountId,
          featureId: event.featureId,
          state: 'eligible',
          createdAt: new Date().toISOString(),
          expiresAt: Timestamp.fromMillis(Date.now() + 30 * DAY),
        });
        return true;
      });
      if (saved) created++;
    }
    return { status: 'completed', created, scanned: facts.size };
  }

  /**
   * A12 — retención acotada.
   *
   * La lista es una **allowlist**, no «todas las colecciones con expiresAt», y
   * esto es deliberado. Hay tres clases de documento que caducan y que aun así
   * no se pueden barrer desde aquí:
   *
   * - `label_event_retries` en estado `dead`: es la evidencia de un hecho que
   *   ocurrió y no se pudo registrar. Borrarlo destruiría justo lo que hay que
   *   reconciliar, y además esos documentos ya no tienen `expiresAt`.
   * - Reservas de idempotencia activas (`label_workflow_exports`,
   *   `label_template_runs`, operaciones durables): borrar una reserva viva
   *   convierte un reintento en una segunda conversión cobrada.
   * - Credenciales y tokens pendientes de revocación (claves de API,
   *   conexiones de Drive): su baja tiene su propio flujo; una limpieza por
   *   tiempo los dejaría revocados a medias o vivos sin dueño.
   *
   * Cada colección nueva se añade solo cuando alguien comprueba que no es
   * ninguna de las tres cosas.
   */
  /**
   * A12 — retención en dos capas.
   *
   * La primera es un barrido por `expiresAt` y **solo** para colecciones cuyo
   * contenido es dato de medición: si se pierde una fila de `product_events`
   * vencida no desaparece ninguna reserva ni ninguna evidencia de cobro.
   *
   * `event_outbox` estaba en esta lista y era un error: sus documentos nacen
   * con `expiresAt` **y** con estado, y el barrido ciego borraba a los 90 días
   * un hecho que seguía sin entregar. Ahora pasa por la segunda capa, donde el
   * estado manda: lo `delivered` y vencido se borra y lo `pending`, `leased` o
   * `dead` se conserva y se reporta.
   *
   * La segunda capa es `GrowthRetentionService`: mira el estado, revalida en
   * transacción y solo retira metadatos de operaciones terminales
   * reconciliadas, conservando la identidad de la reserva y la evidencia
   * contable.
   */
  private async retention(fence?: LeaseFence) {
    const db = this.firestore.getClient();
    let deleted = 0;
    const eventDataCollections = [
      'product_events',
      'product_event_dedup',
      'growth_event_facts',
      // Señales operativas: tienen `expiresAt` a 90 días, no son reservas ni
      // secretos, y su pérdida no destruye evidencia financiera.
      'growth_operational_signals',
    ];
    for (const name of eventDataCollections) {
      const rows = await db
        .collection(name)
        .where('expiresAt', '<=', Timestamp.now())
        .limit(400)
        .get();
      const batch = db.batch();
      rows.docs.forEach((d) => batch.delete(d.ref));
      if (!rows.empty) {
        await batch.commit();
        deleted += rows.size;
      }
    }

    // El cursor de la capa por estado se guarda para que la vuelta siguiente
    // avance en vez de volver a mirar la misma página. Se publica con el fence
    // del job: un lease vencido no puede adelantar el cursor de otro.
    const stateRef = db.collection('growth_retention_state').doc('latest');
    const previous = (await stateRef.get()).data();
    const stateAware = await new GrowthRetentionService(db).cleanup({
      limitPerTarget: 200,
      cursors: previous?.nextCursors ?? {},
    });
    await this.publish(
      stateRef,
      {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        nextCursors: stateAware.nextCursors,
      },
      fence,
    );

    return {
      deleted,
      bounded: true,
      /** Tope por colección y vuelta; el resto espera la siguiente ejecución. */
      batchLimit: 400,
      collectionsSwept: eventDataCollections.length,
      stateAware,
      /**
       * Un atraso se clasifica, nunca se resuelve borrando: si una colección
       * protegida acumula documentos vencidos, esto lo reporta y lo deja para
       * su dueño. Borrar un token pendiente de revocar dejaría un secreto vivo
       * sin registro de que había que retirarlo.
       */
      backlogPolicy: 'classify_never_delete_protected',
      /** Lo que NO se barre a ciegas, y por qué, va en el contrato de retención. */
      protectedFromRetention: [
        // Cola de hechos: un pendiente o un `dead` es evidencia de algo que
        // ocurrió y todavía no se registró. Nunca se borra por antigüedad; la
        // capa por estado sí retira lo ya entregado.
        'event_outbox',
        'label_event_retries',
        // Reservas de idempotencia: borrarlas convierte una repetición en una
        // segunda conversión cobrada. Solo se les retiran metadatos.
        'label_workflow_exports',
        'label_template_runs',
        // Trabajos y operaciones con contador o cuota reservada en vuelo.
        'api_jobs',
        'api_job_inputs',
        'durable_operations',
        // Secretos y su revocación: solo el `ack` caduca; lo pendiente o
        // fallido guarda un token que todavía hay que revocar.
        'drive_revocations',
        'drive_oauth_states',
        'api_credentials',
        'integration_connections',
        // Presets versionados: sin TTL por contrato de su módulo.
        'pdf_output_presets',
        'pdf_output_preset_versions',
        // Hechos y agregados financieros: son la evidencia de lo que se
        // afirmó y de lo que se cobró.
        'billing_facts',
        'growth_first_payments',
        'growth_cost_entries',
        'growth_enterprise_contracts',
        'growth_paid_stocks',
        'growth_snapshots',
        'conversion_history',
      ],
    };
  }
}
