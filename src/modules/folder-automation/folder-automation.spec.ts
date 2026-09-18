import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { DriveRecipeAdapter } from './drive-recipe.adapter.js';
import { PdfPreparationService } from '../pdf-preparation/pdf-preparation.service.js';
import { TemplateRunsService } from '../label-templates/template-runs.service.js';
import { FirestoreTemplateRepository } from '../label-templates/label-templates.firestore-repository.js';
import { ExcelJsWorkbookReader } from '../label-templates/tabular/exceljs-workbook-reader.js';
import { Timestamp } from '@google-cloud/firestore';
import { PDFDocument } from 'pdf-lib';
import axios from 'axios';
import { FolderAutomationService } from './folder-automation.service.js';
import { FolderAutomationController } from './folder-automation.controller.js';
import {
  GoogleDriveProvider,
  DRIVE_SCOPES,
  DriveProviderError,
} from './google-drive.provider.js';
import { PublicApiCrypto, hash } from '../public-api/public-api.crypto.js';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';
import { MemoryDb } from './testing/memory-db.js';
import {
  enqueueAccountDriveRevocations,
  retryDriveRevocation,
} from './drive-revocation.repository.js';
import { LabelSize } from '../zpl/enums/label-size.enum.js';
import { HttpException, HttpStatus } from '@nestjs/common';
import { ZplService } from '../zpl/zpl.service.js';
import { ZplValidatorService } from '../zpl/validation/zpl-validator.service.js';
jest.mock('axios');
const account = 'owner';
const labelSize = Object.values(LabelSize)[0];
async function fixture(realRecipes = false, realZplParsing = false) {
  const db = new MemoryDb();
  db.rows.set(`users/${account}`, { plan: 'pro' });
  const config = {
    get: (key: string) =>
      ({
        PUBLIC_API_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
        GOOGLE_DRIVE_CLIENT_ID: 'client',
        GOOGLE_DRIVE_CLIENT_SECRET: 'secret',
        GOOGLE_DRIVE_REDIRECT_URI: 'https://example.test/callback',
        GOOGLE_DRIVE_PICKER_APP_ID: '12345',
      })[key],
  };
  const crypto = new PublicApiCrypto(config as any);
  const realProvider = new GoogleDriveProvider(config as any);
  const provider = {
    settings: jest.fn(() => realProvider.settings()),
    authorization: jest.fn((state, challenge) =>
      realProvider.authorization(state, challenge),
    ),
    exchange: jest.fn().mockResolvedValue({
      access_token: 'access',
      refresh_token: 'refresh-secret',
      scope: DRIVE_SCOPES.join(' '),
    }),
    refresh: jest.fn().mockResolvedValue('access'),
    picker: jest.fn().mockResolvedValue({
      accessToken: 'access',
      expiresIn: 3600,
      appId: '12345',
      scopes: DRIVE_SCOPES,
    }),
    revoke: jest.fn().mockResolvedValue(undefined),
    file: jest.fn().mockImplementation(async (_token, id) => ({
      id,
      mimeType: 'application/vnd.google-apps.folder',
      capabilities: { canAddChildren: true, canListChildren: true },
    })),
    startToken: jest.fn().mockResolvedValue('watermark'),
    listFiles: jest.fn().mockResolvedValue({ files: [] }),
    changes: jest
      .fn()
      .mockResolvedValue({ changes: [], newStartPageToken: 'watermark2' }),
    revision: jest
      .fn()
      .mockResolvedValue(Buffer.from('^XA^FO10,10^FDhello^FS^XZ')),
    outputId: jest.fn().mockResolvedValue('allocated-output'),
    upload: jest.fn().mockResolvedValue({ id: 'allocated-output' }),
  };
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
  const document = await PDFDocument.create();
  document.addPage();
  const pdf = Buffer.from(await document.save());
  const files = new Map<string, Buffer>();
  const storage = {
    readFile: jest.fn(async (path: string) => files.get(path) ?? pdf),
    saveFile: jest.fn(async (path: string, bytes: Buffer) => {
      files.set(path, bytes);
    }),
    generateSignedUrlForPath: jest
      .fn()
      .mockResolvedValue('https://synthetic.invalid/private-pdf'),
    deleteFile: jest.fn(async (path: string) => {
      files.delete(path);
    }),
  };
  const zpl = {
    countLabels: realZplParsing
      ? jest.fn((content: string) =>
          (Object.create(ZplService.prototype) as ZplService).countLabels(
            content,
          ),
        )
      : jest.fn().mockResolvedValue({ data: { totalLabels: 1 } }),
    runDurableConversion: jest.fn().mockImplementation(async (input) => {
      db.rows.set(`durable_operations/${input.operationId}`, {
        userId: input.userId,
        status: 'completed',
        storagePath: 'owned.pdf',
        outputFormat: 'pdf',
      });
      return { jobId: input.operationId, status: 'completed' };
    }),
  };
  const realValidator = new ZplValidatorService({
    recordValidation: jest.fn().mockResolvedValue(undefined),
  } as any);
  const validator = {
    validate: realZplParsing
      ? jest.fn((content, options) => realValidator.validate(content, options))
      : jest.fn().mockResolvedValue({ isValid: true }),
  };
  const store = {
    getClient: () => db,
    isAccountDeletionMarked: async (uid: string) =>
      db.rows.has(`deleted_accounts/${uid}`),
  };
  const users = {
    getUserById: jest.fn(async (uid: string) => db.rows.get(`users/${uid}`)),
    getEffectivePlan: () => 'pro',
    getEffectivePlanLimits: () => ({ maxPdfsPerMonth: 1000 }),
    invalidateHistoryScanCache: jest.fn(),
    checkCanConvert: jest.fn().mockResolvedValue({
      allowed: true,
      periodInfo: {
        periodId: 'owner-period',
        periodStart: new Date(),
        periodEnd: new Date(Date.now() + 86400000),
      },
    }),
  };
  const pdfService = new PdfPreparationService(
    store as any,
    storage as any,
    users as any,
    flags as any,
    events as any,
  );
  const tables = new TemplateRunsService(
    new FirestoreTemplateRepository(db as any),
    {
      assertFeature: (uid: string) =>
        flags.assertFeatureAvailable(uid, 'data_templates'),
    } as any,
    users as any,
    zpl as any,
    new ExcelJsWorkbookReader(),
  );
  const recipes = new DriveRecipeAdapter(
    store as any,
    flags as any,
    pdfService,
    tables,
    zpl as any,
  );
  const service = new FolderAutomationService(
    store as any,
    flags as any,
    events as any,
    crypto,
    provider as any,
    zpl as any,
    validator as any,
    storage as any,
    realRecipes ? recipes : undefined,
  );
  async function connect() {
    const start = await service.start(account, {});
    const state = new URL(start.authorizationUrl).searchParams.get('state');
    return service.complete(account, { state, code: 'code' });
  }
  async function configured() {
    const c = await connect();
    await service.configure(account, c.id, {
      expectedVersion: 1,
      inputFolderId: 'in',
      outputFolderId: 'out',
      labelSize,
      recipeVersion: 1,
      enabled: true,
    });
    return c.id;
  }
  const file = (id = 'source', rev = 'revision1') => ({
    id,
    headRevisionId: rev,
    size: '28',
    mimeType: 'text/plain',
    parents: ['in'],
  });
  async function run() {
    const id = await configured();
    provider.listFiles.mockResolvedValue({ files: [file()] });
    await service.scanOne(id);
    return [...db.rows.values()].find((row) => row.connectionId === id);
  }
  return {
    db,
    crypto,
    provider,
    realProvider,
    flags,
    events,
    pdf,
    storage,
    zpl,
    validator,
    recipes,
    service,
    connect,
    configured,
    file,
    run,
  };
}
describe('Drive automation boundaries', () => {
  test('all management uses Firebase guard and UID from request', async () => {
    expect(
      Reflect.getMetadata('__guards__', FolderAutomationController),
    ).toContain(FirebaseAuthGuard);
    const mock = { start: jest.fn() };
    new FolderAutomationController(mock as any).start(
      { user: { uid: 'uid' } },
      {},
    );
    expect(mock.start).toHaveBeenCalledWith('uid', {});
  });
  test('OAuth binds state to owner, PKCE, ten minute TTL and rejects replay', async () => {
    const f = await fixture();
    const response = await f.service.start(account, {});
    const url = new URL(response.authorizationUrl),
      state = url.searchParams.get('state');
    const row = f.db.rows.get(`drive_oauth_states/${hash(state)}`);
    expect(row.expiresAt.toMillis() - Date.now()).toBeLessThanOrEqual(600000);
    expect(JSON.stringify(row)).not.toContain('refresh-secret');
    await expect(
      f.service.complete('other', { state, code: 'code' }),
    ).rejects.toThrow();
    await f.service.complete(account, { state, code: 'code' });
    const verifier = f.provider.exchange.mock.calls[0][1];
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
      url.searchParams.get('code_challenge'),
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    await expect(
      f.service.complete(account, { state, code: 'again' }),
    ).rejects.toThrow();
    expect(f.provider.exchange).toHaveBeenCalledTimes(1);
  });
  test('expired state, incomplete scopes, absent OAuth and server flags fail closed', async () => {
    const f = await fixture();
    expect(() =>
      new GoogleDriveProvider({ get: () => undefined } as any).settings(),
    ).toThrow('GOOGLE_DRIVE_OAUTH_UNAVAILABLE');
    const start = await f.service.start(account, {}),
      state = new URL(start.authorizationUrl).searchParams.get('state');
    f.db.rows.get(`drive_oauth_states/${hash(state)}`).expiresAt =
      Timestamp.fromMillis(0);
    await expect(
      f.service.complete(account, { state, code: 'code' }),
    ).rejects.toThrow();
    f.provider.exchange.mockResolvedValue({
      access_token: 'a',
      refresh_token: 'r',
      scope: DRIVE_SCOPES[1],
    });
    await expect(f.connect()).rejects.toThrow('scopes');
    f.flags.assertFeatureAvailable.mockRejectedValue(new Error('disabled'));
    await expect(f.service.start(account, {})).rejects.toThrow('disabled');
  });
  test('secrets stay encrypted and picker token is owner-bound, version fenced and no-store', async () => {
    const f = await fixture();
    const c = await f.connect();
    expect(JSON.stringify(await f.service.connections(account))).not.toContain(
      'secret',
    );
    expect(
      JSON.stringify(f.db.rows.get(`drive_connections/${c.id}`)),
    ).not.toContain('refresh-secret');
    await expect(f.service.picker('other', c.id, {})).rejects.toThrow();
    expect(await f.service.picker(account, c.id, {})).toMatchObject({
      expiresIn: 3600,
    });
    expect(
      Reflect.getMetadata(
        '__headers__',
        FolderAutomationController.prototype.picker,
      ),
    ).toEqual(
      expect.arrayContaining([{ name: 'Cache-Control', value: 'no-store' }]),
    );
    f.provider.picker.mockImplementationOnce(async () => {
      f.db.rows.get(`drive_connections/${c.id}`).revokedAt = 'now';
      return {} as any;
    });
    await expect(f.service.picker(account, c.id, {})).rejects.toThrow(
      'Connection changed',
    );
  });
  test('folder configuration validates distinct folders and CAS, pause blocks work', async () => {
    const f = await fixture(),
      id = await f.configured();
    const body = {
      expectedVersion: 2,
      inputFolderId: 'in',
      outputFolderId: 'in',
      labelSize,
      recipeVersion: 1,
      enabled: true,
    };
    await expect(f.service.configure(account, id, body)).rejects.toThrow();
    await expect(
      f.service.configure('other', id, { ...body, outputFolderId: 'out' }),
    ).rejects.toThrow();
    await expect(
      f.service.configure(account, id, {
        ...body,
        outputFolderId: 'out',
        expectedVersion: 1,
      }),
    ).rejects.toThrow('version');
    await f.service.configure(account, id, {
      ...body,
      outputFolderId: 'out',
      enabled: false,
    });
    await f.service.scanOne(id);
    expect(f.provider.listFiles).not.toHaveBeenCalled();
  });
  test('paged cursor and revision identity dedup concurrent scans and exclude own output', async () => {
    const f = await fixture(),
      id = await f.configured();
    f.provider.listFiles
      .mockResolvedValueOnce({
        files: [f.file(), f.file()],
        nextPageToken: 'page2',
      })
      .mockResolvedValueOnce({
        files: [
          f.file('other'),
          { ...f.file('pdf'), appProperties: { zplpdfOutput: 'true' } },
          { ...f.file('outside'), parents: ['out'] },
        ],
      });
    await Promise.all([f.service.scanOne(id), f.service.scanOne(id)]);
    let rows = [...f.db.rows.values()].filter((row) => row.connectionId === id);
    expect(rows).toHaveLength(2);
    expect(f.provider.listFiles.mock.calls[1][2]).toBe('page2');
    expect(f.db.rows.get(`drive_connections/${id}`).pageToken).toBe(
      'watermark',
    );
    f.db.rows.get(`drive_connections/${id}`).nextScanAt = new Date(
      0,
    ).toISOString();
    f.provider.changes.mockResolvedValue({
      changes: [{ file: f.file() }, { file: f.file('source', 'revision2') }],
      newStartPageToken: 'nextwatermark',
    });
    await f.service.scanOne(id);
    rows = [...f.db.rows.values()].filter((row) => row.connectionId === id);
    expect(rows).toHaveLength(3);
    expect(f.db.rows.get(`drive_connections/${id}`).pageToken).toBe(
      'nextwatermark',
    );
    expect(f.events.recordServerEvent).not.toHaveBeenCalled();
  });
  test('empty scan is no usage and missing/expired cursors do not invent completion', async () => {
    const f = await fixture(),
      id = await f.configured();
    await f.service.scanOne(id);
    expect(f.events.recordServerEvent).not.toHaveBeenCalled();
    const c = f.db.rows.get(`drive_connections/${id}`);
    c.nextScanAt = new Date(0).toISOString();
    f.provider.changes.mockRejectedValueOnce(new DriveProviderError(410));
    await expect(f.service.scanOne(id)).rejects.toThrow();
    expect(f.db.rows.get(`drive_connections/${id}`)).toMatchObject({
      scanPhase: 'initial',
      pageToken: null,
      lastScanStatus: 'failed',
    });
  });
  test('conversion followed by upload is the sole success fact, retry preserves successful receipt', async () => {
    const f = await fixture(),
      run = await f.run();
    await f.service.processOne(run.id);
    expect(f.zpl.runDurableConversion).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: run.id,
        userId: account,
        labelSize,
      }),
    );
    expect(f.provider.upload).toHaveBeenCalledTimes(1);
    expect(f.db.rows.get(`drive_runs/${run.id}`).status).toBe('succeeded');
    expect(f.events.recordServerEvent).toHaveBeenCalledTimes(1);
    await expect(f.service.retry(account, run.id, 'retry')).rejects.toThrow();
    await f.service.processOne(run.id);
    expect(f.provider.upload).toHaveBeenCalledTimes(1);
  });
  test('upload receipt recovers after commit outage without downloading source or printing twice', async () => {
    const f = await fixture(),
      run = await f.run();
    f.events.recordServerEvent.mockRejectedValueOnce(
      new Error('database outage'),
    );
    await f.service.processOne(run.id);
    const row = f.db.rows.get(`drive_runs/${run.id}`);
    expect(row.status).toBe('queued');
    expect(f.db.rows.has(`events/${run.id}`)).toBe(false);
    f.provider.file.mockResolvedValue({
      id: row.outputId,
      mimeType: 'application/pdf',
      parents: ['out'],
      appProperties: { zplpdfRunId: run.id },
      md5Checksum: row.outputChecksum,
    });
    row.availableAt = new Date(0).toISOString();
    await f.service.processOne(run.id);
    expect(f.db.rows.get(`drive_runs/${run.id}`).status).toBe('succeeded');
    expect(f.provider.revision).toHaveBeenCalledTimes(1);
    expect(f.provider.upload).toHaveBeenCalledTimes(1);
  });
  test('invalid source fails, only failed run may retry, ownership and tombstone enforced', async () => {
    const f = await fixture(),
      run = await f.run();
    f.validator.validate.mockResolvedValue({ isValid: false });
    await f.service.processOne(run.id);
    expect(f.db.rows.get(`drive_runs/${run.id}`).status).toBe('failed');
    expect(f.events.recordServerEvent).not.toHaveBeenCalled();
    await expect(f.service.retry('other', run.id, 'retry')).rejects.toThrow();
    await f.service.retry(account, run.id, 'retry');
    expect(f.db.rows.get(`drive_runs/${run.id}`).status).toBe('queued');
    f.db.rows.set(`deleted_accounts/${account}`, {});
    await expect(f.service.processOne(run.id)).rejects.toThrow(
      'Account unavailable',
    );
    expect(f.zpl.runDurableConversion).not.toHaveBeenCalled();
  });
  test('plain text that yields no ZPL blocks fails once before conversion or upload', async () => {
    const f = await fixture(false, true);
    f.provider.revision.mockResolvedValue(
      Buffer.from('ARCHIVO DE PRUEBA SIN ZPL VALIDO'),
    );
    const run = await f.run();

    await f.service.processOne(run.id);
    await f.service.processOne(run.id);

    expect(f.validator.validate).toHaveBeenCalledTimes(1);
    expect(f.zpl.countLabels).toHaveBeenCalledTimes(1);
    expect(f.zpl.runDurableConversion).not.toHaveBeenCalled();
    expect(f.provider.upload).not.toHaveBeenCalled();
    expect(f.db.rows.get(`drive_runs/${run.id}`)).toMatchObject({
      status: 'failed',
      attempts: 1,
    });
  });
  test.each([HttpStatus.TOO_MANY_REQUESTS, HttpStatus.SERVICE_UNAVAILABLE])(
    'keeps HTTP %s label-count failures retryable after real ZPL parsing',
    async (status) => {
      const f = await fixture(false, true),
        run = await f.run();
      const realCountLabels = f.zpl.countLabels.getMockImplementation()!;
      f.zpl.countLabels.mockImplementationOnce(async (content: string) => {
        await realCountLabels(content);
        throw new HttpException('Temporary label-count failure', status);
      });

      await f.service.processOne(run.id);

      expect(f.zpl.countLabels).toHaveBeenCalled();
      expect(f.zpl.runDurableConversion).not.toHaveBeenCalled();
      expect(f.provider.upload).not.toHaveBeenCalled();
      expect(f.db.rows.get(`drive_runs/${run.id}`)).toMatchObject({
        status: 'queued',
        attempts: 1,
      });
    },
  );
  test('valid ZPL still converts and uploads with real validation and counting', async () => {
    const f = await fixture(false, true),
      run = await f.run();

    await f.service.processOne(run.id);

    expect(f.zpl.runDurableConversion).toHaveBeenCalledTimes(1);
    expect(f.provider.upload).toHaveBeenCalledTimes(1);
    expect(f.db.rows.get(`drive_runs/${run.id}`).status).toBe('succeeded');
  });
  test('disconnect blocks all work immediately and persists retryable token revocation', async () => {
    const f = await fixture(),
      run = await f.run();
    f.provider.revoke.mockRejectedValueOnce(new Error('offline'));
    expect(
      await f.service.disconnect(account, run.connectionId, {
        expectedVersion: 2,
      }),
    ).toMatchObject({ status: 'disconnecting' });
    expect(
      f.db.rows.get(`drive_connections/${run.connectionId}`),
    ).toMatchObject({ status: 'disconnecting' });
    await f.service.processOne(run.id);
    expect(f.zpl.runDurableConversion).not.toHaveBeenCalled();
    f.db.rows.get(`drive_revocations/${run.connectionId}`).availableAt =
      new Date(0).toISOString();
    await f.service.revokePending();
    expect(
      f.db.rows.get(`drive_connections/${run.connectionId}`),
    ).toMatchObject({ status: 'disconnected' });
    expect(
      f.db.rows.get(`drive_connections/${run.connectionId}`).secret,
    ).toBeUndefined();
  });
  test('concurrent lease recovery reuses durable conversion id and cannot emit success before provider output', async () => {
    const f = await fixture(),
      run = await f.run();
    f.provider.upload.mockRejectedValueOnce(new DriveProviderError(503));
    await Promise.all([
      f.service.processOne(run.id),
      f.service.processOne(run.id),
    ]);
    expect(f.zpl.runDurableConversion).toHaveBeenCalledTimes(1);
    expect(f.events.recordServerEvent).not.toHaveBeenCalled();
    expect(f.db.rows.get(`drive_runs/${run.id}`).status).toBe('queued');
  });
});
describe('Google transport (mock network)', () => {
  afterEach(() => jest.clearAllMocks());
  test('token exchange sends verifier, bounded fixed hosts and no redirects; missing picker config is explicit', async () => {
    const f = await fixture();
    (axios.post as jest.Mock).mockResolvedValue({
      data: { access_token: 'a', expires_in: 3600 },
    });
    await f.realProvider.exchange('code', 'verifier');
    expect(axios.post).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/token',
      expect.stringContaining('code_verifier=verifier'),
      expect.objectContaining({
        maxRedirects: 0,
        timeout: 10000,
        proxy: false,
      }),
    );
    expect(await f.realProvider.picker('r')).toMatchObject({
      accessToken: 'a',
      appId: '12345',
    });
  });
  test('upload conflict checks same generated ID, ownership marker, output parent and checksum', async () => {
    const f = await fixture();
    const md5 = createHash('md5').update(f.pdf).digest('hex');
    (axios.request as jest.Mock)
      .mockRejectedValueOnce({ response: { status: 409 } })
      .mockResolvedValueOnce({
        data: {
          id: 'out',
          mimeType: 'application/pdf',
          parents: ['folder'],
          appProperties: { zplpdfRunId: 'run' },
          md5Checksum: md5,
        },
      });
    await expect(
      f.realProvider.upload('token', 'out', 'folder', f.pdf, 'run'),
    ).resolves.toMatchObject({ id: 'out' });
    expect(axios.request).toHaveBeenCalledWith(
      expect.objectContaining({
        maxRedirects: 0,
        timeout: 15000,
        proxy: false,
      }),
    );
    (axios.request as jest.Mock)
      .mockResolvedValueOnce({ data: { id: 'out' } })
      .mockResolvedValueOnce({
        data: {
          id: 'out',
          mimeType: 'application/pdf',
          parents: ['folder'],
          appProperties: { zplpdfRunId: 'run' },
          md5Checksum: 'wrong',
        },
      });
    await expect(
      f.realProvider.upload('token', 'out', 'folder', f.pdf, 'run'),
    ).rejects.toThrow('DRIVE_PROVIDER');
  });
});
describe('Drive retry receipts', () => {
  test('failed-only retry is idempotent across processing and history reports honest retryability', async () => {
    const f = await fixture(),
      run = await f.run();
    f.validator.validate.mockResolvedValue({ isValid: false });
    await f.service.processOne(run.id);
    let list = await f.service.runs(account, run.connectionId);
    expect(list.items[0]).toMatchObject({
      retryable: true,
      expiresAt: expect.any(String),
    });
    const results = await Promise.all([
      f.service.retry(account, run.id, 'retry-once'),
      f.service.retry(account, run.id, 'retry-once'),
    ]);
    expect(results.filter((r) => r.duplicate)).toHaveLength(1);
    await f.service.processOne(run.id);
    expect(f.db.rows.get(`drive_runs/${run.id}`).status).toBe('failed');
    expect(await f.service.retry(account, run.id, 'retry-once')).toMatchObject({
      duplicate: true,
      status: 'failed',
    });
    expect(f.db.rows.get(`drive_runs/${run.id}`).status).toBe('failed');
    f.db.rows.get(`drive_connections/${run.connectionId}`).status = 'paused';
    list = await f.service.runs(account, run.connectionId);
    expect(list.items[0].retryable).toBe(false);
  });
  test('lease takeover before upload cannot produce output or canonical success', async () => {
    const f = await fixture(),
      run = await f.run();
    f.storage.readFile.mockImplementationOnce(async () => {
      f.db.rows.get(`drive_runs/${run.id}`).leaseToken = 'new-worker';
      return f.pdf;
    });
    await f.service.processOne(run.id);
    expect(f.provider.upload).not.toHaveBeenCalled();
    expect(f.events.recordServerEvent).not.toHaveBeenCalled();
  });
});
describe('Durable revocation independent of account deletion', () => {
  test('copies encrypted secret before cascade, keeps original AAD and can revoke after deletion', async () => {
    const f = await fixture(),
      id = await f.configured();
    f.db.rows.set(`deleted_accounts/${account}`, {});
    await enqueueAccountDriveRevocations(f.db as any, account);
    const receipt = f.db.rows.get(`drive_revocations/${id}`);
    expect(receipt.status).toBe('queued');
    expect(JSON.stringify(receipt)).not.toContain('refresh-secret');
    expect(receipt.expiresAt).toBeUndefined();
    f.db.rows.delete(`drive_connections/${id}`);
    expect(await f.service.revokePending()).toMatchObject({
      acknowledged: 1,
      persistenceErrors: 0,
    });
    expect(f.provider.revoke).toHaveBeenCalledWith('refresh-secret');
    expect(f.db.rows.get(`drive_revocations/${id}`)).toMatchObject({
      status: 'acknowledged',
      expiresAt: expect.any(Timestamp),
    });
    expect(f.db.rows.get(`drive_revocations/${id}`).secret).toBeUndefined();
  });
  test('one provider failure does not block others; backoff/cap preserve secret for explicit operator retry', async () => {
    const f = await fixture();
    const first = await f.configured(),
      second = await f.configured();
    await enqueueAccountDriveRevocations(f.db as any, account);
    f.provider.revoke.mockRejectedValueOnce(new Error('offline'));
    expect(await f.service.revokePending()).toMatchObject({
      scanned: 2,
      failed: 1,
      acknowledged: 1,
    });
    const failed = [first, second].find(
      (id) => f.db.rows.get(`drive_revocations/${id}`).status === 'queued',
    );
    const row = f.db.rows.get(`drive_revocations/${failed}`);
    expect(row.availableAt > new Date().toISOString()).toBe(true);
    row.attempts = 7;
    row.availableAt = new Date(0).toISOString();
    f.provider.revoke.mockRejectedValueOnce(new Error('still offline'));
    await f.service.revokePending();
    expect(f.db.rows.get(`drive_revocations/${failed}`)).toMatchObject({
      status: 'failed',
      attempts: 8,
    });
    expect(
      f.db.rows.get(`drive_revocations/${failed}`).expiresAt,
    ).toBeUndefined();
    expect(f.db.rows.get(`drive_revocations/${failed}`).secret).toBeDefined();
    await retryDriveRevocation(f.db as any, failed);
    await f.service.revokePending();
    expect(f.db.rows.get(`drive_revocations/${failed}`).status).toBe(
      'acknowledged',
    );
  });
  test('simultaneous revocation workers acquire one lease and lost lease prevents acknowledgement', async () => {
    const f = await fixture(),
      id = await f.configured();
    await enqueueAccountDriveRevocations(f.db as any, account);
    await Promise.all([f.service.revokePending(), f.service.revokePending()]);
    expect(f.provider.revoke).toHaveBeenCalledTimes(1);
    expect(f.db.rows.get(`drive_revocations/${id}`).status).toBe(
      'acknowledged',
    );
  });
  test('page limit is enforced before durable renderer', async () => {
    const f = await fixture(),
      run = await f.run();
    f.zpl.countLabels.mockResolvedValue({ data: { totalLabels: 501 } });
    await f.service.processOne(run.id);
    expect(f.zpl.runDurableConversion).not.toHaveBeenCalled();
    expect(f.db.rows.get(`drive_runs/${run.id}`).status).toBe('failed');
  });
});
describe('OAuth deletion race', () => {
  test('token received after tombstone is durably enqueued for revocation instead of recreating connection', async () => {
    const f = await fixture();
    f.provider.exchange.mockImplementationOnce(async () => {
      f.db.rows.set(`deleted_accounts/${account}`, {});
      return {
        access_token: 'access',
        refresh_token: 'new-secret',
        scope: DRIVE_SCOPES.join(' '),
      };
    });
    await expect(f.connect()).rejects.toThrow('Account unavailable');
    expect(
      [...f.db.rows.keys()].filter((k) => k.startsWith('drive_connections/')),
    ).toHaveLength(0);
    const pending = [...f.db.rows.values()].filter(
      (row) => row.status === 'queued' && row.secret,
    );
    expect(pending).toHaveLength(1);
    expect(JSON.stringify(pending)).not.toContain('new-secret');
    await f.service.revokePending();
    expect(f.provider.revoke).toHaveBeenCalledWith('new-secret');
  });
});
describe('Paused connection scheduling', () => {
  test('paused due rows are postponed so they cannot monopolize worker batch; resume preserves identity', async () => {
    const f = await fixture(),
      run = await f.run();
    f.db.rows.get(`drive_connections/${run.connectionId}`).status = 'paused';
    await f.service.processOne(run.id);
    const paused = f.db.rows.get(`drive_runs/${run.id}`);
    expect(paused.status).toBe('queued');
    expect(paused.availableAt > new Date().toISOString()).toBe(true);
    expect(f.zpl.runDurableConversion).not.toHaveBeenCalled();
    f.db.rows.get(`drive_connections/${run.connectionId}`).status = 'active';
    paused.availableAt = new Date(0).toISOString();
    await f.service.processOne(run.id);
    expect(f.db.rows.get(`drive_runs/${run.id}`).status).toBe('succeeded');
  });
});

