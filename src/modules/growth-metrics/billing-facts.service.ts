import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type Stripe from 'stripe';
import { FirestoreService } from '../cache/firestore.service.js';
import { refundDelta } from './revenue-ledger.js';

/** Immutable financial source facts. Called only after Stripe signature verification. */
@Injectable()
export class BillingFactsService {
  constructor(private readonly firestore: FirestoreService) {}

  async recordReconciledInvoice(invoice: Stripe.Invoice): Promise<void> {
    if (invoice.status !== 'paid') return;
    await this.record(
      {
        id: `reconcile_${invoice.id}`,
        type: 'invoice.payment_succeeded',
        created: invoice.status_transitions?.paid_at ?? invoice.created,
        livemode: invoice.livemode,
        data: { object: invoice },
      } as Stripe.Event,
      'stripe_read_api',
    );
  }

  /**
   * Reembolso observado por la lista de solo lectura.
   *
   * Es la línea **autoritativa** del libro: cada objeto `re_…` es un reembolso
   * con su importe y su fecha. El hecho que deja `charge.refunded` queda como
   * señal de que ese cargo tiene devoluciones —útil para saber que hay que
   * conciliar— pero no se suma, porque `charge.refunds` es una lista paginada
   * que puede venir truncada y no permite afirmar «estos son todos».
   */
  async recordObservedRefund(
    refund: Stripe.Refund,
    livemode: boolean,
  ): Promise<void> {
    if (!refund?.id || !Number.isSafeInteger(refund.amount)) return;
    if (refund.amount <= 0) return;
    // Un reembolso fallido o cancelado no devolvió dinero.
    if (refund.status && !['succeeded', 'pending'].includes(refund.status))
      return;

    const db = this.firestore.getClient();
    const ref = db
      .collection('billing_facts')
      .doc(`stripe_refund_${refund.id}`);
    const chargeId =
      typeof refund.charge === 'string'
        ? refund.charge
        : (refund.charge?.id ?? null);

    await db.runTransaction(async (tx) => {
      const existing = await tx.get(ref);
      if (existing.exists) return;
      tx.create(ref, {
        schemaVersion: 1,
        source: 'stripe_read_api',
        type: 'refund_observed',
        objectId: refund.id,
        chargeId,
        paymentIntentId:
          typeof refund.payment_intent === 'string'
            ? refund.payment_intent
            : (refund.payment_intent?.id ?? null),
        amountMinor: refund.amount,
        currency: refund.currency,
        refundStatus: refund.status ?? null,
        reason: refund.reason ?? null,
        occurredAt: new Date(refund.created * 1000).toISOString(),
        receivedAt: new Date().toISOString(),
        livemode,
        // La atribución a cuenta se resuelve por el cargo en la conciliación;
        // el libro por moneda no la necesita y no se inventa aquí.
        accountId: null,
        attributionStatus: 'not_required_for_currency_ledger',
        countedInLedger: true,
      });
    });
  }

  async recordVerifiedEvent(event: Stripe.Event): Promise<void> {
    if (event.type === 'charge.refunded')
      return this.recordRefund(event, 'stripe_verified_webhook');
    return this.record(event, 'stripe_verified_webhook');
  }

  /**
   * Reembolso observado.
   *
   * `charge.amount_refunded` es **acumulado** sobre el cargo: dos reembolsos
   * parciales llegan como 30 y luego 50, no como 30 y 20. Por eso se guarda un
   * único documento por cargo con el acumulado y solo se sube; sumar los
   * eventos contaría 80 donde hubo 50. El cobro original no se toca: los dos
   * hechos conservan su identidad y su fecha, que es lo que permite no
   * reescribir el mes en que se cobró.
   */
  private async recordRefund(event: Stripe.Event, source: string) {
    const charge = event.data.object as Stripe.Charge;
    if (!charge?.id || !Number.isSafeInteger(charge.amount_refunded)) return;
    if (charge.amount_refunded <= 0) return;

    const db = this.firestore.getClient();
    const ref = db.collection('billing_facts').doc(`refund_${charge.id}`);
    const customerId =
      typeof charge.customer === 'string'
        ? charge.customer
        : charge.customer?.id;
    const account = customerId
      ? await this.firestore.getUserByStripeCustomerId(customerId)
      : null;

    await db.runTransaction(async (tx) => {
      const existing = await tx.get(ref);
      const deleted = account
        ? await tx.get(db.collection('deleted_accounts').doc(account.id))
        : null;
      const anonymized = !!deleted?.exists;
      const previous = existing.get('cumulativeRefundedMinor') ?? 0;
      const delta = refundDelta(previous, charge.amount_refunded);
      // Un evento reordenado que trae menos acumulado que el ya conocido no
      // reduce nada: Stripe no garantiza orden de entrega.
      if (existing.exists && delta === 0) return;

      tx.set(
        ref,
        {
          schemaVersion: 1,
          source,
          type: 'charge_refunded',
          stripeEventId: event.id,
          objectId: charge.id,
          // En la versión Basil de la API el cargo ya NO lleva `invoice`: el
          // vínculo pasa por el PaymentIntent. Se guarda ese identificador y se
          // deja la asociación a factura para la conciliación de lectura, en vez
          // de castear un campo que no existe y quedarse con `undefined`.
          paymentIntentId:
            typeof charge.payment_intent === 'string'
              ? charge.payment_intent
              : (charge.payment_intent?.id ?? null),
          invoiceId: null,
          invoiceLinkStatus: 'requires_read_api_lookup',
          ...(anonymized || !customerId ? {} : { customerId }),
          accountId: account && !anonymized ? account.id : null,
          attributionStatus: anonymized
            ? 'anonymized'
            : account
              ? 'resolved'
              : 'pending',
          cumulativeRefundedMinor: charge.amount_refunded,
          lastDeltaMinor: delta,
          /**
           * Señal, no línea del libro: `charge.refunds` es paginado y puede
           * llegar truncado, así que de aquí no se puede deducir el total de
           * devoluciones. La cifra autoritativa la pone `refunds.list`.
           */
          countedInLedger: false,
          ledgerRole: 'refund_signal_requires_reconciliation',
          currency: charge.currency,
          occurredAt: new Date(event.created * 1000).toISOString(),
          receivedAt: new Date().toISOString(),
          livemode: event.livemode,
          fullyRefunded: charge.refunded === true,
        },
        { merge: true },
      );
    });
  }

