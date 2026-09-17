import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { FieldValue, Timestamp } from '@google-cloud/firestore';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { Reflector } from '@nestjs/core';
import { PublicApiCrypto } from './public-api.crypto.js';
import { ApiCredentialsService } from './api-credentials.service.js';
import { ApiJobsService } from './api-jobs.service.js';
import {
  ApiCallbacksService,
  callbackSignature,
} from './api-callbacks.service.js';
import { ApiKeyGuard } from './api-key.guard.js';
import { PublicApiJobsController } from './public-api.controller.js';
import {
  CallbackTransport,
  callbackUrl,
  isPublicAddress,
} from './callback-transport.service.js';
import { ApiTemplateAdapter } from './api-template.adapter.js';
import { ApiConversionAdapter } from './api-conversion.adapter.js';
import { operationUuid } from './api-job-validation.js';

jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));
jest.mock('node:https', () => ({ request: jest.fn() }));
class MemoryDb {
  rows = new Map<string, any>();
  private tail = Promise.resolve();
  ref(path: string): any {
    return {
      path,
      id: path.split('/').pop(),
      get: async () => this.snap(path),
      update: async (value: any) => this.apply(path, value, true),
    };
  }
  snap(path: string): any {
    const data = this.rows.get(path);
    return {
      ref: this.ref(path),
      id: path.split('/').pop(),
      exists: !!data,
      data: () => data,
      get: (key: string) => data?.[key],
    };
  }
  collection(name: string): any {
    const query = (field: string, op: string, value: any) => ({
      orderBy: (_key: string) => query(field, op, value),
      limit: (limit: number) => ({
        get: async () => {
          const docs = [...this.rows.entries()]
            .filter(
              ([path, row]) =>
                path.startsWith(`${name}/`) &&
                (op === '=='
                  ? row[field] === value
                  : row[field] !== undefined && row[field] <= value),
            )
            .sort((a, b) =>
              String(a[1][field]).localeCompare(String(b[1][field])),
            )
            .slice(0, limit)
            .map(([path]) => this.snap(path));
          return { docs, size: docs.length };
        },
      }),
    });
    return { doc: (id: string) => this.ref(`${name}/${id}`), where: query };
  }
  apply(path: string, data: any, merge = false) {
    const row = merge ? { ...this.rows.get(path) } : {};
    for (const [key, value] of Object.entries(data)) {
      if (value instanceof FieldValue && value.isEqual(FieldValue.delete()))
        delete row[key];
      else row[key] = value;
    }
    this.rows.set(path, row);
  }
  async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const prior = this.tail;
    let release: () => void;
    this.tail = new Promise((resolve) => {
      release = resolve;
    });
    await prior;
    const writes: Array<() => void> = [];
    try {
      const result = await fn({
        get: async (ref: any) => {
          if (writes.length) throw new Error('read after write');
          return this.snap(ref.path);
        },
        create: (ref: any, v: any) =>
          writes.push(() => this.apply(ref.path, v)),
        update: (ref: any, v: any) =>
          writes.push(() => this.apply(ref.path, v, true)),
        set: (ref: any, v: any, opts: any) =>
          writes.push(() => this.apply(ref.path, v, opts?.merge)),
      });
      writes.forEach((write) => write());
      return result;
    } finally {
      release();
    }
  }
}
function fixture() {
  const db = new MemoryDb();
  const store = {
    getClient: () => db,
    isAccountDeletionMarked: jest.fn().mockResolvedValue(false),
  };
  const config = {
    get: (key: string) =>
      key === 'PUBLIC_API_ENCRYPTION_KEY'
        ? Buffer.alloc(32, 7).toString('base64')
        : undefined,
  };
  const crypto = new PublicApiCrypto(config as any);
  const flags = {
    account: jest.fn().mockResolvedValue({ plan: 'pro' }),
    assertFeatureAvailable: jest
      .fn()
      .mockResolvedValue({ featureVersion: '1' }),
  };
  const transport = {
    resolve: jest.fn().mockResolvedValue({}),
    send: jest.fn().mockResolvedValue(undefined),
  };
  const credentials = new ApiCredentialsService(
    store as any,
    flags as any,
    crypto,
    transport as any,
  );
  const events = {
    recordServerEvent: jest.fn().mockImplementation(async (input, tx) => {
      tx.create(db.collection('test_events').doc(input.eventId), input);
      return { duplicate: false };
    }),
  };
  const converter = {
    run: jest.fn().mockImplementation(async (input) => ({
      jobId: input.operationId,
      status: 'completed',
    })),
    result: jest.fn().mockResolvedValue({
      url: 'https://storage.example.test/signed',
      filename: 'result.pdf',
    }),
  };
  const jobs = new ApiJobsService(
    store as any,
    flags as any,
    events as any,
    credentials,
    crypto,
    converter,
    new ApiTemplateAdapter(store as any),
  );
  const callbacks = new ApiCallbacksService(
    store as any,
    credentials,
    crypto,
    transport as any,
  );
  return {
    db,
    store,
    crypto,
    flags,
    transport,
    credentials,
    events,
    converter,
    jobs,
    callbacks,
  };
}
const input = () => ({
  zplContent: '^XA^FO20,20^FDsynthetic^FS^XZ',
  labelSize: '4x6',
});
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-17T12:00:00Z'));
});
afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

