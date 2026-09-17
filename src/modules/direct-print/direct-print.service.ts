import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { FieldValue, Timestamp } from '@google-cloud/firestore';
import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { FirestoreService } from '../cache/firestore.service.js';
import { FeatureFlagsService } from '../product-observability/feature-flags.service.js';
import { ProductObservabilityService } from '../product-observability/product-observability.service.js';
import { PublicApiCrypto } from '../public-api/public-api.crypto.js';
import { operationUuid, stableJson } from '../public-api/api-job-validation.js';
import { PrintNodeProvider, PrintProviderError } from './printnode.provider.js';
import { OwnedPdfService } from './owned-pdf.service.js';
@Injectable()
export class DirectPrintService {
  constructor(
    private readonly store: FirestoreService,
    private readonly flags: FeatureFlagsService,
    private readonly events: ProductObservabilityService,
    private readonly crypto: PublicApiCrypto,
    private readonly provider: PrintNodeProvider,
    private readonly pdf: OwnedPdfService,
  ) {}
  private db() {
    return this.store.getClient();
  }
  private async live(tx: any, accountId: string) {
    if (
      (await tx.get(this.db().collection('deleted_accounts').doc(accountId)))
        .exists
    )
      throw new GoneException('Account unavailable');
  }
  async connect(accountId: string, input: any) {
    if (
      !input ||
      Array.isArray(input) ||
      typeof input !== 'object' ||
      Object.keys(input).some((k) => k !== 'apiKey') ||
      typeof input.apiKey !== 'string' ||
      input.apiKey.length < 20 ||
      input.apiKey.length > 200
    )
      throw new BadRequestException('Invalid provider key');
    await this.flags.assertFeatureAvailable(accountId, 'direct_print');
    const id = randomUUID();
    const secret = this.crypto.seal(input.apiKey, `print:${accountId}:${id}`);
    await this.provider.printers(input.apiKey);
    const row = {
      id,
      accountId,
      secret,
      version: 1,
      revokedAt: null,
      createdAt: new Date().toISOString(),
    };
    await this.db().runTransaction(async (tx) => {
      await this.live(tx, accountId);
      tx.create(this.db().collection('print_connections').doc(id), row);
    });
    return { id, version: 1 };
  }
  async connections(accountId: string) {
    const rows = await this.db()
      .collection('print_connections')
      .where('accountId', '==', accountId)
      .limit(100)
      .get();
    return {
      items: rows.docs.map((d) => {
        const { secret: _secret, ...safe } = d.data();
        return safe;
      }),
    };
  }
  private async connection(accountId: string, id: string) {
    if (!isUUID(id, '4')) throw new NotFoundException();
    const row = (
      await this.db().collection('print_connections').doc(id).get()
    ).data();
    if (!row || row.accountId !== accountId || row.revokedAt)
      throw new NotFoundException('Connection unavailable');
    return row;
  }
  private key(row: any) {
    return this.crypto.open(row.secret, `print:${row.accountId}:${row.id}`);
  }
  async disconnect(accountId: string, id: string) {
    await this.connection(accountId, id);
    const ref = this.db().collection('print_connections').doc(id);
    await this.db().runTransaction(async (tx) => {
      const row = (await tx.get(ref)).data();
      if (row?.accountId !== accountId) throw new NotFoundException();
      tx.update(ref, {
        secret: FieldValue.delete(),
        revokedAt: new Date().toISOString(),
        version: row.version + 1,
      });
    });
    return {
      revoked: true,
      providerKeyRevocation: 'user_must_revoke_at_printnode',
    };
  }
  async printers(accountId: string, id: string) {
    const connection = await this.connection(accountId, id);
    const printers = await this.provider.printers(this.key(connection));
    return {
      observedAt: new Date().toISOString(),
      items: printers.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        computerId: p.computer?.id,
        clientState: p.computer?.state ?? 'unknown',
        printerState: p.state ?? 'unknown',
      })),
    };
  }
  async create(
    accountId: string,
    key: string,
    input: any,
    reprintOf?: string,
    reprintStateVersion?: number,
  ) {
    if (
      !/^[\w.:-]{1,128}$/.test(key ?? '') ||
      !input ||
      Array.isArray(input) ||
      typeof input !== 'object' ||
      Object.keys(input).some(
        (k) => !['connectionId', 'printerId', 'conversionId'].includes(k),
      ) ||
      !isUUID(input.connectionId, '4') ||
      !isUUID(input.conversionId, '4') ||
      !Number.isSafeInteger(input.printerId) ||
      input.printerId < 1
    )
      throw new BadRequestException('Invalid print request');
    await this.flags.account(accountId);
    const id = operationUuid('print', accountId, key);
    const fingerprint = stableJson({
      ...input,
      reprintOf: reprintOf ?? null,
      reprintStateVersion: reprintStateVersion ?? null,
    });
    const ref = this.db().collection('print_jobs').doc(id);
    const prior = (await ref.get()).data();
    if (prior) {
      if (prior.accountId !== accountId || prior.fingerprint !== fingerprint)
        throw new ConflictException('IDEMPOTENCY_KEY_REUSED');
      return this.safe(prior);
    }
    const flag = await this.flags.assertFeatureAvailable(
      accountId,
      'direct_print',
    );
    const conn = await this.connection(accountId, input.connectionId);
    await this.provider.printer(this.key(conn), input.printerId);
    const source = await this.pdf.load(accountId, input.conversionId);
    return this.db().runTransaction(async (tx) => {
      await this.live(tx, accountId);
      const existing = (await tx.get(ref)).data();
      const current = (
        await tx.get(this.db().collection('print_connections').doc(conn.id))
      ).data();
      const original = reprintOf
        ? (
            await tx.get(this.db().collection('print_jobs').doc(reprintOf))
          ).data()
        : null;
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new ConflictException();
        return this.safe(existing);
      }
      if (
        original &&
        (original.accountId !== accountId ||
          original.version !== reprintStateVersion)
      )
        throw new ConflictException('STATE_VERSION_CHANGED');
      if (reprintOf && !original) throw new NotFoundException();
      if (!current || current.revokedAt || current.version !== conn.version)
        throw new ConflictException('Connection changed');
      const now = new Date().toISOString();
      const row = {
        id,
        accountId,
        ...input,
        connectionVersion: conn.version,
        featureVersion: flag.featureVersion,
        fingerprint,
        reprintOf: reprintOf ?? null,
        storagePath: source.path,
        checksum: source.checksum,
        pages: source.pages,
        status: 'queued',
        version: 1,
        createdAt: now,
        updatedAt: now,
        availableAt: now,
        providerJobId: null,
        expiresAt: Timestamp.fromMillis(Date.now() + 90 * 86400000),
      };
      if (original)
        tx.update(this.db().collection('print_jobs').doc(reprintOf), {
          version: original.version + 1,
          lastReprintId: id,
          updatedAt: now,
        });
      tx.create(ref, row);
      return this.safe(row);
    });
  }
  private safe(row: any) {
    const {
      secret: _secret,
      fingerprint: _fingerprint,
      storagePath: _path,
      checksum: _checksum,
      leaseToken: _token,
      ...safe
    } = row;
    return {
      ...safe,
      stateVersion: row.version,
      expiresAt: row.expiresAt.toDate().toISOString(),
      clientFreshness: !row.clientObservation
        ? 'unknown'
        : Date.now() - Date.parse(row.clientObservation.observedAt) > 120000
          ? 'stale'
          : 'recent',
    };
  }
  private async owned(accountId: string, id: string) {
    if (!isUUID(id, '4')) throw new NotFoundException();
    const row = (await this.db().collection('print_jobs').doc(id).get()).data();
    if (!row || row.accountId !== accountId) throw new NotFoundException();
    return row;
  }
  async jobs(accountId: string) {
    await this.flags.account(accountId);
    const rows = await this.db()
      .collection('print_jobs')
      .where('accountId', '==', accountId)
      .limit(100)
      .get();
    return { items: rows.docs.map((d) => this.safe(d.data())) };
  }
  async status(accountId: string, id: string) {
    return this.safe(await this.owned(accountId, id));
  }
  async reprint(accountId: string, id: string, key: string, input: any) {
    if (
      !input ||
      Array.isArray(input) ||
      typeof input !== 'object' ||
      Object.keys(input).some(
        (k) => !['confirm', 'stateVersion'].includes(k),
      ) ||
      !Number.isSafeInteger(input.stateVersion) ||
      input.confirm !== true
    )
      throw new BadRequestException('Explicit reprint confirmation required');
    const original = await this.owned(accountId, id);
    const prior = /^[\w.:-]{1,128}$/.test(key ?? '')
      ? (
          await this.db()
            .collection('print_jobs')
            .doc(operationUuid('print', accountId, key))
            .get()
        ).data()
      : null;
    if (!prior && original.version !== input.stateVersion)
      throw new ConflictException('STATE_VERSION_CHANGED');
    if (original.status === 'queued')
      throw new ConflictException('Original has not been sent');
    return this.create(
      accountId,
      key,
      {
        connectionId: original.connectionId,
        printerId: original.printerId,
        conversionId: original.conversionId,
      },
      id,
      input.stateVersion,
    );
  }
  async confirm(accountId: string, id: string, input: any) {
    if (
      !input ||
      Array.isArray(input) ||
      typeof input !== 'object' ||
      Object.keys(input).some(
        (k) => !['printed', 'stateVersion'].includes(k),
      ) ||
      !Number.isSafeInteger(input.stateVersion) ||
      input.printed !== true
    )
      throw new BadRequestException('Manual confirmation required');
    await this.owned(accountId, id);
    await this.db().runTransaction(async (tx) => {
      await this.live(tx, accountId);
      const ref = this.db().collection('print_jobs').doc(id);
      const row = (await tx.get(ref)).data();
      if (row?.accountId !== accountId) throw new NotFoundException();
      if (row.version !== input.stateVersion)
        throw new ConflictException('STATE_VERSION_CHANGED');
      if (row.physicalConfirmation) return;
      if (!['sent', 'acknowledged', 'unknown'].includes(row.status))
        throw new ConflictException('Job not submitted');
      const now = new Date().toISOString();
      await this.events.recordServerEvent(
        {
          schemaVersion: 1,
          eventId: operationUuid('print-confirm', id),
          operationId: id,
          eventName: 'print_confirmed',
          featureId: 'direct_print',
          featureVersion: row.featureVersion,
          accountId,
          occurredAt: now,
          source: 'print',
          jobId: id,
        },
        tx,
      );
      tx.update(ref, {
        physicalConfirmation: {
          method: 'manual',
          confirmedBy: accountId,
          confirmedAt: now,
        },
        version: row.version + 1,
      });
    });
    return this.status(accountId, id);
  }
  async dispatchJobs(limit = 10) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new BadRequestException();
    const rows = await this.db()
      .collection('print_jobs')
      .where('availableAt', '<=', new Date().toISOString())
      .orderBy('availableAt')
      .limit(limit)
      .get();
    for (const row of rows.docs) await this.dispatchOne(row.id);
    return { scanned: rows.size };
  }
  async dispatchOne(id: string) {
    const ref = this.db().collection('print_jobs').doc(id);
    const token = randomUUID();
    const row: any = await this.db().runTransaction(async (tx) => {
      const r = (await tx.get(ref)).data();
      if (!r || !r.availableAt || r.availableAt > new Date().toISOString())
        return null;
      await this.live(tx, r.accountId);
      if (r.expiresAt.toMillis() <= Date.now()) {
        tx.update(ref, {
          status: r.dispatchStartedAt ? 'unknown' : 'failed',
          errorCode: 'JOB_EXPIRED',
          version: r.version + 1,
          updatedAt: new Date().toISOString(),
          availableAt: FieldValue.delete(),
        });
        return null;
      }
      if (r.status === 'sent' || r.status === 'unknown') {
        tx.update(ref, {
          leaseToken: token,
          availableAt: new Date(Date.now() + 60000).toISOString(),
        });
        return r;
      }
      if (r.status !== 'queued') return null;
      if (r.dispatchStartedAt) {
        tx.update(ref, {
          status: 'unknown',
          availableAt: FieldValue.delete(),
          errorCode: 'SEND_OUTCOME_UNKNOWN',
          version: r.version + 1,
        });
        return null;
      }
      const c = (
        await tx.get(
          this.db().collection('print_connections').doc(r.connectionId),
        )
      ).data();
      if (!c || c.revokedAt || c.version !== r.connectionVersion) {
        tx.update(ref, {
          status: 'failed',
          availableAt: FieldValue.delete(),
          errorCode: 'CONNECTION_REVOKED',
          version: r.version + 1,
          updatedAt: new Date().toISOString(),
        });
        return null;
      }
      tx.update(ref, {
        dispatchStartedAt: new Date().toISOString(),
        leaseToken: token,
        availableAt: new Date(Date.now() + 60000).toISOString(),
      });
      return r;
    });
    if (!row) return;
    if (row.status === 'sent' || row.status === 'unknown') {
      await this.reconcile(row, token);
      return;
    }
    let providerJobId: number;
    let state = 'failed';
    try {
      await this.flags.assertFeatureAvailable(row.accountId, 'direct_print');
      const conn = await this.connection(row.accountId, row.connectionId);
      const printer = await this.provider.printer(
        this.key(conn),
        row.printerId,
      );
      const source = await this.pdf.load(row.accountId, row.conversionId);
      if (source.checksum !== row.checksum)
        throw new BadRequestException('Source changed');
      await this.db().runTransaction(async (tx) => {
        await this.live(tx, row.accountId);
        const current = (await tx.get(ref)).data();
        const c = (
          await tx.get(
            this.db().collection('print_connections').doc(row.connectionId),
          )
        ).data();
        if (
          current?.leaseToken !== token ||
          current.availableAt <= new Date().toISOString() ||
          !c ||
          c.revokedAt ||
          c.version !== row.connectionVersion
        )
          throw new ConflictException('Dispatch revoked');
        tx.update(ref, {
          clientObservation: {
            state: printer.computer?.state ?? 'unknown',
            observedAt: new Date().toISOString(),
          },
        });
      });
      state = 'unknown';
      providerJobId = await this.provider.submit(
        this.key(conn),
        row.printerId,
        source.pdf,
        id,
      );
      state = 'sent';
    } catch (error) {
      if (
        error instanceof PrintProviderError &&
        error.status &&
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 409, 429].includes(error.status)
      )
        state = 'failed';
    }
    await this.db().runTransaction(async (tx) => {
      await this.live(tx, row.accountId);
      const current = (await tx.get(ref)).data();
      if (
        !current ||
        current.leaseToken !== token ||
        current.status !== 'queued'
      )
        return;
      tx.update(ref, {
        status: state,
        providerJobId: providerJobId ?? null,
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
        availableAt:
          state === 'sent'
            ? new Date(Date.now() + 10000).toISOString()
            : FieldValue.delete(),
        errorCode:
          state === 'unknown'
            ? 'SEND_OUTCOME_UNKNOWN'
            : state === 'failed'
              ? 'SEND_REJECTED'
              : null,
        leaseToken: FieldValue.delete(),
      });
    });
  }
  private async reconcile(row: any, token: string) {
    if (!row.providerJobId) return;
    let states: any[] = [];
    let conn: any;
    try {
      conn = await this.connection(row.accountId, row.connectionId);
      states = await this.provider.states(this.key(conn), row.providerJobId);
    } catch {
      // Poll failures cannot authorize another submission. Persist bounded reconciliation.
    }
    const latest = [...states].sort(
      (a, b) => Date.parse(b.createTimestamp) - Date.parse(a.createTimestamp),
    )[0];
    const exhausted =
      (row.pollAttempts ?? 0) >= 119 ||
      Date.now() - Date.parse(row.dispatchStartedAt) > 86400000;
    const status =
      latest?.state === 'done'
        ? 'acknowledged'
        : ['error', 'expired'].includes(latest?.state)
          ? 'failed'
          : ['new', 'sent_to_client'].includes(latest?.state)
            ? exhausted
              ? 'unknown'
              : 'sent'
            : 'unknown';
    await this.db().runTransaction(async (tx) => {
      await this.live(tx, row.accountId);
      const ref = this.db().collection('print_jobs').doc(row.id);
      const current = (await tx.get(ref)).data();
      if (
        !current ||
        !['sent', 'unknown'].includes(current.status) ||
        current.providerJobId !== row.providerJobId ||
        current.leaseToken !== token
      )
        return;
      const now = new Date().toISOString();
      if (status === 'acknowledged')
        await this.events.recordServerEvent(
          {
            schemaVersion: 1,
            eventId: operationUuid('print-ack', row.id),
            operationId: row.id,
            eventName: 'print_job_acknowledged',
            featureId: 'direct_print',
            featureVersion: row.featureVersion,
            accountId: row.accountId,
            occurredAt: now,
            source: 'print',
            jobId: row.id,
          },
          tx,
        );
      tx.update(ref, {
        status,
        leaseToken: FieldValue.delete(),
        providerState: latest?.state ?? 'unknown',
        pollAttempts: (current.pollAttempts ?? 0) + 1,
        updatedAt: now,
        version: current.version + 1,
        availableAt:
          !exhausted && ['sent', 'unknown'].includes(status)
            ? new Date(Date.now() + 60000).toISOString()
            : FieldValue.delete(),
      });
    });
  }
}
