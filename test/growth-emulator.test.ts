import { Firestore, Timestamp } from '@google-cloud/firestore';
import { randomUUID } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import {
  DurableOperationRepository,
  DurableOperationInput,
} from '../src/common/services/durable-operation.repository.js';
import { ProductEventRepository } from '../src/modules/product-observability/product-event.repository.js';
import { ApiJobsService } from '../src/modules/public-api/api-jobs.service.js';
import { PdfPreparationService } from '../src/modules/pdf-preparation/pdf-preparation.service.js';

if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8085')
  throw new Error(
    'This suite requires the isolated local Firestore emulator at 127.0.0.1:8085',
  );
const projectId = 'demo-zplpdf-growth';
const db = new Firestore({ projectId, ignoreUndefinedProperties: true });
const secondDb = new Firestore({ projectId, ignoreUndefinedProperties: true });
const uid = `synthetic-${randomUUID()}`;
const period = {
  periodId: uid + '_period',
  periodStart: new Date('2026-09-01'),
  periodEnd: new Date('2026-10-01'),
};
function input(id = randomUUID()): DurableOperationInput {
  return {
    operationId: id,
    userId: uid,
    fingerprint: id,
    period,
    maxPdfs: 1,
    labelCount: 2,
    labelSize: '4x6',
    outputFormat: 'pdf',
    sourcePath: 'synthetic/source.zpl',
    userPlan: 'pro',
  };
}
beforeEach(async () => {
  await db.doc(`users/${uid}`).set({ plan: 'pro' });
  await db.doc(`usage/${period.periodId}`).delete();
  await db.doc(`deleted_accounts/${uid}`).delete();
});
afterAll(async () => {
  await db.terminate();
  await secondDb.terminate();
});

test('real Firestore transactions admit one concurrent quota reservation and record one history/global increment', async () => {
  const a = new DurableOperationRepository(db),
    b = new DurableOperationRepository(secondDb);
  const first = input(),
    second = input();
  const claims = await Promise.allSettled([a.claim(first), b.claim(second)]);
  expect(claims.filter((c) => c.status === 'fulfilled')).toHaveLength(1);
  const winner = claims[0].status === 'fulfilled' ? first : second;
  const claim = claims.find(
    (c) => c.status === 'fulfilled',
  ) as PromiseFulfilledResult<any>;
  expect(
    (await db.doc(`usage/${period.periodId}`).get()).get('reservedPdfCount'),
  ).toBe(1);
  const before =
    (await db.doc('global_totals/totals').get()).get('pdfsTotal') ?? 0;
  await a.finish(winner.operationId, claim.value.token, {
    url: 'https://synthetic.invalid/result.pdf',
    filename: 'synthetic.pdf',
    storagePath: 'synthetic/result.pdf',
  });
  expect((await db.doc(`usage/${period.periodId}`).get()).data()).toMatchObject(
    { pdfCount: 1, reservedPdfCount: 0, labelCount: 2 },
  );
  expect((await b.claim(winner)).completed).toBe(true);
  expect((await db.doc('global_totals/totals').get()).get('pdfsTotal')).toBe(
    before + 1,
  );
  const history = await db
    .collection('conversion_history')
    .where('jobId', '==', winner.operationId)
    .get();
  expect(history.size).toBe(1);
});

test('business state and event/outbox roll back together, then retries deduplicate across clients', async () => {
  const repository = new ProductEventRepository(db),
    other = new ProductEventRepository(secondDb);
  const event: any = {
    eventId: randomUUID(),
    operationId: randomUUID(),
    accountId: uid,
    schemaVersion: 1,
    eventName: 'api_job_succeeded',
    featureId: 'self_service_api',
    featureVersion: '1',
    occurredAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    source: 'api',
    planAtEvent: 'pro',
    environment: 'test',
    isSynthetic: true,
  };
  const writes = [{ event, fingerprint: 'fixed' }];
  await expect(
    db.runTransaction(async (tx) => {
      await repository.record(writes, tx);
      tx.set(db.doc(`synthetic_business/${event.operationId}`), {
        status: 'completed',
      });
      throw new Error('synthetic interruption');
    }),
  ).rejects.toThrow('synthetic interruption');
  expect(
    (await db.doc(`synthetic_business/${event.operationId}`).get()).exists,
  ).toBe(false);
  const replies = await Promise.all([
    repository.record(writes),
    other.record(writes),
  ]);
  expect(replies.flat().filter((r) => !r.duplicate)).toHaveLength(1);
  expect(
    (
      await db
        .collection('product_events')
        .where('operationId', '==', event.operationId)
        .get()
    ).size,
  ).toBe(1);
  await db.doc(`deleted_accounts/${uid}`).set({ deletedAt: Timestamp.now() });
  await expect(
    repository.record([
      { event: { ...event, eventId: randomUUID() }, fingerprint: 'next' },
    ]),
  ).rejects.toThrow('Account unavailable');
});