describe('keys and encrypted secrets', () => {
  it('reveals once, hashes storage, enforces owner, scopes, revocation and server flag', async () => {
    const f = fixture();
    const key = await f.credentials.createKey('a', { scopes: ['jobs:read'] });
    expect((await f.credentials.authenticate(key.token)).accountId).toBe('a');
    expect(JSON.stringify([...f.db.rows.values()])).not.toContain(
      key.token.split('.')[1],
    );
    expect(JSON.stringify(await f.credentials.list('a', 'keys'))).not.toContain(
      'secretHash',
    );
    await expect(f.credentials.revoke('b', key.id, 'keys')).rejects.toThrow();
    await f.credentials.revoke('a', key.id, 'keys');
    await expect(f.credentials.authenticate(key.token)).rejects.toThrow();
    f.flags.assertFeatureAvailable.mockRejectedValue(
      new Error('flag disabled'),
    );
    await expect(
      f.credentials.createKey('a', { scopes: ['jobs:write'] }),
    ).rejects.toThrow();
  });
  it('rejects unknown scopes, forged fields and bounds concurrent key creation', async () => {
    const f = fixture();
    await expect(
      f.credentials.createKey('a', { scopes: ['admin'] }),
    ).rejects.toThrow();
    await expect(
      f.credentials.createKey('a', { scopes: ['jobs:read'], accountId: 'b' }),
    ).rejects.toThrow();
    const result = await Promise.allSettled(
      Array.from({ length: 11 }, () =>
        f.credentials.createKey('a', { scopes: ['jobs:read'] }),
      ),
    );
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
  });
  it('auth guard denies missing write scope and accepts read scope', async () => {
    const f = fixture();
    const key = await f.credentials.createKey('a', { scopes: ['jobs:read'] });
    const req = { headers: { authorization: `Bearer ${key.token}` } };
    const guard = new ApiKeyGuard(f.credentials, new Reflector());
    const context = (method: string) =>
      ({
        switchToHttp: () => ({ getRequest: () => req }),
        getHandler: () => PublicApiJobsController.prototype[method],
        getClass: () => PublicApiJobsController,
      }) as any;
    await expect(guard.canActivate(context('create'))).rejects.toThrow(
      'API scope required',
    );
    expect(await guard.canActivate(context('status'))).toBe(true);
  });
  it('requires configured encryption, binds ciphertext to context and reveals callback secret once', async () => {
    expect(() =>
      new PublicApiCrypto({ get: () => undefined } as any).seal('secret', 'a'),
    ).toThrow();
    const f = fixture();
    const cb = await f.credentials.createCallback('a', {
      url: 'https://callbacks.example.test/hook',
    });
    const stored = f.db.rows.get(`api_callback_endpoints/${cb.id}`);
    expect(JSON.stringify(stored)).not.toContain(cb.signingSecret);
    expect(f.crypto.open(stored.secret, `a:${cb.id}`)).toBe(cb.signingSecret);
    expect(() => f.crypto.open(stored.secret, `b:${cb.id}`)).toThrow();
    expect(
      JSON.stringify(await f.credentials.list('a', 'callbacks')),
    ).not.toContain('ciphertext');
  });
});

