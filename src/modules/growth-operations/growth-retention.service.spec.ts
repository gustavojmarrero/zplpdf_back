import { Timestamp } from '@google-cloud/firestore';
import { GrowthRetentionService } from './growth-retention.service.js';

const DAY = 86400000;
const NOW = new Date('2026-09-18T00:00:00.000Z');
const expired = Timestamp.fromMillis(NOW.getTime() - DAY);
const fresh = Timestamp.fromMillis(NOW.getTime() + DAY);

/**
 * Doble de Firestore con lo que usa la limpieza: páginas ordenadas por id con
 * cursor, transacciones que exigen lecturas antes de escrituras y
 * `FieldValue.delete()` aplicado de verdad al documento.
 *
 * Tiene un gancho para simular la carrera que importa: cambiar el documento
 * **entre** la consulta de la página y la transacción que lo redacta.
 */
function fakeFirestore() {
  const data = new Map<string, Map<string, any>>();
  const bucket = (name: string) => {
    if (!data.has(name)) data.set(name, new Map());
    return data.get(name);
  };
  const isDelete = (value: any) =>
    value && typeof value === 'object' && value._delete === true;

  let onTransaction: (() => void) | undefined;

  function collection(name: string, filters: any[] = [], cap?: number) {
    const api: any = {
      doc: (id: string) => ({ collection: name, id }),
      orderBy: () => api,
      where: (field: string, _op: string, value: any) =>
        collection(name, [...filters, { field, value }], cap),
      limit: (value: number) => collection(name, filters, value),
      startAfter: (cursor: string) =>
        collection(name, [...filters, { after: cursor }], cap),
      get: async () => {
        let rows = [...bucket(name).entries()].sort(([a], [b]) =>
          a.localeCompare(b),
        );
        for (const filter of filters) {
          if (filter.after)
            rows = rows.filter(([id]) => id.localeCompare(filter.after) > 0);
          else
            rows = rows.filter(([, row]) => row[filter.field] === filter.value);
        }
        const limited = cap === undefined ? rows : rows.slice(0, cap);
        return {
          size: limited.length,
          empty: limited.length === 0,
          docs: limited.map(([id, row]) => ({
            id,
            data: () => row,
            get: (key: string) => row[key],
          })),
        };
      },
    };
    return api;
  }

  const db: any = {
    collection: (name: string) => collection(name),
    runTransaction: async (fn: any) => {
      onTransaction?.();
      let wrote = false;
      const tx = {
        get: async (ref: any) => {
          if (wrote) throw new Error('Firestore: reads must precede writes');
          const row = bucket(ref.collection).get(ref.id);
          return {
            exists: row !== undefined,
            data: () => row,
            get: (key: string) => row?.[key],
          };
        },
        update: (ref: any, patch: any) => {
          wrote = true;
          const row = { ...bucket(ref.collection).get(ref.id) };
          for (const [key, value] of Object.entries(patch))
            if (isDelete(value)) delete row[key];
            else row[key] = value;
          bucket(ref.collection).set(ref.id, row);
        },
        set: (ref: any, value: any) => {
          wrote = true;
          bucket(ref.collection).set(ref.id, value);
        },
        delete: (ref: any) => {
          wrote = true;
          bucket(ref.collection).delete(ref.id);
        },
      };
      return fn(tx);
    },
  };

  return {
    db,
    bucket,
    race: (hook: () => void) => {
      // Solo la primera transacción sufre la carrera.
      onTransaction = () => {
        onTransaction = undefined;
        hook();
      };
    },
  };
}

jest.mock('@google-cloud/firestore', () => {
  const actual = jest.requireActual('@google-cloud/firestore');
  return {
    ...actual,
    FieldValue: { delete: () => ({ _delete: true }) },
  };
});

function acceptedExport(overrides: Record<string, any> = {}) {
  return {
    exportId: 'exp-1',
    accountId: 'cuenta-1',
    status: 'accepted',
    jobId: 'job-1',
    labelCount: 4,
    intentHash: 'hash-1',
    labelIds: ['lbl_a', 'lbl_b'],
    workflowSnapshot: { id: 'wf-1', labels: ['contenido'] },
    createdAt: new Date(NOW.getTime() - 100 * DAY).toISOString(),
    expiresAt: expired,
    ...overrides,
  };
}

