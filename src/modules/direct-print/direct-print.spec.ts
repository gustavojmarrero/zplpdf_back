import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Timestamp } from '@google-cloud/firestore';
import { PDFDocument } from 'pdf-lib';
import axios from 'axios';
import { DirectPrintService } from './direct-print.service.js';
import { DirectPrintController } from './direct-print.controller.js';
import { PrintNodeProvider, PrintProviderError } from './printnode.provider.js';
import { OwnedPdfService } from './owned-pdf.service.js';
import { PublicApiCrypto } from '../public-api/public-api.crypto.js';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';
import { MemoryDb } from '../folder-automation/testing/memory-db.js';
jest.mock('axios');
async function fixture() {
  const db = new MemoryDb(),
    account = 'owner',
    conversionId = randomUUID();
  const config = {
    get: (key: string) =>
      key === 'PUBLIC_API_ENCRYPTION_KEY'
        ? Buffer.alloc(32, 4).toString('base64')
        : undefined,
  };
  const crypto = new PublicApiCrypto(config as any);
  const flags = {
    account: jest.fn().mockResolvedValue({ plan: 'pro' }),
    assertFeatureAvailable: jest
      .fn()
      .mockResolvedValue({ featureVersion: '1' }),
  };
  const events = {
    recordServerEvent: jest.fn().mockImplementation(async (input, tx) => {
      tx.create(db.collection('events').doc(input.eventId), input);
    }),
  };
  const printer = {
    id: 42,
    name: 'Thermal printer',
    state: 'online',
    computer: { id: 1, state: 'connected' },
  };
  const provider = {
    printers: jest.fn().mockResolvedValue([printer]),
    printer: jest.fn().mockResolvedValue(printer),
    submit: jest.fn().mockResolvedValue(1234),
    states: jest.fn().mockResolvedValue([
      {
        printJobId: 1234,
        state: 'done',
        createTimestamp: new Date().toISOString(),
      },
    ]),
  };
  const doc = await PDFDocument.create();
  doc.addPage();
  const bytes = Buffer.from(await doc.save());
  const storage = { readFile: jest.fn().mockResolvedValue(bytes) };
  const store = {
    getClient: () => db,
    getConversionStatus: jest.fn().mockResolvedValue(null),
  };
  db.rows.set(`durable_operations/${conversionId}`, {
    userId: account,
    status: 'completed',
    outputFormat: 'pdf',
    storagePath: 'owned.pdf',
  });
  const pdf = new OwnedPdfService(store as any, storage as any, config as any);
  const service = new DirectPrintService(
    store as any,
    flags as any,
    events as any,
    crypto,
    provider as any,
    pdf,
  );
  async function setup() {
    const connection = await service.connect(account, {
      apiKey: 'provider-key-12345678901234567890',
    });
    return { connectionId: connection.id, printerId: 42, conversionId };
  }
  async function job() {
    const input = await setup();
    return service.create(account, 'operation', input);
  }
  const due = (id: string) => {
    db.rows.get(`print_jobs/${id}`).availableAt = new Date(0).toISOString();
  };
  return {
    db,
    account,
    conversionId,
    crypto,
    flags,
    events,
    provider,
    bytes,
    storage,
    store,
    pdf,
    service,
    setup,
    job,
    due,
  };
}
describe('Direct print safety and durable state', () => {
  test('Firebase auth guard protects all endpoints and controllers derive owner from UID', () => {
    expect(Reflect.getMetadata('__guards__', DirectPrintController)).toContain(
      FirebaseAuthGuard,
    );
    const service = { create: jest.fn() };
    new DirectPrintController(service as any).create(
      { user: { uid: 'owner' } },
      'key',
      { conversionId: 'id' },
    );
    expect(service.create).toHaveBeenCalledWith('owner', 'key', {
      conversionId: 'id',
    });
  });
  test('provider keys are encrypted, never exposed, flags and ownership fail closed', async () => {
    const f = await fixture(),
      input = await f.setup();
    expect(
      JSON.stringify(await f.service.connections(f.account)),
    ).not.toContain('provider-key');
    expect(
      JSON.stringify(f.db.rows.get(`print_connections/${input.connectionId}`)),
    ).not.toContain('provider-key');
    await expect(
      f.service.printers('other', input.connectionId),
    ).rejects.toThrow();
    f.flags.assertFeatureAvailable.mockRejectedValue(new Error('disabled'));
    await expect(f.service.create(f.account, 'key', input)).rejects.toThrow(
      'disabled',
    );
    expect(f.provider.submit).not.toHaveBeenCalled();
  });
  test('concurrent equivalent intent accepts one job across instances; key/payload conflicts reject', async () => {
    const f = await fixture(),
      input = await f.setup();
    const second = new DirectPrintService(
      f.store as any,
      f.flags as any,
      f.events as any,
      f.crypto,
      f.provider as any,
      f.pdf,
    );
    const jobs = await Promise.all([
      f.service.create(f.account, 'same', input),
      second.create(f.account, 'same', input),
    ]);
    expect(jobs[0].id).toBe(jobs[1].id);
    expect(
      [...f.db.rows.keys()].filter((p) => p.startsWith('print_jobs/')),
    ).toHaveLength(1);
    await expect(
      f.service.create(f.account, 'same', { ...input, printerId: 99 }),
    ).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
    expect(f.provider.submit).not.toHaveBeenCalled();
    expect(f.events.recordServerEvent).not.toHaveBeenCalled();
  });
  test('owned completed PDF required; arbitrary URLs, other owner, incomplete job and source expiry rejected', async () => {
    const f = await fixture(),
      input = await f.setup();
    await expect(
      f.service.create(f.account, 'url', {
        ...input,
        url: 'http://127.0.0.1/private',
      }),
    ).rejects.toThrow();
    f.db.rows.get(`durable_operations/${f.conversionId}`).userId = 'other';
    await expect(f.service.create(f.account, 'wrong', input)).rejects.toThrow(
      'Owned PDF',
    );
    f.db.rows.get(`durable_operations/${f.conversionId}`).userId = f.account;
    f.db.rows.get(`durable_operations/${f.conversionId}`).status = 'processing';
    await expect(
      f.service.create(f.account, 'notdone', input),
    ).rejects.toThrow();
    f.db.rows.get(`durable_operations/${f.conversionId}`).status = 'completed';
    f.storage.readFile.mockResolvedValue(null);
    await expect(f.service.create(f.account, 'expired', input)).rejects.toThrow(
      'expired',
    );
  });
  test('provider printer ownership checked at acceptance and again before sending', async () => {
    const f = await fixture(),
      job = await f.job();
    f.provider.printer.mockRejectedValueOnce(new PrintProviderError(404));
    await f.service.dispatchOne(job.id);
    expect(f.provider.submit).not.toHaveBeenCalled();
    expect((await f.service.status(f.account, job.id)).status).toBe('failed');
    expect(f.provider.printer).toHaveBeenCalledTimes(2);
  });
  test('concurrent dispatch sends once, durable provider id polls ACK and never claims physical printing', async () => {
    const f = await fixture(),
      job = await f.job();
    await Promise.all([
      f.service.dispatchOne(job.id),
      f.service.dispatchOne(job.id),
    ]);
    expect(f.provider.submit).toHaveBeenCalledTimes(1);
    let state = await f.service.status(f.account, job.id);
    expect(state).toMatchObject({
      status: 'sent',
      providerJobId: 1234,
      clientFreshness: 'recent',
    });
    expect(f.events.recordServerEvent).not.toHaveBeenCalled();
    f.due(job.id);
    await f.service.dispatchOne(job.id);
    state = await f.service.status(f.account, job.id);
    expect(state.status).toBe('acknowledged');
    expect(state.physicalConfirmation).toBeUndefined();
    expect(f.events.recordServerEvent.mock.calls[0][0].eventName).toBe(
      'print_job_acknowledged',
    );
    await expect(
      f.service.confirm(f.account, job.id, { printed: true, stateVersion: 1 }),
    ).rejects.toThrow('STATE_VERSION_CHANGED');
    await f.service.confirm(f.account, job.id, {
      printed: true,
      stateVersion: state.stateVersion,
    });
    expect(
      (await f.service.status(f.account, job.id)).physicalConfirmation.method,
    ).toBe('manual');
    expect(f.events.recordServerEvent.mock.calls[1][0].eventName).toBe(
      'print_confirmed',
    );
  });
  test('transport timeout is unknown without any automatic resend; reprint requires explicit new intent and CAS', async () => {
    const f = await fixture(),
      job = await f.job();
    f.provider.submit.mockRejectedValueOnce(new PrintProviderError());
    await f.service.dispatchOne(job.id);
    const unknown = await f.service.status(f.account, job.id);
    expect(unknown.status).toBe('unknown');
    await f.service.dispatchJobs();
    await f.service.dispatchOne(job.id);
    expect(f.provider.submit).toHaveBeenCalledTimes(1);
    await expect(
      f.service.reprint(f.account, job.id, 'reprint', {
        confirm: false,
        stateVersion: unknown.stateVersion,
      }),
    ).rejects.toThrow();
    await expect(
      f.service.reprint(f.account, job.id, 'reprint', {
        confirm: true,
        stateVersion: 1,
      }),
    ).rejects.toThrow('STATE_VERSION_CHANGED');
    const next = await f.service.reprint(f.account, job.id, 'reprint', {
      confirm: true,
      stateVersion: unknown.stateVersion,
    });
    expect(next).toMatchObject({ reprintOf: job.id, status: 'queued' });
    expect(next.id).not.toBe(job.id);
    await f.service.dispatchOne(next.id);
    expect(f.provider.submit).toHaveBeenCalledTimes(2);
  });
  test.each([409, 429, 503, 408])(
    'ambiguous provider HTTP %s stays unknown',
    async (status) => {
      const f = await fixture(),
        job = await f.job();
      f.provider.submit.mockRejectedValue(new PrintProviderError(status));
      await f.service.dispatchOne(job.id);
      expect((await f.service.status(f.account, job.id)).status).toBe(
        'unknown',
      );
      expect(f.events.recordServerEvent).not.toHaveBeenCalled();
    },
  );
  test('definite rejection fails; stale client status does not become physical result', async () => {
    const f = await fixture(),
      job = await f.job();
    f.provider.submit.mockRejectedValue(new PrintProviderError(400));
    await f.service.dispatchOne(job.id);
    f.db.rows.get(`print_jobs/${job.id}`).clientObservation.observedAt =
      new Date(0).toISOString();
    expect(await f.service.status(f.account, job.id)).toMatchObject({
      status: 'failed',
      clientFreshness: 'stale',
    });
    expect(f.events.recordServerEvent).not.toHaveBeenCalled();
  });
  test('crash after network before durable receipt becomes unknown on lease recovery, without resend', async () => {
    const f = await fixture(),
      job = await f.job();
    let fail = true;
    f.provider.submit.mockImplementationOnce(async () => {
      f.db.beforeCommit = () => {
        if (fail) {
          fail = false;
          throw new Error('db unavailable');
        }
      };
      return 1234;
    });
    await expect(f.service.dispatchOne(job.id)).rejects.toThrow(
      'db unavailable',
    );
    expect(
      f.db.rows.get(`print_jobs/${job.id}`).dispatchStartedAt,
    ).toBeDefined();
    f.due(job.id);
    await f.service.dispatchOne(job.id);
    expect((await f.service.status(f.account, job.id)).status).toBe('unknown');
    expect(f.provider.submit).toHaveBeenCalledTimes(1);
  });
  test('revocation race, account deletion and job expiry prevent sends', async () => {
    const f = await fixture(),
      job = await f.job();
    await f.service.disconnect(f.account, job.connectionId);
    await f.service.dispatchOne(job.id);
    expect((await f.service.status(f.account, job.id)).status).toBe('failed');
    const g = await fixture(),
      other = await g.job();
    g.db.rows.set(`deleted_accounts/${g.account}`, {});
    await expect(g.service.dispatchOne(other.id)).rejects.toThrow(
      'Account unavailable',
    );
    expect(g.provider.submit).not.toHaveBeenCalled();
    const h = await fixture(),
      expired = await h.job();
    h.db.rows.get(`print_jobs/${expired.id}`).expiresAt =
      Timestamp.fromMillis(0);
    await h.service.dispatchOne(expired.id);
    expect((await h.service.status(h.account, expired.id)).status).toBe(
      'failed',
    );
    expect(h.provider.submit).not.toHaveBeenCalled();
  });
  test('lost lease before network send is fenced', async () => {
    const f = await fixture(),
      job = await f.job();
    f.provider.printer.mockImplementationOnce(async () => {
      f.db.rows.get(`print_jobs/${job.id}`).leaseToken = 'new-worker';
      return { id: 42 };
    });
    await f.service.dispatchOne(job.id);
    expect(f.provider.submit).not.toHaveBeenCalled();
  });
  test('ACK and outbox are atomic on write failure, reconciliation retries only reads', async () => {
    const f = await fixture(),
      job = await f.job();
    await f.service.dispatchOne(job.id);
    f.due(job.id);
    f.events.recordServerEvent.mockRejectedValueOnce(new Error('event outage'));
    await expect(f.service.dispatchOne(job.id)).rejects.toThrow('event outage');
    expect((await f.service.status(f.account, job.id)).status).toBe('sent');
    expect(
      [...f.db.rows.keys()].filter((k) => k.startsWith('events/')),
    ).toHaveLength(0);
    f.due(job.id);
    await f.service.dispatchOne(job.id);
    expect((await f.service.status(f.account, job.id)).status).toBe(
      'acknowledged',
    );
    expect(f.provider.submit).toHaveBeenCalledTimes(1);
  });
  test('poll errors are bounded, never resubmit, jobs list and confirm enforce owner', async () => {
    const f = await fixture(),
      job = await f.job();
    await f.service.dispatchOne(job.id);
    f.provider.states.mockRejectedValue(new PrintProviderError());
    f.db.rows.get(`print_jobs/${job.id}`).pollAttempts = 119;
    f.due(job.id);
    await f.service.dispatchOne(job.id);
    expect((await f.service.status(f.account, job.id)).status).toBe('unknown');
    expect(f.db.rows.get(`print_jobs/${job.id}`).availableAt).toBeUndefined();
    expect(await f.service.jobs('other')).toEqual({ items: [] });
    await expect(f.service.status('other', job.id)).rejects.toThrow();
    await expect(
      f.service.confirm('other', job.id, { printed: true, stateVersion: 2 }),
    ).rejects.toThrow();
    expect(f.provider.submit).toHaveBeenCalledTimes(1);
  });
});
describe('PrintNode transport and owned storage', () => {
  afterEach(() => jest.clearAllMocks());
  test('base64 PDF, documented provider idempotency, Basic auth and bounded fixed endpoint', async () => {
    const p = new PrintNodeProvider();
    (axios.request as jest.Mock).mockResolvedValue({ data: 99 });
    expect(
      await p.submit('secret', 42, Buffer.from('%PDF-'), 'operation'),
    ).toBe(99);
    expect(axios.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.printnode.com/printjobs',
        auth: { username: 'secret', password: '' },
        maxRedirects: 0,
        timeout: 15000,
        proxy: false,
        headers: { 'X-Idempotency-Key': 'operation' },
        data: expect.objectContaining({
          contentType: 'pdf_base64',
          content: Buffer.from('%PDF-').toString('base64'),
          printerId: 42,
          expireAfter: 600,
        }),
      }),
    );
  });
  test('invalid provider response is sanitized, nested state records are scoped by job ID', async () => {
    const p = new PrintNodeProvider();
    (axios.request as jest.Mock).mockResolvedValueOnce({
      data: { error: 'secret' },
    });
    await expect(
      p.submit('secret', 42, Buffer.from('%PDF-'), 'operation'),
    ).rejects.toThrow('PRINT_PROVIDER_REQUEST_FAILED');
    (axios.request as jest.Mock).mockResolvedValueOnce({
      data: [
        [
          { printJobId: 99, state: 'done' },
          { printJobId: 100, state: 'done' },
        ],
      ],
    });
    expect(await p.states('secret', 99)).toEqual([
      { printJobId: 99, state: 'done' },
    ]);
  });
  test('legacy URL cannot select another bucket or private HTTP target; no HTTP fetch occurs', async () => {
    const f = await fixture();
    f.db.rows.delete(`durable_operations/${f.conversionId}`);
    f.store.getConversionStatus.mockResolvedValue({
      userId: f.account,
      status: 'completed',
      outputFormat: 'pdf',
      resultUrl: 'http://127.0.0.1/secret',
    });
    await expect(f.pdf.load(f.account, f.conversionId)).rejects.toThrow(
      'Owned PDF',
    );
    f.store.getConversionStatus.mockResolvedValue({
      userId: f.account,
      status: 'completed',
      outputFormat: 'pdf',
      resultUrl: 'https://storage.googleapis.com/other-bucket/secret',
    });
    await expect(f.pdf.load(f.account, f.conversionId)).rejects.toThrow(
      'Owned PDF',
    );
    expect(f.storage.readFile).not.toHaveBeenCalled();
  });
});
describe('CAS on manual reprint', () => {
  test('two simultaneous distinct reprints consume the original version once; same intent replays', async () => {
    const f = await fixture(),
      job = await f.job();
    f.provider.submit.mockRejectedValueOnce(new PrintProviderError());
    await f.service.dispatchOne(job.id);
    const current = await f.service.status(f.account, job.id),
      body = { confirm: true, stateVersion: current.stateVersion };
    const results = await Promise.allSettled([
      f.service.reprint(f.account, job.id, 'new-a', body),
      f.service.reprint(f.account, job.id, 'new-b', body),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const success = results.find(
      (r) => r.status === 'fulfilled',
    ) as PromiseFulfilledResult<any>;
    const key = results[0].status === 'fulfilled' ? 'new-a' : 'new-b';
    expect((await f.service.reprint(f.account, job.id, key, body)).id).toBe(
      success.value.id,
    );
    expect((await f.service.status(f.account, job.id)).stateVersion).toBe(
      current.stateVersion + 1,
    );
  });
  test('kill switch is rechecked before a queued physical side effect', async () => {
    const f = await fixture(),
      job = await f.job();
    f.flags.assertFeatureAvailable.mockRejectedValue(new Error('disabled'));
    await f.service.dispatchOne(job.id);
    expect(f.provider.submit).not.toHaveBeenCalled();
    expect((await f.service.status(f.account, job.id)).status).toBe('failed');
  });
});
