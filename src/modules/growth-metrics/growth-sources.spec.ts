import {
  CoverageBlockers,
  LeaseFence,
  LeaseLostError,
  loadExclusionPolicy,
  observationUsableAt,
  resolveSourceWatermark,
} from './growth-sources.js';

const CUTOFF = '2026-09-17T06:00:00.000Z';

function baseInput() {
  return {
    cutoff: CUTOFF,
    maxEventReceivedAt: '2026-09-17T05:30:00.000Z',
    eventBacklog: false,
    labelEventBacklog: false,
    deadEvents: false,
    billingWatermark: '2026-09-17T04:00:00.000Z',
    billingCompletedAt: '2026-09-17T04:10:00.000Z',
    truncated: false,
  };
}

describe('resolveSourceWatermark', () => {
  it('usa la marca real de las fuentes, no la hora del planificador', () => {
    const result = resolveSourceWatermark(baseInput());

    // El corte es 06:00 pero la facturación solo sabe hasta las 04:00: la marca
    // es el mínimo, porque publicar 06:00 afirmaría cobertura que no existe.
    expect(result.sourceWatermark).toBe('2026-09-17T04:00:00.000Z');
    expect(result.coverage).toBe('complete');
    expect(result.blockers).toEqual([]);
  });

  it('sin hechos ingeridos no hay marca de eventos', () => {
    const result = resolveSourceWatermark({
      ...baseInput(),
      maxEventReceivedAt: null,
    });

    expect(result.eventWatermark).toBeNull();
    expect(result.sourceWatermark).toBeNull();
    expect(result.blockers).toContain(CoverageBlockers.NO_EVENT_WATERMARK);
  });

  it('la cola de BE04/BE05 invalida la marca igual que la de observabilidad', () => {
    for (const key of [
      'eventBacklog',
      'labelEventBacklog',
      'deadEvents',
    ] as const) {
      const result = resolveSourceWatermark({ ...baseInput(), [key]: true });
      expect(result.eventWatermark).toBeNull();
      expect(result.sourceWatermark).toBeNull();
      expect(result.coverage).not.toBe('complete');
    }
  });

  it('una conciliación posterior al corte no aporta marca', () => {
    const result = resolveSourceWatermark({
      ...baseInput(),
      billingCompletedAt: '2026-09-18T04:00:00.000Z',
    });

    // Sabe cosas que ese día no se sabían: no puede sellar un snapshot pasado.
    expect(result.billingWatermark).toBeNull();
    expect(result.sourceWatermark).toBeNull();
    expect(result.blockers).toContain(CoverageBlockers.BILLING_INCOMPLETE);
  });

  it('el truncado por límite de escaneo se declara', () => {
    expect(
      resolveSourceWatermark({ ...baseInput(), truncated: true }).blockers,
    ).toContain(CoverageBlockers.SCAN_LIMIT);
  });

  it('nunca devuelve una marca posterior al corte', () => {
    const result = resolveSourceWatermark({
      ...baseInput(),
      maxEventReceivedAt: '2026-09-20T00:00:00.000Z',
      billingWatermark: '2026-09-20T00:00:00.000Z',
      billingCompletedAt: '2026-09-17T05:00:00.000Z',
    });

    expect(result.sourceWatermark).toBe(CUTOFF);
  });

  it('un sistema tranquilo no pierde cobertura por falta de tráfico', () => {
    // El último hecho es de hace semanas y la cola está vacía: el canal está
    // drenado, así que el conocimiento llega hasta el corte. Acotar por el
    // último hecho congelaría las ventanas D30 de un producto con poco uso.
    const result = resolveSourceWatermark({
      ...baseInput(),
      maxEventReceivedAt: '2026-08-01T00:00:00.000Z',
      billingWatermark: CUTOFF,
      billingCompletedAt: '2026-09-17T05:00:00.000Z',
    });

    expect(result.eventWatermark).toBe(CUTOFF);
    expect(result.lastIngestedAt).toBe('2026-08-01T00:00:00.000Z');
    expect(result.sourceWatermark).toBe(CUTOFF);
  });
});

describe('observationUsableAt', () => {
  it('acepta una observación anterior al corte y fresca', () => {
    expect(
      observationUsableAt('2026-09-17T00:00:00.000Z', CUTOFF, 36 * 3600000),
    ).toBe(true);
  });

  it('rechaza una observación POSTERIOR al corte', () => {
    // Este era el fallo: la edad negativa también es «menor que la frescura»,
    // así que el inventario de hoy entraba en el snapshot de hace seis días.
    expect(
      observationUsableAt('2026-09-23T00:00:00.000Z', CUTOFF, 36 * 3600000),
    ).toBe(false);
  });

  it('rechaza una observación demasiado vieja o ausente', () => {
    expect(
      observationUsableAt('2026-09-10T00:00:00.000Z', CUTOFF, 36 * 3600000),
    ).toBe(false);
    expect(observationUsableAt(null, CUTOFF, 36 * 3600000)).toBe(false);
    expect(observationUsableAt('no-es-fecha', CUTOFF, 36 * 3600000)).toBe(
      false,
    );
  });
});

describe('loadExclusionPolicy', () => {
  function db(ids: string[]) {
    return {
      collection: () => ({
        limit: () => ({
          get: async () => ({
            docs: ids.map((id) => ({
              id,
              get: (key: string) => (key === 'accountId' ? id : undefined),
            })),
          }),
        }),
      }),
    } as any;
  }

  it('une la lista de configuración con la colección viva', async () => {
    const policy = await loadExclusionPolicy(db(['qa-1']), 'admin-1, admin-2');

    expect(policy.isExcluded('admin-1')).toBe(true);
    expect(policy.isExcluded('qa-1')).toBe(true);
    expect(policy.isExcluded('cliente-real')).toBe(false);
    expect(policy.size).toBe(3);
  });

  it('sin exclusiones configuradas lo dice en vez de fingir una lista', async () => {
    const policy = await loadExclusionPolicy(db([]), undefined);

    expect(policy.size).toBe(0);
    expect(policy.source).toBe('empty');
  });
});

describe('LeaseFence', () => {
  function tx(data: Record<string, unknown> | undefined) {
    return { get: async () => ({ data: () => data }) } as any;
  }

  it('deja pasar al dueño del lease', async () => {
    const fence = new LeaseFence({} as any, 'token-1', () => 1000);
    await expect(
      fence.assert(tx({ token: 'token-1', leaseUntil: 2000 })),
    ).resolves.toBeUndefined();
  });

  it('rechaza un token distinto y un lease vencido', async () => {
    const fence = new LeaseFence({} as any, 'token-1', () => 1000);

    await expect(
      fence.assert(tx({ token: 'token-2', leaseUntil: 2000 })),
    ).rejects.toBeInstanceOf(LeaseLostError);
    await expect(
      fence.assert(tx({ token: 'token-1', leaseUntil: 500 })),
    ).rejects.toBeInstanceOf(LeaseLostError);
    await expect(fence.assert(tx(undefined))).rejects.toBeInstanceOf(
      LeaseLostError,
    );
  });
});
