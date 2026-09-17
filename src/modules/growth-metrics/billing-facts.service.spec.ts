import type Stripe from 'stripe';
import { BillingFactsService } from './billing-facts.service.js';
import { FirestoreService } from '../cache/firestore.service.js';
describe('verified billing facts', () => {
  const docs = new Map<string, unknown>();
  const tx = {
    get: jest.fn(async (id: string) => ({
      exists: docs.has(id),
      get: (key: string) => (docs.get(id) as any)?.[key],
    })),
    set: jest.fn((id: string, data: unknown) => docs.set(id, data)),
    create: jest.fn((id: string, data: unknown) => docs.set(id, data)),
  };
  const account = jest.fn();
  let service: BillingFactsService;
  const invoiceEvent = (id = 'evt_a', amount = 100) =>
    ({
      id,
      type: 'invoice.payment_succeeded',
      created: 1767225600,
      livemode: false,
      data: {
        object: {
          id: 'in_a',
          customer: 'cus_a',
          status: 'paid',
          amount_paid: amount,
          currency: 'usd',
          status_transitions: { paid_at: 1767225600 },
          billing_reason: 'subscription_create',
        },
      },
    }) as unknown as Stripe.Event;
  beforeEach(() => {
    docs.clear();
    jest.clearAllMocks();
    account.mockResolvedValue({ id: 'account_a' });
    service = new BillingFactsService({
      getUserByStripeCustomerId: account,
      getClient: () => ({
        collection: () => ({ doc: (id: string) => id }),
        runTransaction: (f: (t: typeof tx) => unknown) => f(tx),
      }),
    } as unknown as FirestoreService);
  });
  it('deduplicates multiple event deliveries of the same invoice', async () => {
    await service.recordVerifiedEvent(invoiceEvent());
    await service.recordVerifiedEvent(invoiceEvent('evt_b'));
    expect(tx.create).toHaveBeenCalledTimes(1);
    expect(docs.get('invoice_in_a')).toMatchObject({
      accountId: 'account_a',
      positivePayment: true,
      amountMinor: 100,
    });
  });
  it('preserves unmapped customer facts for reconciliation instead of dropping them', async () => {
    account.mockResolvedValue(null);
    await service.recordVerifiedEvent(invoiceEvent());
    expect(docs.get('invoice_in_a')).toMatchObject({
      accountId: null,
      attributionStatus: 'pending',
    });
  });
  it('marca la cobertura del primer pago según su origen', async () => {
    await service.recordVerifiedEvent(invoiceEvent());
    // Solo se vio el webhook: este «primero» puede ser en realidad el segundo.
    expect(docs.get('live_or_test_first')).toBeUndefined();
    expect(docs.get('test_account_a')).toMatchObject({
      coverage: 'webhook_only',
    });

    docs.clear();
    await service.recordReconciledInvoice({
      id: 'in_a',
      customer: 'cus_a',
      status: 'paid',
      amount_paid: 100,
      currency: 'usd',
      livemode: false,
      created: 1767225600,
      status_transitions: { paid_at: 1767225600 },
      billing_reason: 'subscription_create',
    } as unknown as Stripe.Invoice);
    expect(docs.get('test_account_a')).toMatchObject({
      coverage: 'reconciled_history',
    });
  });

  it('registra el reembolso como hecho propio, con el acumulado del cargo', async () => {
    const refund = (cumulative: number, id = 'evt_r') =>
      ({
        id,
        type: 'charge.refunded',
        created: 1767312000,
        livemode: false,
        data: {
          object: {
            id: 'ch_a',
            customer: 'cus_a',
            currency: 'usd',
            amount_refunded: cumulative,
            refunded: false,
            payment_intent: 'pi_a',
          },
        },
      }) as unknown as Stripe.Event;

    await service.recordVerifiedEvent(refund(3000));
    expect(docs.get('refund_ch_a')).toMatchObject({
      type: 'charge_refunded',
      cumulativeRefundedMinor: 3000,
      lastDeltaMinor: 3000,
      currency: 'usd',
      accountId: 'account_a',
      // En la API Basil el cargo ya no trae `invoice`: se guarda el
      // PaymentIntent y se declara que falta la asociación.
      paymentIntentId: 'pi_a',
      invoiceLinkStatus: 'requires_read_api_lookup',
    });

    // Segundo reembolso parcial: el acumulado sube y el delta es la diferencia.
    await service.recordVerifiedEvent(refund(5000, 'evt_r2'));
    expect(docs.get('refund_ch_a')).toMatchObject({
      cumulativeRefundedMinor: 5000,
      lastDeltaMinor: 2000,
    });

    // Entrega reordenada con menos acumulado: no reduce nada.
    await service.recordVerifiedEvent(refund(3000, 'evt_r3'));
    expect(docs.get('refund_ch_a')).toMatchObject({
      cumulativeRefundedMinor: 5000,
    });
  });

  it('does not count zero invoices or checkout completion as paid acquisition', async () => {
    await service.recordVerifiedEvent(invoiceEvent('evt_a', 0));
    expect(docs.get('invoice_in_a')).toMatchObject({ positivePayment: false });
    await service.recordVerifiedEvent({
      ...invoiceEvent(),
      type: 'checkout.session.completed',
    } as Stripe.Event);
    expect(tx.create).toHaveBeenCalledTimes(1);
  });
});
