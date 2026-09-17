import { ConfigService } from '@nestjs/config';
import { FirestoreService } from '../cache/firestore.service.js';
import { ProductEventOutboxService } from '../product-observability/product-event-outbox.service.js';
import { GrowthJobsService } from './growth-jobs.service.js';

const DAY = 86400000;

/**
 * Doble de Firestore con lo que usa el agregado: documentos por ruta, consultas
 * con filtros y transacciones que respetan el orden lecturas→escrituras.
 *
 * No pretende ser Firestore: pretende que las reglas que se prueban aquí
 * —fencing, ventanas y cobertura— se ejecuten sobre el mismo código que corre
 * en producción, sin red ni credenciales.
 */
function fakeFirestore() {
  const docs = new Map<string, any>();
  const collections = new Map<string, Map<string, any>>();

  const bucket = (name: string) => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  };

  const snapshot = (path: string) => ({
    exists: docs.has(path),
    id: path.split('/').pop(),
    ref: { path },
    data: () => docs.get(path),
    get: (key: string) => docs.get(path)?.[key],
  });

  function query(name: string, filters: any[] = [], cap?: number) {
    const api = {
      where: (field: string, op: string, value: any) =>
        query(name, [...filters, { field, op, value }], cap),
      orderBy: () => api,
      startAfter: (cursor: string) =>
        query(name, [...filters, { after: cursor }], cap),
      limit: (value: number) => query(name, filters, value),
      get: async () => {
        const rows = [...bucket(name).entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .filter(([id]) =>
            filters.every(({ after }) => !after || id.localeCompare(after) > 0),
          )
          .filter(([, row]) =>
            filters.every(({ field, op, value, after }) => {
              if (after) return true;
              const actual = row[field];
              if (op === '==') return actual === value;
              if (op === '>=') return actual >= value;
              if (op === '<=') return actual !== undefined && actual <= value;
              if (op === 'in') return value.includes(actual);
              return true;
            }),
          );
        const limited = cap === undefined ? rows : rows.slice(0, cap);
        return {
          size: limited.length,
          empty: limited.length === 0,
          docs: limited.map(([id, row]) => ({
            id,
            ref: { path: `${name}/${id}` },
            data: () => row,
            get: (key: string) => row[key],
          })),
        };
      },
    };
    return api;
  }

  const db: any = {
    batch: () => {
      const pending: any[] = [];
      return {
        delete: (ref: any) => pending.push(ref),
        commit: async () => {
          for (const ref of pending) {
            const [name, id] = String(ref.path).split('/');
            bucket(name).delete(id);
          }
        },
      };
    },
    collection: (name: string) => ({
      ...query(name),
      doc: (id: string) => ({
        path: `${name}/${id}`,
        get: async () => {
          const row = bucket(name).get(id);
          return {
            exists: row !== undefined,
            data: () => row,
            get: (key: string) => row?.[key],
          };
        },
      }),
    }),
    runTransaction: async (fn: any) => {
      let wrote = false;
      const tx = {
        get: async (ref: any) => {
          if (wrote) throw new Error('Firestore: reads must precede writes');
          const [name, id] = String(ref.path).split('/');
          const row = bucket(name).get(id);
          return {
            exists: row !== undefined,
            ref,
            data: () => row,
            get: (key: string) => row?.[key],
          };
        },
        set: (ref: any, value: any, options?: any) => {
          wrote = true;
          const [name, id] = String(ref.path).split('/');
          const prior = options?.merge ? bucket(name).get(id) : undefined;
          bucket(name).set(id, { ...prior, ...value });
          docs.set(ref.path, bucket(name).get(id));
        },
        update: (ref: any, value: any) => {
          wrote = true;
          const [name, id] = String(ref.path).split('/');
          bucket(name).set(id, { ...bucket(name).get(id), ...value });
          docs.set(ref.path, bucket(name).get(id));
        },
        create: (ref: any, value: any) => tx.set(ref, value),
        delete: () => {
          wrote = true;
        },
      };
      return fn(tx);
    },
  };

  return { db, bucket, snapshot };
}

