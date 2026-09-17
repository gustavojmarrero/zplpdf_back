import {
  DriveRecipeAdapter,
  driveRecipeLimits,
} from './drive-recipe.adapter.js';
import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  Optional,
  NotFoundException,
} from '@nestjs/common';
import { FieldValue, Timestamp } from '@google-cloud/firestore';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { isUUID } from 'class-validator';
import { FirestoreService } from '../cache/firestore.service.js';
import { FeatureFlagsService } from '../product-observability/feature-flags.service.js';
import { ProductObservabilityService } from '../product-observability/product-observability.service.js';
import { PublicApiCrypto, hash } from '../public-api/public-api.crypto.js';
import { operationUuid } from '../public-api/api-job-validation.js';
import { ZplService } from '../zpl/zpl.service.js';
import { ZplValidatorService } from '../zpl/validation/zpl-validator.service.js';
import { StorageService } from '../storage/storage.service.js';
import { LabelSize } from '../zpl/enums/label-size.enum.js';
import {
  GoogleDriveProvider,
  DRIVE_SCOPES,
  DriveProviderError,
} from './google-drive.provider.js';
import { queueDriveRevocation } from './drive-revocation.repository.js';
const DRIVE_ID = /^[A-Za-z0-9_-]{1,200}$/;
@Injectable()
export class FolderAutomationService {
  constructor(
    private readonly store: FirestoreService,
    private readonly flags: FeatureFlagsService,
    private readonly events: ProductObservabilityService,
    private readonly crypto: PublicApiCrypto,
    private readonly provider: GoogleDriveProvider,
    private readonly zpl: ZplService,
    private readonly validator: ZplValidatorService,
    private readonly storage: StorageService,
    @Optional() private readonly recipes?: DriveRecipeAdapter,
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
  async start(accountId: string, input: any) {
    if (
      !input ||
      Array.isArray(input) ||
      typeof input !== 'object' ||
      Object.keys(input).length
    )
      throw new BadRequestException();
    await this.flags.assertFeatureAvailable(accountId, 'folder_automation');
    this.provider.settings();
    const state = randomBytes(32).toString('base64url'),
      verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const expiresAt = Timestamp.fromMillis(Date.now() + 600000);
    const secret = this.crypto.seal(
      verifier,
      `drive-state:${accountId}:${hash(state)}`,
    );
    await this.db().runTransaction(async (tx) => {
      await this.live(tx, accountId);
      tx.create(this.db().collection('drive_oauth_states').doc(hash(state)), {
        accountId,
        verifier: secret,
        used: false,
        expiresAt,
      });
    });
    return {
      authorizationUrl: this.provider.authorization(state, challenge),
      stateExpiresAt: new Date(expiresAt.toMillis()).toISOString(),
    };
  }
  async complete(accountId: string, input: any) {
    if (
      !input ||
      Array.isArray(input) ||
      typeof input !== 'object' ||
      Object.keys(input).some((k) => !['state', 'code'].includes(k)) ||
      typeof input.state !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.state) ||
      typeof input.code !== 'string' ||
      !input.code ||
      input.code.length > 4096
    )
      throw new BadRequestException('Invalid OAuth response');
    const flag = await this.flags.assertFeatureAvailable(
      accountId,
      'folder_automation',
    );
    const verifier = await this.db().runTransaction(async (tx) => {
      await this.live(tx, accountId);
      const ref = this.db()
        .collection('drive_oauth_states')
        .doc(hash(input.state));
      const row = (await tx.get(ref)).data();
      if (
        !row ||
        row.accountId !== accountId ||
        row.used ||
        row.expiresAt.toMillis() <= Date.now()
      )
        throw new BadRequestException('Invalid OAuth state');
      tx.update(ref, { used: true, verifier: FieldValue.delete() });
      return this.crypto.open(
        row.verifier,
        `drive-state:${accountId}:${hash(input.state)}`,
      );
    });
    const tokens = await this.provider.exchange(input.code, verifier);
    if (
      typeof tokens.refresh_token !== 'string' ||
      typeof tokens.access_token !== 'string' ||
      !DRIVE_SCOPES.every((scope) =>
        String(tokens.scope ?? '')
          .split(' ')
          .includes(scope),
      )
    ) {
      // A rejected grant is still a live provider credential. Keep it encrypted
      // in the revocation outbox, including when offline access was not granted.
      const rejectedToken = tokens.refresh_token || tokens.access_token;
      if (typeof rejectedToken === 'string' && rejectedToken) {
        const rejectedId = randomUUID();
        const rejectedSecret = this.crypto.seal(
          rejectedToken,
          `drive:${accountId}:${rejectedId}`,
        );
        await this.db().runTransaction(async (tx) => {
          queueDriveRevocation(
            tx,
            this.db(),
            {
              id: rejectedId,
              accountId,
              secret: rejectedSecret,
            },
            undefined,
          );
        });
      }
      throw new BadRequestException('Drive scopes and offline access required');
    }
    const id = randomUUID();
    const secret = this.crypto.seal(
      tokens.refresh_token,
      `drive:${accountId}:${id}`,
    );
    const saved = await this.db().runTransaction(async (tx) => {
      const deleted = await tx.get(
        this.db().collection('deleted_accounts').doc(accountId),
      );
      if (deleted.exists) {
        queueDriveRevocation(
          tx,
          this.db(),
          { id, accountId, secret },
          undefined,
        );
        return false;
      }
      tx.create(this.db().collection('drive_connections').doc(id), {
        id,
        accountId,
        secret,
        featureVersion: flag.featureVersion,
        status: 'unconfigured',
        version: 1,
        createdAt: new Date().toISOString(),
        revokedAt: null,
        scanPhase: 'initial',
        pageToken: null,
        startPageToken: null,
      });
      return true;
    });
    if (!saved) throw new GoneException('Account unavailable');
    return { id, version: 1, status: 'unconfigured' };
  }
  private async owned(accountId: string, id: string) {
    if (!isUUID(id, '4')) throw new NotFoundException();
    const row = (
      await this.db().collection('drive_connections').doc(id).get()
    ).data();
    if (!row || row.accountId !== accountId) throw new NotFoundException();
    return row;
  }
  async connections(accountId: string) {
    const rows = await this.db()
      .collection('drive_connections')
      .where('accountId', '==', accountId)
      .limit(100)
      .get();
    return { items: rows.docs.map((d) => this.safeConnection(d.data())) };
  }
  private safeConnection(row: any) {
    const {
      secret: _secret,
      recipeSnapshot: _snapshot,
      pageToken: _page,
      startPageToken: _start,
      leaseToken: _lease,
      ...safe
    } = row;
    return Object.fromEntries(
      Object.entries(safe).filter(
        ([, value]) => !(value instanceof FieldValue),
      ),
    );
  }
  private async access(row: any) {
    if (row.revokedAt || row.status === 'disconnected')
      throw new GoneException('Connection revoked');
    return this.provider.refresh(
      this.crypto.open(row.secret, `drive:${row.accountId}:${row.id}`),
    );
  }
  async picker(accountId: string, id: string, input: any) {
    if (
      !input ||
      Array.isArray(input) ||
      typeof input !== 'object' ||
      Object.keys(input).length
    )
      throw new BadRequestException();
    await this.flags.assertFeatureAvailable(accountId, 'folder_automation');
    const row = await this.owned(accountId, id);
    if (row.revokedAt) throw new GoneException('Connection revoked');
    const result = await this.provider.picker(
      this.crypto.open(row.secret, `drive:${accountId}:${id}`),
    );
    await this.db().runTransaction(async (tx) => {
      await this.live(tx, accountId);
      const current = (
        await tx.get(this.db().collection('drive_connections').doc(id))
      ).data();
      if (!current || current.revokedAt || current.version !== row.version)
        throw new ConflictException('Connection changed');
    });
    return result;
  }
  async configure(accountId: string, id: string, input: any) {
    if (
      !input ||
      Array.isArray(input) ||
      typeof input !== 'object' ||
      Object.keys(input).some(
        (k) =>
          ![
            'expectedVersion',
            'inputFolderId',
            'outputFolderId',
            'labelSize',
            'recipeVersion',
            'enabled',
            'recipe',
          ].includes(k),
      ) ||
      !Number.isSafeInteger(input.expectedVersion) ||
      !DRIVE_ID.test(input.inputFolderId ?? '') ||
      !DRIVE_ID.test(input.outputFolderId ?? '') ||
      input.inputFolderId === input.outputFolderId ||
      !Object.values(LabelSize).includes(input.labelSize) ||
      !Number.isSafeInteger(input.recipeVersion) ||
      input.recipeVersion < 1 ||
      typeof input.enabled !== 'boolean'
    )
      throw new BadRequestException('Invalid Drive recipe');
    if (input.enabled)
      await this.flags.assertFeatureAvailable(accountId, 'folder_automation');
    const resolvedRecipe = this.recipes
      ? await this.recipes.resolve(accountId, input.recipe)
      : input.recipe && input.recipe.kind !== 'zpl'
        ? (() => {
            throw new BadRequestException('DRIVE_RECIPE_UNAVAILABLE');
          })()
        : {
            recipe: { kind: 'zpl' },
            snapshot: { kind: 'zpl' },
            fingerprint: 'zpl-v1',
          };
    const row = await this.owned(accountId, id);
    const access = await this.access(row);
    const [source, target] = await Promise.all([
      this.provider.file(access, input.inputFolderId),
      this.provider.file(access, input.outputFolderId),
    ]);
    if (
      source.mimeType !== 'application/vnd.google-apps.folder' ||
      target.mimeType !== 'application/vnd.google-apps.folder' ||
      source.trashed ||
      target.trashed ||
      source.capabilities?.canListChildren === false ||
      target.capabilities?.canAddChildren !== true
    )
      throw new BadRequestException('Folder permissions required');
    return this.db().runTransaction(async (tx) => {
      await this.live(tx, accountId);
      const ref = this.db().collection('drive_connections').doc(id);
      const current = (await tx.get(ref)).data();
      if (
        !current ||
        current.accountId !== accountId ||
        current.version !== input.expectedVersion ||
        current.revokedAt
      )
        throw new ConflictException('Connection version changed');
      const changed =
        current.inputFolderId !== input.inputFolderId ||
        current.outputFolderId !== input.outputFolderId ||
        current.labelSize !== input.labelSize ||
        (current.recipeFingerprint ?? 'zpl-v1') !== resolvedRecipe.fingerprint;
      if (
        current.recipeVersion &&
        (input.recipeVersion < current.recipeVersion ||
          (changed && input.recipeVersion === current.recipeVersion))
      )
        throw new ConflictException('New recipeVersion required');
      const reset = changed || current.recipeVersion !== input.recipeVersion;
      const update = {
        inputFolderId: input.inputFolderId,
        outputFolderId: input.outputFolderId,
        labelSize: input.labelSize,
        recipeVersion: input.recipeVersion,
        recipe: resolvedRecipe.recipe,
        recipeSnapshot: resolvedRecipe.snapshot,
        recipeFingerprint: resolvedRecipe.fingerprint,
        status: input.enabled ? 'active' : 'paused',
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
        nextScanAt: input.enabled
          ? new Date().toISOString()
          : FieldValue.delete(),
        leaseToken: FieldValue.delete(),
        ...(reset
          ? { scanPhase: 'initial', pageToken: null, startPageToken: null }
          : {}),
      };
      tx.update(ref, update);
      return this.safeConnection({ ...current, ...update });
    });
  }
  async setEnabled(accountId: string, id: string, input: any) {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (k) => !['expectedVersion', 'enabled'].includes(k),
      ) ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 1 ||
      typeof input.enabled !== 'boolean'
    )
      throw new BadRequestException('Invalid connection state');
    if (input.enabled)
      await this.flags.assertFeatureAvailable(accountId, 'folder_automation');
    await this.owned(accountId, id);
    return this.db().runTransaction(async (tx) => {
      await this.live(tx, accountId);
      const ref = this.db().collection('drive_connections').doc(id);
      const current = (await tx.get(ref)).data();
      if (
        !current ||
        current.accountId !== accountId ||
        current.version !== input.expectedVersion ||
        current.revokedAt ||
        !['active', 'paused'].includes(current.status)
      )
        throw new ConflictException('Connection version changed');
      const update = {
        status: input.enabled ? 'active' : 'paused',
        version: current.version + 1,
        nextScanAt: input.enabled
          ? new Date().toISOString()
          : FieldValue.delete(),
        leaseToken: FieldValue.delete(),
        updatedAt: new Date().toISOString(),
      };
      tx.update(ref, update);
      return this.safeConnection({ ...current, ...update });
    });
  }
  async disconnect(accountId: string, id: string, input: any) {
    if (
      !input ||
      Array.isArray(input) ||
      typeof input !== 'object' ||
      Object.keys(input).some((k) => k !== 'expectedVersion') ||
      !Number.isSafeInteger(input.expectedVersion)
    )
      throw new BadRequestException();
    await this.owned(accountId, id);
    await this.db().runTransaction(async (tx) => {
      const ref = this.db().collection('drive_connections').doc(id);
      const current = (await tx.get(ref)).data();
      const revocationRef = this.db().collection('drive_revocations').doc(id);
      const receipt = (await tx.get(revocationRef)).data();
      if (
        current?.accountId !== accountId ||
        current.version !== input.expectedVersion
      )
        throw new ConflictException('Connection version changed');
      if (current.status === 'disconnected') return;
      queueDriveRevocation(tx, this.db(), current, receipt);
      if (receipt?.status === 'failed')
        tx.update(revocationRef, {
          status: 'queued',
          attempts: 0,
          availableAt: new Date().toISOString(),
          errorCode: FieldValue.delete(),
        });
      tx.update(ref, {
        status: 'disconnecting',
        version: current.version + 1,
        revokedAt: current.revokedAt ?? new Date().toISOString(),
        nextScanAt: FieldValue.delete(),
        leaseToken: FieldValue.delete(),
      });
    });
    await this.revokeOne(id);
    return this.safeConnection(await this.owned(accountId, id));
  }
  private async revokeOne(id: string) {
    const ref = this.db().collection('drive_revocations').doc(id),
      token = randomUUID();
    const row: FirebaseFirestore.DocumentData = await this.db().runTransaction(
      async (tx) => {
        const current = (await tx.get(ref)).data();
        if (
          !current ||
          !['queued', 'delivering'].includes(current.status) ||
          !current.availableAt ||
          current.availableAt > new Date().toISOString()
        )
          return null;
        tx.update(ref, {
          status: 'delivering',
          leaseToken: token,
          attempts: current.attempts + 1,
          availableAt: new Date(Date.now() + 60000).toISOString(),
        });
        return { ...current, attempts: current.attempts + 1 };
      },
    );
    if (!row) return 'skipped';
    try {
      await this.provider.revoke(
        this.crypto.open(row.secret, `drive:${row.accountId}:${id}`),
      );
    } catch {
      await this.db().runTransaction(async (tx) => {
        const current = (await tx.get(ref)).data();
        if (current?.leaseToken !== token) return;
        const failed = row.attempts >= 8;
        tx.update(ref, {
          status: failed ? 'failed' : 'queued',
          errorCode: 'DRIVE_REVOCATION_FAILED',
          leaseToken: FieldValue.delete(),
          availableAt: failed
            ? FieldValue.delete()
            : new Date(
                Date.now() + Math.min(3600000, 60000 * 2 ** (row.attempts - 1)),
              ).toISOString(),
        });
      });
      return 'failed';
    }
    await this.db().runTransaction(async (tx) => {
      const current = (await tx.get(ref)).data();
      const connectionRef = this.db().collection('drive_connections').doc(id);
      const connection = (await tx.get(connectionRef)).data();
      if (current?.leaseToken !== token) return;
      tx.update(ref, {
        status: 'acknowledged',
        secret: FieldValue.delete(),
        leaseToken: FieldValue.delete(),
        availableAt: FieldValue.delete(),
        completedAt: new Date().toISOString(),
        expiresAt: Timestamp.fromMillis(Date.now() + 7 * 86400000),
      });
      if (connection?.accountId === row.accountId)
        tx.update(connectionRef, {
          status: 'disconnected',
          secret: FieldValue.delete(),
        });
    });
    return 'acknowledged';
  }
  async revokePending(limit = 10) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new BadRequestException();
    const rows = await this.db()
      .collection('drive_revocations')
      .where('availableAt', '<=', new Date().toISOString())
      .orderBy('availableAt')
      .limit(limit)
      .get();
    const outcomes = {
      scanned: rows.size,
      acknowledged: 0,
      failed: 0,
      skipped: 0,
      persistenceErrors: 0,
    };
    for (const row of rows.docs) {
      try {
        outcomes[await this.revokeOne(row.id)]++;
      } catch {
        outcomes.persistenceErrors++;
      } // Durable lease remains recoverable; report failure, continue other rows.
    }
    return outcomes;
  }
  async runs(accountId: string, id: string) {
    const connection = await this.owned(accountId, id);
    const rows = await this.db()
      .collection('drive_runs')
      .where('connectionId', '==', id)
      .limit(100)
      .get();
    return {
      items: rows.docs.map((d) => {
        const {
          leaseToken: _lease,
          recipeSnapshot: _snapshot,
          ...safe
        } = d.data();
        return {
          ...safe,
          expiresAt: safe.expiresAt.toDate().toISOString(),
          retryable:
            safe.status === 'failed' &&
            connection.status === 'active' &&
            !connection.revokedAt &&
            safe.expiresAt.toMillis() > Date.now(),
        };
      }),
    };
  }
  private candidate(connection: any, file: any) {
    const limits = driveRecipeLimits(connection.recipe);
    return (
      file &&
      !file.trashed &&
      file.parents?.includes(connection.inputFolderId) &&
      !file.parents.includes(connection.outputFolderId) &&
      file.id !== connection.outputFolderId &&
      !file.appProperties?.zplpdfOutput &&
      limits.mimes.includes(file.mimeType) &&
      DRIVE_ID.test(file.id ?? '') &&
      typeof file.headRevisionId === 'string' &&
      Number(file.size) > 0 &&
      Number(file.size) <= limits.maxBytes
    );
  }
  async scanDue(limit = 10) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new BadRequestException();
    const rows = await this.db()
      .collection('drive_connections')
      .where('nextScanAt', '<=', new Date().toISOString())
      .orderBy('nextScanAt')
      .limit(limit)
      .get();
    for (const row of rows.docs) await this.scanOne(row.id);
    return { scanned: rows.size };
  }
  async scanOne(id: string) {
    const ref = this.db().collection('drive_connections').doc(id);
    const token = randomUUID();
    const row: any = await this.db().runTransaction(async (tx) => {
      const current = (await tx.get(ref)).data();
      if (
        !current ||
        current.status !== 'active' ||
        current.nextScanAt > new Date().toISOString()
      )
        return null;
      await this.live(tx, current.accountId);
      tx.update(ref, {
        leaseToken: token,
        nextScanAt: new Date(Date.now() + 120000).toISOString(),
      });
      return current;
    });
    if (!row) return;
    try {
      await this.flags.assertFeatureAvailable(
        row.accountId,
        'folder_automation',
      );
      const access = await this.access(row);
      const start =
        row.startPageToken ?? (await this.provider.startToken(access));
      let pageToken = row.pageToken,
        phase = row.scanPhase;
      for (let page = 0; page < 5; page++) {
        const result =
          phase === 'initial'
            ? await this.provider.listFiles(
                access,
                row.inputFolderId,
                pageToken ?? undefined,
              )
            : await this.provider.changes(access, pageToken ?? start);
        if (result.incompleteSearch) throw new Error('DRIVE_INCOMPLETE_SEARCH');
        const files =
          phase === 'initial'
            ? result.files
            : (result.changes ?? [])
                .filter((change) => !change.removed)
                .map((change) => change.file);
        if (!Array.isArray(files)) throw new Error('DRIVE_INVALID_PAGE');
        const next = result.nextPageToken ?? null;
        const finished =
          phase === 'initial' ? !next : !next && !!result.newStartPageToken;
        if (phase === 'changes' && !next && !result.newStartPageToken)
          throw new Error('DRIVE_CURSOR_MISSING');
        const nextPhase = phase === 'initial' && finished ? 'changes' : phase;
        const newPage =
          next ?? (phase === 'initial' ? start : result.newStartPageToken);
        await this.db().runTransaction(async (tx) => {
          await this.live(tx, row.accountId);
          const current = (await tx.get(ref)).data();
          if (
            current?.leaseToken !== token ||
            current.version !== row.version ||
            current.nextScanAt <= new Date().toISOString() ||
            current.status !== 'active'
          )
            throw new ConflictException('Scan changed');
          const candidates = files
            .filter((file) => this.candidate(row, file))
            .map((file) => ({
              file,
              id: operationUuid(
                'drive-run',
                id,
                file.id,
                file.headRevisionId,
                String(row.recipeVersion),
              ),
            }));
          const unique = [
            ...new Map(candidates.map((item) => [item.id, item])).values(),
          ];
          const previous = await Promise.all(
            unique.map((item) =>
              tx.get(this.db().collection('drive_runs').doc(item.id)),
            ),
          );
          unique.forEach((item, i) => {
            if (previous[i].exists) return;
            tx.create(this.db().collection('drive_runs').doc(item.id), {
              id: item.id,
              accountId: row.accountId,
              connectionId: id,
              fileId: item.file.id,
              revisionId: item.file.headRevisionId,
              sourceChecksum: item.file.md5Checksum ?? null,
              recipeVersion: row.recipeVersion,
              recipe: row.recipe ?? { kind: 'zpl' },
              recipeSnapshot: row.recipeSnapshot ?? { kind: 'zpl' },
              labelSize: row.labelSize,
              outputFolderId: row.outputFolderId,
              inputFolderId: row.inputFolderId,
              featureVersion: row.featureVersion,
              status: 'queued',
              attempts: 0,
              createdAt: new Date().toISOString(),
              availableAt: new Date().toISOString(),
              expiresAt: Timestamp.fromMillis(Date.now() + 90 * 86400000),
            });
          });
          tx.update(ref, {
            startPageToken: start,
            pageToken: newPage,
            scanPhase: nextPhase,
            lastScanAt: new Date().toISOString(),
            lastScanStatus: finished ? 'complete' : 'partial',
            nextScanAt: new Date(
              Date.now() + (finished ? 300000 : 120000),
            ).toISOString(),
          });
        });
        pageToken = newPage;
        phase = nextPhase;
        if (finished) break;
      }
    } catch (error) {
      await this.db().runTransaction(async (tx) => {
        const current = (await tx.get(ref)).data();
        if (current?.leaseToken !== token) return;
        tx.update(ref, {
          ...(error instanceof DriveProviderError && error.status === 410
            ? { scanPhase: 'initial', pageToken: null, startPageToken: null }
            : {}),
          lastScanStatus: 'failed',
          errorCode: 'DRIVE_SCAN_FAILED',
          nextScanAt: new Date(Date.now() + 300000).toISOString(),
        });
      });
      throw error;
    } finally {
      await this.db().runTransaction(async (tx) => {
        const current = (await tx.get(ref)).data();
        if (current?.leaseToken === token)
          tx.update(ref, { leaseToken: FieldValue.delete() });
      });
    }
  }
  async retry(accountId: string, id: string, key: string) {
    if (!isUUID(id, '4')) throw new NotFoundException();
    if (!/^[\w.:-]{1,128}$/.test(key ?? ''))
      throw new BadRequestException('Idempotency-Key required');
    await this.flags.assertFeatureAvailable(accountId, 'folder_automation');
    return this.db().runTransaction(async (tx) => {
      await this.live(tx, accountId);
      const ref = this.db().collection('drive_runs').doc(id);
      const receiptRef = this.db()
        .collection('drive_retry_requests')
        .doc(operationUuid('drive-retry', accountId, key));
      const receipt = (await tx.get(receiptRef)).data();
      const row = (await tx.get(ref)).data();
      if (!row || row.accountId !== accountId) throw new NotFoundException();
      if (receipt) {
        if (receipt.runId !== id || receipt.accountId !== accountId)
          throw new ConflictException('IDEMPOTENCY_KEY_REUSED');
        return { id, status: row.status, duplicate: true };
      }
      const c = (
        await tx.get(
          this.db().collection('drive_connections').doc(row.connectionId),
        )
      ).data();
      if (
        row.status !== 'failed' ||
        c?.status !== 'active' ||
        row.expiresAt.toMillis() <= Date.now()
      )
        throw new ConflictException('Run cannot retry');
      tx.update(ref, {
        status: 'queued',
        attempts: 0,
        errorCode: FieldValue.delete(),
        availableAt: new Date().toISOString(),
      });
      tx.create(receiptRef, { accountId, runId: id, expiresAt: row.expiresAt });
      return { id, status: 'queued', duplicate: false };
    });
  }
  async processDue(limit = 10) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new BadRequestException();
    const rows = await this.db()
      .collection('drive_runs')
      .where('availableAt', '<=', new Date().toISOString())
      .orderBy('availableAt')
      .limit(limit)
      .get();
    for (const row of rows.docs) await this.processOne(row.id);
    return { scanned: rows.size };
  }
  async processOne(id: string) {
    const ref = this.db().collection('drive_runs').doc(id),
      token = randomUUID();
    const row: any = await this.db().runTransaction(async (tx) => {
      const current = (await tx.get(ref)).data();
      if (
        !current ||
        !['queued', 'running'].includes(current.status) ||
        current.availableAt > new Date().toISOString()
      )
        return null;
      await this.live(tx, current.accountId);
      const c = (
        await tx.get(
          this.db().collection('drive_connections').doc(current.connectionId),
        )
      ).data();
      if (c?.status !== 'active') {
        tx.update(ref, {
          status: c?.status === 'paused' ? 'queued' : 'failed',
          errorCode:
            c?.status === 'paused' ? 'CONNECTION_PAUSED' : 'CONNECTION_REVOKED',
          availableAt:
            c?.status === 'paused'
              ? new Date(Date.now() + 300000).toISOString()
              : FieldValue.delete(),
          leaseToken: FieldValue.delete(),
        });
        return null;
      }
      tx.update(ref, {
        status: 'running',
        leaseToken: token,
        attempts: current.attempts + 1,
        availableAt: new Date(Date.now() + 600000).toISOString(),
      });
      return { ...current, attempts: current.attempts + 1 };
    });
    if (!row) return;
    let leaseHealthy = true;
    const timer = setInterval(
      () =>
        void this.db()
          .runTransaction(async (tx) => {
            const current = (await tx.get(ref)).data();
            if (current?.leaseToken === token)
              tx.update(ref, {
                availableAt: new Date(Date.now() + 600000).toISOString(),
              });
          })
          .catch(() => {
            leaseHealthy = false;
          }),
      30000,
    );
    timer.unref();
    try {
      if (row.attempts > 8 || row.expiresAt.toMillis() <= Date.now())
        throw new GoneException('Run expired');
      const connection = await this.owned(row.accountId, row.connectionId);
      if (connection.status !== 'active')
        throw new ConflictException('Connection paused');
      await this.flags.assertFeatureAvailable(
        row.accountId,
        'folder_automation',
      );
      const access = await this.access(connection);
      let outputId = row.outputId;
      if (!outputId) {
        const generated = await this.provider.outputId(access);
        await this.db().runTransaction(async (tx) => {
          const current = (await tx.get(ref)).data();
          if (current?.leaseToken !== token)
            throw new ConflictException('Lease lost');
          outputId = current.outputId ?? generated;
          tx.update(ref, { outputId });
        });
      }
      // Recover the external receipt before touching a possibly expired source revision.
      if (row.outputChecksum) {
        let receipt: any;
        try {
          receipt = await this.provider.file(access, outputId);
        } catch (error) {
          if (!(error instanceof DriveProviderError) || error.status !== 404)
            throw error;
        }
        if (receipt) {
          if (
            receipt.trashed ||
            receipt.id !== outputId ||
            receipt.appProperties?.zplpdfRunId !== id ||
            !receipt.parents?.includes(row.outputFolderId) ||
            receipt.mimeType !== 'application/pdf' ||
            receipt.md5Checksum !== row.outputChecksum
          )
            throw new BadRequestException('Output receipt mismatch');
          await this.finish(row, token, outputId);
          return;
        }
      }
      const source = await this.provider.revision(
        access,
        row.fileId,
        row.revisionId,
        driveRecipeLimits(row.recipe).maxBytes,
      );
      if (
        !source.length ||
        source.length > driveRecipeLimits(row.recipe).maxBytes ||
        (row.sourceChecksum &&
          createHash('md5').update(source).digest('hex') !== row.sourceChecksum)
      )
        throw new BadRequestException('Source revision mismatch');
      let converted: { status: string };
      if (row.recipe?.kind && row.recipe.kind !== 'zpl') {
        if (!this.recipes || !row.recipeSnapshot)
          throw new BadRequestException('DRIVE_RECIPE_UNAVAILABLE');
        converted = await this.recipes.convert(
          row.accountId,
          id,
          source,
          row.recipeSnapshot,
        );
      } else {
        const zplContent = source.toString('utf8');
        if (
          !(await this.validator.validate(zplContent, { language: 'en' }))
            .isValid
        )
          throw new BadRequestException('Invalid source ZPL');
        const labels = (await this.zpl.countLabels(zplContent)).data
          .totalLabels;
        if (!Number.isSafeInteger(labels) || labels < 1 || labels > 500)
          throw new BadRequestException('Label page limit');
        converted = await this.zpl.runDurableConversion({
          operationId: id,
          userId: row.accountId,
          zplContent,
          labelSize: row.labelSize,
        });
      }
      if (converted.status !== 'completed')
        throw new Error('CONVERSION_NOT_COMPLETE');
      const operation = (
        await this.db().collection('durable_operations').doc(id).get()
      ).data();
      if (
        operation?.userId !== row.accountId ||
        operation.status !== 'completed' ||
        !operation.storagePath
      )
        throw new Error('OUTPUT_UNAVAILABLE');
      const pdf = await this.storage.readFile(
        operation.storagePath,
        20 * 1024 * 1024,
      );
      if (!pdf || pdf.subarray(0, 5).toString() !== '%PDF-')
        throw new Error('OUTPUT_UNAVAILABLE');
      const document = await PDFDocument.load(pdf);
      if (document.getPageCount() < 1 || document.getPageCount() > 500)
        throw new BadRequestException('PDF page limit');
      if (!leaseHealthy) throw new ConflictException('Lease renewal failed');
      await this.db().runTransaction(async (tx) => {
        await this.live(tx, row.accountId);
        const current = (await tx.get(ref)).data();
        const c = (
          await tx.get(
            this.db().collection('drive_connections').doc(row.connectionId),
          )
        ).data();
        if (
          current?.leaseToken !== token ||
          current.availableAt <= new Date().toISOString() ||
          c?.status !== 'active' ||
          c.version !== connection.version
        )
          throw new ConflictException('Connection changed');
        tx.update(ref, {
          outputChecksum: createHash('md5').update(pdf).digest('hex'),
        });
      });
      await this.provider.upload(access, outputId, row.outputFolderId, pdf, id);
      await this.finish(row, token, outputId);
    } catch (error) {
      const inProgress = error?.message === 'OPERATION_IN_PROGRESS';
      const terminal =
        !inProgress &&
        (error instanceof BadRequestException ||
          error instanceof GoneException ||
          row.attempts >= 8);
      await this.db().runTransaction(async (tx) => {
        const current = (await tx.get(ref)).data();
        if (current?.leaseToken !== token) return;
        tx.update(ref, {
          status: terminal ? 'failed' : 'queued',
          attempts: inProgress ? row.attempts - 1 : row.attempts,
          errorCode: 'DRIVE_RUN_FAILED',
          leaseToken: FieldValue.delete(),
          availableAt: terminal
            ? FieldValue.delete()
            : new Date(Date.now() + 60000).toISOString(),
        });
      });
    } finally {
      clearInterval(timer);
    }
  }
  private async finish(row: any, token: string, outputId: string) {
    await this.db().runTransaction(async (tx) => {
      await this.live(tx, row.accountId);
      const current = (
        await tx.get(this.db().collection('drive_runs').doc(row.id))
      ).data();
      if (
        current?.leaseToken !== token ||
        current.status !== 'running' ||
        current.availableAt <= new Date().toISOString()
      )
        throw new ConflictException('Lease lost');
      const now = new Date().toISOString();
      await this.events.recordServerEvent(
        {
          schemaVersion: 1,
          eventId: row.id,
          operationId: row.id,
          eventName: 'folder_run_succeeded',
          featureId: 'folder_automation',
          featureVersion: row.featureVersion,
          accountId: row.accountId,
          occurredAt: now,
          source: 'folder',
          jobId: row.id,
        },
        tx,
      );
      tx.update(this.db().collection('drive_runs').doc(row.id), {
        status: 'succeeded',
        outputId,
        completedAt: now,
        availableAt: FieldValue.delete(),
        leaseToken: FieldValue.delete(),
      });
    });
  }
}