test('Firebase API job pagination cannot cross account ownership', async () => {
  const store = { getClient: () => db },
    flags = { account: async () => ({ plan: 'pro' }) };
  const jobs = new ApiJobsService(
    store as any,
    flags as any,
    null,
    null,
    null,
    null,
    null,
  );
  const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
  for (const id of ids)
    await db.doc(`api_jobs/${id}`).set({
      id,
      accountId: uid,
      status: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attempts: 0,
      callbackId: null,
    });
  await db
    .doc(`api_jobs/${randomUUID()}`)
    .set({ accountId: 'foreign', status: 'queued' });
  const first = await jobs.list(uid, undefined, 2),
    last = await jobs.list(uid, first.nextCursor, 2);
  expect(first.items.map((x) => x.id)).toEqual(ids.slice(0, 2));
  expect(last.items.map((x) => x.id)).toEqual(ids.slice(2));
  expect(last.nextCursor).toBeNull();
});

test('PDF preparation persists output, quota, history and event atomically with replay and owner isolation', async () => {
  const files = new Map<string, Buffer>();
  const store = {
    getClient: () => db,
    isAccountDeletionMarked: async (account: string) =>
      (await db.doc(`deleted_accounts/${account}`).get()).exists,
  };
  const storage = {
    saveFile: async (path: string, bytes: Buffer) => files.set(path, bytes),
    generateSignedUrlForPath: async () => 'https://synthetic.invalid/pdf',
    deleteFile: async (path: string) => files.delete(path),
  };
  const users = {
    checkCanConvert: async () => ({ allowed: true, periodInfo: period }),
    getUserById: async () => ({ plan: 'pro' }),
    getEffectivePlanLimits: () => ({ maxPdfsPerMonth: 1 }),
    getEffectivePlan: () => 'pro',
    invalidateHistoryScanCache: () => undefined,
  };
  const repository = new ProductEventRepository(db);
  const events = {
    recordServerEvent: async (event: any, tx: any) =>
      repository.record(
        [
          {
            event: {
              ...event,
              receivedAt: new Date().toISOString(),
              planAtEvent: 'pro',
              environment: 'test',
              isSynthetic: true,
            },
            fingerprint: event.operationId,
          },
        ],
        tx,
      ),
  };
  const service = new PdfPreparationService(
    store as any,
    storage as any,
    users as any,
    { assertFeatureAvailable: async () => ({ featureVersion: '1' }) } as any,
    events as any,
  );
  const pdf = await PDFDocument.create();
  pdf.addPage([288, 432]).drawText('SYNTHETIC ONLY');
  const bytes = Buffer.from(await pdf.save()),
    id = randomUUID();
  const recipe = {
    paper: '4x6' as const,
    columns: 1,
    rows: 1,
    marginPt: 0,
    gapPt: 0,
    scale: 'actual' as const,
    selections: [{ page: 0, rotation: 0 as const }],
  };
  expect(await service.export(uid, id, bytes, recipe)).toMatchObject({
    status: 'completed',
    labelCount: 1,
  });
  expect(await service.export(uid, id, bytes, recipe)).toMatchObject({
    status: 'completed',
  });
  expect((await db.doc(`usage/${period.periodId}`).get()).get('pdfCount')).toBe(
    1,
  );
  expect(
    (await db.collection('product_events').where('operationId', '==', id).get())
      .size,
  ).toBe(1);
  await expect(service.status('foreign', id)).rejects.toThrow();
  expect(files.size).toBe(2);
});