describe('A12 — retirada de metadatos en operaciones terminales', () => {
  it('retira el material pesado y conserva la evidencia y la identidad', async () => {
    const store = fakeFirestore();
    store.bucket('label_workflow_exports').set('exp-1', acceptedExport());

    const report = await new GrowthRetentionService(store.db).cleanup({
      now: NOW,
    });

    const row = store.bucket('label_workflow_exports').get('exp-1');
    // Lo pesado y con datos del usuario se va.
    expect(row.workflowSnapshot).toBeUndefined();
    expect(row.labelIds).toBeUndefined();
    // La identidad de la reserva y la evidencia del cobro se quedan: sin ellas
    // una repetición volvería a convertir y a cobrar.
    expect(row).toMatchObject({
      exportId: 'exp-1',
      status: 'accepted',
      jobId: 'job-1',
      labelCount: 4,
      intentHash: 'hash-1',
      retentionState: 'metadata_redacted',
      redactedFields: ['workflowSnapshot', 'labelIds'],
    });
    // Los campos que hacen falta para borrar la cuenta y para reconocer una
    // repetición sobreviven siempre, y el informe dice para qué.
    expect(row.accountId).toBe('cuenta-1');
    expect(report.preservedFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'accountId',
          purpose: 'account_deletion_sweep_and_ownership',
        }),
        expect.objectContaining({ field: 'intentHash' }),
      ]),
    );
    expect(row.metadataRedactedAt).toBe(NOW.toISOString());

    const target = report.targets.find(
      (t) => t.collection === 'label_workflow_exports',
    );
    expect(target).toMatchObject({ scanned: 1, redacted: 1, skipped: 0 });
    expect(report.semantics).toBe(
      'status_aware_cleanup_preserves_reservations_and_accounting',
    );
  });

  it('el documento nunca se borra, ni vencido', async () => {
    const store = fakeFirestore();
    store.bucket('label_workflow_exports').set('exp-1', acceptedExport());

    await new GrowthRetentionService(store.db).cleanup({ now: NOW });

    expect(store.bucket('label_workflow_exports').has('exp-1')).toBe(true);
  });

  it('retira todo el contexto privado de una ejecución de plantilla', async () => {
    const store = fakeFirestore();
    store.bucket('label_template_runs').set('run-1', {
      runId: 'run-1',
      accountId: 'cuenta-1',
      status: 'accepted',
      jobId: 'job-2',
      labelCount: 3,
      diagnostics: [{ rowNumber: 1, message: 'valor del archivo del usuario' }],
      // Los tres campos privados que el tipo declara de verdad.
      resolvedMapping: { fields: { sku: 'clave del cliente' } },
      originalFilename: 'pedidos de julio.xlsx',
      requestHash: 'hash-de-peticion',
      completionEvent: { id: 'ev-1', event: { operationId: 'run-1' } },
      intentHash: 'hash-1',
      createdAt: new Date(NOW.getTime() - 100 * DAY).toISOString(),
      expiresAt: expired,
    });

    await new GrowthRetentionService(store.db).cleanup({ now: NOW });

    const row = store.bucket('label_template_runs').get('run-1');
    const serialized = JSON.stringify(row);
    expect(row.diagnostics).toBeUndefined();
    expect(row.resolvedMapping).toBeUndefined();
    expect(row.originalFilename).toBeUndefined();
    expect(row.completionEvent).toBeUndefined();
    expect(serialized).not.toContain('valor del archivo');
    expect(serialized).not.toContain('clave del cliente');
    expect(serialized).not.toContain('pedidos de julio');
    // `requestHash` es un hash, no contenido, y es la identidad con la que se
    // reconoce una repetición: se queda, como el resto de la evidencia.
    expect(row.requestHash).toBe('hash-de-peticion');
    expect(row.accountId).toBe('cuenta-1');
    expect(row.jobId).toBe('job-2');
    expect(row.intentHash).toBe('hash-1');
  });

  it('retira la receta de recuperación de una operación durable conciliada', async () => {
    const store = fakeFirestore();
    store.bucket('durable_operations').set('op-1', {
      status: 'completed',
      userId: 'cuenta-1',
      reserved: false,
      leaseUntil: 0,
      labelCount: 2,
      originalFilename: 'lote.zpl',
      sourcePath: 'debug-zpl/cuenta-1/op.zpl',
      // La receta con la que se reharía la conversión.
      recovery: { zplPath: 'debug-zpl/cuenta-1/op.zpl', labelSize: '4x6' },
      createdAt: new Date(NOW.getTime() - 100 * DAY).toISOString(),
    });
    store
      .bucket('conversion_history')
      .set('operation_op-1', { userId: 'cuenta-1', status: 'completed' });

    await new GrowthRetentionService(store.db).cleanup({ now: NOW });

    const row = store.bucket('durable_operations').get('op-1');
    expect(row.recovery).toBeUndefined();
    expect(row.originalFilename).toBeUndefined();
    expect(row.sourcePath).toBeUndefined();
    // Pasada la retención ya no se puede rehacer la conversión, así que la
    // receta solo era superficie. La evidencia del cobro se queda.
    expect(row.labelCount).toBe(2);
    expect(row.status).toBe('completed');
    expect(store.bucket('conversion_history').has('operation_op-1')).toBe(true);
  });

  it('la cola de etiquetas no tiene estado entregado: nada que limpiar', async () => {
    const store = fakeFirestore();
    // `ack` borra el documento al confirmar la entrega, así que lo único que
    // queda es pendiente o muerto, y las dos cosas son evidencia.
    store.bucket('label_event_retries').set('ev-pending', {
      id: 'ev-pending',
      accountId: 'cuenta-1',
      status: 'pending',
      event: { operationId: 'exp-1', labelCount: 4 },
      availableAt: new Date(NOW.getTime() - DAY).toISOString(),
    });
    store.bucket('label_event_retries').set('ev-dead', {
      id: 'ev-dead',
      accountId: 'cuenta-1',
      status: 'dead',
      event: { operationId: 'exp-2', labelCount: 1 },
    });

    const report = await new GrowthRetentionService(store.db).cleanup({
      now: NOW,
    });

    expect(store.bucket('label_event_retries').has('ev-pending')).toBe(true);
    expect(store.bucket('label_event_retries').has('ev-dead')).toBe(true);
    expect(report.neverDeleted).toContain('label_event_retries');
    expect(
      report.backlog.filter((e) => e.collection === 'label_event_retries'),
    ).toHaveLength(2);
  });

  it('repetir la limpieza no vuelve a tocar lo ya retirado', async () => {
    const store = fakeFirestore();
    store.bucket('label_workflow_exports').set('exp-1', acceptedExport());
    const service = new GrowthRetentionService(store.db);

    await service.cleanup({ now: NOW });
    const afterFirst = {
      ...store.bucket('label_workflow_exports').get('exp-1'),
    };
    const second = await service.cleanup({ now: NOW });

    expect(store.bucket('label_workflow_exports').get('exp-1')).toEqual(
      afterFirst,
    );
    const target = second.targets.find(
      (t) => t.collection === 'label_workflow_exports',
    );
    expect(target).toMatchObject({
      redacted: 0,
      skippedByReason: { already_redacted: 1 },
    });
  });
});