function buildService(
  store: ReturnType<typeof fakeFirestore>,
  config: Record<string, string> = {},
) {
  return new GrowthJobsService(
    {
      getClient: () => store.db,
      getUserByStripeCustomerId: jest.fn().mockResolvedValue(null),
      isAccountDeletionMarked: jest.fn().mockResolvedValue(false),
      getLastFeedbackByUser: jest.fn().mockResolvedValue(null),
    } as unknown as FirestoreService,
    {
      dispatch: jest.fn().mockResolvedValue({ delivered: 0 }),
    } as unknown as ProductEventOutboxService,
    new ConfigService({
      NODE_ENV: 'test',
      GROWTH_COHORT_START: '2020-01-01T00:00:00.000Z',
      ...config,
    }),
    { run: jest.fn().mockResolvedValue({ status: 'missing_data' }) } as any,
  );
}

/** Deja las fuentes en un estado con cobertura completa hasta `at`. */
function seedCompleteSources(
  store: ReturnType<typeof fakeFirestore>,
  at: number,
) {
  store.bucket('growth_event_facts').set('e1', {
    accountId: 'cuenta-real',
    featureId: 'packing_workflow',
    eventName: 'feature_exposed',
    environment: 'test',
    isSynthetic: false,
    occurredAt: new Date(at - 40 * DAY).toISOString(),
    receivedAt: new Date(at - 40 * DAY).toISOString(),
  });
  store.bucket('growth_account_feature_firsts').set('a1', {
    accountId: 'cuenta-real',
    featureId: 'packing_workflow',
    environment: 'test',
    isSynthetic: false,
    firstExposureAt: new Date(at - 40 * DAY).toISOString(),
  });
  store.bucket('growth_billing_sync').set('test', {
    status: 'complete',
    unresolved: 0,
    completedAt: new Date(at - 3600000).toISOString(),
    sourceWatermark: new Date(at - 2 * 3600000).toISOString(),
  });
  store.bucket('growth_paid_stocks').set('test_latest', {
    status: 'complete',
    observedAt: new Date(at - 3600000).toISOString(),
    paidAccounts: 4,
    runId: 'run-1',
  });
}