describe('Drive state changes preserve frozen recipes', () => {
  it('pauses and resumes without resolving an archived preset or calling the provider', async () => {
    const f = await fixture(),
      id = await f.configured();
    const row = f.db.rows.get(`drive_connections/${id}`);
    const snapshot = { kind: 'pdf', layout: { paper: '4x6' } };
    f.db.apply(
      `drive_connections/${id}`,
      {
        recipeSnapshot: snapshot,
        recipe: { kind: 'pdf', presetId: 'synthetic', presetVersion: 1 },
      },
      true,
    );
    f.provider.file.mockClear();
    f.provider.refresh.mockClear();
    const paused = await f.service.setEnabled(account, id, {
      expectedVersion: row.version,
      enabled: false,
    });
    expect(paused.status).toBe('paused');
    expect(paused).not.toHaveProperty('recipeSnapshot');
    const resumed = await f.service.setEnabled(account, id, {
      expectedVersion: paused.version,
      enabled: true,
    });
    expect(resumed.status).toBe('active');
    expect(resumed.recipeVersion).toBe(row.recipeVersion);
    expect(f.db.rows.get(`drive_connections/${id}`).recipeSnapshot).toEqual(
      snapshot,
    );
    expect(f.provider.file).not.toHaveBeenCalled();
    expect(f.provider.refresh).not.toHaveBeenCalled();
    await expect(
      f.service.setEnabled(account, id, {
        expectedVersion: paused.version,
        enabled: false,
      }),
    ).rejects.toThrow('Connection version changed');
    await expect(
      f.service.setEnabled('foreign', id, {
        expectedVersion: resumed.version,
        enabled: false,
      }),
    ).rejects.toThrow();
  });
});

