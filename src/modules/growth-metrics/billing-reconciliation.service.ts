import { calculatePaidAccountBridge } from './cohort-metrics.js';
import { buildRevenueLedger } from './revenue-ledger.js';
import { resolveSubscriptionPeriod } from './renewal-cohorts.js';
import type { RevenueFact } from './revenue-ledger.js';
import { getDateStringInTimezone } from '../../utils/timezone.util.js';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import { FieldValue } from '@google-cloud/firestore';
import { FirestoreService } from '../cache/firestore.service.js';
import { BillingFactsService } from './billing-facts.service.js';
import { LeaseFence } from './growth-sources.js';

/** Read-only Stripe inventory. Pagination survives process death; it never charges or changes access. */
@Injectable()
export class BillingReconciliationService {
  constructor(
    private readonly store: FirestoreService,
    private readonly facts: BillingFactsService,
    private readonly config: ConfigService,
  ) {}
  protected client(): Stripe | null {
    const key = this.config.get<string>('GROWTH_STRIPE_READ_KEY');
    const live =
      (this.config.get('PRODUCT_ENVIRONMENT') ??
        this.config.get('NODE_ENV')) === 'production';
    if (!key) return null;
    if (!key.startsWith(live ? 'rk_live_' : 'rk_test_'))
      throw new Error(
        'Growth reconciliation requires matching restricted read key',
      );
    return new Stripe(key, { maxNetworkRetries: 2, timeout: 15000 });
  }
  async run(maxPages = 10, jobFence?: LeaseFence) {
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20)
      throw new Error('Invalid page budget');
    const stripe = this.client();
    if (!stripe)
      return {
        status: 'missing_data',
        reason: 'stripe_read_key_not_configured',
      };
    const db = this.store.getClient();
    const live =
      (this.config.get('PRODUCT_ENVIRONMENT') ??
        this.config.get('NODE_ENV')) === 'production';
    const ref = db
      .collection('growth_billing_sync')
      .doc(live ? 'live' : 'test');
    const token = randomUUID();
    const state = await db.runTransaction(async (tx) => {
      const current = (await tx.get(ref)).data();
      if (current?.leaseUntil > Date.now()) return null;
      const next =
        current?.phase && current.phase !== 'completed'
          ? current
          : {
              phase: 'invoices',
              cursor: null,
              startedAt: new Date().toISOString(),
              scanned: 0,
              subscriptionScanned: 0,
              refundScanned: 0,
              refundPhaseComplete: false,
              unresolved: 0,
              runId: randomUUID(),
            };
      tx.set(ref, {
        ...next,
        token,
        leaseUntil: Date.now() + 10 * 60000,
        status: 'in_progress',
      });
      return next;
    });
    if (!state) return { status: 'already_claimed' };
    try {
      for (
        let page = 0;
        page < maxPages && state.phase !== 'completed';
        page++
      ) {
        if (state.phase === 'invoices') {
          const invoices = await stripe.invoices.list({
            status: 'paid',
            limit: 100,
            created: { lte: Math.floor(Date.parse(state.startedAt) / 1000) },
            ...(state.cursor ? { starting_after: state.cursor } : {}),
          });
          for (const invoice of invoices.data) {
            if (invoice.livemode !== live)
              throw new Error('Stripe mode mismatch');
            await this.facts.recordReconciledInvoice(invoice);
          }
          state.scanned += invoices.data.length;
          state.cursor = invoices.has_more ? invoices.data.at(-1)?.id : null;
          if (invoices.has_more && !state.cursor)
            throw new Error('Invalid Stripe cursor');
          if (!invoices.has_more) state.phase = 'subscriptions';
        } else if (state.phase === 'refunds') {
          /**
           * Los reembolsos se recorren por su propia lista.
           *
           * `charge.refunded` trae `amount_refunded` acumulado del cargo, pero
           * el objeto `charge` **no** garantiza traer todos los reembolsos
           * embebidos: `charge.refunds` es una lista paginada y puede venir
           * truncada. Inferir «todos los reembolsos» de ahí subcontaría en
           * cuanto un cargo tenga varios. Esta fase es la única fuente
           * autoritativa del libro; el hecho del webhook queda como señal.
           */
          const refunds = await stripe.refunds.list({
            limit: 100,
            created: { lte: Math.floor(Date.parse(state.startedAt) / 1000) },
            ...(state.cursor ? { starting_after: state.cursor } : {}),
          });
          for (const refund of refunds.data) {
            await this.facts.recordObservedRefund(refund, live);
          }
          state.refundScanned += refunds.data.length;
          state.cursor = refunds.has_more ? refunds.data.at(-1)?.id : null;
          if (refunds.has_more && !state.cursor)
            throw new Error('Invalid Stripe cursor');
          if (!refunds.has_more) {
            // La cobertura histórica de reembolsos solo se puede afirmar cuando
            // la lista se recorrió hasta el final en este recorrido.
            state.refundPhaseComplete = true;
            await this.publishInventory(state, live, ref, token, jobFence);
            state.phase = 'completed';
          }
        } else {
          const subscriptions = await stripe.subscriptions.list({
            status: 'all',
            limit: 100,
            // Mismo tope temporal que las facturas: el inventario es una
            // observación de un intervalo acotado, no «todo lo que exista
            // ahora». Sin esto, una suscripción creada a mitad del recorrido
            // entra en unas páginas y no en otras.
            created: { lte: Math.floor(Date.parse(state.startedAt) / 1000) },
            ...(state.cursor ? { starting_after: state.cursor } : {}),
          });
          for (const subscription of subscriptions.data) {
            if (subscription.livemode !== live)
              throw new Error('Stripe mode mismatch');
            const customerId =
              typeof subscription.customer === 'string'
                ? subscription.customer
                : subscription.customer.id;
            const account =
              await this.store.getUserByStripeCustomerId(customerId);
            if (
              !account ||
              (await this.store.isAccountDeletionMarked(account.id))
            ) {
              if (subscription.status === 'active') state.unresolved++;
              continue;
            }
            const intervals = [
              ...new Set(
                subscription.items.data.map(
                  (item) => item.price.recurring?.interval ?? 'unknown',
                ),
              ),
            ];
            // En la API Basil `current_period_end` ya NO está en la
            // suscripción: vive en cada item. Leerlo del objeto raíz devolvería
            // `undefined` en silencio y dejaría la cohorte de renovación vacía
            // para siempre.
            const period = resolveSubscriptionPeriod(
              subscription.items.data as { current_period_end?: number }[],
            );
            const member = db
              .collection('growth_paid_inventory_members')
              .doc(`${state.runId}_${subscription.id}`);
            await db.runTransaction(async (tx) => {
              const tombstone = await tx.get(
                db.collection('deleted_accounts').doc(account.id),
              );
              const first = await tx.get(
                db
                  .collection('growth_first_payments')
                  .doc(`${live ? 'live' : 'test'}_${account.id}`),
              );
              if (tombstone.exists) return;
              tx.set(member, {
                runId: state.runId,
                accountId: account.id,
                livemode: live,
                status: subscription.status,
                isPaid: subscription.status === 'active' && first.exists,
                // Sin primer pago registrado no se puede afirmar que sea una
                // cuenta paga: puede ser cobertura que falta, no una cortesía.
                paidEvidence: first.exists
                  ? (first.get('coverage') ?? 'webhook_only')
                  : 'missing_first_payment',
                firstPaidAt: first.get('firstPaidAt') ?? null,
                billingInterval:
                  intervals.length === 1 ? intervals[0] : 'mixed',
                subscriptionId: subscription.id,
                currentPeriodEnd: period.currentPeriodEnd,
                mixedPeriods: period.mixedPeriods,
                /** Cancelación futura: indicador anticipado, no baja efectiva. */
                cancellationScheduled: subscription.cancel_at_period_end,
                observedAt: new Date().toISOString(),
              });
            });
          }
          state.subscriptionScanned += subscriptions.data.length;
          state.cursor = subscriptions.has_more
            ? subscriptions.data.at(-1)?.id
            : null;
          if (subscriptions.has_more && !state.cursor)
            throw new Error('Invalid Stripe cursor');
          if (!subscriptions.has_more) {
            // Antes de publicar falta el histórico de reembolsos: sin él el
            // libro de ingresos no puede declarar cobertura.
            state.phase = 'refunds';
            state.cursor = null;
          }
        }
        await db.runTransaction(async (tx) => {
          const current = (await tx.get(ref)).data();
          if (current?.token !== token || current.leaseUntil <= Date.now())
            throw new Error('Reconciliation lease lost');
          tx.set(ref, {
            ...state,
            token,
            leaseUntil: Date.now() + 10 * 60000,
            status: state.phase === 'completed' ? 'complete' : 'in_progress',
            ...(state.phase === 'completed'
              ? {
                  completedAt: new Date().toISOString(),
                  sourceWatermark: state.startedAt,
                }
              : {}),
          });
        });
      }
      return {
        status: state.phase === 'completed' ? 'complete' : 'in_progress',
        phase: state.phase,
        scanned: state.scanned,
        subscriptionScanned: state.subscriptionScanned,
        unresolved: state.unresolved,
      };
    } finally {
      await db.runTransaction(async (tx) => {
        if ((await tx.get(ref)).get('token') === token)
          tx.update(ref, { leaseUntil: 0, token: FieldValue.delete() });
      });
    }
  }
  /**
   * Libro de ingresos y reembolsos por moneda, construido a partir de los
   * hechos ya persistidos (`billing_facts`).
   *
   * No llama a Stripe: los cobros entran por webhook verificado y por la
   * conciliación de lectura, y los reembolsos por `charge.refunded`. Si no hay
   * hechos de reembolso todavía, el libro lo dice con `missing_data` en vez de
   * publicar un neto igual al bruto, que afirmaría que no hubo reembolsos.
   */
  protected async buildLedger(
    live: boolean,
    windowStart: string,
    refundHistoryComplete: boolean,
  ) {
    const db = this.store.getClient();
    const [payments, refunds] = await Promise.all([
      db
        .collection('billing_facts')
        .where('livemode', '==', live)
        .where('type', '==', 'invoice_paid')
        .where('occurredAt', '>=', windowStart)
        .limit(5001)
        .get(),
      // Solo los reembolsos observados por la lista cuentan en el libro. El
      // hecho del webhook (`charge_refunded`) es una señal de que ese cargo
      // tiene devoluciones, no una cifra completa.
      db
        .collection('billing_facts')
        .where('livemode', '==', live)
        .where('type', '==', 'refund_observed')
        .where('occurredAt', '>=', windowStart)
        .limit(5001)
        .get(),
    ]);
    const truncated = payments.size > 5000 || refunds.size > 5000;
    const facts: RevenueFact[] = [
      ...payments.docs
        .map((doc) => doc.data())
        .filter((row) => row.positivePayment && row.amountMinor > 0)
        .map((row) => ({
          objectId: row.objectId,
          kind: 'payment' as const,
          currency: row.currency,
          amountMinor: row.amountMinor,
          occurredAt: row.occurredAt,
          livemode: row.livemode,
          accountId: row.accountId ?? null,
        })),
      ...refunds.docs
        .map((doc) => doc.data())
        .map((row) => ({
          objectId: row.objectId,
          kind: 'refund' as const,
          currency: row.currency,
          // Importe de ESTE reembolso. Cada objeto `re_…` es una línea propia,
          // así que dos devoluciones parciales del mismo cargo son dos líneas
          // y no hay acumulados que interpretar.
          amountMinor: row.amountMinor,
          occurredAt: row.occurredAt,
          livemode: row.livemode,
          accountId: row.accountId ?? null,
        })),
    ];

    // Sin el histórico de reembolsos recorrido, el neto podría estar por
    // encima del real: se declara parcial en vez de presentarlo como completo.
    const coverage = truncated
      ? 'partial'
      : refundHistoryComplete
        ? 'complete'
        : 'partial';

    return {
      ...buildRevenueLedger({
        facts,
        window: { start: windowStart, end: new Date().toISOString() },
        coverage,
      }),
      refundFactsObserved: refunds.size,
      refundHistoryComplete,
      truncated,
      ...(refundHistoryComplete
        ? {}
        : { coverageReason: 'refund_history_not_walked' }),
    };
  }

  protected async publishInventory(
    state: any,
    live: boolean,
    syncRef?: FirebaseFirestore.DocumentReference,
    token?: string,
    jobFence?: LeaseFence,
  ) {
    const db = this.store.getClient(),
      mode = live ? 'live' : 'test';
    const latestRef = db.collection('growth_paid_stocks').doc(`${mode}_latest`);
    const previous = (await latestRef.get()).data();
    if (previous?.runId === state.runId) return;
    const rows = await db
      .collection('growth_paid_inventory_members')
      .where('runId', '==', state.runId)
      .limit(10001)
      .get();
    const current = rows.docs.map((d) => d.data());
    const previousRows =
      previous?.status === 'complete'
        ? await db
            .collection('growth_paid_inventory_members')
            .where('runId', '==', previous.runId)
            .limit(10001)
            .get()
        : null;
    const complete = state.unresolved === 0 && rows.size <= 10000;
    const currentPaid = current
      .filter((row) => row.isPaid)
      .map((row) => row.accountId);
    let bridge: Record<string, any> = {
      status: 'missing_data',
      reason: 'opening_inventory_missing',
    };
    if (complete && previousRows && previousRows.size <= 10000) {
      const opening = previousRows.docs
        .map((d) => d.data())
        .filter((row) => row.isPaid)
        .map((row) => row.accountId);
      const historic = current
        .filter(
          (row) => row.firstPaidAt && row.firstPaidAt < previous.observedAt,
        )
        .map((row) => row.accountId);
      const calculated = calculatePaidAccountBridge(
        opening,
        currentPaid,
        historic,
      );
      const adjustment = calculated.opening - previous.paidAccounts;
      bridge = {
        ...calculated,
        opening: previous.paidAccounts,
        adjustment,
        net: calculated.closing - previous.paidAccounts,
        reconciled:
          previous.paidAccounts +
            calculated.newPaid +
            calculated.reactivated -
            calculated.effectiveChurn +
            adjustment ===
          calculated.closing,
        status: 'observed',
        window: { start: previous.observedAt, end: new Date().toISOString() },
        adjustmentReason: adjustment ? 'historical_membership_removed' : null,
      };
    }
    const ledger = await this.buildLedger(
      live,
      state.startedAt,
      state.refundPhaseComplete === true,
    );
    const receipt = {
      schemaVersion: 2,
      runId: state.runId,
      revenueLedger: ledger,
      livemode: live,
      status: complete ? 'complete' : 'incomplete',
      observedAt: new Date().toISOString(),
      readStartedAt: state.startedAt,
      paidAccounts: complete ? new Set(currentPaid).size : null,
      byInterval: ['month', 'year', 'mixed', 'unknown'].map((interval) => ({
        interval,
        accounts: complete
          ? new Set(
              current
                .filter((row) => row.isPaid && row.billingInterval === interval)
                .map((row) => row.accountId),
            ).size
          : null,
      })),
      intervalSemantics: 'account_can_have_multiple_intervals_do_not_sum',
      paidDefinition:
        'active_subscription_with_previous_positive_subscription_invoice',
      bridge,
    };
    // La publicación comprueba el lease DENTRO de su transacción: antes el
    // inventario y `latest` se escribían y solo después se descubría que el
    // lease había vencido, con lo que un proceso adelantado podía hacer
    // retroceder el inventario publicado.
    const historicRef = db
      .collection('growth_paid_stocks')
      .doc(`${mode}_${getDateStringInTimezone()}_${state.runId}`);
    await db.runTransaction(async (tx) => {
      if (jobFence) await jobFence.assert(tx);
      if (syncRef && token) {
        const current = await tx.get(syncRef);
        if (
          current.get('token') !== token ||
          !(current.get('leaseUntil') > Date.now())
        )
          throw new Error('Reconciliation lease lost');
      }
      tx.set(historicRef, receipt);
      tx.set(latestRef, receipt);
    });
  }
}