describe('A03 agregación — ventanas y contaminación del backfill', () => {
  it('no mete el inventario de hoy en el snapshot de un día pasado', async () => {
    const store = fakeFirestore();
    const now = Date.parse('2026-09-17T06:00:00.000Z');
    seedCompleteSources(store, now);
    jest.useFakeTimers().setSystemTime(now);

    try {
      await buildService(store).run('aggregate', new Date(now).toISOString());
    } finally {
      jest.useRealTimers();
    }

    const snapshots = store.bucket('growth_snapshots');
    const historic = [...snapshots.entries()].filter(
      ([id]) => id !== 'latest' && !id.startsWith('2026-09-17'),
    );

    // El inventario se observó hoy: ningún snapshot anterior puede llevarlo.
    expect(historic.length).toBeGreaterThan(0);
    for (const [, row] of historic) {
      expect(row.paidAccountStock.status).toBe('missing_data');
      expect(row.paidAccountStock.reason).toBe(
        'inventory_outside_snapshot_window',
      );
      expect(row.blockers).toContain('inventory_after_cutoff');
      // Y sin cobertura no se publica tasa ninguna.
      expect(row.status).toBe('incomplete');
      expect(row.features).toEqual([]);
    }
  });

  it('el snapshot del día sí usa el inventario y declara sus semánticas', async () => {
    const store = fakeFirestore();
    const now = Date.parse('2026-09-17T06:00:00.000Z');
    seedCompleteSources(store, now);
    jest.useFakeTimers().setSystemTime(now);

    try {
      await buildService(store).run('aggregate', new Date(now).toISOString());
    } finally {
      jest.useRealTimers();
    }

    const latest = store.bucket('growth_snapshots').get('latest');
    expect(latest.paidAccountStock.paidAccounts).toBe(4);
    // Existencias en un instante: no es conversión ni actividad.
    expect(latest.paidAccountStockSemantics).toBe(
      'point_in_time_stock_not_conversion',
    );
    expect(latest.crossFeatureSemantics).toBe(
      'do_not_sum_converted_accounts_across_features',
    );
  });

  it('la marca de agua sale de las fuentes, no del reloj del planificador', async () => {
    const store = fakeFirestore();
    const now = Date.parse('2026-09-17T06:00:00.000Z');
    seedCompleteSources(store, now);
    jest.useFakeTimers().setSystemTime(now);

    try {
      await buildService(store).run('aggregate', new Date(now).toISOString());
    } finally {
      jest.useRealTimers();
    }

    const latest = store.bucket('growth_snapshots').get('latest');
    // La facturación solo sabe hasta hace dos horas: esa es la marca.
    expect(latest.sourceWatermark).toBe(
      new Date(now - 2 * 3600000).toISOString(),
    );
    expect(latest.sourceWatermark).not.toBe(new Date(now).toISOString());
  });

  it('un atraso en la cola de BE04/BE05 bloquea la cobertura', async () => {
    const store = fakeFirestore();
    const now = Date.parse('2026-09-17T06:00:00.000Z');
    seedCompleteSources(store, now);
    store.bucket('label_event_retries').set('pendiente', {
      status: 'pending',
      availableAt: new Date(now - 60000).toISOString(),
      accountId: 'cuenta-real',
    });
    jest.useFakeTimers().setSystemTime(now);

    try {
      await buildService(store).run('aggregate', new Date(now).toISOString());
    } finally {
      jest.useRealTimers();
    }

    const latest = store.bucket('growth_snapshots').get('latest');
    expect(latest.blockers).toContain('label_event_backlog');
    expect(latest.sourceWatermark).toBeNull();
    expect(latest.status).toBe('incomplete');
    expect(latest.counterSignals.labelEventBacklog).toBe(true);
  });

  it('excluye cuentas de QA y administración del recuento', async () => {
    const store = fakeFirestore();
    const now = Date.parse('2026-09-17T06:00:00.000Z');
    seedCompleteSources(store, now);
    store.bucket('growth_event_facts').set('e2', {
      accountId: 'cuenta-qa',
      featureId: 'packing_workflow',
      eventName: 'packing_export_succeeded',
      environment: 'test',
      isSynthetic: false,
      occurredAt: new Date(now - 10 * DAY).toISOString(),
      receivedAt: new Date(now - 10 * DAY).toISOString(),
    });
    jest.useFakeTimers().setSystemTime(now);

    try {
      await buildService(store, {
        GROWTH_EXCLUDED_ACCOUNT_IDS: 'cuenta-qa',
      }).run('aggregate', new Date(now).toISOString());
    } finally {
      jest.useRealTimers();
    }

    const latest = store.bucket('growth_snapshots').get('latest');
    expect(latest.excludedAccountsConfigured).toBe(1);
    expect(latest.accountsCounted).toBe(1);
  });

  it('con primer pago solo de webhook no publica conversión', async () => {
    const store = fakeFirestore();
    const now = Date.parse('2026-09-17T06:00:00.000Z');
    seedCompleteSources(store, now);
    store.bucket('growth_first_payments').set('test_cuenta-real', {
      accountId: 'cuenta-real',
      livemode: false,
      firstPaidAt: new Date(now - 20 * DAY).toISOString(),
      amountMinor: 1000,
      // Sin histórico conciliado: este «primero» puede ser el segundo.
      coverage: 'webhook_only',
    });
    jest.useFakeTimers().setSystemTime(now);

    try {
      await buildService(store).run('aggregate', new Date(now).toISOString());
    } finally {
      jest.useRealTimers();
    }

    const latest = store.bucket('growth_snapshots').get('latest');
    expect(latest.firstPaymentCoverage).toBe('partial');
    expect(latest.blockers).toContain('first_payment_coverage_partial');
    expect(latest.status).toBe('incomplete');
  });
});

