import {
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { FieldPath, FieldValue, Timestamp } from '@google-cloud/firestore';
import { randomUUID } from 'node:crypto';
import { FirestoreService } from '../cache/firestore.service.js';
import { FeatureFlagsService } from '../product-observability/feature-flags.service.js';
import { ProductObservabilityService } from '../product-observability/product-observability.service.js';
import { ApiTemplateAdapter } from './api-template.adapter.js';
import { ApiCredentialsService } from './api-credentials.service.js';
import { PublicApiCrypto, hash } from './public-api.crypto.js';
import {
  operationUuid,
  stableJson,
  validateJob,
} from './api-job-validation.js';
import { PUBLIC_API_CONVERSION } from './public-api.types.js';
import type { ApiConversionPort } from './public-api.types.js';

const LEASE_MS = 10 * 60000;
@Injectable()
export class ApiJobsService {
  constructor(
    private readonly store: FirestoreService,
    private readonly flags: FeatureFlagsService,
    private readonly events: ProductObservabilityService,
    private readonly credentials: ApiCredentialsService,
    private readonly crypto: PublicApiCrypto,
    @Inject(PUBLIC_API_CONVERSION)
    private readonly converter: ApiConversionPort,
    private readonly templates: ApiTemplateAdapter,
  ) {}
  async create(accountId: string, idempotencyKey: string, input: unknown) {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(idempotencyKey ?? ''))
      throw new BadRequestException('Idempotency-Key required');
    const value = validateJob(input);
    await this.flags.account(accountId);
    const id = operationUuid('public-api', accountId, idempotencyKey);
    const fingerprint = hash(stableJson(value));
    const db = this.store.getClient();
    const existing = (await db.collection('api_jobs').doc(id).get()).data();
    if (existing) {
      if (
        existing.accountId !== accountId ||
        existing.fingerprint !== fingerprint
      )
        throw new ConflictException('IDEMPOTENCY_KEY_REUSED');
      return this.safe(existing);
    }
    const feature = await this.flags.assertFeatureAvailable(
      accountId,
      'self_service_api',
    );
    if (value.callbackId)
      await this.credentials.callback(accountId, value.callbackId);
    const zplContent = await this.renderInput(accountId, value);
    const envelope = JSON.stringify({
      request: value,
      ...(!value.zplContent ? { zplContent } : {}),
    });
    if (Buffer.byteLength(envelope) > 512 * 1024)
      throw new BadRequestException('Rendered job input too large');
    const secret = this.crypto.seal(envelope, `${accountId}:${id}`);
    const result = await db.runTransaction(async (tx) => {
      if (
        (await tx.get(db.collection('deleted_accounts').doc(accountId))).exists
      )
        throw new GoneException('Account unavailable');
      const ref = db.collection('api_jobs').doc(id);
      const prior = await tx.get(ref);
      const counter = db.collection('api_account_limits').doc(hash(accountId));
      const counts = await tx.get(counter);
      if (prior.exists) {
        if (prior.get('fingerprint') !== fingerprint)
          throw new ConflictException('IDEMPOTENCY_KEY_REUSED');
        return this.safe(prior.data());
      }
      if ((counts.get('jobs') ?? 0) >= 20)
        throw new ConflictException('Too many pending jobs');
      const now = new Date().toISOString();
      const row = {
        id,
        accountId,
        fingerprint,
        status: 'queued',
        featureVersion: feature.featureVersion,
        testMode: value.testMode === true,
        callbackId: value.callbackId ?? null,
        createdAt: now,
        updatedAt: now,
        availableAt: now,
        attempts: 0,
        generation: 1,
        expiresAt: Timestamp.fromMillis(Date.now() + 90 * 86400000),
      };
      tx.create(ref, row);
      tx.create(db.collection('api_job_inputs').doc(id), {
        accountId,
        secret,
        expiresAt: Timestamp.fromMillis(Date.now() + 15 * 86400000),
      });
      tx.set(
        counter,
        { accountId, jobs: (counts.get('jobs') ?? 0) + 1 },
        { merge: true },
      );
      return this.safe(row);
    });
    // Fast path only; Firestore queue remains authoritative after process death.
    setImmediate(() => void this.processJob(id).catch(() => undefined));
    return result;
  }
  private safe(row: any) {
    return {
      id: row.id,
      testMode: row.testMode === true,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      attempts: row.attempts,
      errorCode: row.errorCode ?? null,
      callbackId: row.callbackId,
    };
  }
  private async owned(accountId: string, id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new NotFoundException();
    const row = (
      await this.store.getClient().collection('api_jobs').doc(id).get()
    ).data();
    if (!row || row.accountId !== accountId) throw new NotFoundException();
    return row;
  }
  async list(accountId: string, cursor?: string, limit = 25) {
    await this.flags.account(accountId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new BadRequestException('Invalid page limit');
    if (cursor && !/^[0-9a-f-]{36}$/.test(cursor))
      throw new BadRequestException('Invalid cursor');
    let query = this.store
      .getClient()
      .collection('api_jobs')
      .where('accountId', '==', accountId)
      .orderBy(FieldPath.documentId());
    if (cursor) query = query.startAfter(cursor);
    const rows = await query.limit(limit + 1).get();
    const page = rows.docs.slice(0, limit);
    return {
      items: page.map((doc) => this.safe(doc.data())),
      nextCursor: rows.size > limit ? page[page.length - 1].id : null,
    };
  }
  async usage(accountId: string) {
    await this.flags.account(accountId);
    const counts = await this.store
      .getClient()
      .collection('api_account_limits')
      .doc(hash(accountId))
      .get();
    return {
      pendingJobs: counts.get('jobs') ?? 0,
      maxPendingJobs: 20,
      retentionDays: 90,
      observedAt: new Date().toISOString(),
    };
  }
  async status(accountId: string, id: string) {
    return this.safe(await this.owned(accountId, id));
  }
  async result(accountId: string, id: string) {
    const row = await this.owned(accountId, id);
    if (row.status !== 'succeeded')
      throw new ConflictException('Job not completed');
    return {
      ...(await this.converter.result(id, accountId)),
      expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
    };
  }
  async cancel(accountId: string, id: string) {
    await this.owned(accountId, id);
    const db = this.store.getClient();
    return db.runTransaction(async (tx) => {
      if (
        (await tx.get(db.collection('deleted_accounts').doc(accountId))).exists
      )
        throw new GoneException('Account unavailable');
      const ref = db.collection('api_jobs').doc(id);
      const row = (await tx.get(ref)).data();
      const counter = db.collection('api_account_limits').doc(hash(accountId));
      const count = await tx.get(counter);
      if (row?.accountId !== accountId) throw new NotFoundException();
      if (row.status === 'cancelled') return this.safe(row);
      if (row.status !== 'queued' || row.attempts !== 0)
        throw new ConflictException('Only unstarted jobs can be cancelled');
      const next = {
        ...row,
        status: 'cancelled',
        updatedAt: new Date().toISOString(),
      };
      tx.update(ref, {
        status: next.status,
        updatedAt: next.updatedAt,
        availableAt: FieldValue.delete(),
      });
      tx.set(
        counter,
        { jobs: Math.max(0, (count.get('jobs') ?? 1) - 1) },
        { merge: true },
      );
      return this.safe(next);
    });
  }
  async retry(accountId: string, id: string) {
    await this.flags.assertFeatureAvailable(accountId, 'self_service_api');
    await this.owned(accountId, id);
    const db = this.store.getClient();
    return db.runTransaction(async (tx) => {
      if (
        (await tx.get(db.collection('deleted_accounts').doc(accountId))).exists
      )
        throw new GoneException('Account unavailable');
      const ref = db.collection('api_jobs').doc(id);
      const row = (await tx.get(ref)).data();
      const input = await tx.get(db.collection('api_job_inputs').doc(id));
      const counter = db.collection('api_account_limits').doc(hash(accountId));
      const count = await tx.get(counter);
      if (row?.accountId !== accountId) throw new NotFoundException();
      if (row.status !== 'failed')
        throw new ConflictException('Only failed jobs can retry');
      if (!input.exists || input.get('expiresAt').toMillis() <= Date.now())
        throw new GoneException('Job input expired');
      if ((count.get('jobs') ?? 0) >= 20)
        throw new ConflictException('Too many pending jobs');
      const next = {
        status: 'queued',
        attempts: 0,
        generation: row.generation + 1,
        availableAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        errorCode: FieldValue.delete(),
      };
      tx.update(ref, next);
      tx.set(counter, { jobs: (count.get('jobs') ?? 0) + 1 }, { merge: true });
      return { id, status: 'queued' };
    });
  }
  async processDueJobs(limit = 10) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new BadRequestException('Invalid worker limit');
    const due = await this.store
      .getClient()
      .collection('api_jobs')
      .where('availableAt', '<=', new Date().toISOString())
      .orderBy('availableAt')
      .limit(limit)
      .get();
    for (const row of due.docs) await this.processJob(row.id);
    return { scanned: due.size };
  }
  async processJob(id: string) {
    const db = this.store.getClient();
    const ref = db.collection('api_jobs').doc(id);
    const token = randomUUID();
    const row: any = await db.runTransaction(async (tx) => {
      const data = (await tx.get(ref)).data();
      if (
        !data ||
        !['queued', 'running'].includes(data.status) ||
        data.availableAt > new Date().toISOString()
      )
        return null;
      if (
        (await tx.get(db.collection('deleted_accounts').doc(data.accountId)))
          .exists
      )
        return null;
      tx.update(ref, {
        status: 'running',
        leaseToken: token,
        availableAt: new Date(Date.now() + LEASE_MS).toISOString(),
        attempts: data.attempts + 1,
        updatedAt: new Date().toISOString(),
      });
      return { ...data, attempts: data.attempts + 1 };
    });
    if (!row) return;
    const heartbeat = setInterval(
      () =>
        void db
          .runTransaction(async (tx) => {
            const current = (await tx.get(ref)).data();
            if (
              (
                await tx.get(
                  db.collection('deleted_accounts').doc(row.accountId),
                )
              ).exists
            )
              return;
            if (current?.leaseToken === token && current.status === 'running')
              tx.update(ref, {
                availableAt: new Date(Date.now() + LEASE_MS).toISOString(),
              });
          })
          .catch(() => undefined),
      30000,
    );
    heartbeat.unref();
    try {
      if (row.attempts > 8) {
        await this.finish(row, token, false);
        return;
      }
      await this.flags.account(row.accountId);
      const stored = (
        await db.collection('api_job_inputs').doc(id).get()
      ).data();
      if (!stored || stored.expiresAt.toMillis() <= Date.now())
        throw new GoneException('Job input expired');
      const envelope = JSON.parse(
        this.crypto.open(stored.secret, `${row.accountId}:${id}`),
      );
      const input = validateJob(envelope.request);
      const zplContent = envelope.zplContent ?? input.zplContent;
      if (typeof zplContent !== 'string' || !zplContent)
        throw new BadRequestException('Invalid stored input');
      const result = await this.converter.run({
        operationId: id,
        accountId: row.accountId,
        zplContent,
        labelSize: input.labelSize,
      });
      if (result.jobId !== id || result.status !== 'completed')
        throw new Error('CONVERSION_NOT_COMPLETE');
      await this.finish(row, token, true);
    } catch (error) {
      const inProgress =
        error?.getStatus?.() === 409 &&
        error?.message === 'OPERATION_IN_PROGRESS';
      const terminal =
        !inProgress &&
        (error instanceof GoneException ||
          error instanceof BadRequestException ||
          row.attempts >= 8);
      if (terminal) await this.finish(row, token, false);
      else
        await db.runTransaction(async (tx) => {
          const current = (await tx.get(ref)).data();
          if (
            (await tx.get(db.collection('deleted_accounts').doc(row.accountId)))
              .exists
          )
            return;
          if (current?.leaseToken !== token || current.status !== 'running')
            return;
          tx.update(ref, {
            status: 'queued',
            ...(inProgress ? { attempts: Math.max(0, row.attempts - 1) } : {}),
            leaseToken: FieldValue.delete(),
            availableAt: new Date(
              Date.now() +
                (inProgress
                  ? 60000
                  : Math.min(3600000, 1000 * 2 ** row.attempts)),
            ).toISOString(),
            errorCode: 'CONVERSION_RETRY',
            updatedAt: new Date().toISOString(),
          });
        });
    } finally {
      clearInterval(heartbeat);
    }
  }
  private async renderInput(
    accountId: string,
    input: ReturnType<typeof validateJob>,
  ): Promise<string> {
    if (input.zplContent) return input.zplContent;
    const rendered = await this.templates.renderRows(
      accountId,
      input.templateId,
      input.templateVersion,
      input.rows,
    );
    if (rendered.labelSize !== input.labelSize)
      throw new BadRequestException('Template labelSize mismatch');
    return rendered.zplContent;
  }
  private async finish(row: any, token: string, success: boolean) {
    const db = this.store.getClient();
    const ref = db.collection('api_jobs').doc(row.id);
    await db.runTransaction(async (tx) => {
      const current = (await tx.get(ref)).data();
      const counter = db
        .collection('api_account_limits')
        .doc(hash(row.accountId));
      const counts = await tx.get(counter);
      if (
        (await tx.get(db.collection('deleted_accounts').doc(row.accountId)))
          .exists
      )
        return;
      if (
        current?.leaseToken !== token ||
        current.status !== 'running' ||
        current.availableAt <= new Date().toISOString()
      )
        return;
      const now = new Date().toISOString();
      if (success)
        await this.events.recordServerEvent(
          {
            eventId: row.id,
            operationId: row.id,
            schemaVersion: 1,
            eventName: 'api_job_succeeded',
            isSynthetic: row.testMode === true,
            accountId: row.accountId,
            featureId: 'self_service_api',
            featureVersion: row.featureVersion,
            occurredAt: now,
            source: 'api',
            jobId: row.id,
          },
          tx,
        );
      const status = success ? 'succeeded' : 'failed';
      tx.update(ref, {
        status,
        leaseToken: FieldValue.delete(),
        availableAt: FieldValue.delete(),
        updatedAt: now,
        ...(!success
          ? { errorCode: 'CONVERSION_FAILED' }
          : { errorCode: FieldValue.delete() }),
      });
      tx.set(
        counter,
        { jobs: Math.max(0, (counts.get('jobs') ?? 1) - 1) },
        { merge: true },
      );
      if (row.callbackId) {
        const eventId = operationUuid(
          'callback',
          row.id,
          status,
          String(row.generation),
        );
        const payload = {
          schemaVersion: 1,
          eventId,
          eventName: `api_job.${status}`,
          testMode: row.testMode === true,
          jobId: row.id,
          status,
          occurredAt: now,
        };
        tx.create(db.collection('api_callback_deliveries').doc(eventId), {
          id: eventId,
          accountId: row.accountId,
          callbackId: row.callbackId,
          jobId: row.id,
          payload,
          state: 'pending',
          attempts: 0,
          availableAt: now,
          createdAt: now,
          expiresAt: Timestamp.fromMillis(Date.now() + 90 * 86400000),
        });
      }
    });
  }
}