describe('durable API jobs', () => {
  it('concurrent instances share one deterministic operation and conflicting payload fails', async () => {
    const f = fixture();
    const [a, b] = await Promise.all([
      f.jobs.create('a', 'intent-1', input()),
      f.jobs.create('a', 'intent-1', {
        labelSize: '4x6',
        zplContent: input().zplContent,
      }),
    ]);
    expect(a.id).toBe(b.id);
    expect(a.status).toBe('queued');
    expect(f.converter.run).not.toHaveBeenCalled();
    await expect(
      f.jobs.create('a', 'intent-1', {
        ...input(),
        zplContent: '^XA^FDdifferent^FS^XZ',
      }),
    ).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
    expect(
      [...f.db.rows.keys()].filter((path) => path.startsWith('api_jobs/')),
    ).toHaveLength(1);
    expect(JSON.stringify([...f.db.rows.values()])).not.toContain('synthetic');
    await Promise.all([f.jobs.processJob(a.id), f.jobs.processJob(a.id)]);
    expect(f.converter.run).toHaveBeenCalledTimes(1);
    expect((await f.jobs.status('a', a.id)).status).toBe('succeeded');
    expect(f.events.recordServerEvent).toHaveBeenCalledTimes(1);
  });
  it('does not fabricate success from acceptance and recovers crashed lease with same operation ID', async () => {
    const f = fixture();
    const job = await f.jobs.create('a', 'recovery', input());
    const path = `api_jobs/${job.id}`;
    f.db.apply(
      path,
      {
        status: 'running',
        leaseToken: 'dead-worker',
        availableAt: new Date(Date.now() + 60000).toISOString(),
      },
      true,
    );
    await f.jobs.processJob(job.id);
    expect(f.converter.run).not.toHaveBeenCalled();
    jest.setSystemTime(Date.now() + 60001);
    await f.jobs.processJob(job.id);
    expect(f.converter.run.mock.calls[0][0].operationId).toBe(job.id);
    const pending = await f.jobs.create('a', 'accepted', input());
    f.converter.run.mockResolvedValue({ jobId: pending.id, status: 'pending' });
    await f.jobs.processJob(pending.id);
    expect((await f.jobs.status('a', pending.id)).status).toBe('queued');
  });
  it('fences stale workers and retries durable completed result after final transaction failure', async () => {
    const f = fixture();
    const job = await f.jobs.create('a', 'crash-after-render', input());
    f.events.recordServerEvent.mockRejectedValueOnce(
      new Error('db unavailable'),
    );
    await f.jobs.processJob(job.id);
    expect((await f.jobs.status('a', job.id)).status).toBe('queued');
    jest.setSystemTime(Date.now() + 3000);
    await f.jobs.processJob(job.id);
    expect(
      f.converter.run.mock.calls.map((call) => call[0].operationId),
    ).toEqual([job.id, job.id]);
    expect((await f.jobs.status('a', job.id)).status).toBe('succeeded');
  });
  it('enforces ownership, state transitions, cancellation, and bounded automatic retries', async () => {
    const f = fixture();
    const job = await f.jobs.create('a', 'cancel', input());
    await expect(f.jobs.status('b', job.id)).rejects.toThrow();
    await expect(f.jobs.result('a', job.id)).rejects.toThrow();
    await f.jobs.cancel('a', job.id);
    await f.jobs.processJob(job.id);
    expect(f.converter.run).not.toHaveBeenCalled();
    const retry = await f.jobs.create('a', 'fail', input());
    f.converter.run.mockRejectedValue(
      new Error('network secret must not leak'),
    );
    for (let i = 0; i < 8; i++) {
      await f.jobs.processJob(retry.id);
      jest.setSystemTime(Date.now() + 3600001);
    }
    expect((await f.jobs.status('a', retry.id)).status).toBe('failed');
    expect(JSON.stringify([...f.db.rows.values()])).not.toContain(
      'network secret',
    );
    await f.jobs.retry('a', retry.id);
    expect((await f.jobs.status('a', retry.id)).status).toBe('queued');
  });
  it('rejects forged owner and incompatible input sources', async () => {
    const f = fixture();
    for (const body of [
      { ...input(), accountId: 'b' },
      { ...input(), templateId: randomUUID() },
      { ...input(), labelSize: 'random' },
    ])
      await expect(f.jobs.create('a', 'bad', body)).rejects.toThrow();
  });
});