describe('Drive completion lease expiry', () => {
  it('recovers an upload receipt without letting an expired worker commit success', async () => {
    const f = await fixture();
    const run = await f.run();
    f.provider.upload.mockImplementationOnce(async () => {
      // The remote upload completed after the worker lost its time lease.
      f.db.rows.get(`drive_runs/${run.id}`).availableAt = new Date(
        0,
      ).toISOString();
      return { id: 'allocated-output' };
    });
    await f.service.processOne(run.id);
    expect(f.db.rows.get(`drive_runs/${run.id}`).status).toBe('queued');
    expect(f.events.recordServerEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventName: 'folder_run_succeeded' }),
      expect.anything(),
    );
    const row = f.db.rows.get(`drive_runs/${run.id}`);
    row.availableAt = new Date(0).toISOString();
    f.provider.file.mockResolvedValueOnce({
      id: 'allocated-output',
      appProperties: { zplpdfRunId: run.id },
      parents: ['out'],
      mimeType: 'application/pdf',
      md5Checksum: row.outputChecksum,
    });
    await f.service.processOne(run.id);
    expect(f.db.rows.get(`drive_runs/${run.id}`).status).toBe('succeeded');
    expect(f.provider.upload).toHaveBeenCalledTimes(1);
    expect(f.provider.revision).toHaveBeenCalledTimes(1);
  });
});

