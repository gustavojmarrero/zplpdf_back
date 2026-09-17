import { Firestore, Timestamp } from '@google-cloud/firestore';
import { randomUUID } from 'node:crypto';
import { GrowthRetentionService } from '../src/modules/growth-operations/growth-retention.service.js';

/**
 * A12 contra el emulador REAL de Firestore.
 *
 * Aquí no hay dobles: las transacciones, `FieldValue.delete()`, el borrado de
 * documento y la paginación por `__name__` los ejecuta el emulador. Es donde se
 * puede comprobar lo que un doble no garantiza: que dos clientes distintos que
 * limpian a la vez no se pisan, que la revalidación dentro de la transacción ve
 * el cambio que otro cliente acaba de confirmar, y que un `Timestamp` nativo se
 * compara como fecha y no como objeto.
 */
if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8085')
  throw new Error(
    'This suite requires the isolated local Firestore emulator at 127.0.0.1:8085',
  );

const projectId = 'demo-zplpdf-growth';
const db = new Firestore({ projectId, ignoreUndefinedProperties: true });
/** Segundo cliente: la limpieza concurrente tiene que cruzar la conexión. */
const otherClient = new Firestore({
  projectId,
  ignoreUndefinedProperties: true,
});

const DAY = 86400000;
const suite = randomUUID().slice(0, 8);
const account = `synthetic-retention-${suite}`;
const NOW = new Date();
const expired = Timestamp.fromMillis(NOW.getTime() - DAY);
const fresh = Timestamp.fromMillis(NOW.getTime() + 30 * DAY);

/** Ids con prefijo de suite: cada ejecución trabaja sobre sus documentos. */
const id = (name: string) => `${suite}-${name}`;

function exportRow(overrides: Record<string, any> = {}) {
  return {
    exportId: id('exp'),
    accountId: account,
    workflowId: id('wf'),
    idempotencyKey: id('key'),
    intentHash: 'hash-1',
    status: 'accepted',
    jobId: id('job'),
    labelCount: 4,
    uniqueLabelCount: 2,
    labelIds: ['lbl_a', 'lbl_b'],
    workflowSnapshot: { id: id('wf'), name: 'lote de julio' },
    completionEvent: { id: id('ev'), event: { operationId: id('exp') } },
    createdAt: new Date(NOW.getTime() - 120 * DAY).toISOString(),
    updatedAt: new Date(NOW.getTime() - 120 * DAY).toISOString(),
    expiresAt: expired,
    ...overrides,
  };
}

async function wipe() {
  const collections = [
    'label_workflow_exports',
    'label_template_runs',
    'api_jobs',
    'api_job_inputs',
    'durable_operations',
    'conversion_history',
    'event_outbox',
    'label_event_retries',
  ];
  for (const name of collections) {
    const rows = await db.collection(name).get();
    await Promise.all(
      rows.docs
        .filter((doc) => doc.id.startsWith(suite))
        .map((doc) => doc.ref.delete()),
    );
  }
}

beforeEach(wipe);

afterAll(async () => {
  await wipe();
  await Promise.all([db.terminate(), otherClient.terminate()]);
});

