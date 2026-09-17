import 'reflect-metadata';
import { FieldValue, Firestore } from '@google-cloud/firestore';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { FirestoreService } from '../cache/firestore.service.js';
import { FirebaseAdminService } from '../auth/firebase-admin.service.js';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';
import { AdminAuthGuard } from '../../common/guards/admin-auth.guard.js';
import { FeatureFlagsService } from './feature-flags.service.js';
import {
  ProductEventRepository,
  eventKey,
} from './product-event.repository.js';
import { ProductObservabilityService } from './product-observability.service.js';
import { ProductEventOutboxService } from './product-event-outbox.service.js';
import { ProductObservabilityController } from './product-observability.controller.js';
import type { ServerEventInput } from './observability.types.js';
import { ObservabilityFirestoreProvider } from './firestore.provider.js';

/** Transactional fake: staged writes roll back; concurrent transactions serialize. No network. */
class MemoryFirestore {
  rows = new Map<string, any>();
  private tail = Promise.resolve();
  private snapshot(path: string) {
    const data = this.rows.get(path);
    return {
      exists: Boolean(data),
      id: path.split('/').pop(),
      data: () => data,
      get: (key: string) => data?.[key],
    };
  }
  collection(name: string) {
    return {
      doc: (id: string) => ({
        path: `${name}/${id}`,
        get: async () => this.snapshot(`${name}/${id}`),
      }),
      where: (_field: string, _op: string, now: string) => ({
        orderBy: () => ({
          limit: (limit: number) => ({
            get: async () => {
              const docs = [...this.rows.entries()]
                .filter(
                  ([path, row]) =>
                    path.startsWith(`${name}/`) &&
                    typeof row.availableAt === 'string' &&
                    row.availableAt <= now,
                )
                .sort((a, b) =>
                  a[1].availableAt.localeCompare(b[1].availableAt),
                )
                .slice(0, limit)
                .map(([path]) => this.snapshot(path));
              return { docs, size: docs.length };
            },
          }),
        }),
      }),
    };
  }
  async runTransaction<T>(callback: (tx: any) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: () => void;
    this.tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    const writes: Array<() => void> = [];
    try {
      const result = await callback({
        get: async (ref: any) => {
          if (writes.length) throw new Error('Read after write');
          return this.snapshot(ref.path);
        },
        create: (ref: any, data: any) => {
          writes.push(() => this.rows.set(ref.path, { ...data }));
        },
        update: (ref: any, data: any) => {
          writes.push(() => {
            const row = { ...this.rows.get(ref.path) };
            for (const [key, value] of Object.entries(data)) {
              if (
                value instanceof FieldValue &&
                value.isEqual(FieldValue.delete())
              )
                delete row[key];
              else row[key] = value;
            }
            this.rows.set(ref.path, row);
          });
        },
      });
      writes.forEach((write) => write());
      return result;
    } finally {
      release();
    }
  }
}

const enabledFlag = {
  enabled: true,
  killSwitch: false,
  owner: 'product',
  updatedAt: '2026-09-17T00:00:00.000Z',
  version: '1',
  allowedPlans: ['pro'],
  rolloutPercent: 100,
  experimentId: 'packing-v1',
  assignmentVersion: '1',
};
function fixture() {
  const db = new MemoryFirestore();
  const settings: Record<string, string> = {
    NODE_ENV: 'test',
    ADMIN_EMAILS: 'admin@example.test',
    PRODUCT_FEATURE_FLAGS: JSON.stringify({ packing_workflow: enabledFlag }),
  };
  const users = {
    isAccountDeletionMarked: jest.fn().mockResolvedValue(false),
    getUserById: jest.fn().mockImplementation(async (id: string) => ({
      id,
      plan: 'pro',
      role: 'user',
      email: 'user@example.test',
    })),
    saveAdminAuditLog: jest.fn(),
    getClient: () => db,
  };
  const config = { get: (key: string) => settings[key] } as ConfigService;
  const flags = new FeatureFlagsService(
    users as unknown as FirestoreService,
    config,
  );
  const repository = new ProductEventRepository(db as unknown as Firestore);
  const service = new ProductObservabilityService(repository, flags, config);
  const outbox = new ProductEventOutboxService(db as unknown as Firestore);
  return { db, settings, users, config, flags, repository, service, outbox };
}
function web() {
  return {
    sentAt: new Date().toISOString(),
    consentEpoch: randomUUID(),
    sessionEpoch: randomUUID(),
    consent: { analytics: true, version: '2026-09-17' },
    events: [
      {
        eventId: randomUUID(),
        schemaVersion: 1,
        eventName: 'feature_exposed',
        surface: 'workspace',
        occurredAt: new Date().toISOString(),
        featureId: 'packing_workflow',
        featureVersion: '1',
      },
    ],
  };
}
function server(): ServerEventInput {
  return {
    eventId: randomUUID(),
    schemaVersion: 1,
    eventName: 'packing_export_succeeded',
    accountId: 'account-a',
    featureId: 'packing_workflow',
    featureVersion: '1',
    operationId: randomUUID(),
    occurredAt: new Date().toISOString(),
    source: 'api',
  };
}

