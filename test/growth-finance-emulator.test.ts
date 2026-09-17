import { ConfigService } from '@nestjs/config';
import { Firestore } from '@google-cloud/firestore';
import { randomUUID } from 'node:crypto';
import type Stripe from 'stripe';
import { BillingFactsService } from '../src/modules/growth-metrics/billing-facts.service.js';
import { BillingReconciliationService } from '../src/modules/growth-metrics/billing-reconciliation.service.js';
import { GrowthJobsService } from '../src/modules/growth-metrics/growth-jobs.service.js';
import type { FirestoreService } from '../src/modules/cache/firestore.service.js';
import type { ProductEventOutboxService } from '../src/modules/product-observability/product-event-outbox.service.js';

/**
 * Pruebas financieras contra el emulador REAL de Firestore.
 *
 * Lo único simulado es Stripe: las facturas y los reembolsos son objetos de
 * fixture y no se hace ninguna llamada a la API. Todo lo demás —transacciones,
 * `create` frente a documento existente, lease con token entre dos clientes
 * distintos y consultas por `livemode`— corre contra el emulador, que es donde
 * se puede comprobar lo que un doble no garantiza: que dos transacciones
 * concurrentes se serialicen de verdad.
 */
if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8085')
  throw new Error(
    'This suite requires the isolated local Firestore emulator at 127.0.0.1:8085',
  );

const projectId = 'demo-zplpdf-growth';
/** Dos clientes distintos: el fence tiene que cruzar la frontera de conexión. */
const db = new Firestore({ projectId, ignoreUndefinedProperties: true });
const otherClient = new Firestore({
  projectId,
  ignoreUndefinedProperties: true,
});

const suite = randomUUID().slice(0, 8);
const account = `synthetic-finance-${suite}`;
const customerId = `cus_${suite}`;

function storeFor(client: Firestore, mappedAccount: { id: string } | null) {
  return {
    getClient: () => client,
    getUserByStripeCustomerId: async () => mappedAccount,
    isAccountDeletionMarked: async () => false,
    getLastFeedbackByUser: async () => null,
  } as unknown as FirestoreService;
}

function invoiceEvent(input: {
  eventId?: string;
  invoiceId: string;
  livemode: boolean;
  paidAt: number;
  amount?: number;
}): Stripe.Event {
  return {
    id: input.eventId ?? `evt_${randomUUID().slice(0, 8)}`,
    type: 'invoice.payment_succeeded',
    created: input.paidAt,
    livemode: input.livemode,
    data: {
      object: {
        id: input.invoiceId,
        customer: customerId,
        status: 'paid',
        amount_paid: input.amount ?? 50000,
        currency: 'mxn',
        billing_reason: 'subscription_create',
        status_transitions: { paid_at: input.paidAt },
        lines: { data: [{ price: { recurring: { interval: 'month' } } }] },
      },
    },
  } as unknown as Stripe.Event;
}

function refund(input: {
  id: string;
  amount: number;
  created: number;
  status?: string;
}): Stripe.Refund {
  return {
    id: input.id,
    amount: input.amount,
    currency: 'mxn',
    charge: `ch_${input.id}`,
    payment_intent: `pi_${input.id}`,
    created: input.created,
    status: input.status ?? 'succeeded',
    reason: 'requested_by_customer',
  } as unknown as Stripe.Refund;
}

/** Expone el libro protegido para poder comprobar su cobertura. */
class LedgerProbe extends BillingReconciliationService {
  ledger(live: boolean, windowStart: string, refundHistoryComplete: boolean) {
    return this.buildLedger(live, windowStart, refundHistoryComplete);
  }
}

async function wipe(paths: string[]) {
  await Promise.all(paths.map((path) => db.doc(path).delete()));
}

beforeAll(async () => {
  await db.doc(`users/${account}`).set({ plan: 'pro' });
});

afterAll(async () => {
  await Promise.all([db.terminate(), otherClient.terminate()]);
});