describe('A12 real — retirada de metadatos y evidencia', () => {
  it('retira el contexto privado y conserva reserva, cuota y evidencia', async () => {
    await db.doc(`label_workflow_exports/${id('exp')}`).set(exportRow());

    const report = await new GrowthRetentionService(db).cleanup({ now: NOW });

    const row = (
      await db.doc(`label_workflow_exports/${id('exp')}`).get()
    ).data();
    expect(row.workflowSnapshot).toBeUndefined();
    expect(row.labelIds).toBeUndefined();
    expect(row.completionEvent).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain('lote de julio');
    // Reserva de idempotencia, propiedad y evidencia contable intactas: sin
    // ellas una repetición volvería a convertir y a consumir cuota.
    expect(row).toMatchObject({
      accountId: account,
      idempotencyKey: id('key'),
      intentHash: 'hash-1',
      status: 'accepted',
      jobId: id('job'),
      labelCount: 4,
      retentionState: 'metadata_redacted',
    });
    expect(
      report.targets.find((t) => t.collection === 'label_workflow_exports'),
    ).toMatchObject({ redacted: 1, mode: 'redact' });
  });

  it('retira los tres campos privados reales de una ejecución de plantilla', async () => {
    await db.doc(`label_template_runs/${id('run')}`).set({
      runId: id('run'),
      accountId: account,
      status: 'accepted',
      jobId: id('job'),
      labelCount: 3,
      intentHash: 'hash-run',
      requestHash: 'hash-de-peticion',
      diagnostics: [{ rowNumber: 1, message: 'valor del archivo' }],
      resolvedMapping: { fields: { sku: 'clave del cliente' } },
      originalFilename: 'pedidos de julio.xlsx',
      createdAt: new Date(NOW.getTime() - 120 * DAY).toISOString(),
      expiresAt: expired,
    });

    await new GrowthRetentionService(db).cleanup({ now: NOW });

    const row = (await db.doc(`label_template_runs/${id('run')}`).get()).data();
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('valor del archivo');
    expect(serialized).not.toContain('clave del cliente');
    expect(serialized).not.toContain('pedidos de julio');
    // El hash de repetición y la evidencia se quedan.
    expect(row.requestHash).toBe('hash-de-peticion');
    expect(row.accountId).toBe(account);
    expect(row.jobId).toBe(id('job'));
  });

  it('retira la receta durable solo con evidencia contable presente', async () => {
    const base = {
      status: 'completed',
      userId: account,
      reserved: false,
      leaseUntil: 0,
      labelCount: 2,
      recovery: { zplPath: 'debug-zpl/op.zpl', labelSize: '4x6' },
      originalFilename: 'lote.zpl',
      createdAt: new Date(NOW.getTime() - 120 * DAY).toISOString(),
    };
    await db.doc(`durable_operations/${id('op-ok')}`).set(base);
    await db.doc(`durable_operations/${id('op-sin-asiento')}`).set(base);
    await db.doc(`durable_operations/${id('op-reservada')}`).set({
      ...base,
      reserved: true,
    });
    await db
      .doc(`conversion_history/operation_${id('op-ok')}`)
      .set({ userId: account, status: 'completed' });

    const report = await new GrowthRetentionService(db).cleanup({ now: NOW });

    expect(
      (await db.doc(`durable_operations/${id('op-ok')}`).get()).get('recovery'),
    ).toBeUndefined();
    // Sin asiento en el historial no hay evidencia del cobro: no se toca.
    expect(
      (await db.doc(`durable_operations/${id('op-sin-asiento')}`).get()).get(
        'recovery',
      ),
    ).toBeDefined();
    // Con cuota apartada, tampoco.
    expect(
      (await db.doc(`durable_operations/${id('op-reservada')}`).get()).get(
        'recovery',
      ),
    ).toBeDefined();

    const target = report.targets.find(
      (t) => t.collection === 'durable_operations',
    );
    expect(target.skippedByReason).toMatchObject({
      accounting_evidence_missing: 1,
      reservation_held: 1,
    });
  });
});