describe('consented product tour events', () => {
  function tourFixture(eventName = 'tour_started') {
    const f = fixture();
    f.settings.PRODUCT_FEATURE_FLAGS = JSON.stringify({
      packing_workflow: {
        ...enabledFlag,
        allowedPlans: ['pro', 'promax', 'enterprise'],
      },
    });
    f.settings.PRODUCT_UPDATES_RELEASE = JSON.stringify({
      releaseId: 'growth-2026-09',
      tourVersion: '1',
      manifestVersion: '1',
      environment: 'test',
      enabled: true,
      releasedAt: '2020-01-01T00:00:00Z',
      releasedFeatureIds: ['packing_workflow'],
      steps: [
        {
          stepId: 'packing_workflow',
          featureId: 'packing_workflow',
          anchorId: 'nav-packing_workflow',
          order: 1,
        },
      ],
    });
    const old = web();
    const body = {
      ...old,
      events: [
        {
          ...old.events[0],
          eventName,
          surface: 'tour',
          releaseId: 'growth-2026-09',
          tourVersion: '1',
          tourStepId: 'packing_workflow',
        },
      ],
    };
    return { ...f, body };
  }

  it('deduplicates tour retries but rejects changed metadata with the same event ID', async () => {
    const f = tourFixture();
    await f.service.recordWebEvents('account-a', f.body);
    const duplicate = await f.service.recordWebEvents('account-a', f.body);
    expect(duplicate.results[0].duplicate).toBe(true);
    const changed = structuredClone(f.body);
    changed.events[0].eventName = 'tour_completed';
    await expect(
      f.service.recordWebEvents('account-a', changed),
    ).rejects.toThrow();
  });

  it('accepts an honest upgrade click from Free only for a globally released offer', async () => {
    const f = tourFixture('tour_upgrade_clicked');
    f.users.getUserById.mockResolvedValue({
      id: 'account-a',
      plan: 'free',
      role: 'user',
    });
    await expect(
      f.service.recordWebEvents('account-a', f.body),
    ).resolves.toBeDefined();
    f.body.events[0].eventId = randomUUID();
    f.body.events[0].eventName = 'tour_feature_opened';
    await expect(
      f.service.recordWebEvents('account-a', f.body),
    ).rejects.toThrow('Invalid tour event context');
    f.body.events[0].eventName = 'tour_upgrade_clicked';
    const flags = JSON.parse(f.settings.PRODUCT_FEATURE_FLAGS);
    flags.packing_workflow.rolloutPercent = 10;
    f.settings.PRODUCT_FEATURE_FLAGS = JSON.stringify(flags);
    await expect(
      f.service.recordWebEvents('account-a', f.body),
    ).rejects.toThrow('Feature unavailable');
  });

  it('rejects unknown releases, wrong surfaces, missing consent and non-tour metadata', async () => {
    for (const mutate of [
      (f: ReturnType<typeof tourFixture>) => {
        f.body.events[0].releaseId = 'invented';
      },
      (f: ReturnType<typeof tourFixture>) => {
        f.body.events[0].surface = 'workspace';
      },
      (f: ReturnType<typeof tourFixture>) => {
        f.body.consent.analytics = false;
      },
      (f: ReturnType<typeof tourFixture>) => {
        f.body.events[0].eventName = 'feature_exposed';
      },
      (f: ReturnType<typeof tourFixture>) => {
        delete f.settings.PRODUCT_UPDATES_RELEASE;
      },
    ]) {
      const f = tourFixture();
      mutate(f);
      await expect(
        f.service.recordWebEvents('account-a', f.body),
      ).rejects.toThrow();
    }
  });
});

