import type { Coverage } from './growth-sources.js';

/**
 * Costes declarados y economía observada.
 *
 * El plan (§5) pide «ingreso incremental observado menos renderer, nube,
 * conectores y soporte; separar estimación de coste por operación de costes
 * facturados». Aquí solo entran **costes facturados y declarados**: este módulo
 * no estima nada. Si una categoría no tiene fuente, la economía no se publica;
 * un neto calculado con tres de cuatro categorías es peor que no dar número,
 * porque parece completo.
 *
 * Y como en el libro de ingresos: **nunca se suma entre monedas**. Un coste en
 * USD no se resta de un ingreso en MXN sin tipo de cambio de la fecha.
 */

/**
 * Código de fuente admitido. Cerrado a propósito: cualquier cosa que no encaje
 * se cuenta pero no se publica, así una etiqueta con un correo o una URL no
 * llega al snapshot por el camino de los costes.
 */
export const SAFE_SOURCE_CODE = /^[a-z][a-z0-9_-]{0,39}$/;

export const COST_CATEGORIES = [
  'renderer',
  'cloud',
  'connector',
  'support',
] as const;

export type CostCategory = (typeof COST_CATEGORIES)[number];

export interface CostEntry {
  /** Período contable `YYYY-MM`. */
  period: string;
  category: CostCategory;
  currency: string;
  amountMinor: number;
  /**
   * Código de fuente, no etiqueta libre: `^[a-z][a-z0-9_-]{0,39}$`. Lo
   * mantiene operación y se valida antes de publicar nada, porque una etiqueta
   * libre acaba conteniendo el correo o la URL del proveedor y este documento
   * lo leen el panel y el exportador.
   */
  source: string;
  /** `invoiced` es dinero facturado; `declared` es una cifra aportada a mano. */
  basis: 'invoiced' | 'declared';
  observedAt: string;
}

export interface CategoryCost {
  category: CostCategory;
  amountMinor: number | null;
  entries: number;
  /** Cuántas fuentes distintas, no cuáles: las etiquetas no se publican. */
  sourceCount: number;
  /** Bases observadas, que son un enumerado cerrado y seguro. */
  basis: ('invoiced' | 'declared')[];
  /** Entradas cuya fuente no cumple el código seguro: se cuentan, no se muestran. */
  unsafeSourceLabels: number;
  status: 'observed' | 'missing_data';
}

export interface CurrencyEconomics {
  currency: string;
  costByCategory: CategoryCost[];
  costTotalMinor: number | null;
  /** Ingreso neto de reembolsos en esta moneda, si lo hay. */
  netRevenueMinor: number | null;
  /** Solo con las cuatro categorías presentes y el ingreso con cobertura completa. */
  contributionMinor: number | null;
  status: 'observed' | 'missing_data';
  reason?: string;
}

export interface CostLedger {
  schemaVersion: 1;
  period: string;
  coverage: Coverage;
  byCurrency: CurrencyEconomics[];
  totalsOmittedReason: 'mixed_currencies_require_dated_fx';
  /** Categorías sin ninguna entrada en el período, por moneda. */
  missingCategories: { currency: string; missing: CostCategory[] }[];
  estimatedCostsExcluded: true;
  semantics: 'invoiced_and_declared_costs_only_no_estimates';
}

export function buildCostLedger(input: {
  period: string;
  entries: CostEntry[];
  /** Ingreso neto por moneda, del libro de ingresos. */
  netRevenueByCurrency: { currency: string; netMinor: number }[];
  /** Cobertura del ingreso: sin ella no hay economía, aunque haya costes. */
  revenueCoverage: Coverage;
}): CostLedger {
  const valid = input.entries.filter(
    (entry) =>
      entry.period === input.period &&
      COST_CATEGORIES.includes(entry.category) &&
      !!entry.currency &&
      Number.isSafeInteger(entry.amountMinor) &&
      entry.amountMinor >= 0,
  );

  const currencies = [
    ...new Set([
      ...valid.map((entry) => entry.currency.toLowerCase()),
      ...input.netRevenueByCurrency.map((row) => row.currency.toLowerCase()),
    ]),
  ].sort();

  const missingCategories: CostLedger['missingCategories'] = [];

  const byCurrency = currencies.map<CurrencyEconomics>((currency) => {
    const rows = valid.filter(
      (entry) => entry.currency.toLowerCase() === currency,
    );
    const costByCategory = COST_CATEGORIES.map<CategoryCost>((category) => {
      const categoryRows = rows.filter((entry) => entry.category === category);
      return {
        category,
        // Sin entradas es ausencia de dato, no un coste de cero: nadie ha
        // declarado que ese mes no se gastara nada en renderer.
        amountMinor: categoryRows.length
          ? categoryRows.reduce((sum, entry) => sum + entry.amountMinor, 0)
          : null,
        entries: categoryRows.length,
        sourceCount: new Set(
          categoryRows
            .map((entry) => entry.source)
            .filter((source) => SAFE_SOURCE_CODE.test(source ?? '')),
        ).size,
        basis: [
          ...new Set(categoryRows.map((entry) => entry.basis)),
        ].sort() as ('invoiced' | 'declared')[],
        unsafeSourceLabels: categoryRows.filter(
          (entry) => !SAFE_SOURCE_CODE.test(entry.source ?? ''),
        ).length,
        status: categoryRows.length ? 'observed' : 'missing_data',
      };
    });

    const missing = costByCategory
      .filter((row) => row.status === 'missing_data')
      .map((row) => row.category);
    if (missing.length) missingCategories.push({ currency, missing });

    const complete = missing.length === 0;
    const costTotalMinor = complete
      ? costByCategory.reduce((sum, row) => sum + (row.amountMinor ?? 0), 0)
      : null;
    const netRevenueMinor =
      input.netRevenueByCurrency.find(
        (row) => row.currency.toLowerCase() === currency,
      )?.netMinor ?? null;

    const usable =
      complete &&
      netRevenueMinor !== null &&
      input.revenueCoverage === 'complete';

    return {
      currency,
      costByCategory,
      costTotalMinor,
      netRevenueMinor,
      contributionMinor: usable ? netRevenueMinor - costTotalMinor : null,
      status: usable ? 'observed' : 'missing_data',
      ...(usable
        ? {}
        : {
            reason: !complete
              ? `missing_cost_categories:${missing.join(',')}`
              : netRevenueMinor === null
                ? 'no_revenue_in_currency'
                : `revenue_coverage_${input.revenueCoverage}`,
          }),
    };
  });

  const observed = byCurrency.filter((row) => row.status === 'observed').length;

  return {
    schemaVersion: 1,
    period: input.period,
    coverage:
      byCurrency.length === 0
        ? 'missing_data'
        : observed === byCurrency.length
          ? 'complete'
          : observed > 0
            ? 'partial'
            : 'missing_data',
    byCurrency,
    totalsOmittedReason: 'mixed_currencies_require_dated_fx',
    missingCategories,
    estimatedCostsExcluded: true,
    semantics: 'invoiced_and_declared_costs_only_no_estimates',
  };
}