describe('A12 real — estado y vencimiento', () => {
  it('no toca lo pendiente ni lo no vencido, y lo reporta', async () => {
    await db
      .doc(`label_workflow_exports/${id('pendiente')}`)
      .set(exportRow({ status: 'pending' }));
    await db
      .doc(`label_workflow_exports/${id('fresca')}`)
      .set(exportRow({ expiresAt: fresh }));

    const report = await new GrowthRetentionService(db).cleanup({ now: NOW });

    for (const name of ['pendiente', 'fresca']) {
      const row = (
        await db.doc(`label_workflow_exports/${id(name)}`).get()
      ).data();
      expect(row.workflowSnapshot).toBeDefined();
      expect(row.retentionState).toBeUndefined();
    }
    const target = report.targets.find(
      (t) => t.collection === 'label_workflow_exports',
    );
    expect(target.skippedByReason).toMatchObject({
      not_terminal: 1,
      not_expired: 1,
    });
    expect(report.backlog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          collection: 'label_workflow_exports',
          state: 'pending',
        }),
      ]),
    );
  });

  it('borra la fila de outbox entregada y conserva pending y dead', async () => {
    const row = {
      eventKey: id('clave'),
      accountId: account,
      attempts: 1,
      createdAt: new Date(NOW.getTime() - 120 * DAY).toISOString(),
      expiresAt: expired,
    };
    await db.doc(`event_outbox/${id('entregada')}`).set({
      ...row,
      state: 'delivered',
    });
    await db
      .doc(`event_outbox/${id('pendiente')}`)
      .set({ ...row, state: 'pending', availableAt: 'ya' });
    await db.doc(`event_outbox/${id('muerta')}`).set({ ...row, state: 'dead' });

    const report = await new GrowthRetentionService(db).cleanup({ now: NOW });

    expect((await db.doc(`event_outbox/${id('entregada')}`).get()).exists).toBe(
      false,
    );
    // Un hecho sin entregar sobrevive: es la evidencia que el outbox existe
    // para conservar.
    expect((await db.doc(`event_outbox/${id('pendiente')}`).get()).exists).toBe(
      true,
    );
    expect((await db.doc(`event_outbox/${id('muerta')}`).get()).exists).toBe(
      true,
    );
    expect(
      report.targets.find((t) => t.collection === 'event_outbox'),
    ).toMatchObject({ mode: 'delete', redacted: 1 });
  });

  it('la cola de etiquetas se conserva entera: no hay estado entregado', async () => {
    await db.doc(`label_event_retries/${id('ev-pendiente')}`).set({
      id: id('ev-pendiente'),
      accountId: account,
      status: 'pending',
      event: { operationId: id('exp'), labelCount: 4 },
      availableAt: new Date(NOW.getTime() - DAY).toISOString(),
    });
    await db.doc(`label_event_retries/${id('ev-muerto')}`).set({
      id: id('ev-muerto'),
      accountId: account,
      status: 'dead',
      event: { operationId: id('exp2'), labelCount: 1 },
    });

    const report = await new GrowthRetentionService(db).cleanup({ now: NOW });

    for (const name of ['ev-pendiente', 'ev-muerto'])
      expect(
        (await db.doc(`label_event_retries/${id(name)}`).get()).exists,
      ).toBe(true);
    expect(report.neverDeleted).toContain('label_event_retries');
  });

  it('conserva la entrada de un trabajo fallido y limpia la del terminal', async () => {
    await db.doc(`api_jobs/${id('job-ok')}`).set({ status: 'succeeded' });
    await db
      .doc(`api_job_inputs/${id('job-ok')}`)
      .set({ accountId: account, secret: 'payload-1', expiresAt: expired });
    await db.doc(`api_jobs/${id('job-fallido')}`).set({ status: 'failed' });
    await db
      .doc(`api_job_inputs/${id('job-fallido')}`)
      .set({ accountId: account, secret: 'payload-2', expiresAt: expired });

    const report = await new GrowthRetentionService(db).cleanup({ now: NOW });

    expect(
      (await db.doc(`api_job_inputs/${id('job-ok')}`).get()).get('secret'),
    ).toBeUndefined();
    // Un fallido es reintentable y el reintento LEE esta entrada.
    expect(
      (await db.doc(`api_job_inputs/${id('job-fallido')}`).get()).get('secret'),
    ).toBe('payload-2');
    expect(
      report.targets.find((t) => t.collection === 'api_job_inputs')
        .skippedByReason.retryable_failure,
    ).toBe(1);
  });
});