describe('JSON template jobs', () => {
  function templateFixture(f: ReturnType<typeof fixture>) {
    const id = randomUUID();
    f.db.rows.set(`label_templates/${id}`, {
      id,
      ownerId: 'a',
      accountId: 'a',
      status: 'active',
    });
    f.db.rows.set(`label_template_versions/${id}:1`, {
      templateId: id,
      ownerId: 'a',
      accountId: 'a',
      versionNumber: 1,
      labelSize: '4x6',
      fields: [
        { key: 'code', label: 'Code', type: 'code', required: true },
        { key: 'text', label: 'Text', type: 'text', required: true },
      ],
      zplTemplate: '^XA^FO20,20^FD{{code}}^FS^FO20,60^FD{{text}}^FS^XZ',
    });
    return {
      templateId: id,
      templateVersion: 1,
      labelSize: '4x6',
      rows: [{ code: '00123', text: '^XZ^XA~JA' }],
    };
  }
  it('renders owned immutable version using shared escaping and preserves encrypted snapshot after archival', async () => {
    const f = fixture();
    const source = templateFixture(f);
    const job = await f.jobs.create('a', 'template', source);
    f.db.rows.get(`label_templates/${source.templateId}`).status = 'archived';
    expect((await f.jobs.create('a', 'template', source)).id).toBe(job.id);
    await f.jobs.processJob(job.id);
    const zpl = f.converter.run.mock.calls[0][0].zplContent;
    expect(zpl).toContain('00123');
    expect(zpl).not.toContain('^XZ^XA~JA');
    expect(zpl).toContain('_5EXZ');
    expect((await f.jobs.status('a', job.id)).status).toBe('succeeded');
  });
  it('rejects foreign version, mismatched size and ambiguous numeric identifiers', async () => {
    const f = fixture();
    const source = templateFixture(f);
    await expect(f.jobs.create('b', 'foreign', source)).rejects.toThrow();
    await expect(
      f.jobs.create('a', 'size', { ...source, labelSize: '2x1' }),
    ).rejects.toThrow();
    await expect(
      f.jobs.create('a', 'number', {
        ...source,
        rows: [{ code: 123, text: 'x' }],
      }),
    ).rejects.toThrow();
    await expect(
      f.jobs.create('a', 'version', { ...source, templateVersion: 2 }),
    ).rejects.toThrow();
  });
});

describe('callback delivery', () => {
  it('signs exact payload, retries with stable event ID, and stores no raw error', async () => {
    const f = fixture();
    const cb = await f.credentials.createCallback('a', {
      url: 'https://callbacks.example.test/hook',
    });
    const job = await f.jobs.create('a', 'callback', {
      ...input(),
      callbackId: cb.id,
    });
    await f.jobs.processJob(job.id);
    f.transport.send.mockRejectedValueOnce(new Error('secret server response'));
    expect(await f.callbacks.dispatchCallbacks()).toMatchObject({
      delivered: 0,
    });
    jest.setSystemTime(Date.now() + 3000);
    expect(await f.callbacks.dispatchCallbacks()).toMatchObject({
      delivered: 1,
    });
    const first = f.transport.send.mock.calls[0],
      second = f.transport.send.mock.calls[1];
    expect(first[1]).toBe(second[1]);
    expect(first[2]['X-ZPLPDF-Event-Id']).toBe(second[2]['X-ZPLPDF-Event-Id']);
    expect(second[2]['X-ZPLPDF-Signature']).toBe(
      callbackSignature(
        cb.signingSecret,
        second[2]['X-ZPLPDF-Timestamp'],
        second[1],
      ),
    );
    expect(second[1]).not.toContain('zplContent');
    expect(JSON.stringify([...f.db.rows.values()])).not.toContain(
      'secret server response',
    );
    expect(await f.callbacks.dispatchCallbacks()).toMatchObject({ scanned: 0 });
  });
  it('bounds callback retries and exposes exhausted delivery without secrets', async () => {
    const f = fixture();
    const cb = await f.credentials.createCallback('a', {
      url: 'https://callbacks.example.test/hook',
    });
    const job = await f.jobs.create('a', 'dead-callback', {
      ...input(),
      callbackId: cb.id,
    });
    await f.jobs.processJob(job.id);
    f.transport.send.mockRejectedValue(new Error('unavailable'));
    for (let i = 0; i < 8; i++) {
      await f.callbacks.dispatchCallbacks();
      jest.setSystemTime(Date.now() + 3600001);
    }
    expect(f.transport.send).toHaveBeenCalledTimes(8);
    expect(await f.callbacks.dispatchCallbacks()).toMatchObject({ scanned: 0 });
    const result = await f.callbacks.deliveries('a', cb.id);
    expect(result.items[0]).toMatchObject({
      state: 'dead',
      attempts: 8,
      lastErrorCode: 'CALLBACK_DELIVERY_FAILED',
    });
    expect(JSON.stringify(result)).not.toContain(cb.signingSecret);
  });
  it('revocation blocks pending delivery and foreign callbacks cannot be attached', async () => {
    const f = fixture();
    const cb = await f.credentials.createCallback('a', {
      url: 'https://callbacks.example.test/hook',
    });
    await expect(
      f.jobs.create('b', 'foreign', { ...input(), callbackId: cb.id }),
    ).rejects.toThrow();
    const job = await f.jobs.create('a', 'revoked', {
      ...input(),
      callbackId: cb.id,
    });
    await f.jobs.processJob(job.id);
    await f.credentials.revoke('a', cb.id, 'callbacks');
    await f.callbacks.dispatchCallbacks();
    expect(f.transport.send).not.toHaveBeenCalled();
  });
  it('recovers an expired callback lease and ignores stale ack after lease replacement', async () => {
    const f = fixture();
    const cb = await f.credentials.createCallback('a', {
      url: 'https://callbacks.example.test/hook',
    });
    const job = await f.jobs.create('a', 'lease', {
      ...input(),
      callbackId: cb.id,
    });
    await f.jobs.processJob(job.id);
    const path = [...f.db.rows.keys()].find((k) =>
      k.startsWith('api_callback_deliveries/'),
    );
    f.db.apply(
      path,
      {
        state: 'leased',
        token: 'dead',
        availableAt: new Date(Date.now() - 1).toISOString(),
      },
      true,
    );
    f.transport.send.mockImplementation(async () => {
      f.db.apply(path, { token: 'new-owner' }, true);
    });
    expect(await f.callbacks.dispatchCallbacks()).toMatchObject({
      delivered: 0,
    });
    expect(f.db.rows.get(path).state).toBe('leased');
  });
});