describe('A12 — lo que se protege', () => {
  it('no toca una operación pendiente ni una fallida, y las reporta', async () => {
    const store = fakeFirestore();
    store
      .bucket('label_workflow_exports')
      .set('exp-pending', acceptedExport({ status: 'pending' }));
    store
      .bucket('label_workflow_exports')
      .set('exp-failed', acceptedExport({ status: 'failed' }));

    const report = await new GrowthRetentionService(store.db).cleanup({
      now: NOW,
    });

    for (const id of ['exp-pending', 'exp-failed']) {
      const row = store.bucket('label_workflow_exports').get(id);
      expect(row.workflowSnapshot).toBeDefined();
      expect(row.retentionState).toBeUndefined();
    }
    const target = report.targets.find(
      (t) => t.collection === 'label_workflow_exports',
    );
    expect(target.skippedByReason.not_terminal).toBe(2);
    // Y se informan como atraso, con su motivo.
    expect(report.backlog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          collection: 'label_workflow_exports',
          state: 'pending',
          reason: 'operation_resumable_or_retryable',
        }),
        expect.objectContaining({
          collection: 'label_workflow_exports',
          state: 'failed',
        }),
      ]),
    );
  });

  it('no toca lo que aún no ha vencido', async () => {
    const store = fakeFirestore();
    store
      .bucket('label_workflow_exports')
      .set('exp-1', acceptedExport({ expiresAt: fresh }));

    const report = await new GrowthRetentionService(store.db).cleanup({
      now: NOW,
    });

    expect(
      store.bucket('label_workflow_exports').get('exp-1').workflowSnapshot,
    ).toBeDefined();
    expect(
      report.targets.find((t) => t.collection === 'label_workflow_exports')
        .skippedByReason.not_expired,
    ).toBe(1);
  });

  it('sin expiresAt deriva el vencimiento de la creación y no lo asume', async () => {
    const store = fakeFirestore();
    const { expiresAt, ...withoutExpiry } = acceptedExport();
    store.bucket('label_workflow_exports').set('exp-viejo', withoutExpiry);
    store.bucket('label_workflow_exports').set('exp-nuevo', {
      ...withoutExpiry,
      createdAt: new Date(NOW.getTime() - DAY).toISOString(),
    });

    await new GrowthRetentionService(store.db).cleanup({ now: NOW });

    // 100 días: vencido. Un día: no.
    expect(
      store.bucket('label_workflow_exports').get('exp-viejo').retentionState,
    ).toBe('metadata_redacted');
    expect(
      store.bucket('label_workflow_exports').get('exp-nuevo').retentionState,
    ).toBeUndefined();
  });

  it('conserva la entrada de un trabajo de API fallido, que es reintentable', async () => {
    const store = fakeFirestore();
    store.bucket('api_jobs').set('job-failed', { status: 'failed' });
    store.bucket('api_job_inputs').set('job-failed', {
      accountId: 'cuenta-1',
      secret: 'payload-del-cliente',
      expiresAt: expired,
    });

    const report = await new GrowthRetentionService(store.db).cleanup({
      now: NOW,
    });

    // El reintento lee esta entrada: retirarla dejaría el trabajo sin
    // recuperación posible.
    expect(store.bucket('api_job_inputs').get('job-failed').secret).toBe(
      'payload-del-cliente',
    );
    expect(
      report.targets.find((t) => t.collection === 'api_job_inputs')
        .skippedByReason.retryable_failure,
    ).toBe(1);
  });

  it('retira la entrada solo cuando el trabajo terminó y liberó su reserva', async () => {
    const store = fakeFirestore();
    store.bucket('api_jobs').set('job-ok', { status: 'succeeded' });
    store.bucket('api_job_inputs').set('job-ok', {
      secret: 'payload-1',
      expiresAt: expired,
    });
    store.bucket('api_jobs').set('job-running', {
      status: 'running',
      leaseToken: 'tok',
      availableAt: 'x',
    });
    store.bucket('api_job_inputs').set('job-running', {
      secret: 'payload-2',
      expiresAt: expired,
    });
    store
      .bucket('api_jobs')
      .set('job-queued', { status: 'succeeded', availableAt: 'pendiente' });
    store.bucket('api_job_inputs').set('job-queued', {
      secret: 'payload-3',
      expiresAt: expired,
    });

    const report = await new GrowthRetentionService(store.db).cleanup({
      now: NOW,
    });

    expect(store.bucket('api_job_inputs').get('job-ok').secret).toBeUndefined();
    expect(store.bucket('api_job_inputs').get('job-running').secret).toBe(
      'payload-2',
    );
    // Terminal pero con marca de cola viva: sigue habiendo reserva.
    expect(store.bucket('api_job_inputs').get('job-queued').secret).toBe(
      'payload-3',
    );
    const target = report.targets.find(
      (t) => t.collection === 'api_job_inputs',
    );
    expect(target.redacted).toBe(1);
    expect(target.skippedByReason).toMatchObject({
      not_terminal: 1,
      reservation_held: 1,
    });
  });

  it('no toca una operación durable con cuota reservada ni sin evidencia contable', async () => {
    const store = fakeFirestore();
    const base = {
      status: 'completed',
      userId: 'cuenta-1',
      leaseUntil: 0,
      labelCount: 2,
      originalFilename: 'pedidos de julio.zpl',
      sourcePath: 'debug-zpl/cuenta-1/durable/op.zpl',
      createdAt: new Date(NOW.getTime() - 100 * DAY).toISOString(),
    };
    store.bucket('durable_operations').set('op-reserved', {
      ...base,
      reserved: true,
    });
    store.bucket('durable_operations').set('op-sin-evidencia', {
      ...base,
      reserved: false,
    });
    store
      .bucket('durable_operations')
      .set('op-ok', { ...base, reserved: false });
    store
      .bucket('conversion_history')
      .set('operation_op-ok', { userId: 'cuenta-1', status: 'completed' });

    const report = await new GrowthRetentionService(store.db).cleanup({
      now: NOW,
    });

    expect(
      store.bucket('durable_operations').get('op-reserved').sourcePath,
    ).toBe(base.sourcePath);
    expect(
      store.bucket('durable_operations').get('op-sin-evidencia')
        .originalFilename,
    ).toBe('pedidos de julio.zpl');
    // El único que se limpia es el conciliado: tiene su asiento en el historial.
    const cleaned = store.bucket('durable_operations').get('op-ok');
    expect(cleaned.originalFilename).toBeUndefined();
    expect(cleaned.labelCount).toBe(2);

    const target = report.targets.find(
      (t) => t.collection === 'durable_operations',
    );
    expect(target.redacted).toBe(1);
    expect(target.skippedByReason).toMatchObject({
      reservation_held: 1,
      accounting_evidence_missing: 1,
    });
  });

  it('reporta como atraso los hechos sin entregar de las dos colas', async () => {
    const store = fakeFirestore();
    store.bucket('event_outbox').set('e1', { state: 'dead' });
    store.bucket('event_outbox').set('e2', { state: 'pending' });
    store.bucket('label_event_retries').set('l1', { status: 'dead' });
    store.bucket('durable_operations').set('op-live', { status: 'processing' });

    const report = await new GrowthRetentionService(store.db).cleanup({
      now: NOW,
    });

    expect(report.backlog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          collection: 'event_outbox',
          state: 'dead',
          reason: 'fact_not_delivered',
        }),
        expect.objectContaining({
          collection: 'label_event_retries',
          state: 'dead',
        }),
        expect.objectContaining({
          collection: 'durable_operations',
          state: 'processing',
          reason: 'quota_reservation_in_flight',
        }),
      ]),
    );
    // La cola de BE04/BE05 no se borra nunca; de la de observabilidad solo se
    // borra lo ya entregado, y el informe lo dice en vez de prometer lo
    // contrario.
    expect(report.neverDeleted).toContain('label_event_retries');
    expect(report.neverDeleted).not.toContain('event_outbox');
    expect(report.deletedWhenTerminal).toEqual([
      { collection: 'event_outbox', state: 'delivered' },
    ]);
  });
});

