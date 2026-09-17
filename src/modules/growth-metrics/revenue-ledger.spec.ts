import { buildRevenueLedger, refundDelta } from './revenue-ledger.js';
import type { RevenueFact } from './revenue-ledger.js';

const WINDOW = {
  start: '2026-09-01T00:00:00.000Z',
  end: '2026-09-30T23:59:59.000Z',
};

function payment(overrides: Partial<RevenueFact> = {}): RevenueFact {
  return {
    objectId: 'in_1',
    kind: 'payment',
    currency: 'mxn',
    amountMinor: 50000,
    occurredAt: '2026-09-10T00:00:00.000Z',
    livemode: false,
    ...overrides,
  };
}

describe('buildRevenueLedger', () => {
  it('separa por moneda y no publica ningún total', () => {
    const ledger = buildRevenueLedger({
      facts: [
        payment({ currency: 'mxn', amountMinor: 50000 }),
        payment({ objectId: 'in_2', currency: 'usd', amountMinor: 2900 }),
      ],
      window: WINDOW,
      coverage: 'complete',
    });

    expect(ledger.byCurrency).toEqual([
      {
        currency: 'mxn',
        grossMinor: 50000,
        refundedMinor: 0,
        netMinor: 50000,
        payments: 1,
        refunds: 0,
      },
      {
        currency: 'usd',
        grossMinor: 2900,
        refundedMinor: 0,
        netMinor: 2900,
        payments: 1,
        refunds: 0,
      },
    ]);
    // Sumar MXN y USD sin tipo de cambio de la fecha del cobro no es dinero.
    expect(ledger).not.toHaveProperty('totalMinor');
    expect(ledger.totalsOmittedReason).toBe(
      'mixed_currencies_require_dated_fx',
    );
  });

  it('el reembolso resta del neto sin borrar el bruto', () => {
    const ledger = buildRevenueLedger({
      facts: [
        payment({ amountMinor: 50000 }),
        {
          objectId: 'ch_1',
          kind: 'refund',
          currency: 'mxn',
          amountMinor: 20000,
          occurredAt: '2026-09-20T00:00:00.000Z',
          livemode: false,
        },
      ],
      window: WINDOW,
      coverage: 'complete',
    });

    expect(ledger.byCurrency[0]).toMatchObject({
      grossMinor: 50000,
      refundedMinor: 20000,
      netMinor: 30000,
    });
  });

  it('un reembolso de un cobro anterior a la ventana se cuenta aparte', () => {
    const ledger = buildRevenueLedger({
      facts: [
        payment({ amountMinor: 50000 }),
        {
          objectId: 'ch_viejo',
          kind: 'refund',
          currency: 'mxn',
          amountMinor: 10000,
          occurredAt: '2026-08-15T00:00:00.000Z',
          livemode: false,
        },
      ],
      window: WINDOW,
      coverage: 'complete',
    });

    // No se resta de un bruto que no incluye ese cobro: se informa.
    expect(ledger.byCurrency[0].netMinor).toBe(50000);
    expect(ledger.refundsOutsideWindow).toBe(1);
  });

  it('descarta cuentas excluidas y las cuenta', () => {
    const ledger = buildRevenueLedger({
      facts: [
        payment({ accountId: 'cliente' }),
        payment({ objectId: 'in_qa', accountId: 'qa-1', amountMinor: 999999 }),
      ],
      window: WINDOW,
      coverage: 'complete',
      isExcluded: (accountId) => accountId === 'qa-1',
    });

    expect(ledger.byCurrency[0].grossMinor).toBe(50000);
    expect(ledger.excludedAccounts).toBe(1);
  });

  it('ignora importes no positivos o sin moneda', () => {
    const ledger = buildRevenueLedger({
      facts: [
        payment({ amountMinor: 0 }),
        payment({ objectId: 'in_3', currency: '' }),
        payment({ objectId: 'in_4', amountMinor: 1.5 }),
      ],
      window: WINDOW,
      coverage: 'complete',
    });

    // Una factura con cupón total no es un cobro positivo (plan §5).
    expect(ledger.byCurrency).toEqual([]);
  });

  it('propaga la cobertura recibida sin adornarla', () => {
    expect(
      buildRevenueLedger({ facts: [], window: WINDOW, coverage: 'partial' })
        .coverage,
    ).toBe('partial');
  });
});

describe('refundDelta', () => {
  it('trata amount_refunded como acumulado, no como incremento', () => {
    // Dos reembolsos parciales del mismo cargo llegan como 30 y luego 50:
    // sumar los eventos contaría 80 donde hubo 50.
    expect(refundDelta(0, 3000)).toBe(3000);
    expect(refundDelta(3000, 5000)).toBe(2000);
  });

  it('un evento reordenado con menos acumulado no resta nada', () => {
    expect(refundDelta(5000, 3000)).toBe(0);
  });

  it('descarta valores imposibles', () => {
    expect(refundDelta(0, 0)).toBe(0);
    expect(refundDelta(0, -100)).toBe(0);
    expect(refundDelta(0, 1.5)).toBe(0);
  });
});