describe('Firebase management actions', () => {
  it('retries only owned dead unexpired callbacks with a stable event identity', async () => {
    const f = fixture();
    const cb = await f.credentials.createCallback('a', {
      url: 'https://callbacks.example.test/hook',
    });
    const id = randomUUID();
    const path = `api_callback_deliveries/${id}`;
    f.db.apply(path, {
      accountId: 'a',
      callbackId: cb.id,
      state: 'dead',
      attempts: 8,
      payload: { eventId: id },
      expiresAt: Timestamp.fromMillis(Date.now() + 60000),
    });
    await expect(
      f.callbacks.retryDeadDelivery('b', cb.id, id),
    ).rejects.toThrow();
    expect(await f.callbacks.retryDeadDelivery('a', cb.id, id)).toEqual({
      id,
      state: 'pending',
    });
    expect(f.db.rows.get(path)).toMatchObject({
      attempts: 0,
      payload: { eventId: id },
    });
    await expect(f.callbacks.retryDeadDelivery('a', cb.id, id)).rejects.toThrow(
      'Only dead',
    );
    f.db.apply(
      path,
      { state: 'dead', expiresAt: Timestamp.fromMillis(Date.now() - 1) },
      true,
    );
    await expect(f.callbacks.retryDeadDelivery('a', cb.id, id)).rejects.toThrow(
      'expired',
    );
    f.db.apply(
      path,
      { expiresAt: Timestamp.fromMillis(Date.now() + 60000) },
      true,
    );
    await f.credentials.revoke('a', cb.id, 'callbacks');
    await expect(f.callbacks.retryDeadDelivery('a', cb.id, id)).rejects.toThrow(
      'Callback unavailable',
    );
    expect(f.transport.send).not.toHaveBeenCalled();
  });
  it('returns pending capacity separately from billing quota and denies invalid pagination', async () => {
    const f = fixture();
    expect(await f.jobs.usage('a')).toMatchObject({
      pendingJobs: 0,
      maxPendingJobs: 20,
    });
    await f.jobs.create('a', 'capacity', input());
    expect(await f.jobs.usage('a')).toMatchObject({ pendingJobs: 1 });
    expect(await f.jobs.usage('b')).toMatchObject({ pendingJobs: 0 });
    await expect(f.jobs.list('a', undefined, 101)).rejects.toThrow(
      'Invalid page limit',
    );
    await expect(f.jobs.list('a', '../foreign')).rejects.toThrow(
      'Invalid cursor',
    );
  });
});