describe('A12 — cola de salida: solo lo entregado se borra', () => {
  function outboxRow(overrides: Record<string, any> = {}) {
    return {
      eventKey: 'clave-1',
      accountId: 'cuenta-1',
      state: 'delivered',
      attempts: 1,
      createdAt: new Date(NOW.getTime() - 100 * DAY).toISOString(),
      expiresAt: expired,
      ...overrides,
    };
  }

  it('borra la fila de un hecho entregado y vencido', async () => {
    const store = fakeFirestore();
    store.bucket('event_outbox').set('clave-1', outboxRow());

    const report = await new GrowthRetentionService(store.db).cleanup({
      now: NOW,
    });

    // Entregado: el hecho ya está registrado y la fila solo servía para la
    // entrega. Es el único caso en el que esta limpieza borra un documento.
    expect(store.bucket('event_outbox').has('clave-1')).toBe(false);
    const target = report.targets.find((t) => t.collection === 'event_outbox');
    expect(target).toMatchObject({ mode: 'delete', redacted: 1 });
  });

  it('no borra pending, leased ni dead aunque estén vencidos', async () => {
    const store = fakeFirestore();
    store
      .bucket('event_outbox')
      .set('c-pending', outboxRow({ state: 'pending' }));
    store
      .bucket('event_outbox')
      .set('c-leased', outboxRow({ state: 'leased' }));
    store.bucket('event_outbox').set('c-dead', outboxRow({ state: 'dead' }));

    const report = await new GrowthRetentionService(store.db).cleanup({
      now: NOW,
    });

    for (const id of ['c-pending', 'c-leased', 'c-dead'])
      expect(store.bucket('event_outbox').has(id)).toBe(true);
    const target = report.targets.find((t) => t.collection === 'event_outbox');
    expect(target.skippedByReason.not_terminal).toBe(3);
    expect(
      report.backlog.filter((e) => e.collection === 'event_outbox'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: 'pending' }),
        expect.objectContaining({ state: 'leased' }),
        expect.objectContaining({ state: 'dead' }),
      ]),
    );
  });

  it('no borra lo entregado que aún no ha vencido', async () => {
    const store = fakeFirestore();
    store
      .bucket('event_outbox')
      .set('clave-1', outboxRow({ expiresAt: fresh }));

    const report = await new GrowthRetentionService(store.db).cleanup({
      now: NOW,
    });

    expect(store.bucket('event_outbox').has('clave-1')).toBe(true);
    expect(
      report.targets.find((t) => t.collection === 'event_outbox')
        .skippedByReason.not_expired,
    ).toBe(1);
  });

  it('no borra una fila entregada que todavía tiene lease o turno', async () => {
    const store = fakeFirestore();
    store
      .bucket('event_outbox')
      .set('c-lease', outboxRow({ leaseToken: 'tok' }));
    store
      .bucket('event_outbox')
      .set('c-turno', outboxRow({ availableAt: 'pendiente' }));

    const report = await new GrowthRetentionService(store.db).cleanup({
      now: NOW,
    });

    expect(store.bucket('event_outbox').has('c-lease')).toBe(true);
    expect(store.bucket('event_outbox').has('c-turno')).toBe(true);
    expect(
      report.targets.find((t) => t.collection === 'event_outbox')
        .skippedByReason.lease_held,
    ).toBe(2);
  });

  it('carrera: si vuelve a pending entre la consulta y la transacción, no se borra', async () => {
    const store = fakeFirestore();
    store.bucket('event_outbox').set('clave-1', outboxRow());
    // Un requeue manual de un `dead`, o una reentrega en curso, devuelven la
    // fila a pending justo en esa ventana.
    store.race(() =>
      store
        .bucket('event_outbox')
        .set('clave-1', outboxRow({ state: 'pending', availableAt: 'ya' })),
    );

    const report = await new GrowthRetentionService(store.db).cleanup({
      now: NOW,
    });

    expect(store.bucket('event_outbox').has('clave-1')).toBe(true);
    expect(
      report.targets.find((t) => t.collection === 'event_outbox')
        .skippedByReason.not_terminal,
    ).toBe(1);
  });
});