describe('A03/A05 fencing — un lease vencido no publica', () => {
  it('no escribe snapshot ni latest si otro proceso tomó la ventana', async () => {
    const store = fakeFirestore();
    const now = Date.parse('2026-09-17T06:00:00.000Z');
    seedCompleteSources(store, now);
    store.bucket('growth_snapshots').set('latest', { marca: 'anterior' });
    jest.useFakeTimers().setSystemTime(now);

    const service = buildService(store);
    // Otro trabajador roba la ventana en cuanto este reclama el lease.
    const runs = store.bucket('growth_job_runs');
    const original = store.db.runTransaction;
    let stolen = false;
    store.db.runTransaction = async (fn: any) => {
      const result = await original(fn);
      if (!stolen) {
        for (const [id, row] of runs.entries())
          if (row.token) {
            runs.set(id, { ...row, token: 'token-de-otro' });
            stolen = true;
          }
      }
      return result;
    };

    try {
      await expect(
        service.run('aggregate', new Date(now).toISOString()),
      ).rejects.toThrow(/lease lost/i);
    } finally {
      jest.useRealTimers();
      store.db.runTransaction = original;
    }

    // `latest` sigue siendo el anterior: el proceso desahuciado no publicó.
    expect(store.bucket('growth_snapshots').get('latest')).toEqual({
      marca: 'anterior',
    });
    // Y tampoco toca el documento de ejecución: el lease es de otro, así que
    // este proceso no marca su estado ni le pisa el token.
    const [, run] = [...runs.entries()][0];
    expect(run.token).toBe('token-de-otro');
    expect(run.errorCode).toBeUndefined();
    expect(run.status).toBe('running');
  });

  it('el panel no recomienda nada si alguna dependencia está incompleta', async () => {
    const store = fakeFirestore();
    const now = Date.parse('2026-09-17T07:10:00.000Z');
    store.bucket('growth_snapshots').set('latest', {
      status: 'observed',
      coverage: 'complete',
      billingCoverage: 'complete',
      firstPaymentCoverage: 'partial',
      sourceWatermark: new Date(now - 3600000).toISOString(),
      generatedAt: new Date(now - 3600000).toISOString(),
      calculationVersion: 'growth-v2',
      counterSignals: { eventBacklog: false },
    });
    store.bucket('growth_quality').set('latest', {
      status: 'observed',
      generatedAt: new Date(now - 600000).toISOString(),
    });
    jest.useFakeTimers().setSystemTime(now);

    try {
      await buildService(store).run('panel', new Date(now).toISOString());
    } finally {
      jest.useRealTimers();
    }

    const panel = store.bucket('growth_panel_receipts').get('latest');
    expect(panel.canEvaluateGrowth).toBe(false);
    expect(panel.blockers).toContain('first_payment_coverage_incomplete');
    expect(panel.sourceWatermark).toBeNull();
  });
});

describe('A02 calidad — cuenta las dos colas', () => {
  it('degrada la medición con hechos de etiquetas sin entregar', async () => {
    const store = fakeFirestore();
    const now = Date.parse('2026-09-17T06:15:00.000Z');
    store.bucket('label_event_retries').set('muerto', {
      status: 'dead',
      accountId: 'cuenta-real',
    });
    jest.useFakeTimers().setSystemTime(now);

    try {
      await buildService(store).run('quality', new Date(now).toISOString());
    } finally {
      jest.useRealTimers();
    }

    const quality = store.bucket('growth_quality').get('latest');
    expect(quality.status).toBe('degraded');
    expect(quality.labelEventDead).toBe(1);
    // La calidad de medición nunca autoriza a concluir negocio.
    expect(quality.canEvaluateGrowth).toBe(false);
  });
});