describe('(a) fence de publicación con dos clientes', () => {
  const config = new ConfigService({
    NODE_ENV: 'test',
    GROWTH_COHORT_START: '2020-01-01T00:00:00.000Z',
  });

  function jobs(client: Firestore) {
    return new GrowthJobsService(
      storeFor(client, null),
      {
        dispatch: async () => ({ delivered: 0 }),
      } as unknown as ProductEventOutboxService,
      config,
      { run: async () => ({ status: 'missing_data' }) } as any,
    );
  }

  it('publica cuando el lease sigue siendo suyo', async () => {
    const scheduledAt = new Date().toISOString();
    await wipe(['growth_quality/latest']);
    await db.doc('growth_quality/latest').set({ marca: 'anterior' });

    const result = await jobs(db).run('quality', scheduledAt);

    expect(result.status).toBe('completed');
    const published = (await db.doc('growth_quality/latest').get()).data();
    expect(published.marca).toBeUndefined();
    expect(published.schemaVersion).toBe(1);
  });

  it('un lease robado por otro cliente impide publicar y deja `latest` intacto', async () => {
    const scheduledAt = new Date(Date.now() - 20 * 60000).toISOString();
    await db.doc('growth_quality/latest').set({ marca: 'anterior' });

    const service = jobs(db);
    // El robo ocurre entre reclamar el lease y publicar: es la ventana en la
    // que antes el snapshot se escribía antes de comprobar el token.
    const original = (service as any).quality.bind(service);
    jest
      .spyOn(service as any, 'quality')
      .mockImplementation(async (fence: unknown) => {
        const runs = await otherClient
          .collection('growth_job_runs')
          .where('job', '==', 'quality')
          .where('status', '==', 'running')
          .get();
        expect(runs.empty).toBe(false);
        // Segundo cliente, transacción propia: se queda con la ventana.
        await Promise.all(
          runs.docs.map((doc) =>
            doc.ref.update({
              token: `otro-${suite}`,
              leaseUntil: Date.now() + 600000,
            }),
          ),
        );
        return original(fence);
      });

    await expect(service.run('quality', scheduledAt)).rejects.toThrow(
      /lease lost/i,
    );

    // `latest` no retrocede: lo que había sigue ahí.
    const published = (await db.doc('growth_quality/latest').get()).data();
    expect(published).toEqual({ marca: 'anterior' });

    // Y el proceso desahuciado no toca el documento del nuevo dueño.
    const runs = await db
      .collection('growth_job_runs')
      .where('job', '==', 'quality')
      .where('token', '==', `otro-${suite}`)
      .get();
    expect(runs.size).toBe(1);
    expect(runs.docs[0].get('status')).toBe('running');
    expect(runs.docs[0].get('errorCode')).toBeUndefined();
  });
});