describe('feature permissions', () => {
  it('returns exactly seven disabled flags by default', async () => {
    const f = fixture();
    delete f.settings.PRODUCT_FEATURE_FLAGS;
    const result = await f.flags.getFeatures('account-a');
    expect(result.features).toHaveLength(7);
    expect(result.features.every((flag) => !flag.available)).toBe(true);
    await expect(
      f.flags.assertFeatureAvailable('account-a', 'packing_workflow'),
    ).rejects.toThrow('Feature unavailable');
  });
  it('uses server plan, deterministic assignment and kill switch', async () => {
    const f = fixture();
    expect(await f.flags.getFeatures('account-a')).toEqual(
      await f.flags.getFeatures('account-a'),
    );
    await expect(
      f.flags.assertFeatureAvailable('account-a', 'packing_workflow'),
    ).resolves.toMatchObject({ available: true });
    f.users.getUserById.mockResolvedValue({
      id: 'account-a',
      plan: 'free',
      role: 'user',
    });
    await expect(
      f.flags.assertFeatureAvailable('account-a', 'packing_workflow'),
    ).rejects.toThrow();
    f.settings.PRODUCT_FEATURE_FLAGS = JSON.stringify({
      packing_workflow: { ...enabledFlag, killSwitch: true },
    });
    await expect(
      f.flags.assertFeatureAvailable('account-a', 'packing_workflow'),
    ).rejects.toThrow();
  });
  it('fails closed for invalid flag config or unavailable/deleted account', async () => {
    const f = fixture();
    f.settings.PRODUCT_FEATURE_FLAGS = '{';
    await expect(f.flags.getFeatures('account-a')).rejects.toThrow(
      'Invalid server feature configuration',
    );
    f.users.isAccountDeletionMarked.mockResolvedValue(true);
    await expect(f.flags.account('account-a')).rejects.toThrow();
    f.users.isAccountDeletionMarked.mockResolvedValue(false);
    f.users.getUserById.mockResolvedValue(null);
    await expect(f.flags.account('account-a')).rejects.toThrow();
  });
  it('marks admin simulation synthetic', async () => {
    const f = fixture();
    f.users.getUserById.mockResolvedValue({
      id: 'account-a',
      plan: 'free',
      role: 'admin',
      simulatedPlan: 'pro',
      simulationExpiresAt: new Date(Date.now() + 60000),
    });
    expect(await f.flags.account('account-a')).toEqual({
      plan: 'pro',
      isSynthetic: true,
    });
  });
  it('persists first eligible assignment independently of consent and never overwrites it', async () => {
    const f = fixture();
    await f.flags.getFeatures('account-a');
    const rows = [...f.db.rows.entries()].filter(([path]) =>
      path.startsWith('growth_assignments/'),
    );
    expect(rows).toHaveLength(1);
    const original = { ...rows[0][1] };
    expect(original).toMatchObject({
      accountId: 'account-a',
      featureId: 'packing_workflow',
      variant: 'treatment',
      plan: 'pro',
      initiallyPaid: true,
      isSynthetic: false,
    });
    f.settings.PRODUCT_FEATURE_FLAGS = JSON.stringify({
      packing_workflow: { ...enabledFlag, rolloutPercent: 0 },
    });
    expect(
      (await f.flags.getFeatures('account-a')).features[0].experimentAssignment
        .variant,
    ).toBe('treatment');
    expect(f.db.rows.get(rows[0][0])).toEqual(original);
    f.settings.PRODUCT_FEATURE_FLAGS = JSON.stringify({
      packing_workflow: {
        ...enabledFlag,
        assignmentVersion: '2',
        rolloutPercent: 0,
      },
    });
    expect(
      (await f.flags.getFeatures('account-a')).features[0].experimentAssignment
        .variant,
    ).toBe('control');
    expect(
      [...f.db.rows.keys()].filter((path) =>
        path.startsWith('growth_assignments/'),
      ),
    ).toHaveLength(2);
  });
  it('shares configured client through public provider', () => {
    const f = fixture();
    expect((ObservabilityFirestoreProvider as any).useFactory(f.users)).toBe(
      f.db,
    );
  });
});