describe('A03/A04 — secciones financieras en el snapshot', () => {
  function seedFinance(store: ReturnType<typeof fakeFirestore>, at: number) {
    seedCompleteSources(store, at);
    // Inventario publicado con su libro de ingresos y sus miembros.
    store.bucket('growth_paid_stocks').set('test_latest', {
      status: 'complete',
      observedAt: new Date(at - 3600000).toISOString(),
      paidAccounts: 2,
      runId: 'run-1',
      revenueLedger: {
        coverage: 'complete',
        byCurrency: [{ currency: 'mxn', netMinor: 100000 }],
      },
    });
    store.bucket('growth_paid_inventory_members').set('run-1_sub_month', {
      runId: 'run-1',
      accountId: 'cuenta-real',
      livemode: false,
      subscriptionId: 'sub_month',
      billingInterval: 'month',
      currentPeriodEnd: new Date(at - 30 * DAY).toISOString(),
      status: 'active',
      isPaid: true,
    });
    store.bucket('billing_facts').set('invoice_in_cycle', {
      livemode: false,
      type: 'invoice_paid',
      positivePayment: true,
      subscriptionId: 'sub_month',
      accountId: 'cuenta-real',
      billingReason: 'subscription_cycle',
      occurredAt: new Date(at - 29 * DAY).toISOString(),
      amountMinor: 50000,
      currency: 'mxn',
      attributionStatus: 'resolved',
    });
  }

  it('publica renovación mensual madura y no cuenta el alta como renovación', async () => {
    const store = fakeFirestore();
    const now = Date.parse('2026-09-17T06:00:00.000Z');
    seedFinance(store, now);
    store.bucket('billing_facts').set('invoice_in_create', {
      livemode: false,
      type: 'invoice_paid',
      positivePayment: true,
      subscriptionId: 'sub_month',
      accountId: 'cuenta-real',
      billingReason: 'subscription_create',
      occurredAt: new Date(now - 60 * DAY).toISOString(),
      amountMinor: 50000,
      currency: 'mxn',
      attributionStatus: 'resolved',
    });
    jest.useFakeTimers().setSystemTime(now);

    try {
      await buildService(store).run('aggregate', new Date(now).toISOString());
    } finally {
      jest.useRealTimers();
    }

    const latest = store.bucket('growth_snapshots').get('latest');
    const month = latest.renewals.byInterval.find(
      (row: any) => row.interval === 'month',
    );
    expect(month).toMatchObject({ numerator: 1, denominator: 1, value: 1 });
    // El anual no tiene cohorte: ausencia, no 0%.
    expect(
      latest.renewals.byInterval.find((row: any) => row.interval === 'year'),
    ).toMatchObject({ denominator: 0, status: 'insufficient_data' });
  });

  it('el segmento Enterprise manual no se suma al inventario de Stripe', async () => {
    const store = fakeFirestore();
    const now = Date.parse('2026-09-17T06:00:00.000Z');
    seedFinance(store, now);
    store.bucket('users').set('ent-manual', { plan: 'enterprise' });
    store.bucket('users').set('cuenta-real', { plan: 'enterprise' });
    jest.useFakeTimers().setSystemTime(now);

    try {
      await buildService(store).run('aggregate', new Date(now).toISOString());
    } finally {
      jest.useRealTimers();
    }

    const latest = store.bucket('growth_snapshots').get('latest');
    // `cuenta-real` ya está en el inventario: solo `ent-manual` es manual.
    expect(latest.enterpriseSegment).toMatchObject({
      manualAccounts: 1,
      accountsAlreadyInStripe: 1,
      accountsWithoutRevenue: 1,
      doNotSumWithStripe: true,
    });
    expect(latest.enterpriseSegment.revenueByCurrency).toEqual([]);
    // Ningún UID ni etiqueta de fuente sale en el documento publicado.
    expect(JSON.stringify(latest)).not.toContain('cuenta-real');
    expect(latest.enterpriseSegment).not.toHaveProperty('sources');
    // Y el recuento de pagas sigue siendo el del inventario, sin sumarle nada.
    expect(latest.paidAccountStock.paidAccounts).toBe(2);
  });

  it('sin costes declarados la economía es missing_data, no cero', async () => {
    const store = fakeFirestore();
    const now = Date.parse('2026-09-17T06:00:00.000Z');
    seedFinance(store, now);
    jest.useFakeTimers().setSystemTime(now);

    try {
      await buildService(store).run('aggregate', new Date(now).toISOString());
    } finally {
      jest.useRealTimers();
    }

    const latest = store.bucket('growth_snapshots').get('latest');
    expect(latest.economics.byCurrency[0]).toMatchObject({
      currency: 'mxn',
      contributionMinor: null,
      status: 'missing_data',
    });
    expect(latest.economics.estimatedCostsExcluded).toBe(true);
  });

  it('con las cuatro categorías publica contribución en su moneda', async () => {
    const store = fakeFirestore();
    const now = Date.parse('2026-09-17T06:00:00.000Z');
    seedFinance(store, now);
    for (const category of ['renderer', 'cloud', 'connector', 'support'])
      store.bucket('growth_cost_entries').set(`2026-09_${category}`, {
        period: '2026-09',
        category,
        currency: 'mxn',
        amountMinor: 10000,
        source: `factura-${category}`,
        basis: 'invoiced',
        observedAt: new Date(now).toISOString(),
      });
    jest.useFakeTimers().setSystemTime(now);

    try {
      await buildService(store).run('aggregate', new Date(now).toISOString());
    } finally {
      jest.useRealTimers();
    }

    const latest = store.bucket('growth_snapshots').get('latest');
    expect(latest.economics.byCurrency[0]).toMatchObject({
      costTotalMinor: 40000,
      netRevenueMinor: 100000,
      contributionMinor: 60000,
      status: 'observed',
    });
    // Las etiquetas `factura-*` de las entradas no se publican.
    expect(JSON.stringify(latest.economics)).not.toContain('factura-');
    expect(latest.economics.byCurrency[0].costByCategory[0]).toMatchObject({
      sourceCount: 1,
      unsafeSourceLabels: 0,
    });
  });

  it('el snapshot no lleva identificadores de cuenta en ninguna sección', async () => {
    const store = fakeFirestore();
    const now = Date.parse('2026-09-17T06:00:00.000Z');
    seedFinance(store, now);
    store.bucket('growth_assignments').set('asg-1', {
      accountId: 'uid-privado-1',
      featureId: 'packing_workflow',
      environment: 'test',
      isSynthetic: false,
      assignedAt: new Date(now - 60 * DAY).toISOString(),
      initiallyPaid: false,
      experimentId: 'exp-1',
      assignmentVersion: 'v1',
      variant: 'treatment',
    });
    store.bucket('growth_first_payments').set('test_uid-privado-1', {
      accountId: 'uid-privado-1',
      livemode: false,
      firstPaidAt: new Date(now - 40 * DAY).toISOString(),
      amountMinor: 50000,
      coverage: 'reconciled_history',
    });
    jest.useFakeTimers().setSystemTime(now);

    try {
      await buildService(store).run('aggregate', new Date(now).toISOString());
    } finally {
      jest.useRealTimers();
    }

    const latest = store.bucket('growth_snapshots').get('latest');
    const serialized = JSON.stringify(latest);

    // La conversión se publica como recuento; el UID se queda en el proceso.
    expect(serialized).not.toContain('uid-privado-1');
    expect(latest.distinctConvertedAccounts).toBe(1);
    const paid = latest.features
      .flatMap((feature: any) => feature.paid30dByAssignment)
      .find((row: any) => row.variant === 'treatment');
    expect(paid).toMatchObject({ convertedAccountCount: 1 });
    expect(paid).not.toHaveProperty('convertedAccounts');
  });

  it('las fricciones operativas no son cero cuando falta instrumentación', async () => {
    const store = fakeFirestore();
    const now = Date.parse('2026-09-17T06:00:00.000Z');
    seedFinance(store, now);
    store.bucket('growth_operational_signals').set('sig-1', {
      id: 'sig-1',
      accountId: 'cuenta-real',
      featureId: 'packing_workflow',
      kind: 'quota_rejected',
      code: 'MONTHLY_LIMIT_EXCEEDED',
      statusCode: 403,
      environment: 'test',
      isSynthetic: false,
      occurredAt: new Date(now - DAY).toISOString(),
    });
    jest.useFakeTimers().setSystemTime(now);

    try {
      // Sin GROWTH_OPERATIONAL_SIGNALS_START no se puede afirmar cobertura.
      await buildService(store).run('aggregate', new Date(now).toISOString());
    } finally {
      jest.useRealTimers();
    }

    let latest = store.bucket('growth_snapshots').get('latest');
    expect(latest.counterSignals.operational).toMatchObject({
      coverage: 'missing_data',
      quotaRejections: null,
      reason: 'operational_signals_start_not_configured',
    });

    // Con la fecha configurada sí se cuentan, con cobertura de mejor esfuerzo.
    const store2 = fakeFirestore();
    seedFinance(store2, now);
    store2.bucket('growth_operational_signals').set('sig-1', {
      id: 'sig-1',
      accountId: 'cuenta-real',
      featureId: 'packing_workflow',
      kind: 'quota_rejected',
      code: 'MONTHLY_LIMIT_EXCEEDED',
      statusCode: 403,
      environment: 'test',
      isSynthetic: false,
      occurredAt: new Date(now - DAY).toISOString(),
    });
    jest.useFakeTimers().setSystemTime(now);
    try {
      await buildService(store2, {
        GROWTH_OPERATIONAL_SIGNALS_START: new Date(
          now - 200 * DAY,
        ).toISOString(),
      }).run('aggregate', new Date(now).toISOString());
    } finally {
      jest.useRealTimers();
    }

    latest = store2.bucket('growth_snapshots').get('latest');
    expect(latest.counterSignals.operational).toMatchObject({
      coverage: 'best_effort',
      quotaRejections: 1,
      accountsAffected: 1,
    });
    // Y siguen sin ser crecimiento: no entran en el recuento de éxitos.
    expect(latest.accountEventCount).toBe(1);
  });
});