describe('SSRF and IP pinning', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '100.64.0.1',
    '192.168.1.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    'fe80::1',
    'fc00::1',
    '2001:db8::1',
    '2002:7f00:1::',
  ])('blocks non-public IP %s', (ip) =>
    expect(isPublicAddress(ip)).toBe(false),
  );
  it.each([
    'http://example.test',
    'https://localhost',
    'https://2130706433',
    'https://[::1]',
    'https://user:pass@example.test',
    'https://example.test:8443',
    'https://example.test/?secret=a',
  ])('rejects unsafe URL %s', (url) =>
    expect(() => callbackUrl(url)).toThrow(),
  );
  it('rejects mixed public/private DNS results', async () => {
    (lookup as jest.Mock).mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]);
    await expect(
      new CallbackTransport().resolve('https://example.test/hook'),
    ).rejects.toThrow();
  });
  it('pins vetted IP, preserves TLS hostname, and never follows redirects', async () => {
    (lookup as jest.Mock).mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
    ]);
    let options: any;
    let requestedUrl: URL;
    (httpsRequest as jest.Mock).mockImplementation((url, opts, handler) => {
      requestedUrl = url;
      options = opts;
      const req = new EventEmitter() as any;
      req.end = () => {
        const res = new EventEmitter() as any;
        res.statusCode = 302;
        handler(res);
        res.emit('end');
        req.emit('close');
      };
      req.destroy = (error) => req.emit('error', error);
      return req;
    });
    await expect(
      new CallbackTransport().send('https://example.test/hook', '{}', {}),
    ).rejects.toThrow('CALLBACK_HTTP_REJECTED');
    expect(requestedUrl.hostname).toBe('example.test');
    const resolved = jest.fn();
    options.lookup('attacker.changed', { all: true }, resolved);
    expect(resolved).toHaveBeenCalledWith(null, [
      { address: '8.8.8.8', family: 4 },
    ]);
    expect(httpsRequest).toHaveBeenCalledTimes(1);
  });
});

describe('bounded callback transport', () => {
  it('rejects excessive responses', async () => {
    (lookup as jest.Mock).mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
    ]);
    (httpsRequest as jest.Mock).mockImplementation((_url, _opts, handler) => {
      const req = new EventEmitter() as any;
      req.destroy = (error) => {
        req.emit('error', error);
        req.emit('close');
      };
      req.end = () => {
        const res = new EventEmitter() as any;
        res.statusCode = 200;
        handler(res);
        res.emit('data', Buffer.alloc(65537));
      };
      return req;
    });
    await expect(
      new CallbackTransport().send('https://example.test/hook', '{}', {}),
    ).rejects.toThrow('CALLBACK_RESPONSE_TOO_LARGE');
  });
  it('bounds socket time and revalidates DNS on every new delivery', async () => {
    (lookup as jest.Mock).mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
    ]);
    (httpsRequest as jest.Mock).mockImplementation(() => {
      const req = new EventEmitter() as any;
      req.end = () => undefined;
      req.destroy = (error) => {
        req.emit('error', error);
        req.emit('close');
      };
      return req;
    });
    const pending = new CallbackTransport().send(
      'https://example.test/hook',
      '{}',
      {},
    );
    const assertion = expect(pending).rejects.toThrow('CALLBACK_TIMEOUT');
    await jest.advanceTimersByTimeAsync(5001);
    await assertion;
    (lookup as jest.Mock).mockResolvedValue([
      { address: '169.254.169.254', family: 4 },
    ]);
    await expect(
      new CallbackTransport().send('https://example.test/hook', '{}', {}),
    ).rejects.toThrow('Callback address not allowed');
    expect(httpsRequest).toHaveBeenCalledTimes(1);
  });
  it('bounds DNS lookup time', async () => {
    (lookup as jest.Mock).mockImplementation(
      () => new Promise(() => undefined),
    );
    const pending = new CallbackTransport().resolve(
      'https://example.test/hook',
    );
    const assertion = expect(pending).rejects.toThrow('DNS_TIMEOUT');
    await jest.advanceTimersByTimeAsync(2001);
    await assertion;
  });
});

