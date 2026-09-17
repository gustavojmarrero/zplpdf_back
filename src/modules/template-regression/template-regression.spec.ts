import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { Test } from '@nestjs/testing';
import { ForbiddenException, INestApplication } from '@nestjs/common';
import request from 'supertest';
import sharp from 'sharp';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';
import { FirebaseAdminService } from '../auth/firebase-admin.service.js';
import { FirestoreService } from '../cache/firestore.service.js';
import { ConfigService } from '@nestjs/config';
import { ProductObservabilityService } from '../product-observability/product-observability.service.js';
import { ProductEventRepository } from '../product-observability/product-event.repository.js';
import { TemplateRegressionService } from './template-regression.service.js';
import { TemplateRegressionController } from './template-regression.controller.js';
import { TemplateRegressionRepository } from './template-regression.repository.js';
import { LabelSize } from '../zpl/enums/label-size.enum.js';
import { REGRESSION_FIXTURES } from './fixtures.js';
import {
  COLLECTIONS,
  LEASE_MS,
  RENDERER,
} from './template-regression.types.js';
import { settings, validateLabel, validateMaskBounds } from './validation.js';

jest.mock('../zpl/zpl.service.js', () => ({ ZplService: class {} }));

/** Serial, rollback-capable fake which enforces Firestore's reads-before-writes. */
class MemoryFirestore {
  rows = new Map<string, any>();
  private tail = Promise.resolve();
  snapshot(path: string) {
    const row = this.rows.get(path);
    return {
      exists: row !== undefined,
      id: path.split('/').pop(),
      data: () => row,
      get: (key: string) => row?.[key],
    };
  }
  collection(name: string) {
    const query = (
      filters: any[] = [],
      ordering?: [string, string],
      cap = Infinity,
    ): any => ({
      query: true,
      doc: (id: string) => ({
        path: `${name}/${id}`,
        get: async () => this.snapshot(`${name}/${id}`),
      }),
      where: (key: string, op: string, value: any) =>
        query([...filters, [key, op, value]], ordering, cap),
      orderBy: (key: string, order: string) =>
        query(filters, [key, order], cap),
      limit: (limit: number) => query(filters, ordering, limit),
      get: async () => {
        let values = [...this.rows.entries()].filter(
          ([path, row]) =>
            path.startsWith(`${name}/`) &&
            filters.every(([key, op, value]) =>
              op === '=='
                ? row[key] === value
                : op === 'in'
                  ? value.includes(row[key])
                  : op === '>'
                    ? row[key] > value
                    : row[key] <= value,
            ),
        );
        if (ordering)
          values = values.sort(
            (a, b) =>
              String(a[1][ordering[0]]).localeCompare(
                String(b[1][ordering[0]]),
              ) * (ordering[1] === 'desc' ? -1 : 1),
          );
        const docs = values.slice(0, cap).map(([path]) => this.snapshot(path));
        return { docs, size: docs.length };
      },
    });
    return query();
  }
  async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: () => void;
    this.tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    const writes: Array<() => void> = [];
    try {
      const value = await fn({
        get: async (ref: any) => {
          if (writes.length) throw new Error('READ_AFTER_WRITE');
          return ref.query ? ref.get() : this.snapshot(ref.path);
        },
        create: (ref: any, row: any) => {
          if (this.rows.has(ref.path)) throw new Error('ALREADY_EXISTS');
          writes.push(() => this.rows.set(ref.path, { ...row }));
        },
        set: (ref: any, row: any) =>
          writes.push(() => this.rows.set(ref.path, { ...row })),
        update: (ref: any, row: any) =>
          writes.push(() =>
            this.rows.set(ref.path, { ...this.rows.get(ref.path), ...row }),
          ),
      });
      writes.forEach((write) => write());
      return value;
    } finally {
      release();
    }
  }
}
const SOURCE = '^XA^FO10,10^A0N,20,20^FDTEST^FS^PQ1^XZ';
async function png(changed = false, width = 10) {
  const pixels = Buffer.alloc(width * 10 * 3, 255);
  if (changed) pixels.fill(0, 0, 3);
  return sharp(pixels, { raw: { width, height: 10, channels: 3 } })
    .png()
    .toBuffer();
}
describe('template regression durable API (mock providers only)', () => {
  let db: MemoryFirestore,
    service: TemplateRegressionService,
    repository: TemplateRegressionRepository;
  let storage: any,
    renderer: any,
    flags: any,
    events: any,
    firestore: any,
    files: Map<string, Buffer>;
  beforeEach(async () => {
    db = new MemoryFirestore();
    db.rows.set('users/alice', { id: 'alice' });
    db.rows.set('users/bob', { id: 'bob' });
    files = new Map();
    firestore = {
      getClient: () => db,
      isAccountDeletionMarked: async (id: string) =>
        db.rows.has(`deleted_accounts/${id}`),
      getUserById: async (id: string) => db.rows.get(`users/${id}`),
    };
    storage = {
      saveFile: jest.fn(async (path: string, bytes: Buffer) => {
        files.set(path, bytes);
      }),
      readFile: jest.fn(async (path: string, limit: number) => {
        const bytes = files.get(path);
        if (bytes?.length > limit) throw new Error('TOO_LARGE');
        return bytes ?? null;
      }),
      generateSignedUrlForPath: jest.fn(
        async (path: string) => `https://private.invalid/${path}`,
      ),
      deleteByPrefix: jest.fn(async (prefix: string) => {
        for (const path of files.keys())
          if (path.startsWith(prefix)) files.delete(path);
      }),
    };
    renderer = {
      getLabelsPreview: jest.fn(async () => [
        {
          qty: 1,
          img: `data:image/png;base64,${(await png()).toString('base64')}`,
        },
      ]),
    };
    flags = {
      assertFeatureAvailable: jest.fn(async () => ({ featureVersion: '1' })),
    };
    events = {
      recordServerEvent: jest.fn(async (event: any, tx: any) => {
        const ref = db.collection('events').doc(event.eventId);
        await tx.get(ref);
        tx.create(ref, event);
      }),
    };
    service = new TemplateRegressionService(
      firestore,
      storage,
      renderer,
      flags,
      events,
    );
    repository = new TemplateRegressionRepository(db as unknown as Firestore);
  });
  async function baseline(approve = true) {
    const response = await service.createBaseline('alice', {
      operationId: randomUUID(),
      name: 'Test',
      zpl: SOURCE,
      labelSize: LabelSize.TWO_BY_ONE,
    });
    return approve
      ? (
          await service.approve('alice', response.baseline.id, {
            expectedVersion: response.baseline.version,
            note: 'Reviewed synthetic capture',
          })
        ).baseline
      : response.baseline;
  }
  function runInput(base: any, extra: any = {}) {
    return {
      operationId: randomUUID(),
      baselineId: base.id,
      baselineVersion: base.version,
      labelSize: LabelSize.TWO_BY_ONE,
      zpl: SOURCE,
      ...extra,
    };
  }
  it('persists immutable source/image hashes, explicit approval and stable idempotent responses', async () => {
    const input = {
      operationId: randomUUID(),
      name: 'Test',
      zpl: SOURCE,
      labelSize: LabelSize.TWO_BY_ONE,
    };
    const created = await service.createBaseline('alice', input);
    expect(created).toMatchObject({
      schemaVersion: 1,
      baseline: {
        id: input.operationId,
        status: 'ready',
        version: 2,
        renderer: RENDERER,
        approvedAt: null,
        source: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      },
    });
    expect(await service.createBaseline('alice', input)).toEqual(created);
    expect(renderer.getLabelsPreview).toHaveBeenCalledTimes(1);
    expect(renderer.getLabelsPreview).toHaveBeenCalledWith(
      SOURCE,
      LabelSize.TWO_BY_ONE,
      { maxUniqueLabels: 1 },
    );
    expect(
      [...files.keys()].every((path) =>
        path.startsWith(`debug-zpl/alice/regression/${input.operationId}/`),
      ),
    ).toBe(true);
    await expect(
      service.createBaseline('alice', {
        ...input,
        zpl: SOURCE.replace('TEST', 'OTHER'),
      }),
    ).rejects.toThrow('OPERATION_PAYLOAD_CONFLICT');
    const approved = await service.approve('alice', input.operationId, {
      expectedVersion: 2,
      note: 'Review OK',
    });
    expect(approved.baseline).toMatchObject({
      version: 3,
      status: 'approved',
      approvalNote: 'Review OK',
      approvedBy: 'alice',
      source: created.baseline.source,
      image: created.baseline.image,
    });
    expect(
      await service.approve('alice', input.operationId, {
        expectedVersion: 2,
        note: 'Review OK',
      }),
    ).toEqual(approved);
    expect(events.recordServerEvent).toHaveBeenCalledTimes(1);
    await expect(
      service.approve('alice', input.operationId, {
        expectedVersion: 2,
        note: 'Different',
      }),
    ).rejects.toThrow('BASELINE_VERSION_CONFLICT');
  });
  it('fences concurrent duplicate requests while the first renderer owns the lease', async () => {
    let release: (value: any) => void;
    let entered: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    renderer.getLabelsPreview.mockImplementationOnce(() => {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const input = {
      operationId: randomUUID(),
      name: 'Test',
      zpl: SOURCE,
      labelSize: LabelSize.TWO_BY_ONE,
    };
    const first = service.createBaseline('alice', input);
    await started;
    await expect(service.createBaseline('alice', input)).rejects.toThrow(
      'OPERATION_IN_PROGRESS',
    );
    release([
      {
        qty: 1,
        img: `data:image/png;base64,${(await png()).toString('base64')}`,
      },
    ]);
    await first;
    expect(renderer.getLabelsPreview).toHaveBeenCalledTimes(1);
  });
  it('separates exact payload changes from matching pixels and emits completion even on visual regression', async () => {
    const base = await baseline();
    const payloadOnly = await service.createRun(
      'alice',
      runInput(base, { zpl: SOURCE.replace('TEST', 'DIFFERENT') }),
    );
    expect(payloadOnly.run).toMatchObject({
      status: 'completed',
      visual: { passed: true, changedPixels: 0 },
      payload: { changed: true },
      diffImage: { sha256: expect.any(String) },
    });
    renderer.getLabelsPreview.mockResolvedValueOnce([
      {
        qty: 1,
        img: `data:image/png;base64,${(await png(true)).toString('base64')}`,
      },
    ]);
    const input = runInput(base, { options: { maxChangedRatio: 0 } });
    const changed = await service.createRun('alice', input);
    expect(changed.run).toMatchObject({
      status: 'completed',
      visual: { passed: false, changedPixels: 1 },
      payload: { changed: false },
    });
    expect(
      events.recordServerEvent.mock.calls.map(([event]) => event.eventName),
    ).toEqual([
      'baseline_approved',
      'regression_run_completed',
      'regression_run_completed',
    ]);
    await service.createRun('alice', input);
    expect(events.recordServerEvent).toHaveBeenCalledTimes(3);
  });
  it('reports dimension changes separately with no misleading diff PNG or ratio', async () => {
    const base = await baseline();
    renderer.getLabelsPreview.mockResolvedValueOnce([
      {
        qty: 1,
        img: `data:image/png;base64,${(await png(false, 12)).toString('base64')}`,
      },
    ]);
    const result = await service.createRun(
      'alice',
      runInput(base, { labelSize: LabelSize.FOUR_BY_TWO }),
    );
    expect(result.run).toMatchObject({
      visual: {
        status: 'dimensions_changed',
        passed: false,
        candidateWidth: 12,
        changedRatio: null,
      },
      diffImage: null,
    });
  });
  it('requires explicit approved baseline/version and bounded masks before rendering', async () => {
    const base = await baseline(false);
    await expect(service.createRun('alice', runInput(base))).rejects.toThrow(
      'BASELINE_VERSION_CONFLICT',
    );
    const approved = (
      await service.approve('alice', base.id, {
        expectedVersion: base.version,
        note: 'OK',
      })
    ).baseline;
    await expect(service.createRun('alice', runInput(base))).rejects.toThrow(
      'BASELINE_VERSION_CONFLICT',
    );
    await expect(
      service.createRun(
        'alice',
        runInput(approved, {
          options: { masks: [{ x: 0, y: 0, width: 10, height: 3 }] },
        }),
      ),
    ).rejects.toThrow('DIFF_MASK_AREA_EXCEEDED');
    await expect(
      service.createRun(
        'alice',
        runInput(approved, {
          options: { masks: [{ x: 9, y: 0, width: 2, height: 1 }] },
        }),
      ),
    ).rejects.toThrow('INVALID_DIFF_MASK');
    renderer.getLabelsPreview.mockResolvedValueOnce([
      {
        qty: 1,
        img: `data:image/png;base64,${(await png(true)).toString('base64')}`,
      },
    ]);
    const result = await service.createRun(
      'alice',
      runInput(approved, {
        options: { masks: [{ x: 0, y: 0, width: 1, height: 1 }] },
      }),
    );
    expect(result.run.visual).toMatchObject({
      passed: true,
      comparedPixels: 99,
      changedPixels: 0,
    });
  });
  it('adopts a candidate once using CAS and a new operation ID, preserving the original capture', async () => {
    const base = await baseline();
    const result = await service.createRun(
      'alice',
      runInput(base, { zpl: SOURCE.replace('TEST', 'NEW') }),
    );
    const input = {
      operationId: randomUUID(),
      expectedVersion: result.run.version,
      note: 'Intentional content change',
    };
    const adoption = await service.adopt('alice', result.run.id, input);
    expect(adoption).toMatchObject({
      baseline: {
        id: input.operationId,
        status: 'approved',
        version: 1,
        source: result.run.source,
        approvalNote: input.note,
        approvedBy: 'alice',
      },
      run: { adoptedBaselineId: input.operationId, version: 3 },
    });
    expect((await service.get('baseline', 'alice', base.id)).baseline).toEqual(
      base,
    );
    expect(await service.adopt('alice', result.run.id, input)).toEqual(
      adoption,
    );
    await expect(
      service.adopt('alice', result.run.id, {
        ...input,
        operationId: randomUUID(),
      }),
    ).rejects.toThrow('RUN_VERSION_CONFLICT');
    await expect(
      service.adopt('alice', result.run.id, {
        ...input,
        note: 'Changed retry',
      }),
    ).rejects.toThrow('OPERATION_PAYLOAD_CONFLICT');
    expect(
      events.recordServerEvent.mock.calls.filter(
        ([event]) => event.eventName === 'baseline_approved',
      ),
    ).toHaveLength(2);
  });
  it('serializes competing CAS adoption and rolls back event failures atomically', async () => {
    const base = await baseline();
    const result = await service.createRun('alice', runInput(base));
    const inputs = [randomUUID(), randomUUID()].map((operationId) => ({
      operationId,
      expectedVersion: result.run.version,
      note: 'Reviewed',
    }));
    const outcomes = await Promise.allSettled(
      inputs.map((input) => service.adopt('alice', result.run.id, input)),
    );
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    );
    const ready = await baseline(false);
    events.recordServerEvent.mockRejectedValueOnce(
      new Error('OUTBOX_UNAVAILABLE'),
    );
    await expect(
      service.approve('alice', ready.id, {
        expectedVersion: ready.version,
        note: 'OK',
      }),
    ).rejects.toThrow('OUTBOX_UNAVAILABLE');
    expect(
      (await service.get('baseline', 'alice', ready.id)).baseline.status,
    ).toBe('ready');
  });
  it('resumes a staged render after event failure without rerendering or duplicating events', async () => {
    const base = await baseline();
    const input = runInput(base);
    events.recordServerEvent.mockRejectedValueOnce(
      new Error('OUTBOX_UNAVAILABLE'),
    );
    await expect(service.createRun('alice', input)).rejects.toThrow(
      'RENDER_FAILED',
    );
    expect(
      (await service.get('run', 'alice', input.operationId)).run.status,
    ).toBe('failed');
    const renderCount = renderer.getLabelsPreview.mock.calls.length;
    await service.createRun('alice', input);
    expect(renderer.getLabelsPreview).toHaveBeenCalledTimes(renderCount);
    expect(
      [...db.rows.values()].filter(
        (row) => row.eventName === 'regression_run_completed',
      ),
    ).toHaveLength(1);
  });
  it('uses the real observability transaction/outbox boundary and semantic dedup', async () => {
    flags.account = async () => ({ plan: 'pro', isSynthetic: false });
    const actualEvents = new ProductObservabilityService(
      new ProductEventRepository(db as unknown as Firestore),
      flags,
      new ConfigService({ PRODUCT_ENVIRONMENT: 'test' }),
    );
    service = new TemplateRegressionService(
      firestore,
      storage,
      renderer,
      flags,
      actualEvents,
    );
    const base = await baseline();
    const input = runInput(base);
    await service.createRun('alice', input);
    await service.createRun('alice', input);
    const productEvents = [...db.rows.entries()]
      .filter(([path]) => path.startsWith('product_events/'))
      .map(([, row]) => row);
    expect(productEvents.map((event) => event.eventName).sort()).toEqual([
      'baseline_approved',
      'regression_run_completed',
    ]);
    expect(
      [...db.rows.keys()].filter((path) => path.startsWith('event_outbox/')),
    ).toHaveLength(2);
    expect(
      productEvents.find(
        (event) => event.eventName === 'regression_run_completed',
      ),
    ).toMatchObject({
      operationId: input.operationId,
      featureId: 'template_regression',
      featureVersion: '1',
      labelCount: 1,
      source: 'api',
    });
  });
  it('rolls back an outbox write if the completion transaction fails afterwards', async () => {
    const base = await baseline();
    const input = runInput(base);
    events.recordServerEvent.mockImplementationOnce(
      async (event: any, tx: any) => {
        tx.create(db.collection('events').doc(event.eventId), event);
        throw new Error('COMMIT_ABORTED');
      },
    );
    await expect(service.createRun('alice', input)).rejects.toThrow(
      'RENDER_FAILED',
    );
    expect(
      [...db.rows.values()].filter(
        (row) => row.eventName === 'regression_run_completed',
      ),
    ).toHaveLength(0);
    await service.createRun('alice', input);
    expect(
      [...db.rows.values()].filter(
        (row) => row.eventName === 'regression_run_completed',
      ),
    ).toHaveLength(1);
  });
  it('refuses approval/adoption when a private source or image is missing or changed', async () => {
    const ready = await baseline(false);
    const row = db.rows.get(`${COLLECTIONS.baseline}/${ready.id}`);
    files.set(row.image.path, Buffer.from('tampered'));
    await expect(
      service.approve('alice', ready.id, {
        expectedVersion: ready.version,
        note: 'OK',
      }),
    ).rejects.toThrow('ARTIFACT_UNAVAILABLE');
    const base = await baseline();
    const result = await service.createRun('alice', runInput(base));
    files.delete(
      db.rows.get(`${COLLECTIONS.run}/${result.run.id}`).source.path,
    );
    await expect(
      service.adopt('alice', result.run.id, {
        expectedVersion: result.run.version,
        operationId: randomUUID(),
        note: 'OK',
      }),
    ).rejects.toThrow('ARTIFACT_UNAVAILABLE');
  });
  it('retires exhausted crashed attempts from the recovery queue', async () => {
    const input = {
      operationId: randomUUID(),
      name: 'Test',
      labelSize: LabelSize.TWO_BY_ONE,
      sourceHash: 'test',
    };
    await repository.claim('baseline', 'alice', input, 'hash', '1');
    const op = db.rows.get(`${COLLECTIONS.operation}/${input.operationId}`);
    op.leaseUntil = Date.now() - 1;
    op.attempts = 8;
    expect(await service.recover()).toMatchObject({
      scanned: 1,
      recovered: 0,
      failed: 1,
    });
    expect(
      db.rows.get(`${COLLECTIONS.operation}/${input.operationId}`),
    ).toMatchObject({ status: 'failed', leaseUntil: 0 });
    expect(await service.recover()).toMatchObject({ scanned: 0 });
  });
  it('recovers expired leases, fences stale tokens and caps render attempts at eight', async () => {
    const input = {
      operationId: randomUUID(),
      name: 'Test',
      labelSize: LabelSize.TWO_BY_ONE,
      sourceHash: 'test',
    };
    const first = await repository.claim(
      'baseline',
      'alice',
      input,
      'hash',
      '1',
    );
    db.rows.get(`${COLLECTIONS.operation}/${input.operationId}`).leaseUntil =
      Date.now() - 1;
    const second = await repository.claim(
      'baseline',
      'alice',
      input,
      'hash',
      '1',
    );
    await expect(
      repository.stage('alice', input.operationId, first.op.token, {}),
    ).rejects.toThrow('OPERATION_LEASE_LOST');
    await repository.fail('alice', input.operationId, first.op.token);
    expect(
      db.rows.get(`${COLLECTIONS.operation}/${input.operationId}`).token,
    ).toBe(second.op.token);
    const op = db.rows.get(`${COLLECTIONS.operation}/${input.operationId}`);
    op.leaseUntil = Date.now() - 1;
    op.attempts = 8;
    await expect(
      repository.claim('baseline', 'alice', input, 'hash', '1'),
    ).rejects.toThrow('OPERATION_ATTEMPTS_EXHAUSTED');
  });
  it('scheduler reclaims persisted expired work without needing client ZPL', async () => {
    const base = await baseline();
    const input = runInput(base);
    events.recordServerEvent.mockRejectedValueOnce(
      new Error('OUTBOX_UNAVAILABLE'),
    );
    await expect(service.createRun('alice', input)).rejects.toThrow();
    const op = db.rows.get(`${COLLECTIONS.operation}/${input.operationId}`);
    op.status = 'processing';
    op.leaseUntil = Date.now() - 1;
    expect(await service.recover()).toMatchObject({
      scanned: 1,
      recovered: 1,
      failed: 0,
    });
    expect(
      (await service.get('run', 'alice', input.operationId)).run.status,
    ).toBe('completed');
    expect(renderer.getLabelsPreview).toHaveBeenCalledTimes(2);
  });
  it('rejects arbitrary URLs, corrupt PNGs, oversized PNG dimensions and multiple renderer labels', async () => {
    for (const preview of [
      [{ qty: 1, img: 'https://provider.invalid/image.png' }],
      [{ qty: 2, img: 'data:image/png;base64,AA==' }],
      [{ qty: 1, img: 'data:image/png;base64,AA==' }],
      [
        {
          qty: 1,
          img: `data:image/png;base64,${(
            await sharp({
              create: {
                width: 4001,
                height: 4000,
                channels: 3,
                background: 'white',
              },
            })
              .png()
              .toBuffer()
          ).toString('base64')}`,
        },
      ],
    ]) {
      renderer.getLabelsPreview.mockResolvedValueOnce(preview);
      await expect(
        service.createBaseline('alice', {
          operationId: randomUUID(),
          name: 'Bad',
          labelSize: LabelSize.TWO_BY_ONE,
          zpl: SOURCE,
        }),
      ).rejects.toThrow();
    }
    expect(
      [...db.rows.values()].filter((row) => row.status === 'ready'),
    ).toHaveLength(0);
  });
  it('prevents foreign reads, mutations, retries and lists across accounts', async () => {
    const base = await baseline();
    const result = await service.createRun('alice', runInput(base));
    await expect(service.get('baseline', 'bob', base.id)).rejects.toThrow(
      'Not Found',
    );
    await expect(service.get('run', 'bob', result.run.id)).rejects.toThrow(
      'Not Found',
    );
    await expect(
      service.approve('bob', base.id, {
        expectedVersion: base.version,
        note: 'Foreign',
      }),
    ).rejects.toThrow('Not Found');
    await expect(
      service.adopt('bob', result.run.id, {
        operationId: randomUUID(),
        expectedVersion: result.run.version,
        note: 'Foreign',
      }),
    ).rejects.toThrow('Not Found');
    await expect(service.createRun('bob', runInput(base))).rejects.toThrow(
      'Not Found',
    );
    await expect(
      service.createBaseline('bob', {
        operationId: base.id,
        name: 'Test',
        zpl: SOURCE,
        labelSize: LabelSize.TWO_BY_ONE,
      }),
    ).rejects.toThrow('Not Found');
    expect(await service.list('baseline', 'bob')).toEqual({
      schemaVersion: 1,
      baselines: [],
    });
    expect(await service.list('run', 'bob')).toEqual({
      schemaVersion: 1,
      runs: [],
    });
  });
  it('checks deletion tombstones on every write boundary and removes late storage writes', async () => {
    const base = await baseline(false);
    db.rows.set('deleted_accounts/alice', {});
    await expect(
      service.approve('alice', base.id, {
        expectedVersion: base.version,
        note: 'OK',
      }),
    ).rejects.toThrow('ACCOUNT_UNAVAILABLE');
    await expect(service.get('baseline', 'alice', base.id)).rejects.toThrow(
      'ACCOUNT_UNAVAILABLE',
    );
    db.rows.delete('deleted_accounts/alice');
    renderer.getLabelsPreview.mockImplementationOnce(async () => {
      db.rows.set('deleted_accounts/alice', {});
      return [
        {
          qty: 1,
          img: `data:image/png;base64,${(await png()).toString('base64')}`,
        },
      ];
    });
    const id = randomUUID();
    await expect(
      service.createBaseline('alice', {
        operationId: id,
        name: 'Test',
        zpl: SOURCE,
        labelSize: LabelSize.TWO_BY_ONE,
      }),
    ).rejects.toThrow('ACCOUNT_UNAVAILABLE');
    expect([...files.keys()].some((path) => path.includes(id))).toBe(false);
  });
  it('returns metadata with null URLs after 15 days and refuses artifact-dependent actions', async () => {
    const base = await baseline(false);
    const row = db.rows.get(`${COLLECTIONS.baseline}/${base.id}`);
    row.artifactsExpireAt = new Date(Date.now() - 1).toISOString();
    expect(
      (await service.get('baseline', 'alice', base.id)).baseline,
    ).toMatchObject({ source: { url: null }, image: { url: null } });
    await expect(
      service.approve('alice', base.id, {
        expectedVersion: base.version,
        note: 'OK',
      }),
    ).rejects.toThrow('ARTIFACTS_EXPIRED');
    const op = db.rows.get(`${COLLECTIONS.operation}/${base.id}`);
    expect(op.expiresAt.toMillis() - Date.parse(op.createdAt)).toBe(
      90 * 86400000,
    );
    expect(Date.parse(op.artifactsExpireAt) - Date.parse(op.createdAt)).toBe(
      15 * 86400000,
    );
  });
  it('gates every public method with the feature flag', async () => {
    flags.assertFeatureAvailable.mockRejectedValue(
      new ForbiddenException('Feature unavailable'),
    );
    await expect(service.fixtures('alice')).rejects.toThrow(
      'Feature unavailable',
    );
    await expect(service.list('baseline', 'alice')).rejects.toThrow(
      'Feature unavailable',
    );
    await expect(service.get('run', 'alice', randomUUID())).rejects.toThrow(
      'Feature unavailable',
    );
    await expect(
      service.createBaseline('alice', {
        operationId: randomUUID(),
        name: 'Test',
        zpl: SOURCE,
        labelSize: LabelSize.TWO_BY_ONE,
      }),
    ).rejects.toThrow('Feature unavailable');
    expect(renderer.getLabelsPreview).not.toHaveBeenCalled();
  });
  it('marks versioned synthetic fixtures and propagates the marker to completion events', async () => {
    expect(REGRESSION_FIXTURES).toHaveLength(10);
    for (const fixture of REGRESSION_FIXTURES)
      validateLabel(fixture.zpl, fixture.labelSize);
    const fixture = REGRESSION_FIXTURES[0];
    const created = await service.createBaseline('alice', {
      operationId: randomUUID(),
      name: fixture.name,
      zpl: fixture.zpl,
      labelSize: fixture.labelSize,
      fixtureId: fixture.id,
    });
    const base = (
      await service.approve('alice', created.baseline.id, {
        expectedVersion: created.baseline.version,
        note: 'Synthetic fixture',
      })
    ).baseline;
    await service.createRun('alice', runInput(base));
    expect(
      events.recordServerEvent.mock.calls.every(
        ([event]) => event.isSynthetic === true,
      ),
    ).toBe(true);
  });
  describe('HTTP Firebase guard and exact envelopes', () => {
    let app: INestApplication;
    beforeEach(async () => {
      const module = await Test.createTestingModule({
        controllers: [TemplateRegressionController],
        providers: [
          FirebaseAuthGuard,
          { provide: TemplateRegressionService, useValue: service },
          { provide: FirestoreService, useValue: firestore },
          {
            provide: FirebaseAdminService,
            useValue: {
              verifyToken: async (token: string) => {
                if (!['alice', 'bob'].includes(token)) throw new Error();
                return { uid: token };
              },
            },
          },
        ],
      }).compile();
      app = module.createNestApplication();
      app.setGlobalPrefix('api');
      await app.init();
    });
    afterEach(async () => {
      await app.close();
    });
    it('returns 401 without Firebase auth and 403 when the feature is unavailable', async () => {
      await request(app.getHttpServer())
        .get('/api/template-regression/baselines')
        .expect(401);
      await request(app.getHttpServer())
        .get('/api/template-regression/fixtures')
        .set('Authorization', 'Bearer bad')
        .expect(401);
      flags.assertFeatureAvailable.mockRejectedValue(
        new ForbiddenException('Feature unavailable'),
      );
      await request(app.getHttpServer())
        .get('/api/template-regression/fixtures')
        .set('Authorization', 'Bearer alice')
        .expect(403);
    });
    it('uses server identity, rejects extra keys and enforces ownership', async () => {
      await request(app.getHttpServer())
        .post('/api/template-regression/baselines')
        .set('Authorization', 'Bearer alice')
        .send({
          accountId: 'bob',
          operationId: randomUUID(),
          name: 'Test',
          zpl: SOURCE,
          labelSize: '2x1',
        })
        .expect(400);
      const result = await request(app.getHttpServer())
        .post('/api/template-regression/baselines')
        .set('Authorization', 'Bearer alice')
        .send({
          operationId: randomUUID(),
          name: 'Test',
          zpl: SOURCE,
          labelSize: '2x1',
        })
        .expect(201);
      expect(Object.keys(result.body).sort()).toEqual([
        'baseline',
        'schemaVersion',
      ]);
      expect(Object.keys(result.body.baseline).sort()).toEqual(
        [
          'id',
          'operationId',
          'name',
          'version',
          'status',
          'labelSize',
          'renderer',
          'source',
          'image',
          'width',
          'height',
          'createdAt',
          'approvedAt',
          'approvedBy',
          'approvalNote',
          'artifactsExpireAt',
          'metadataExpireAt',
          'errorCode',
          'fixtureId',
          'fixtureVersion',
        ].sort(),
      );
      await request(app.getHttpServer())
        .get(`/api/template-regression/baselines/${result.body.baseline.id}`)
        .set('Authorization', 'Bearer bob')
        .expect(404);
      await request(app.getHttpServer())
        .post(
          `/api/template-regression/baselines/${result.body.baseline.id}/approve`,
        )
        .set('Authorization', 'Bearer alice')
        .send({ expectedVersion: 2 })
        .expect(400);
    });
  });
});

describe('bounded literal ZPL validation', () => {
  it.each([
    '',
    '^XA^XZ',
    '^XA^FD   ^FS^XZ',
    '^XA^FX Comment ^FDnot a real field^FS^XZ',
    `${SOURCE}${SOURCE}`,
    SOURCE.replace('^PQ1', '^PQ2'),
    SOURCE.replace('^PQ1', '^PQ1,0,2'),
    SOURCE.replace('^PQ1', '^PQ1^PQ1'),
    SOURCE.replace('^FO', '^CC!^FO'),
    SOURCE.replace('TEST', 'A'.repeat(128 * 1024)),
    '^XA^XFR:downloaded.ZPL^FS^XZ',
    '^XA^DFR:template.ZPL^FS^FDTEST^FS^XZ',
    SOURCE.replace('^PQ1', '~JA'),
  ])('rejects unsafe or non-single input %#', (source) => {
    expect(() => validateLabel(source, '2x1')).toThrow();
  });
  it('accepts only catalog dimensions and bounded integer masks', () => {
    expect(() => validateLabel(SOURCE, 'constructor')).toThrow(
      'INVALID_LABEL_SIZE',
    );
    expect(() =>
      settings({ masks: Array(21).fill({ x: 0, y: 0, width: 1, height: 1 }) }),
    ).toThrow();
    expect(() => settings({ channelTolerance: 65 })).toThrow();
    expect(() => settings({ maxChangedRatio: 0.11 })).toThrow();
    expect(() =>
      settings({ masks: [{ x: 0.5, y: 0, width: 1, height: 1 }] }),
    ).toThrow();
    expect(() =>
      validateMaskBounds(
        settings({ masks: [{ x: 0, y: 0, width: 10, height: 3 }] }),
        10,
        10,
      ),
    ).toThrow('DIFF_MASK_AREA_EXCEEDED');
    expect(LEASE_MS).toBe(10 * 60000);
  });
});