describe('A12 real — dos clientes, revalidación, repetición y cursor', () => {
  it('dos clientes limpiando a la vez no duplican ni corrompen el documento', async () => {
    await db.doc(`label_workflow_exports/${id('exp')}`).set(exportRow());

    const [first, second] = await Promise.all([
      new GrowthRetentionService(db).cleanup({ now: NOW }),
      new GrowthRetentionService(otherClient).cleanup({ now: NOW }),
    ]);

    const row = (
      await db.doc(`label_workflow_exports/${id('exp')}`).get()
    ).data();
    expect(row.retentionState).toBe('metadata_redacted');
    expect(row.workflowSnapshot).toBeUndefined();
    expect(row.jobId).toBe(id('job'));
    // Uno retira y el otro lo encuentra ya retirado: la transacción serializa
    // las dos vueltas, así que el total de retiradas es exactamente una.
    const redacted = [first, second]
      .map(
        (report) =>
          report.targets.find((t) => t.collection === 'label_workflow_exports')
            .redacted,
      )
      .reduce((a, b) => a + b, 0);
    expect(redacted).toBe(1);
  });

  it('revalida dentro de la transacción: reclamada por otro cliente, no se toca', async () => {
    await db.doc(`label_workflow_exports/${id('exp')}`).set(exportRow());
    const service = new GrowthRetentionService(db);

    // Otro cliente devuelve la operación a `pending` con un lease vivo justo
    // antes de la transacción de limpieza.
    const originalTransaction = db.runTransaction.bind(db);
    const transaction = jest
      .spyOn(db, 'runTransaction')
      .mockImplementationOnce((async (callback: any, options: any) => {
        // The sweep query has already returned its accepted document. Mutate
        // through a second real client before the cleanup transaction reads it.
        await otherClient.doc(`label_workflow_exports/${id('exp')}`).update({
          status: 'pending',
          leaseToken: 'token-nuevo',
          leaseExpiresAt: new Date(NOW.getTime() + 600000).toISOString(),
        });
        return originalTransaction(callback, options);
      }) as any);
    let report: Awaited<ReturnType<GrowthRetentionService['cleanup']>>;
    try {
      report = await service.cleanup({ now: NOW });
      expect(transaction).toHaveBeenCalled();
    } finally {
      transaction.mockRestore();
    }

    const row = (
      await db.doc(`label_workflow_exports/${id('exp')}`).get()
    ).data();
    expect(row.workflowSnapshot).toBeDefined();
    expect(row.retentionState).toBeUndefined();
    expect(
      report.targets.find((t) => t.collection === 'label_workflow_exports')
        .skippedByReason.not_terminal,
    ).toBe(1);
  });

  it('repetir la limpieza no vuelve a escribir lo ya retirado', async () => {
    await db.doc(`label_workflow_exports/${id('exp')}`).set(exportRow());
    const service = new GrowthRetentionService(db);

    await service.cleanup({ now: NOW });
    const afterFirst = (
      await db.doc(`label_workflow_exports/${id('exp')}`).get()
    ).data();
    const second = await service.cleanup({ now: NOW });
    const afterSecond = (
      await db.doc(`label_workflow_exports/${id('exp')}`).get()
    ).data();

    expect(afterSecond.metadataRedactedAt).toBe(afterFirst.metadataRedactedAt);
    expect(
      second.targets.find((t) => t.collection === 'label_workflow_exports')
        .skippedByReason.already_redacted,
    ).toBe(1);
  });

  it('pagina con cursor real y acota cada vuelta', async () => {
    // Ids ordenables dentro de la suite para que el cursor sea comprobable.
    for (const suffix of ['a', 'b', 'c'])
      await db
        .doc(`label_workflow_exports/${suite}-p-${suffix}`)
        .set(exportRow({ exportId: `${suite}-p-${suffix}` }));
    const service = new GrowthRetentionService(db);

    const first = await service.cleanup({ limitPerTarget: 2, now: NOW });
    const firstTarget = first.targets.find(
      (t) => t.collection === 'label_workflow_exports',
    );
    expect(firstTarget.truncated).toBe(true);
    expect(firstTarget.nextCursor).toBe(`${suite}-p-b`);

    const second = await service.cleanup({
      limitPerTarget: 2,
      cursors: first.nextCursors,
      now: NOW,
    });

    // La tercera se limpia en la segunda vuelta, y ninguna se procesa dos veces.
    expect(
      (await db.doc(`label_workflow_exports/${suite}-p-c`).get()).get(
        'retentionState',
      ),
    ).toBe('metadata_redacted');
    expect(
      second.targets.find((t) => t.collection === 'label_workflow_exports')
        .redacted,
    ).toBe(1);
  });

  it('no pierde cuota ni evidencia: el asiento y el uso siguen intactos', async () => {
    await db.doc(`label_workflow_exports/${id('exp')}`).set(exportRow());
    await db.doc(`durable_operations/${id('op')}`).set({
      status: 'completed',
      userId: account,
      reserved: false,
      leaseUntil: 0,
      labelCount: 7,
      recovery: { zplPath: 'x' },
      createdAt: new Date(NOW.getTime() - 120 * DAY).toISOString(),
    });
    await db
      .doc(`conversion_history/operation_${id('op')}`)
      .set({ userId: account, status: 'completed', labelCount: 7 });

    await new GrowthRetentionService(db).cleanup({ now: NOW });

    // El asiento contable no se toca y el recuento que explica el cobro sigue
    // en la operación.
    const evidence = await db
      .doc(`conversion_history/operation_${id('op')}`)
      .get();
    expect(evidence.exists).toBe(true);
    expect(evidence.get('labelCount')).toBe(7);
    expect(
      (await db.doc(`durable_operations/${id('op')}`).get()).get('labelCount'),
    ).toBe(7);
  });
});