  private async record(event: Stripe.Event, source: string): Promise<void> {
    if (
      ![
        'invoice.payment_succeeded',
        'customer.subscription.updated',
        'customer.subscription.deleted',
      ].includes(event.type)
    )
      return;
    const object = event.data.object as Stripe.Invoice | Stripe.Subscription;
    const customerId =
      typeof object.customer === 'string'
        ? object.customer
        : object.customer?.id;
    if (!customerId) throw new Error('Verified billing event missing customer');
    const account = await this.firestore.getUserByStripeCustomerId(customerId);
    const db = this.firestore.getClient();
    const invoiceEvent = event.type.startsWith('invoice.');
    const invoice = object as Stripe.Invoice;
    const paidAt = invoiceEvent
      ? invoice.status_transitions?.paid_at
      : undefined;
    // Only a positive verified payment-success invoice can be an acquisition fact.
    const positivePayment =
      invoiceEvent &&
      invoice.status === 'paid' &&
      invoice.amount_paid > 0 &&
      event.type === 'invoice.payment_succeeded' &&
      Number.isSafeInteger(invoice.amount_paid) &&
      typeof paidAt === 'number';
    const key = invoiceEvent ? `invoice_${object.id}` : `event_${event.id}`;
    const ref = db.collection('billing_facts').doc(key);
    const subscriptionPayment =
      invoiceEvent && (invoice.billing_reason ?? '').startsWith('subscription');
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(ref);
      const deleted = account
        ? await tx.get(db.collection('deleted_accounts').doc(account.id))
        : null;
      const customerDeleted = await tx.get(
        db
          .collection('deleted_billing_customers')
          .doc(createHash('sha256').update(customerId).digest('hex')),
      );
      const anonymized = deleted?.exists || customerDeleted.exists;
      const accountId = account && !anonymized ? account.id : null;
      const summaryRef = accountId
        ? db
            .collection('growth_first_payments')
            .doc(`${event.livemode ? 'live' : 'test'}_${accountId}`)
        : null;
      const summary = summaryRef ? await tx.get(summaryRef) : null;
      if (positivePayment && subscriptionPayment && summaryRef) {
        const firstPaidAt = new Date(paidAt * 1000).toISOString();
        // `coverage` dice de dónde sale este «primero». Con `webhook_only` el
        // mínimo observado puede ser en realidad el segundo pago, porque solo
        // se ven facturas posteriores a la instrumentación; quien calcula
        // conversión tiene que poder distinguirlo y no lo puede adivinar.
        const coverage =
          source === 'stripe_read_api'
            ? 'reconciled_history'
            : (summary.get('coverage') ?? 'webhook_only');
        const intervals = [
          ...new Set(
            (invoice.lines?.data ?? [])
              .map((line: any) => line?.price?.recurring?.interval)
              .filter(Boolean),
          ),
        ];
        if (!summary.exists || firstPaidAt < summary.get('firstPaidAt'))
          tx.set(
            summaryRef,
            {
              accountId,
              livemode: event.livemode,
              firstPaidAt,
              invoiceId: invoice.id,
              amountMinor: invoice.amount_paid,
              currency: invoice.currency,
              coverage,
              // Mensual y anual se informan por separado (plan §5): no se
              // derivan del importe, se leen del precio recurrente.
              billingInterval:
                intervals.length === 1 ? intervals[0] : 'unknown',
            },
            { merge: true },
          );
        else if (coverage === 'reconciled_history')
          tx.set(summaryRef, { coverage }, { merge: true });
      }
      if (existing.exists) return;
      tx.create(ref, {
        schemaVersion: 1,
        source,
        stripeEventId: event.id,
        objectId: object.id,
        ...(anonymized ? {} : { customerId }),
        accountId,
        attributionStatus: anonymized
          ? 'anonymized'
          : accountId
            ? 'resolved'
            : 'pending',
        type: invoiceEvent
          ? 'invoice_paid'
          : event.type === 'customer.subscription.deleted'
            ? 'subscription_ended'
            : 'subscription_updated',
        occurredAt: new Date(
          (positivePayment ? paidAt : event.created) * 1000,
        ).toISOString(),
        receivedAt: new Date().toISOString(),
        livemode: event.livemode,
        ...(invoiceEvent
          ? {
              amountMinor: invoice.amount_paid,
              currency: invoice.currency,
              positivePayment,
              subscriptionPayment,
              billingReason: invoice.billing_reason ?? null,
            }
          : {
              subscriptionStatus: (object as Stripe.Subscription).status,
              cancellationScheduled: (object as Stripe.Subscription)
                .cancel_at_period_end,
              endedAt: (object as Stripe.Subscription).ended_at
                ? new Date(
                    (object as Stripe.Subscription).ended_at * 1000,
                  ).toISOString()
                : null,
            }),
      });
    });
  }
}
