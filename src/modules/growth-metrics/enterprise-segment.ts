import type { Coverage } from './growth-sources.js';
import { SAFE_SOURCE_CODE } from './cost-ledger.js';

/**
 * Segmento Enterprise gestionado a mano.
 *
 * El plan (§5) dice que «Enterprise manual se concilia como segmento
 * separado». Separado quiere decir dos cosas concretas:
 *
 * 1. **No se suma al inventario de Stripe.** Una cuenta Enterprise con
 *    suscripción en Stripe ya está contada ahí; volver a contarla aquí
 *    duplicaría clientes. Solo entran las cuentas Enterprise observadas
 *    internamente que **no** aparecen en el inventario de suscripciones.
 * 2. **No se inventa ingreso.** Un contrato manual sin importe declarado no
 *    aporta dinero al libro: aporta una cuenta y un `missing_data`. El importe
 *    solo existe si alguien lo declaró con su moneda y su período.
 */

export interface InternalEnterpriseAccount {
  accountId: string;
  /** Plan observado en la fuente interna (`users`), no en Stripe. */
  plan: string;
  observedAt: string;
}

export interface EnterpriseContract {
  accountId: string;
  /** Período contable `YYYY-MM`. */
  period: string;
  currency: string;
  amountMinor: number;
  /** Código de fuente cerrado (`^[a-z][a-z0-9_-]{0,39}$`), no etiqueta libre. */
  source: string;
  basis: 'invoiced' | 'declared';
}

export interface EnterpriseSegment {
  schemaVersion: 1;
  period: string;
  coverage: Coverage;
  /** Cuentas Enterprise internas que no están en el inventario de Stripe. */
  manualAccounts: number;
  /** Cuentas Enterprise que sí están en Stripe: se cuentan allí, no aquí. */
  accountsAlreadyInStripe: number;
  /** Manuales con importe declarado para el período. */
  accountsWithDeclaredRevenue: number;
  /** Manuales sin importe: cuentan como cuenta, no como dinero. */
  accountsWithoutRevenue: number;
  revenueByCurrency: {
    currency: string;
    amountMinor: number;
    accounts: number;
    basis: ('invoiced' | 'declared')[];
  }[];
  /** Cuántas fuentes distintas, no cuáles. */
  sourceCount: number;
  /** Contratos cuya fuente no cumple el código seguro: se cuentan, no se muestran. */
  unsafeSourceLabels: number;
  doNotSumWithStripe: true;
  semantics: 'internally_observed_enterprise_not_in_stripe_inventory';
  reason?: string;
}

export function buildEnterpriseSegment(input: {
  period: string;
  internalAccounts: InternalEnterpriseAccount[];
  /** Cuentas presentes en el inventario de suscripciones de Stripe. */
  stripeInventoryAccounts: string[];
  contracts: EnterpriseContract[];
  /** Cobertura del inventario: sin él no se puede saber quién ya está contado. */
  inventoryCoverage: Coverage;
  isExcluded?: (accountId: string) => boolean;
}): EnterpriseSegment {
  const base: EnterpriseSegment = {
    schemaVersion: 1,
    period: input.period,
    coverage: 'missing_data',
    manualAccounts: 0,
    accountsAlreadyInStripe: 0,
    accountsWithDeclaredRevenue: 0,
    accountsWithoutRevenue: 0,
    revenueByCurrency: [],
    sourceCount: 0,
    unsafeSourceLabels: 0,
    doNotSumWithStripe: true,
    semantics: 'internally_observed_enterprise_not_in_stripe_inventory',
  };

  // Sin inventario no se puede distinguir manual de facturado por Stripe, y
  // publicar el recuento entero como «manual» duplicaría clientes.
  if (input.inventoryCoverage !== 'complete')
    return { ...base, reason: `inventory_coverage_${input.inventoryCoverage}` };

  const inStripe = new Set(input.stripeInventoryAccounts);
  const enterprise = input.internalAccounts.filter(
    (account) =>
      account.plan === 'enterprise' && !input.isExcluded?.(account.accountId),
  );
  const manual = enterprise.filter(
    (account) => !inStripe.has(account.accountId),
  );
  const manualIds = new Set(manual.map((account) => account.accountId));

  const contracts = input.contracts.filter(
    (contract) =>
      contract.period === input.period &&
      manualIds.has(contract.accountId) &&
      !!contract.currency &&
      Number.isSafeInteger(contract.amountMinor) &&
      contract.amountMinor > 0,
  );

  const buckets = new Map<
    string,
    { amountMinor: number; accounts: Set<string>; basis: Set<string> }
  >();
  for (const contract of contracts) {
    const currency = contract.currency.toLowerCase();
    if (!buckets.has(currency))
      buckets.set(currency, {
        amountMinor: 0,
        accounts: new Set(),
        basis: new Set(),
      });
    const bucket = buckets.get(currency);
    bucket.amountMinor += contract.amountMinor;
    bucket.accounts.add(contract.accountId);
    bucket.basis.add(contract.basis);
  }

  const withRevenue = new Set(contracts.map((contract) => contract.accountId));

  return {
    ...base,
    coverage:
      manual.length === 0 || withRevenue.size === manual.length
        ? 'complete'
        : 'partial',
    manualAccounts: manual.length,
    accountsAlreadyInStripe: enterprise.length - manual.length,
    accountsWithDeclaredRevenue: withRevenue.size,
    accountsWithoutRevenue: manual.length - withRevenue.size,
    revenueByCurrency: [...buckets.entries()]
      .map(([currency, bucket]) => ({
        currency,
        amountMinor: bucket.amountMinor,
        accounts: bucket.accounts.size,
        basis: [...bucket.basis].sort() as ('invoiced' | 'declared')[],
      }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
    sourceCount: new Set(
      contracts
        .map((contract) => contract.source)
        .filter((source) => SAFE_SOURCE_CODE.test(source ?? '')),
    ).size,
    unsafeSourceLabels: contracts.filter(
      (contract) => !SAFE_SOURCE_CODE.test(contract.source ?? ''),
    ).length,
    ...(manual.length && withRevenue.size < manual.length
      ? { reason: 'manual_accounts_without_declared_revenue' }
      : {}),
  };
}
