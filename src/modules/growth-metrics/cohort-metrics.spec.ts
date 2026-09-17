import {
  calculateFeatureCohorts,
  calculatePaid30d,
  calculatePaidAccountBridge,
  CohortEvent,
} from './cohort-metrics.js';
const at = (day: number) => new Date(Date.UTC(2026, 0, 1 + day)).toISOString();
const event = (
  accountId: string,
  day: number,
  eventName: string,
  isSynthetic = false,
): CohortEvent => ({
  accountId,
  featureId: 'packing_workflow',
  occurredAt: at(day),
  eventName,
  isSynthetic,
});
describe('mature account cohorts', () => {
  it('excludes immature exposure cohorts and synthetic traffic, deduplicates accounts', () => {
    const result = calculateFeatureCohorts(
      [
        event('a', 0, 'feature_exposed'),
        event('a', 1, 'feature_exposed'),
        event('a', 1, 'packing_export_succeeded'),
        event('a', 2, 'packing_export_succeeded'),
        event('b', 9, 'feature_exposed'),
        event('b', 9, 'packing_export_succeeded'),
        event('test', 0, 'feature_exposed', true),
      ],
      'packing_workflow',
      at(10),
    );
    expect(result.activation7d).toEqual({
      numerator: 1,
      denominator: 1,
      value: 1,
      status: 'observed',
    });
    expect(result.retentionW2.value).toBeNull();
  });
  it('uses distinct W2 and D30 windows relative to first activation', () => {
    const result = calculateFeatureCohorts(
      [
        event('a', 0, 'feature_exposed'),
        event('a', 1, 'packing_export_succeeded'),
        event('a', 8, 'packing_export_succeeded'),
        event('a', 31, 'packing_export_succeeded'),
      ],
      'packing_workflow',
      at(32),
    );
    expect(result.retentionW2.numerator).toBe(1);
    expect(result.retentionD30.numerator).toBe(1);
    expect(
      calculateFeatureCohorts([], 'packing_workflow', at(32)).activation7d
        .value,
    ).toBeNull();
  });
  it('uses all mature initially unpaid assignments for paid30d, not consented exposures', () => {
    const result = calculatePaid30d(
      [
        { accountId: 'a', assignedAt: at(0), initiallyPaid: false },
        { accountId: 'b', assignedAt: at(0), initiallyPaid: false },
        { accountId: 'c', assignedAt: at(0), initiallyPaid: true },
        { accountId: 'd', assignedAt: at(29), initiallyPaid: false },
      ],
      [
        { accountId: 'a', paidAt: at(5), amountMinor: 100 },
        { accountId: 'b', paidAt: at(5), amountMinor: 0 },
      ],
      at(30),
    );
    expect(result).toMatchObject({
      numerator: 1,
      denominator: 2,
      value: 0.5,
      status: 'observed',
      excludedUnknownInitialState: 0,
      convertedAccountCount: 1,
      semantics: 'intent_to_treat_initially_unpaid',
    });
  });

  it('no publica identificadores de cuenta, solo el recuento', () => {
    const collector = new Set<string>();
    const result = calculatePaid30d(
      [
        {
          accountId: 'cuenta-uid-real',
          assignedAt: at(0),
          initiallyPaid: false,
        },
      ],
      [{ accountId: 'cuenta-uid-real', paidAt: at(5), amountMinor: 100 }],
      at(30),
      'complete',
      collector,
    );

    // El resultado acaba dentro de `growth_snapshots`, que lo leen el panel y
    // el exportador: ningún UID puede viajar ahí.
    expect(JSON.stringify(result)).not.toContain('cuenta-uid-real');
    expect(result).toMatchObject({ convertedAccountCount: 1 });
    expect(result).not.toHaveProperty('convertedAccounts');
    // Los identificadores solo existen en el acumulador de quien llama.
    expect([...collector]).toEqual(['cuenta-uid-real']);
  });

  it('deja fuera del denominador la asignación sin estado inicial conocido', () => {
    const result = calculatePaid30d(
      [
        { accountId: 'a', assignedAt: at(0), initiallyPaid: false },
        // Sin `initiallyPaid`: antes entraba al denominador como si no pagara,
        // que es exactamente lo que infla la conversión.
        { accountId: 'b', assignedAt: at(0) },
      ],
      [{ accountId: 'a', paidAt: at(5), amountMinor: 100 }],
      at(30),
    );

    expect(result).toMatchObject({
      numerator: 1,
      denominator: 1,
      excludedUnknownInitialState: 1,
    });
  });

  it('no publica tasa si la cobertura del primer pago es parcial', () => {
    const result = calculatePaid30d(
      [{ accountId: 'a', assignedAt: at(0), initiallyPaid: false }],
      [{ accountId: 'a', paidAt: at(5), amountMinor: 100 }],
      at(30),
      'partial',
    );

    // Con histórico incompleto, el «primer pago» observado puede ser el
    // segundo: se devuelve ausencia de dato, no un 100%.
    expect(result).toEqual({
      numerator: null,
      denominator: null,
      value: null,
      status: 'missing_data',
      reason: 'first_payment_coverage_partial',
    });
  });

  it('informa el alcance cuando se conoce la población elegible', () => {
    const exposed = [
      {
        accountId: 'a',
        featureId: 'packing_workflow',
        occurredAt: at(0),
        eventName: 'feature_exposed',
      },
    ];

    expect(
      calculateFeatureCohorts(exposed, 'packing_workflow', at(30), [
        'a',
        'b',
        'c',
        'd',
      ]).reach,
    ).toMatchObject({ numerator: 1, denominator: 4, value: 0.25 });

    // Sin población elegible no se inventa un alcance del 100%.
    expect(
      calculateFeatureCohorts(exposed, 'packing_workflow', at(30)).reach,
    ).toMatchObject({
      status: 'missing_data',
      reason: 'eligible_population_unknown',
    });
  });
});

describe('financial and product retention distinctions', () => {
  it('excludes old payers with a new payment from new paid acquisition', () => {
    const result = calculatePaid30d(
      [
        { accountId: 'returning', assignedAt: at(10), initiallyPaid: false },
        { accountId: 'new', assignedAt: at(10), initiallyPaid: false },
      ],
      [
        { accountId: 'returning', paidAt: at(0), amountMinor: 100 },
        { accountId: 'returning', paidAt: at(15), amountMinor: 100 },
        { accountId: 'new', paidAt: at(15), amountMinor: 100 },
        { accountId: 'new', paidAt: at(16), amountMinor: 100 },
      ],
      at(40),
    );
    expect(result).toMatchObject({ numerator: 1, denominator: 1, value: 1 });
  });
  it('separates retained use of another feature from retention of the original feature', () => {
    const result = calculateFeatureCohorts(
      [
        event('a', 0, 'feature_exposed'),
        event('a', 1, 'packing_export_succeeded'),
        {
          ...event('a', 8, 'template_run_succeeded'),
          featureId: 'label_templates',
        },
      ],
      'packing_workflow',
      at(15),
    );
    expect(result.retentionW2.value).toBe(0);
    expect(result.productRetentionW2.value).toBe(1);
  });
  it('reconciles distinct accounts, not subscriptions or upgrade events', () => {
    expect(
      calculatePaidAccountBridge(
        ['stays', 'leaves', 'stays'],
        ['stays', 'new', 'returns', 'returns'],
        ['stays', 'leaves', 'returns'],
      ),
    ).toMatchObject({
      opening: 2,
      closing: 3,
      newPaid: 1,
      reactivated: 1,
      effectiveChurn: 1,
      net: 1,
      reconciled: true,
    });
  });
});