describe('web validation and canonical facts', () => {
  it.each([
    'packing_export_succeeded',
    'invoice_paid',
    'purchase',
    'print_confirmed',
  ])('rejects client canonical event %s', async (name) => {
    const f = fixture();
    const body = web();
    body.events[0].eventName = name;
    await expect(
      f.service.recordWebEvents('account-a', body),
    ).rejects.toThrow();
    expect(
      [...f.db.rows.keys()].filter(
        (path) => !path.startsWith('growth_assignments/'),
      ),
    ).toHaveLength(0);
  });
  it.each([
    'email',
    'uid',
    'accountId',
    'planAtEvent',
    'zpl',
    'filename',
    'properties',
  ])('rejects free-form or forged field %s', async (key) => {
    const f = fixture();
    const body = web();
    body.events[0][key] = 'secret@example.test';
    await expect(
      f.service.recordWebEvents('account-a', body),
    ).rejects.toThrow();
  });
  it('requires versioned declared consent and 1–20 events', async () => {
    const f = fixture();
    for (const body of [
      { events: web().events },
      { ...web(), consent: { analytics: false, version: '2026-09-17' } },
      { ...web(), consent: { analytics: true, version: 'old' } },
      { ...web(), events: [] },
      { ...web(), events: Array.from({ length: 21 }, () => web().events[0]) },
    ])
      await expect(
        f.service.recordWebEvents('account-a', body),
      ).rejects.toThrow();
  });
  it('validates action, stale versions, UTC timestamps, and bounded age', async () => {
    const f = fixture();
    for (const patch of [
      { action: 'free text' },
      { eventName: 'feature_interacted' },
      { featureVersion: '2' },
      { occurredAt: '2020-01-01T00:00:00Z' },
      { occurredAt: new Date(Date.now() + 3600000).toISOString() },
    ]) {
      const body = web();
      Object.assign(body.events[0], patch);
      await expect(
        f.service.recordWebEvents('account-a', body),
      ).rejects.toThrow();
    }
  });
  it('validates opaque consent/session epochs, sentAt and surface allowlist', async () => {
    const f = fixture();
    for (const patch of [
      { consentEpoch: 1 },
      { sessionEpoch: 'email@example.test' },
      { sentAt: 'bad' },
      { sentAt: '2020-01-01T00:00:00Z' },
    ])
      await expect(
        f.service.recordWebEvents('account-a', { ...web(), ...patch }),
      ).rejects.toThrow();
    const body = web();
    body.events[0].surface = 'https://example.test/private';
    await expect(
      f.service.recordWebEvents('account-a', body),
    ).rejects.toThrow();
  });
  it('deduplicates UUIDv5 tab exposures despite different timestamps and delivery epochs', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-17T12:00:00Z'));
    try {
      const f = fixture();
      const first = web();
      first.events[0].eventId = '6ba7b810-9dad-51d1-80b4-00c04fd430c8';
      const a = await f.service.recordWebEvents('account-a', first);
      jest.advanceTimersByTime(1000);
      const second = web();
      second.events[0].eventId = first.events[0].eventId;
      const b = await f.service.recordWebEvents('account-a', second);
      expect(b.results[0]).toMatchObject({
        key: a.results[0].key,
        duplicate: true,
      });
      const third = await f.service.recordWebEvents('account-a', web());
      expect(third.results[0]).toMatchObject({
        key: a.results[0].key,
        duplicate: true,
      });
      expect(
        [...f.db.rows.keys()].filter((path) =>
          path.startsWith('product_events/'),
        ),
      ).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });
  it('scopes exposures by Merida day, surface and server assignment version', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-17T05:59:00Z'));
    try {
      const f = fixture();
      await f.service.recordWebEvents('account-a', web());
      jest.advanceTimersByTime(120000);
      expect(
        (await f.service.recordWebEvents('account-a', web())).results[0]
          .duplicate,
      ).toBe(false);
      const otherSurface = web();
      otherSurface.events[0].surface = 'editor';
      expect(
        (await f.service.recordWebEvents('account-a', otherSurface)).results[0]
          .duplicate,
      ).toBe(false);
      f.settings.PRODUCT_FEATURE_FLAGS = JSON.stringify({
        packing_workflow: { ...enabledFlag, assignmentVersion: '2' },
      });
      expect(
        (await f.service.recordWebEvents('account-a', web())).results[0]
          .duplicate,
      ).toBe(false);
      const stored = [...f.db.rows.entries()]
        .filter(([path]) => path.startsWith('product_events/'))
        .map(([, row]) => row);
      expect(stored).toHaveLength(4);
      expect(stored[3].assignmentVersion).toBe('2');
    } finally {
      jest.useRealTimers();
    }
  });
  it('deduplicates concurrent retries in account namespace and retains 90-day native TTL', async () => {
    const f = fixture();
    const body = web();
    const results = await Promise.all([
      f.service.recordWebEvents('account-a', body),
      f.service.recordWebEvents('account-a', body),
    ]);
    expect(results.map((r) => r.results[0].duplicate).sort()).toEqual([
      false,
      true,
    ]);
    await f.service.recordWebEvents('account-b', body);
    expect(
      [...f.db.rows.keys()].filter((path) =>
        path.startsWith('product_events/'),
      ),
    ).toHaveLength(2);
    const event = f.db.rows.get(
      `product_events/${eventKey('account-a', body.events[0].eventId)}`,
    );
    expect(event.accountId).toBe('account-a');
    expect(event.planAtEvent).toBe('pro');
    expect(event.expiresAt.toMillis() - Date.parse(event.receivedAt)).toBe(
      90 * 86400000,
    );
  });
  it('rejects event-ID collisions atomically', async () => {
    const f = fixture();
    const body = web();
    await f.service.recordWebEvents('account-a', body);
    const collision = web();
    collision.events[0].eventId = body.events[0].eventId;
    collision.events[0].eventName = 'feature_interacted';
    (collision.events[0] as any).action = 'open';
    collision.events.unshift(web().events[0]);
    await expect(
      f.service.recordWebEvents('account-a', collision),
    ).rejects.toThrow('Event ID already used');
    expect(
      [...f.db.rows.keys()].filter((path) =>
        path.startsWith('product_events/'),
      ),
    ).toHaveLength(1);
  });
  it('deduplicates server facts by semantic operation even with another event ID', async () => {
    const f = fixture();
    const input = server();
    expect((await f.service.recordServerEvent(input)).duplicate).toBe(false);
    expect(
      (await f.service.recordServerEvent({ ...input, eventId: randomUUID() }))
        .duplicate,
    ).toBe(true);
    expect(
      (await f.service.recordServerEvent({ ...input, eventId: randomUUID() }))
        .key,
    ).toBe(eventKey(input.accountId, input.eventId));
    expect(
      [...f.db.rows.keys()].filter((path) =>
        path.startsWith('product_events/'),
      ),
    ).toHaveLength(1);
  });
  it('rolls back event and outbox with the surrounding business transaction', async () => {
    const f = fixture();
    await expect(
      f.db.runTransaction(async (tx) => {
        await f.service.recordServerEvent(server(), tx);
        throw new Error('Business failed');
      }),
    ).rejects.toThrow('Business failed');
    expect(
      [...f.db.rows.keys()].filter(
        (path) => !path.startsWith('growth_assignments/'),
      ),
    ).toHaveLength(0);
  });
  it('rejects server free text and mismatched feature facts', async () => {
    const f = fixture();
    await expect(
      f.service.recordServerEvent({ ...server(), email: 'secret' } as any),
    ).rejects.toThrow();
    await expect(
      f.service.recordServerEvent({ ...server(), featureId: 'direct_print' }),
    ).rejects.toThrow();
  });
  it('exposes missing metrics as null with no growth conclusion', async () => {
    const f = fixture();
    expect(await f.service.quality()).toMatchObject({
      status: 'missing_data',
      eventCount: null,
      coverage: null,
      canEvaluateGrowth: false,
    });
    expect(f.service.snapshots()).toMatchObject({
      status: 'insufficient_data',
      numerator: null,
      denominator: null,
    });
  });
});