describe('conversion adapter', () => {
  it('uses public durable converter and validates actual completion through result ownership', async () => {
    const db = new MemoryDb();
    const zpl = {
      runDurableConversion: jest
        .fn()
        .mockResolvedValue({ jobId: 'stable', status: 'completed' }),
      generateSignedUrl: jest
        .fn()
        .mockResolvedValue('https://storage.test/signed'),
    };
    const validator = {
      validate: jest.fn().mockResolvedValue({ isValid: true }),
    };
    const adapter = new ApiConversionAdapter(
      zpl as any,
      validator as any,
      { getClient: () => db } as any,
    );
    const id = operationUuid('test');
    await adapter.run({ operationId: id, accountId: 'a', ...input() });
    expect(zpl.runDurableConversion).toHaveBeenCalledWith({
      operationId: id,
      userId: 'a',
      ...input(),
    });
    await expect(adapter.result(id, 'a')).rejects.toThrow();
    db.rows.set(`durable_operations/${id}`, {
      status: 'completed',
      userId: 'a',
      storagePath: 'result.pdf',
    });
    await expect(adapter.result(id, 'b')).rejects.toThrow();
    expect(await adapter.result(id, 'a')).toMatchObject({
      url: 'https://storage.test/signed',
    });
  });
});

describe('explicit synthetic API example execution', () => {
  it('renders with normal conversion boundary while marking events and callbacks synthetic', async () => {
    const f = fixture();
    const callback = await f.credentials.createCallback('a', {
      url: 'https://callbacks.example.test/hook',
    });
    const job = await f.jobs.create('a', 'test-example', {
      ...input(),
      testMode: true,
      callbackId: callback.id,
    });
    await f.jobs.processJob(job.id);
    expect(f.converter.run).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: job.id, accountId: 'a' }),
    );
    expect(await f.jobs.status('a', job.id)).toMatchObject({
      status: 'succeeded',
      testMode: true,
    });
    expect(f.events.recordServerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        isSynthetic: true,
        eventName: 'api_job_succeeded',
      }),
      expect.anything(),
    );
    const delivery = [...f.db.rows.entries()].find(([key]) =>
      key.startsWith('api_callback_deliveries/'),
    )?.[1];
    expect(delivery.payload.testMode).toBe(true);
    await expect(
      f.jobs.create('a', 'test-example', {
        ...input(),
        testMode: false,
        callbackId: callback.id,
      }),
    ).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
    await expect(
      f.jobs.create('a', 'invalid-test', { ...input(), testMode: 'true' }),
    ).rejects.toThrow('Invalid test mode');
  });
});

describe('job mutation deletion races', () => {
  it.each(['cancel', 'retry'] as const)(
    'does not %s or recreate quota metadata after an account tombstone',
    async (action) => {
      const f = fixture();
      const job = await f.jobs.create('a', `deletion-${action}`, input());
      const row = f.db.rows.get(`api_jobs/${job.id}`);
      if (action === 'retry') row.status = 'failed';
      // Authentication/feature checks completed before deletion won the race.
      f.db.rows.set('deleted_accounts/a', { deletedAt: Timestamp.now() });
      const before = JSON.stringify([...f.db.rows.entries()]);
      await expect(f.jobs[action]('a', job.id)).rejects.toThrow(
        'Account unavailable',
      );
      expect(JSON.stringify([...f.db.rows.entries()])).toBe(before);
    },
  );
});

describe('API worker account deletion fencing', () => {
  it('cannot recreate counters or callbacks when deletion wins during rendering', async () => {
    const f = fixture();
    const cb = await f.credentials.createCallback('a', {
      url: 'https://example.com/callback',
    });
    const job = await f.jobs.create('a', 'deletion-during-render', {
      ...input(),
      callbackId: cb.id,
    });
    let atDeletion: string;
    f.converter.run.mockImplementationOnce(async (request) => {
      f.db.rows.set('deleted_accounts/a', { deletedAt: Timestamp.now() });
      for (const key of f.db.rows.keys())
        if (key.startsWith('api_account_limits/')) f.db.rows.delete(key);
      atDeletion = JSON.stringify([...f.db.rows.entries()]);
      return { jobId: request.operationId, status: 'completed' };
    });
    await f.jobs.processJob(job.id);
    expect(JSON.stringify([...f.db.rows.entries()])).toBe(atDeletion);
    expect(f.events.recordServerEvent).not.toHaveBeenCalled();
  });
});