describe('A12 — carreras, límites y cursor', () => {
  it('revalida en la transacción: una operación reclamada de nuevo no se toca', async () => {
    const store = fakeFirestore();
    store.bucket('label_workflow_exports').set('exp-1', acceptedExport());

    // Entre la consulta de la página y la transacción, la operación vuelve a
    // `pending` con un lease vivo: decidir con los datos de la consulta habría
    // retirado los metadatos de algo que está corriendo.
    store.race(() => {
      store.bucket('label_workflow_exports').set('exp-1', {
        ...acceptedExport(),
        status: 'pending',
        leaseToken: 'token-nuevo',
      });
    });

    const report = await new GrowthRetentionService(store.db).cleanup({
      now: NOW,
    });

    const row = store.bucket('label_workflow_exports').get('exp-1');
    expect(row.workflowSnapshot).toBeDefined();
    expect(row.retentionState).toBeUndefined();
    expect(
      report.targets.find((t) => t.collection === 'label_workflow_exports')
        .skippedByReason.not_terminal,
    ).toBe(1);
  });

  it('un lease vivo sobre una operación aceptada también la protege', async () => {
    const store = fakeFirestore();
    store
      .bucket('label_workflow_exports')
      .set('exp-1', acceptedExport({ leaseToken: 'tok' }));

    const report = await new GrowthRetentionService(store.db).cleanup({
      now: NOW,
    });

    expect(
      store.bucket('label_workflow_exports').get('exp-1').workflowSnapshot,
    ).toBeDefined();
    expect(
      report.targets.find((t) => t.collection === 'label_workflow_exports')
        .skippedByReason.lease_held,
    ).toBe(1);
  });

  it('un documento que desaparece a mitad no rompe la vuelta', async () => {
    const store = fakeFirestore();
    store.bucket('label_workflow_exports').set('exp-1', acceptedExport());
    store.race(() => store.bucket('label_workflow_exports').delete('exp-1'));

    const report = await new GrowthRetentionService(store.db).cleanup({
      now: NOW,
    });

    expect(
      report.targets.find((t) => t.collection === 'label_workflow_exports')
        .skippedByReason.vanished,
    ).toBe(1);
  });

  it('acota la página, declara el truncado y avanza con el cursor', async () => {
    const store = fakeFirestore();
    for (const id of ['exp-1', 'exp-2', 'exp-3'])
      store
        .bucket('label_workflow_exports')
        .set(id, acceptedExport({ exportId: id }));
    const service = new GrowthRetentionService(store.db);

    const first = await service.cleanup({ limitPerTarget: 2, now: NOW });
    const firstTarget = first.targets.find(
      (t) => t.collection === 'label_workflow_exports',
    );
    expect(firstTarget).toMatchObject({
      scanned: 2,
      redacted: 2,
      truncated: true,
      nextCursor: 'exp-2',
    });
    // La tercera sigue intacta: la vuelta está acotada.
    expect(
      store.bucket('label_workflow_exports').get('exp-3').workflowSnapshot,
    ).toBeDefined();

    const second = await service.cleanup({
      limitPerTarget: 2,
      cursors: first.nextCursors,
      now: NOW,
    });
    const secondTarget = second.targets.find(
      (t) => t.collection === 'label_workflow_exports',
    );
    expect(secondTarget).toMatchObject({
      scanned: 1,
      redacted: 1,
      truncated: false,
    });
    expect(
      store.bucket('label_workflow_exports').get('exp-3').workflowSnapshot,
    ).toBeUndefined();
  });

  it('el recuento de atraso declara cuando está truncado', async () => {
    const store = fakeFirestore();
    for (const id of ['a', 'b', 'c'])
      store.bucket('event_outbox').set(id, { state: 'dead' });

    const report = await new GrowthRetentionService(store.db).cleanup({
      limitPerTarget: 2,
      now: NOW,
    });

    // «Al menos 2», nunca «exactamente 2».
    expect(
      report.backlog.find(
        (entry) =>
          entry.collection === 'event_outbox' && entry.state === 'dead',
      ),
    ).toMatchObject({ count: 2, truncated: true });
  });

  it('el límite por objetivo está acotado por arriba y por abajo', async () => {
    const store = fakeFirestore();
    const service = new GrowthRetentionService(store.db);

    expect((await service.cleanup({ limitPerTarget: 0 })).limitPerTarget).toBe(
      1,
    );
    expect(
      (await service.cleanup({ limitPerTarget: 100000 })).limitPerTarget,
    ).toBe(500);
  });
});