describe('Drive frozen recipe integration with real materializers', () => {
  it('runs the queued PDF snapshot after reconfiguration/archive with one durable quota charge', async () => {
    const f = await fixture(true),
      c = await f.connect(),
      presetId = randomUUID();
    const layout = {
      paper: '4x6',
      columns: 1,
      rows: 1,
      marginPt: 0,
      gapPt: 0,
      scale: 'actual',
      selections: [{ page: 0, rotation: 0 }],
    };
    f.db.rows.set(`pdf_output_presets/${presetId}`, {
      accountId: account,
      status: 'active',
    });
    f.db.rows.set(`pdf_output_preset_versions/${presetId}_1`, {
      accountId: account,
      recipe: layout,
    });
    const config = {
      expectedVersion: 1,
      inputFolderId: 'in',
      outputFolderId: 'out',
      labelSize,
      recipeVersion: 1,
      enabled: true,
      recipe: { kind: 'pdf', presetId, presetVersion: 1 },
    };
    const configured = await f.service.configure(account, c.id, config);
    expect(configured).not.toHaveProperty('recipeSnapshot');
    const source = await PDFDocument.create();
    source.addPage([200, 300]).drawText('SYNTHETIC PDF');
    const bytes = Buffer.from(await source.save());
    f.provider.listFiles.mockResolvedValue({
      files: [
        {
          ...f.file(),
          mimeType: 'application/pdf',
          size: String(bytes.length),
        },
        { ...f.file('unsupported'), mimeType: 'image/png' },
      ],
    });
    f.provider.revision.mockResolvedValue(bytes);
    await f.service.scanOne(c.id);
    const run = [...f.db.rows.values()].find(
      (row) => row.connectionId === c.id,
    );
    f.db.rows.set(`pdf_output_preset_versions/${presetId}_2`, {
      accountId: account,
      recipe: { ...layout, paper: 'a4' },
    });
    await expect(
      f.service.configure(account, c.id, {
        ...config,
        expectedVersion: 2,
        recipe: { ...config.recipe, presetVersion: 2 },
      }),
    ).rejects.toThrow('New recipeVersion required');
    await f.service.configure(account, c.id, {
      ...config,
      expectedVersion: 2,
      recipeVersion: 2,
      recipe: { ...config.recipe, presetVersion: 2 },
    });
    f.db.rows.get(`pdf_output_presets/${presetId}`).status = 'archived';
    await f.service.processOne(run.id);
    await f.service.processOne(run.id);
    expect(f.db.rows.get(`drive_runs/${run.id}`).status).toBe('succeeded');
    const uploaded = await PDFDocument.load(f.provider.upload.mock.calls[0][3]);
    expect(uploaded.getPage(0).getSize()).toEqual({ width: 288, height: 432 });
    expect(f.provider.revision).toHaveBeenCalledWith(
      'access',
      'source',
      'revision1',
      20 * 1024 * 1024,
    );
    expect(f.provider.upload).toHaveBeenCalledTimes(1);
    expect(f.db.rows.get('usage/owner-period')).toMatchObject({
      pdfCount: 1,
      reservedPdfCount: 0,
    });
    const publicViews = JSON.stringify([
      await f.service.runs(account, c.id),
      await f.service.connections(account),
    ]);
    expect(publicViews).not.toContain('recipeSnapshot');
    expect(publicViews).not.toContain('private-pdf');
    expect(publicViews).not.toContain('refresh-secret');
    expect(publicViews).not.toContain('layout');
    expect(f.zpl.runDurableConversion).not.toHaveBeenCalled();
  });
  it.each(['csv', 'xlsx'] as const)(
    'materializes real %s values/copies from the frozen server template after archive and pause/resume',
    async (format) => {
      const f = await fixture(true),
        c = await f.connect(),
        templateId = randomUUID();
      const version = {
        id: `${templateId}:1`,
        templateId,
        ownerId: account,
        accountId: account,
        versionNumber: 1,
        labelSize: '4x6',
        fields: [
          {
            key: 'sku',
            label: 'SKU',
            type: 'code',
            required: true,
            charset: 'digits',
            maxLength: 12,
          },
        ],
        zplTemplate: '^XA^FO10,10^FD{{sku}}^FS^XZ',
        checksum: 'synthetic',
        createdAt: new Date().toISOString(),
      };
      f.db.rows.set(`label_templates/${templateId}`, {
        ownerId: account,
        status: 'active',
      });
      f.db.rows.set(`label_template_versions/${templateId}:1`, version);
      const config = {
        expectedVersion: 1,
        inputFolderId: 'in',
        outputFolderId: 'out',
        labelSize,
        recipeVersion: 1,
        enabled: true,
        recipe: {
          kind: 'template',
          templateId,
          templateVersion: 1,
          format,
          mapping: { fields: { sku: 'SKU' }, quantityColumn: 'Copies' },
        },
      };
      await f.service.configure(account, c.id, config);
      let bytes = Buffer.from('SKU,Copies\n00123,2');
      if (format === 'xlsx') {
        const book = new ExcelJS.Workbook();
        const sheet = book.addWorksheet('Labels');
        sheet.addRow(['SKU', 'Copies']);
        sheet.addRow(['00123', 2]);
        bytes = Buffer.from(await book.xlsx.writeBuffer());
      }
      f.provider.listFiles.mockResolvedValue({
        files: [
          {
            ...f.file(),
            mimeType:
              format === 'csv'
                ? 'text/csv'
                : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            size: String(bytes.length),
          },
        ],
      });
      f.provider.revision.mockResolvedValue(bytes);
      await f.service.scanOne(c.id);
      const run = [...f.db.rows.values()].find(
        (row) => row.connectionId === c.id,
      );
      f.db.rows.get(`label_templates/${templateId}`).status = 'archived';
      // A newer immutable version exists but neither processing nor state changes resolve it.
      f.db.rows.set(`label_template_versions/${templateId}:2`, {
        ...version,
        versionNumber: 2,
        zplTemplate: '^XA^FDNEW VERSION^FS^XZ',
      });
      const resolve = jest.spyOn(f.recipes, 'resolve');
      await f.service.setEnabled(account, c.id, {
        expectedVersion: 2,
        enabled: false,
      });
      await f.service.setEnabled(account, c.id, {
        expectedVersion: 3,
        enabled: true,
      });
      await f.service.processOne(run.id);
      await f.service.processOne(run.id);
      expect(resolve).not.toHaveBeenCalled();
      expect(f.db.rows.get(`drive_runs/${run.id}`).status).toBe('succeeded');
      expect(f.zpl.runDurableConversion).toHaveBeenCalledTimes(1);
      expect(f.zpl.runDurableConversion).toHaveBeenCalledWith(
        expect.objectContaining({
          operationId: run.id,
          userId: account,
          labelSize: '4x6',
          zplContent: expect.stringContaining('00123'),
        }),
      );
      expect(f.zpl.runDurableConversion.mock.calls[0][0].zplContent).toContain(
        '^PQ2',
      );
      expect(f.provider.revision).toHaveBeenCalledWith(
        'access',
        'source',
        'revision1',
        5 * 1024 * 1024,
      );
      const views = JSON.stringify([
        await f.service.runs(account, c.id),
        await f.service.connections(account),
      ]);
      expect(views).not.toContain('zplTemplate');
      expect(views).not.toContain('00123');
      expect(
        [...f.db.rows.keys()].some((key) =>
          key.startsWith('label_template_runs/'),
        ),
      ).toBe(false);
    },
  );
});

