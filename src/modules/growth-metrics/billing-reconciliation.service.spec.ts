import { ConfigService } from '@nestjs/config';
import { BillingReconciliationService } from './billing-reconciliation.service.js';

function fixture() {
  const rows = new Map<string, any>();
  const ref = (path: string) => ({ path });
  const snap = (r: any) => ({
    exists: rows.has(r.path),
    data: () => rows.get(r.path),
    get: (k: string) => rows.get(r.path)?.[k],
  });
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => ref(`${name}/${id}`),
    }),
    runTransaction: async (fn: any) =>
      fn({
        get: async (r: any) => snap(r),
        set: (r: any, data: any) => rows.set(r.path, { ...data }),
        update: (r: any, data: any) =>
          rows.set(r.path, { ...rows.get(r.path), ...data }),
      }),
  };
  const stripe = {
    invoices: { list: jest.fn() },
    subscriptions: { list: jest.fn() },
    refunds: { list: jest.fn() },
  };
  const facts = {
    recordReconciledInvoice: jest.fn(),
    recordObservedRefund: jest.fn(),
  };
  const service = new BillingReconciliationService(
    {
      getClient: () => db,
      getUserByStripeCustomerId: jest.fn().mockResolvedValue(null),
    } as any,
    facts as any,
    new ConfigService({ NODE_ENV: 'test' }),
  );
  jest.spyOn(service as any, 'client').mockReturnValue(stripe);
  jest.spyOn(service as any, 'publishInventory').mockResolvedValue(undefined);
  return { service, stripe, facts, rows };
}
describe('read-only financial reconciliation', () => {
  it('checkpoints full invoice history across process invocations before declaring coverage', async () => {
    const f = fixture();
    f.stripe.invoices.list
      .mockResolvedValueOnce({
        data: [{ id: 'in_1', livemode: false }],
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [{ id: 'in_2', livemode: false }],
        has_more: false,
      });
    f.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    f.stripe.refunds.list.mockResolvedValue({ data: [], has_more: false });
    expect(await f.service.run(1)).toMatchObject({
      status: 'in_progress',
      phase: 'invoices',
    });
    expect(f.rows.get('growth_billing_sync/test').cursor).toBe('in_1');
    expect(
      f.rows.get('growth_billing_sync/test').sourceWatermark,
    ).toBeUndefined();
    // Tres fases: facturas, suscripciones y reembolsos. La cobertura no se
    // declara completa hasta recorrer las tres.
    expect(await f.service.run(3)).toMatchObject({
      status: 'complete',
      scanned: 2,
    });
    expect(f.stripe.invoices.list.mock.calls[1][0]).toMatchObject({
      starting_after: 'in_1',
    });
    expect(f.facts.recordReconciledInvoice).toHaveBeenCalledTimes(2);
  });
  it('does not advance cursor on partial persistence failure and resumes the same page', async () => {
    const f = fixture();
    f.stripe.invoices.list.mockResolvedValue({
      data: [{ id: 'in_1', livemode: false }],
      has_more: false,
    });
    f.facts.recordReconciledInvoice.mockRejectedValueOnce(new Error('failed'));
    await expect(f.service.run(1)).rejects.toThrow('failed');
    expect(f.rows.get('growth_billing_sync/test')).toMatchObject({
      cursor: null,
      leaseUntil: 0,
    });
    expect(await f.service.run(1)).toMatchObject({
      phase: 'subscriptions',
      scanned: 1,
    });
  });
  it('recorre el histórico de reembolsos con su propio cursor y lo reanuda', async () => {
    const f = fixture();
    f.stripe.invoices.list.mockResolvedValue({ data: [], has_more: false });
    f.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    f.stripe.refunds.list
      .mockResolvedValueOnce({
        data: [{ id: 're_1', amount: 100, currency: 'usd' }],
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [{ id: 're_2', amount: 200, currency: 'usd' }],
        has_more: false,
      });

    // Presupuesto justo para facturas, suscripciones y la primera página de
    // reembolsos: la cobertura todavía no puede declararse.
    expect(await f.service.run(3)).toMatchObject({
      status: 'in_progress',
      phase: 'refunds',
    });
    expect(f.rows.get('growth_billing_sync/test').cursor).toBe('re_1');
    expect(f.rows.get('growth_billing_sync/test').refundPhaseComplete).toBe(
      false,
    );

    expect(await f.service.run(2)).toMatchObject({ status: 'complete' });
    expect(f.stripe.refunds.list.mock.calls[1][0]).toMatchObject({
      starting_after: 're_1',
    });
    expect(f.facts.recordObservedRefund).toHaveBeenCalledTimes(2);
    expect(f.rows.get('growth_billing_sync/test').refundPhaseComplete).toBe(
      true,
    );
    // Los reembolsos se piden acotados al inicio del recorrido, como las
    // facturas: el inventario es la observación de un intervalo cerrado.
    expect(f.stripe.refunds.list.mock.calls[0][0].created).toMatchObject({
      lte: expect.any(Number),
    });
  });

  it('un fallo al anotar un reembolso no avanza el cursor', async () => {
    const f = fixture();
    f.stripe.invoices.list.mockResolvedValue({ data: [], has_more: false });
    f.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    f.stripe.refunds.list.mockResolvedValue({
      data: [{ id: 're_1', amount: 100, currency: 'usd' }],
      has_more: false,
    });
    f.facts.recordObservedRefund.mockRejectedValueOnce(new Error('failed'));

    await expect(f.service.run(3)).rejects.toThrow('failed');
    expect(f.rows.get('growth_billing_sync/test')).toMatchObject({
      refundPhaseComplete: false,
      leaseUntil: 0,
    });

    // El reintento vuelve a la misma página y termina el recorrido.
    expect(await f.service.run(3)).toMatchObject({ status: 'complete' });
    expect(f.rows.get('growth_billing_sync/test').refundPhaseComplete).toBe(
      true,
    );
  });

  it('refuses mixed Stripe mode and leaves coverage incomplete', async () => {
    const f = fixture();
    f.stripe.invoices.list.mockResolvedValue({
      data: [{ id: 'in_live', livemode: true }],
      has_more: false,
    });
    await expect(f.service.run(1)).rejects.toThrow('mode mismatch');
    expect(f.facts.recordReconciledInvoice).not.toHaveBeenCalled();
    expect(f.rows.get('growth_billing_sync/test').status).toBe('in_progress');
  });
  it('reports absent read credentials without constructing or calling Stripe', async () => {
    const service = new BillingReconciliationService(
      {} as any,
      {} as any,
      new ConfigService({ NODE_ENV: 'test' }),
    );
    expect(await service.run()).toEqual({
      status: 'missing_data',
      reason: 'stripe_read_key_not_configured',
    });
  });
});