describe('A12 — el barrido ciego ya no toca las colas de hechos', () => {
  it('no borra un outbox vencido sin entregar y lo reporta como atraso', async () => {
    const store = fakeFirestore();
    const now = Date.parse('2026-09-18T03:00:00.000Z');
    const stale = { toMillis: () => now - DAY, _ts: true } as any;

    // Documento de outbox vencido y TODAVÍA sin entregar: el barrido por
    // `expiresAt` lo borraba, perdiendo la evidencia de un hecho pendiente.
    store.bucket('event_outbox').set('clave-1', {
      eventKey: 'clave-1',
      state: 'pending',
      accountId: 'cuenta-real',
      expiresAt: stale,
    });
    store.bucket('product_events').set('ev-1', { expiresAt: stale });
    jest.useFakeTimers().setSystemTime(now);

    let result: any;
    try {
      result = await buildService(store).run(
        'retention',
        new Date(now).toISOString(),
      );
    } finally {
      jest.useRealTimers();
    }

    // El hecho sin entregar sigue ahí y se reporta.
    expect(store.bucket('event_outbox').has('clave-1')).toBe(true);
    expect(result.result.protectedFromRetention).toContain('event_outbox');
    expect(result.result.stateAware.backlog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          collection: 'event_outbox',
          state: 'pending',
          reason: 'fact_not_delivered',
        }),
      ]),
    );
    expect(result.result.stateAware.deletedWhenTerminal).toEqual([
      { collection: 'event_outbox', state: 'delivered' },
    ]);
  });

  it('guarda el cursor de la capa por estado para que la vuelta avance', async () => {
    const store = fakeFirestore();
    const now = Date.parse('2026-09-18T03:00:00.000Z');
    store.bucket('label_workflow_exports').set('exp-1', {
      exportId: 'exp-1',
      status: 'accepted',
      jobId: 'job-1',
      labelIds: ['a'],
      createdAt: new Date(now - 200 * DAY).toISOString(),
    });
    jest.useFakeTimers().setSystemTime(now);

    try {
      await buildService(store).run('retention', new Date(now).toISOString());
    } finally {
      jest.useRealTimers();
    }

    const state = store.bucket('growth_retention_state').get('latest');
    expect(state.nextCursors.label_workflow_exports).toBe('exp-1');
    // Y la operación conserva su identidad tras la retirada de metadatos.
    const row = store.bucket('label_workflow_exports').get('exp-1');
    expect(row.jobId).toBe('job-1');
    expect(row.retentionState).toBe('metadata_redacted');
  });
});