test('PDF presets retain immutable versions, enforce concurrent CAS and account deletion', async () => {
  const { PdfPresetsService } = await import(
    '../src/modules/pdf-preparation/pdf-presets.service.js'
  );
  const flags = {
    assertFeatureAvailable: async () => ({ featureVersion: '1' }),
  };
  const a = new PdfPresetsService({ getClient: () => db } as any, flags as any);
  const b = new PdfPresetsService(
    { getClient: () => secondDb } as any,
    flags as any,
  );
  const presetId = randomUUID();
  const recipe = {
    paper: '4x6',
    columns: 1,
    rows: 1,
    marginPt: 0,
    gapPt: 0,
    scale: 'actual',
    selections: [{ page: 0, rotation: 0 }],
  };
  const original = { id: presetId, name: 'Synthetic preset', recipe };
  expect(await a.create(uid, original)).toMatchObject({
    preset: { version: 1 },
  });
  expect(await b.create(uid, original)).toMatchObject({
    preset: { version: 1 },
  });
  expect(
    (await db.doc(`pdf_preset_limits/${uid}`).get()).get('activeCount'),
  ).toBe(1);
  const attempts = await Promise.allSettled([
    a.update(uid, presetId, { expectedVersion: 1, name: 'A', recipe }),
    b.update(uid, presetId, { expectedVersion: 1, name: 'B', recipe }),
  ]);
  expect(attempts.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  const winner = (
    attempts.find(
      (x) => x.status === 'fulfilled',
    ) as PromiseFulfilledResult<any>
  ).value.preset;
  const versions = await a.versions(uid, presetId);
  expect(versions.versions.map((v) => v.version)).toEqual([2, 1]);
  expect(versions.versions[1].name).toBe('Synthetic preset');
  expect(
    await a.update(uid, presetId, {
      expectedVersion: 1,
      name: winner.name,
      recipe,
    }),
  ).toMatchObject({ preset: { version: 2 } });
  await expect(a.versions('foreign', presetId)).rejects.toThrow(
    'PDF_PRESET_NOT_FOUND',
  );
  await a.archive(uid, presetId, { expectedVersion: 2 });
  await b.archive(uid, presetId, { expectedVersion: 2 });
  expect((await a.list(uid)).presets).toHaveLength(0);
  expect(
    (await db.doc(`pdf_preset_limits/${uid}`).get()).get('activeCount'),
  ).toBe(0);
  expect((await a.versions(uid, presetId)).versions[0].status).toBe('active');
  await db.doc(`deleted_accounts/${uid}`).set({ deletedAt: Timestamp.now() });
  await expect(
    a.create(uid, { ...original, id: randomUUID() }),
  ).rejects.toThrow('Account unavailable');
});

test.each(['workflow', 'template'] as const)(
  'real %s operation fences stale workers and stores completion/event atomically',
  async (kind) => {
    const { FirestoreWorkflowRepository } = await import(
      '../src/modules/workflows/workflows.firestore-repository.js'
    );
    const { FirestoreTemplateRepository } = await import(
      '../src/modules/label-templates/label-templates.firestore-repository.js'
    );
    const { buildOutboxRecord } = await import(
      '../src/modules/workflows/label-event.outbox.js'
    );
    const a: any =
      kind === 'workflow'
        ? new FirestoreWorkflowRepository(db)
        : new FirestoreTemplateRepository(db);
    const b: any =
      kind === 'workflow'
        ? new FirestoreWorkflowRepository(secondDb)
        : new FirestoreTemplateRepository(secondDb);
    const op = randomUUID(),
      now = new Date(),
      workflowId = randomUUID(),
      templateId = randomUUID();
    const candidate: any = {
      accountId: uid,
      ownerId: uid,
      intentHash: op,
      idempotencyKey: op,
      status: 'pending',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      outputFormat: 'pdf',
      labelCount: 1,
      ...(kind === 'workflow'
        ? {
            exportId: op,
            workflowId,
            workflowVersion: 1,
            labelIds: ['label'],
            uniqueLabelCount: 1,
          }
        : {
            runId: op,
            templateId,
            templateVersion: 1,
            labelSize: '4x6',
            format: 'csv',
            rowCount: 1,
            validRowCount: 1,
            emptyRowCount: 0,
            invalidRowCount: 0,
            diagnostics: [],
            sourceChecksum: 'synthetic',
          }),
    };
    const reserve = kind === 'workflow' ? 'reserveExport' : 'reserveRun';
    const complete = kind === 'workflow' ? 'completeExport' : 'completeRun';
    const fail = kind === 'workflow' ? 'failExport' : 'failRun';
    const collection =
      kind === 'workflow' ? 'label_workflow_exports' : 'label_template_runs';
    const first = await a[reserve](candidate, now);
    await db
      .doc(`${collection}/${op}`)
      .update({ leaseExpiresAt: new Date(Date.now() - 1000).toISOString() });
    const second = await b[reserve](candidate, new Date());
    expect(second.record.leaseToken).not.toBe(first.record.leaseToken);
    const patch = {
      jobId: op,
      labelIds: ['label'],
      labelCount: 1,
      uniqueLabelCount: 1,
    };
    const event = buildOutboxRecord({
      accountId: uid,
      operationId: op,
      jobId: op,
      eventName:
        kind === 'workflow'
          ? 'packing_export_succeeded'
          : 'template_run_succeeded',
      featureId: kind === 'workflow' ? 'packing_workflow' : 'data_templates',
      featureVersion: '1',
      source: 'api',
    });
    await expect(
      a[complete](op, first.record.leaseToken, patch, event),
    ).rejects.toThrow();
    await expect(
      a[fail](op, first.record.leaseToken, 'STALE'),
    ).rejects.toThrow();
    await b[complete](op, second.record.leaseToken, patch, event);
    const {
      eventId: _oldId,
      schemaVersion: _schema,
      occurredAt: _occurred,
      ...eventInput
    } = event.event;
    const duplicate = buildOutboxRecord(eventInput);
    await a[complete](
      op,
      first.record.leaseToken,
      { ...patch, jobId: randomUUID() },
      duplicate,
    );
    await a[fail](op, first.record.leaseToken, 'LATE_ERROR');
    const current = (await db.doc(`${collection}/${op}`).get()).data();
    expect(current).toMatchObject({
      status: 'accepted',
      jobId: op,
      completionEvent: { id: event.id },
    });
    expect(
      (
        await db
          .collection('label_event_retries')
          .where('operationId', '==', op)
          .get()
      ).size,
    ).toBe(1);
  },
);