describe('Rejected OAuth grant cleanup', () => {
  it.each(['partial-scope', 'no-refresh'] as const)(
    'durably revokes the unusable %s grant without keeping a connection',
    async (reason) => {
      const f = await fixture();
      f.provider.exchange.mockResolvedValueOnce({
        access_token: 'rejected-access',
        ...(reason === 'partial-scope'
          ? { refresh_token: 'rejected-refresh' }
          : {}),
        scope:
          reason === 'partial-scope' ? DRIVE_SCOPES[0] : DRIVE_SCOPES.join(' '),
      });
      await expect(f.connect()).rejects.toThrow(
        'Drive scopes and offline access required',
      );
      expect(
        [...f.db.rows.keys()].some((key) =>
          key.startsWith('drive_connections/'),
        ),
      ).toBe(false);
      expect(await f.service.revokePending()).toMatchObject({
        scanned: 1,
        acknowledged: 1,
      });
      expect(f.provider.revoke).toHaveBeenCalledWith(
        reason === 'partial-scope' ? 'rejected-refresh' : 'rejected-access',
      );
      const receipt = [...f.db.rows.entries()].find(([key]) =>
        key.startsWith('drive_revocations/'),
      )[1];
      expect(receipt.secret).toBeUndefined();
    },
  );
});