describe('durable outbox', () => {
  afterEach(() => jest.useRealTimers());
  it('recovers expired lease and fences stale acknowledgments', async () => {
    jest.useFakeTimers();
    const f = fixture();
    const { key } = await f.service.recordServerEvent(server());
    const lease = await f.outbox.claim(key);
    expect(await f.outbox.claim(key)).toBeNull();
    jest.advanceTimersByTime(60001);
    const recovered = await f.outbox.claim(key);
    expect(recovered.attempts).toBe(2);
    expect(await f.outbox.settle(lease, true)).toBe(false);
    expect(await f.outbox.settle(recovered, true)).toBe(true);
    expect(await f.outbox.claim(key)).toBeNull();
  });
  it('retries failure with backoff and ACKs successful delivery only', async () => {
    jest.useFakeTimers();
    const f = fixture();
    await f.service.recordServerEvent(server());
    const deliver = jest
      .fn()
      .mockRejectedValueOnce(new Error('secret transport text'))
      .mockResolvedValue(undefined);
    expect(await f.outbox.dispatch(deliver)).toMatchObject({
      failed: 1,
      delivered: 0,
    });
    expect(await f.outbox.dispatch(deliver)).toMatchObject({ scanned: 0 });
    jest.advanceTimersByTime(2001);
    expect(await f.outbox.dispatch(deliver)).toMatchObject({ delivered: 1 });
    expect(deliver.mock.calls[0][1]).toBe(deliver.mock.calls[1][1]);
    expect(JSON.stringify([...f.db.rows.values()])).not.toContain(
      'secret transport text',
    );
    expect(await f.outbox.dispatch(deliver)).toMatchObject({ scanned: 0 });
  });
  it('dead-letters after eight failures and allows explicit retry', async () => {
    jest.useFakeTimers();
    const f = fixture();
    const { key } = await f.service.recordServerEvent(server());
    for (let i = 0; i < 8; i++) {
      const lease = await f.outbox.claim(key);
      expect(lease).not.toBeNull();
      await f.outbox.settle(lease, false);
      jest.advanceTimersByTime(3600001);
    }
    expect(f.db.rows.get(`event_outbox/${key}`).state).toBe('dead');
    expect(await f.outbox.claim(key)).toBeNull();
    expect(await f.outbox.retryDead(key)).toBe(true);
    expect((await f.outbox.claim(key)).attempts).toBe(1);
  });
  it('does not deliver expired event even when TTL has not deleted it', async () => {
    jest.useFakeTimers();
    const f = fixture();
    await f.service.recordServerEvent(server());
    jest.advanceTimersByTime(91 * 86400000);
    const deliver = jest.fn();
    await f.outbox.dispatch(deliver);
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('HTTP guard boundaries', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const f = fixture();
    const module = await Test.createTestingModule({
      controllers: [ProductObservabilityController],
      providers: [
        FirebaseAuthGuard,
        AdminAuthGuard,
        { provide: FeatureFlagsService, useValue: f.flags },
        { provide: ProductObservabilityService, useValue: f.service },
        { provide: ConfigService, useValue: f.config },
        { provide: FirestoreService, useValue: f.users },
        {
          provide: FirebaseAdminService,
          useValue: {
            verifyToken: jest.fn(async (token) => {
              if (token === 'bad') throw new Error();
              return {
                uid: 'account-a',
                email:
                  token === 'admin'
                    ? 'admin@example.test'
                    : 'user@example.test',
              };
            }),
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => app.close());
  it('rejects unauthenticated feature/event/admin access', async () => {
    await request(app.getHttpServer()).get('/users/me/features').expect(401);
    await request(app.getHttpServer())
      .post('/product-events/web')
      .send(web())
      .expect(401);
    await request(app.getHttpServer())
      .get('/admin/observability/quality')
      .expect(401);
  });
  it('denies non-admin and forged admin-email headers', async () => {
    await request(app.getHttpServer())
      .get('/admin/observability/quality')
      .set('Authorization', 'Bearer user')
      .expect(403);
    await request(app.getHttpServer())
      .get('/admin/observability/snapshots')
      .set('Authorization', 'Bearer user')
      .set('X-Admin-Email', 'admin@example.test')
      .expect(403);
  });
  it('derives feature/event identity from guard and grants admin read', async () => {
    await request(app.getHttpServer())
      .get('/users/me/features?plan=enterprise&uid=other')
      .set('Authorization', 'Bearer user')
      .expect(200)
      .expect((res) => expect(res.body.plan).toBe('pro'));
    await request(app.getHttpServer())
      .post('/product-events/web')
      .set('Authorization', 'Bearer user')
      .send(web())
      .expect(202);
    await request(app.getHttpServer())
      .post('/product-events/web')
      .set('Authorization', 'Bearer user')
      .send({ ...web(), accountId: 'other' })
      .expect(400);
    await request(app.getHttpServer())
      .get('/admin/observability/quality')
      .set('Authorization', 'Bearer admin')
      .expect(200)
      .expect((res) => expect(res.body.status).toBe('missing_data'));
  });
});