describe('(b) histórico de facturas y reembolsos: dedup, aislamiento y cobertura', () => {
  const facts = new BillingFactsService(storeFor(db, { id: account }));
  const DAY = 86400;
  // Fechas relativas al reloj real: el libro de ingresos acota su ventana en
  // `now`, así que un importe con fecha futura queda fuera por definición y una
  // fecha fija haría que la prueba dependiera del día en que se ejecuta.
  const nowSeconds = Math.floor(Date.now() / 1000);
  const paidAt = nowSeconds - 10 * DAY;
  const laterPaidAt = nowSeconds - 2 * DAY;
  const windowStart = new Date((nowSeconds - 30 * DAY) * 1000).toISOString();

  beforeEach(async () => {
    await wipe([
      `billing_facts/invoice_in_${suite}_test`,
      `billing_facts/invoice_in_${suite}_live`,
      `billing_facts/invoice_in_${suite}_later`,
      `billing_facts/stripe_refund_re_${suite}_a`,
      `billing_facts/stripe_refund_re_${suite}_failed`,
      `growth_first_payments/test_${account}`,
      `growth_first_payments/live_${account}`,
    ]);
  });

  it('dos entregas de la misma factura dejan un solo hecho', async () => {
    const invoiceId = `in_${suite}_test`;
    await facts.recordVerifiedEvent(
      invoiceEvent({ invoiceId, livemode: false, paidAt }),
    );
    // Stripe no garantiza orden ni unicidad de entrega: otro eventId, misma
    // factura.
    await facts.recordVerifiedEvent(
      invoiceEvent({ invoiceId, livemode: false, paidAt }),
    );

    const rows = await db
      .collection('billing_facts')
      .where('objectId', '==', invoiceId)
      .get();
    expect(rows.size).toBe(1);
    expect(rows.docs[0].get('positivePayment')).toBe(true);
    expect(rows.docs[0].get('amountMinor')).toBe(50000);
  });

  it('el primer pago se queda con el más antiguo y su cobertura sube al conciliar', async () => {
    // Llega primero la factura posterior: el mínimo tiene que ganar después.
    await facts.recordVerifiedEvent(
      invoiceEvent({
        invoiceId: `in_${suite}_later`,
        livemode: false,
        paidAt: laterPaidAt,
      }),
    );
    await facts.recordVerifiedEvent(
      invoiceEvent({ invoiceId: `in_${suite}_test`, livemode: false, paidAt }),
    );

    let summary = (
      await db.doc(`growth_first_payments/test_${account}`).get()
    ).data();
    expect(summary.firstPaidAt).toBe(new Date(paidAt * 1000).toISOString());
    // Solo se vio el webhook: el «primero» observado puede ser el segundo.
    expect(summary.coverage).toBe('webhook_only');
    expect(summary.billingInterval).toBe('month');

    await facts.recordReconciledInvoice({
      id: `in_${suite}_test`,
      customer: customerId,
      status: 'paid',
      amount_paid: 50000,
      currency: 'mxn',
      livemode: false,
      created: paidAt,
      billing_reason: 'subscription_create',
      status_transitions: { paid_at: paidAt },
      lines: { data: [{ price: { recurring: { interval: 'month' } } }] },
    } as unknown as Stripe.Invoice);

    summary = (
      await db.doc(`growth_first_payments/test_${account}`).get()
    ).data();
    expect(summary.coverage).toBe('reconciled_history');
    expect(summary.firstPaidAt).toBe(new Date(paidAt * 1000).toISOString());
  });

  it('live y test no se mezclan: son dos resúmenes y dos hechos', async () => {
    await facts.recordVerifiedEvent(
      invoiceEvent({ invoiceId: `in_${suite}_test`, livemode: false, paidAt }),
    );
    await facts.recordVerifiedEvent(
      invoiceEvent({
        invoiceId: `in_${suite}_live`,
        livemode: true,
        paidAt: laterPaidAt,
      }),
    );

    const [testSummary, liveSummary] = await Promise.all([
      db.doc(`growth_first_payments/test_${account}`).get(),
      db.doc(`growth_first_payments/live_${account}`).get(),
    ]);
    expect(testSummary.get('firstPaidAt')).toBe(
      new Date(paidAt * 1000).toISOString(),
    );
    expect(liveSummary.get('firstPaidAt')).toBe(
      new Date(laterPaidAt * 1000).toISOString(),
    );
    // El pago de prueba no adelanta el primer pago de producción.
    expect(liveSummary.get('livemode')).toBe(true);
    expect(testSummary.get('livemode')).toBe(false);
  });

  it('el mismo reembolso observado dos veces no se cuenta dos veces', async () => {
    const id = `re_${suite}_a`;
    await facts.recordObservedRefund(
      refund({ id, amount: 20000, created: laterPaidAt }),
      false,
    );
    await facts.recordObservedRefund(
      refund({ id, amount: 20000, created: laterPaidAt }),
      false,
    );

    const rows = await db
      .collection('billing_facts')
      .where('objectId', '==', id)
      .get();
    expect(rows.size).toBe(1);
    expect(rows.docs[0].get('type')).toBe('refund_observed');
    expect(rows.docs[0].get('countedInLedger')).toBe(true);
    expect(rows.docs[0].get('amountMinor')).toBe(20000);
  });

  it('un reembolso fallido no devolvió dinero y no se registra', async () => {
    const id = `re_${suite}_failed`;
    await facts.recordObservedRefund(
      refund({ id, amount: 9999, created: laterPaidAt, status: 'failed' }),
      false,
    );

    expect(
      (await db.doc(`billing_facts/stripe_refund_${id}`).get()).exists,
    ).toBe(false);
  });

  it('la cobertura del libro depende de haber recorrido el histórico', async () => {
    const probe = new LedgerProbe(
      storeFor(db, { id: account }),
      facts,
      new ConfigService({ NODE_ENV: 'test' }),
    );
    await facts.recordVerifiedEvent(
      invoiceEvent({ invoiceId: `in_${suite}_test`, livemode: false, paidAt }),
    );
    await facts.recordObservedRefund(
      refund({ id: `re_${suite}_a`, amount: 20000, created: laterPaidAt }),
      false,
    );

    const partial = await probe.ledger(false, windowStart, false);
    expect(partial.coverage).toBe('partial');
    expect(partial.coverageReason).toBe('refund_history_not_walked');

    const complete = await probe.ledger(false, windowStart, true);
    expect(complete.coverage).toBe('complete');
    expect(complete.refundHistoryComplete).toBe(true);

    const mxn = complete.byCurrency.find((row) => row.currency === 'mxn');
    expect(mxn).toMatchObject({
      grossMinor: 50000,
      refundedMinor: 20000,
      netMinor: 30000,
    });
    // El libro no publica total entre monedas.
    expect(complete).not.toHaveProperty('totalMinor');
  });

  it('el libro de producción no ve los hechos de prueba', async () => {
    const probe = new LedgerProbe(
      storeFor(db, { id: account }),
      facts,
      new ConfigService({ NODE_ENV: 'test' }),
    );
    await facts.recordVerifiedEvent(
      invoiceEvent({ invoiceId: `in_${suite}_test`, livemode: false, paidAt }),
    );

    const live = await probe.ledger(true, windowStart, true);
    const liveMxn = live.byCurrency.find((row) => row.currency === 'mxn');
    expect(liveMxn?.grossMinor ?? 0).toBe(0);
  });
});
