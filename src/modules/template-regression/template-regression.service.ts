import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DocumentData, Timestamp, Transaction } from '@google-cloud/firestore';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import sharp from 'sharp';
import { FirestoreService } from '../cache/firestore.service.js';
import { StorageService } from '../storage/storage.service.js';
import { ZplService } from '../zpl/zpl.service.js';
import { FeatureFlagsService } from '../product-observability/feature-flags.service.js';
import { ProductObservabilityService } from '../product-observability/product-observability.service.js';
import {
  TemplateRegressionRepository,
  ResourceKind,
} from './template-regression.repository.js';
import {
  COLLECTIONS,
  CreateBaseline,
  CreateRun,
  MAX_IMAGE_BYTES,
  MAX_INPUT_BYTES,
  METADATA_TTL_MS,
  ResourceEnvelope,
  ResourceViews,
  StoredArtifact,
} from './template-regression.types.js';
import {
  approvalNote,
  objectKeys,
  settings,
  uuid,
  validateLabel,
  validateMaskBounds,
  version,
} from './validation.js';
import { REGRESSION_FIXTURES } from './fixtures.js';
import { compareLabelImages } from './image-diff.js';

const hash = (value: Buffer | string) =>
  createHash('sha256').update(value).digest('hex');
@Injectable()
export class TemplateRegressionService {
  constructor(
    private readonly firestore: FirestoreService,
    private readonly storage: StorageService,
    private readonly zpl: ZplService,
    private readonly flags: FeatureFlagsService,
    private readonly events: ProductObservabilityService,
  ) {}
  private repository() {
    return new TemplateRegressionRepository(this.firestore.getClient());
  }
  private feature(accountId: string) {
    return this.flags.assertFeatureAvailable(accountId, 'template_regression');
  }
  async fixtures(accountId: string) {
    await this.feature(accountId);
    return { schemaVersion: 1, fixtures: REGRESSION_FIXTURES };
  }
  async createBaseline(accountId: string, input: CreateBaseline) {
    objectKeys(input, ['operationId', 'name', 'zpl', 'labelSize', 'fixtureId']);
    uuid(input.operationId);
    validateLabel(input.zpl, input.labelSize);
    if (
      typeof input.name !== 'string' ||
      !input.name.trim() ||
      input.name.length > 120 ||
      /[\x00-\x1f]/.test(input.name)
    )
      throw new BadRequestException('INVALID_BASELINE_NAME');
    if (input.fixtureId !== undefined) {
      const fixture = REGRESSION_FIXTURES.find((f) => f.id === input.fixtureId);
      if (
        !fixture ||
        fixture.zpl !== input.zpl ||
        fixture.labelSize !== input.labelSize
      )
        throw new BadRequestException('INVALID_FIXTURE');
    }
    return this.create(
      'baseline',
      accountId,
      {
        operationId: input.operationId,
        name: input.name.trim(),
        labelSize: input.labelSize,
        fixtureId: input.fixtureId ?? null,
      },
      input.zpl,
    );
  }
  async createRun(accountId: string, input: CreateRun) {
    objectKeys(input, [
      'operationId',
      'baselineId',
      'baselineVersion',
      'zpl',
      'labelSize',
      'options',
    ]);
    uuid(input.operationId);
    uuid(input.baselineId);
    version(input.baselineVersion);
    validateLabel(input.zpl, input.labelSize);
    const options = settings(input.options);
    const repository = this.repository();
    await this.feature(accountId);
    const baseline = await repository.get(
      'baseline',
      input.baselineId,
      accountId,
    );
    validateMaskBounds(options, baseline.width, baseline.height);
    return this.create(
      'run',
      accountId,
      {
        operationId: input.operationId,
        baselineId: input.baselineId,
        baselineVersion: input.baselineVersion,
        labelSize: input.labelSize,
        options,
      },
      input.zpl,
    );
  }
  private async create<K extends ResourceKind>(
    kind: K,
    accountId: string,
    input: DocumentData,
    source: string,
  ) {
    const feature = await this.feature(accountId);
    const sourceHash = hash(source);
    const canonical = { ...input, sourceHash };
    const fingerprint = hash(JSON.stringify(canonical));
    const repository = this.repository();
    const claim = await repository.claim(
      kind,
      accountId,
      canonical,
      fingerprint,
      feature.featureVersion,
    );
    if (!claim.completed) await this.execute(accountId, claim.op, source);
    return this.get(kind, accountId, input.operationId);
  }
  private sourcePath(accountId: string, op: DocumentData) {
    return `debug-zpl/${accountId}/regression/${op.id}/source-${op.input.sourceHash}.zpl`;
  }
  private async write(
    accountId: string,
    op: DocumentData,
    name: string,
    buffer: Buffer,
    mime: string,
  ): Promise<StoredArtifact> {
    // A fenced attempt owns its own path; a late renderer cannot overwrite a
    // newer worker's image or any published immutable baseline.
    const path = `debug-zpl/${accountId}/regression/${op.id}/${op.token}/${name}`;
    await this.storage.saveFile(path, buffer, mime);
    return { path, sha256: hash(buffer) };
  }
  private assertPath(accountId: string, artifact: StoredArtifact) {
    if (
      !artifact ||
      typeof artifact.path !== 'string' ||
      !artifact.path.startsWith(`debug-zpl/${accountId}/regression/`) ||
      artifact.path.includes('..') ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256)
    )
      throw new GoneException('ARTIFACT_UNAVAILABLE');
  }
  private async read(
    accountId: string,
    artifact: StoredArtifact,
    maxBytes = MAX_IMAGE_BYTES,
  ) {
    this.assertPath(accountId, artifact);
    const bytes = await this.storage.readFile(artifact.path, maxBytes);
    if (!bytes || hash(bytes) !== artifact.sha256)
      throw new GoneException('ARTIFACT_UNAVAILABLE');
    return bytes;
  }
  private async render(source: string, labelSize: CreateBaseline['labelSize']) {
    const previews = await this.zpl.getLabelsPreview(source, labelSize, {
      maxUniqueLabels: 1,
    });
    if (
      !Array.isArray(previews) ||
      previews.length !== 1 ||
      previews[0].qty !== 1 ||
      typeof previews[0].img !== 'string'
    )
      throw new ServiceUnavailableException('RENDER_FAILED');
    const data = previews[0].img;
    const prefix = 'data:image/png;base64,';
    if (
      !data.startsWith(prefix) ||
      data.length > prefix.length + Math.ceil(MAX_IMAGE_BYTES / 3) * 4
    )
      throw new BadRequestException('INVALID_REGRESSION_IMAGE');
    const encoded = data.slice(prefix.length);
    if (encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded))
      throw new BadRequestException('INVALID_REGRESSION_IMAGE');
    const buffer = Buffer.from(encoded, 'base64');
    if (buffer.toString('base64') !== encoded)
      throw new BadRequestException('INVALID_REGRESSION_IMAGE');
    try {
      if (
        buffer.length > MAX_IMAGE_BYTES ||
        !buffer
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        throw new Error();
      const image = sharp(buffer, { limitInputPixels: 16_000_000 });
      const metadata = await image.metadata();
      if (
        metadata.format !== 'png' ||
        !metadata.width ||
        !metadata.height ||
        metadata.width * metadata.height > 16_000_000 ||
        (metadata.pages ?? 1) !== 1
      )
        throw new Error();
      // Decode fully, so truncated images cannot become successful baselines.
      await image.raw().toBuffer();
      return { buffer, width: metadata.width, height: metadata.height };
    } catch {
      throw new BadRequestException('INVALID_REGRESSION_IMAGE');
    }
  }
  private async verifyArtifacts(accountId: string, row: DocumentData) {
    this.repository().artifactsLive(row);
    await Promise.all([
      this.read(accountId, row.source, MAX_INPUT_BYTES),
      this.read(accountId, row.image),
      ...(row.diffImage ? [this.read(accountId, row.diffImage)] : []),
    ]);
  }
  private async execute(accountId: string, op: DocumentData, source: string) {
    const repository = this.repository();
    try {
      if (hash(source) !== op.input.sourceHash)
        throw new BadRequestException('OPERATION_PAYLOAD_CONFLICT');
      if (op.stage) {
        await this.verifyArtifacts(accountId, {
          ...op.stage,
          artifactsExpireAt: op.artifactsExpireAt,
        });
      } else {
        const sourcePath = this.sourcePath(accountId, op);
        await this.storage.saveFile(
          sourcePath,
          Buffer.from(source),
          'application/zpl',
        );
        // Read fences before rendering as well as before committing outputs.
        await repository.db.runTransaction((tx) =>
          repository.active(tx, accountId, op.id, op.token),
        );
        const rendered = await this.render(source, op.input.labelSize);
        const row = await repository.get(op.kind, op.id, accountId);
        const image = await this.write(
          accountId,
          op,
          'image.png',
          rendered.buffer,
          'image/png',
        );
        const stage: DocumentData = {
          source: { path: sourcePath, sha256: op.input.sourceHash },
          image,
          completedAt: new Date().toISOString(),
        };
        if (op.kind === 'baseline')
          Object.assign(stage, {
            width: rendered.width,
            height: rendered.height,
          });
        else {
          if (Date.parse(row.baselineArtifactsExpireAt) <= Date.now())
            throw new GoneException('ARTIFACTS_EXPIRED');
          const baselineImage = await this.read(accountId, row.baselineImage);
          const result = await compareLabelImages(
            baselineImage,
            rendered.buffer,
            row.options,
          );
          const { diffPng, ...visual } = result;
          stage.visual = visual;
          stage.diffImage = diffPng
            ? await this.write(accountId, op, 'diff.png', diffPng, 'image/png')
            : null;
          stage.payload = {
            changed: row.baselineSource.sha256 !== op.input.sourceHash,
            baselineSha256: row.baselineSource.sha256,
            candidateSha256: op.input.sourceHash,
          };
        }
        await repository.stage(accountId, op.id, op.token, stage);
      }
      await repository.finish(
        accountId,
        op.id,
        op.token,
        async (tx, current, row) => {
          if (op.kind === 'run')
            await this.event(
              tx,
              accountId,
              current.eventId,
              current.id,
              'regression_run_completed',
              current.featureVersion,
              current.stage.completedAt,
              row.isSynthetic,
            );
        },
      );
    } catch (error) {
      // Failures must not undo a completed transaction or clear another lease.
      try {
        await repository.fail(accountId, op.id, op.token);
      } catch {
        /* Tombstone or outage: recovery retains the original fence. */
      }
      if (await this.firestore.isAccountDeletionMarked(accountId)) {
        await this.storage.deleteByPrefix(
          `debug-zpl/${accountId}/regression/${op.id}/`,
        );
      }
      if (
        error instanceof BadRequestException ||
        error instanceof ConflictException ||
        error instanceof GoneException ||
        error instanceof NotFoundException
      )
        throw error;
      throw new ServiceUnavailableException('RENDER_FAILED');
    }
  }
  private event(
    tx: Transaction,
    accountId: string,
    eventId: string,
    operationId: string,
    eventName: 'regression_run_completed' | 'baseline_approved',
    featureVersion: string,
    occurredAt: string,
    isSynthetic: boolean,
  ) {
    return this.events.recordServerEvent(
      {
        eventId,
        schemaVersion: 1,
        eventName,
        accountId,
        featureId: 'template_regression',
        featureVersion,
        operationId,
        occurredAt,
        source: 'api',
        labelCount: 1,
        isSynthetic: Boolean(isSynthetic),
      },
      tx,
    );
  }
  async get<K extends ResourceKind>(
    kind: K,
    accountId: string,
    id: string,
  ): Promise<ResourceEnvelope<K>> {
    if (!isUUID(id, '4')) throw new NotFoundException();
    await this.feature(accountId);
    const row = await this.repository().get(kind, id, accountId);
    return {
      schemaVersion: 1,
      [kind]: await this.present(kind, accountId, row),
    } as ResourceEnvelope<K>;
  }
  async list(kind: ResourceKind, accountId: string) {
    await this.feature(accountId);
    const repository = this.repository();
    const rows = await repository.db.runTransaction(async (tx) => {
      await repository.guard(tx, accountId);
      const snapshot = await tx.get(
        repository.db
          .collection(COLLECTIONS[kind])
          .where('accountId', '==', accountId)
          .orderBy('createdAt', 'desc')
          .limit(50),
      );
      return snapshot.docs
        .map((doc) => doc.data())
        .filter((row) => row.expiresAt.toMillis() > Date.now());
    });
    return {
      schemaVersion: 1,
      [kind === 'baseline' ? 'baselines' : 'runs']: await Promise.all(
        rows.map((row) => this.present(kind, accountId, row)),
      ),
    };
  }
  private async present<K extends ResourceKind>(
    kind: K,
    accountId: string,
    row: DocumentData,
  ): Promise<ResourceViews[K]> {
    const artifact = async (value: StoredArtifact, filename: string) => {
      if (!value) return null;
      this.assertPath(accountId, value);
      return {
        sha256: value.sha256,
        url:
          Date.parse(row.artifactsExpireAt) > Date.now()
            ? await this.storage.generateSignedUrlForPath(
                value.path,
                filename,
                Math.min(
                  15,
                  (Date.parse(row.artifactsExpireAt) - Date.now()) / 60000,
                ),
              )
            : null,
      };
    };
    const common = {
      id: row.id,
      operationId: row.operationId,
      version: row.version,
      status: row.status,
      labelSize: row.labelSize,
      renderer: row.renderer,
      source: await artifact(row.source, 'source.zpl'),
      image: await artifact(row.image, 'label.png'),
      createdAt: row.createdAt,
      artifactsExpireAt: row.artifactsExpireAt,
      metadataExpireAt: row.expiresAt.toDate().toISOString(),
      errorCode: row.errorCode,
    };
    return (
      kind === 'baseline'
        ? {
            ...common,
            name: row.name,
            width: row.width,
            height: row.height,
            approvedAt: row.approvedAt,
            approvedBy: row.approvedBy,
            approvalNote: row.approvalNote,
            fixtureId: row.fixtureId,
            fixtureVersion: row.fixtureVersion,
          }
        : {
            ...common,
            baselineId: row.baselineId,
            baselineVersion: row.baselineVersion,
            diffImage: await artifact(row.diffImage, 'diff.png'),
            visual: row.visual,
            payload: row.payload,
            options: row.options,
            adoptedBaselineId: row.adoptedBaselineId,
          }
    ) as ResourceViews[K];
  }
  async approve(
    accountId: string,
    id: string,
    input: { expectedVersion: number; note: string },
  ) {
    objectKeys(input, ['expectedVersion', 'note']);
    version(input.expectedVersion);
    const note = approvalNote(input.note);
    if (!isUUID(id, '4')) throw new NotFoundException();
    const feature = await this.feature(accountId);
    const repository = this.repository();
    const capture = await repository.get('baseline', id, accountId);
    if (['ready', 'approved'].includes(capture.status))
      await this.verifyArtifacts(accountId, capture);
    const eventId = randomUUID(),
      occurredAt = new Date().toISOString();
    await repository.db.runTransaction(async (tx) => {
      await repository.guard(tx, accountId);
      const row = repository.owned(
        (await tx.get(repository.ref('baseline', id))).data(),
        accountId,
      );
      repository.artifactsLive(row);
      if (
        row.status === 'approved' &&
        row.approvedFromVersion === input.expectedVersion &&
        row.approvalNote === note
      )
        return;
      if (row.status !== 'ready' || row.version !== input.expectedVersion)
        throw new ConflictException('BASELINE_VERSION_CONFLICT');
      await this.event(
        tx,
        accountId,
        eventId,
        id,
        'baseline_approved',
        feature.featureVersion,
        occurredAt,
        Boolean(row.fixtureId || row.isSynthetic),
      );
      tx.update(repository.ref('baseline', id), {
        status: 'approved',
        version: row.version + 1,
        approvedAt: occurredAt,
        approvedFromVersion: row.version,
        approvedBy: accountId,
        approvalNote: note,
      });
    });
    return this.get('baseline', accountId, id);
  }
  async adopt(
    accountId: string,
    id: string,
    input: { expectedVersion: number; operationId: string; note: string },
  ) {
    objectKeys(input, ['expectedVersion', 'operationId', 'note']);
    version(input.expectedVersion);
    uuid(input.operationId);
    const note = approvalNote(input.note);
    if (!isUUID(id, '4')) throw new NotFoundException();
    const feature = await this.feature(accountId);
    const repository = this.repository();
    const candidate = await repository.get('run', id, accountId);
    if (candidate.status === 'completed')
      await this.verifyArtifacts(accountId, candidate);
    const fingerprint = hash(
      JSON.stringify({
        kind: 'adoption',
        runId: id,
        expectedVersion: input.expectedVersion,
        note,
      }),
    );
    const eventId = randomUUID(),
      occurredAt = new Date().toISOString();
    await repository.db.runTransaction(async (tx) => {
      await repository.guard(tx, accountId);
      const [runDoc, priorDoc, baselineDoc] = await Promise.all([
        tx.get(repository.ref('run', id)),
        tx.get(repository.ref('operation', input.operationId)),
        tx.get(repository.ref('baseline', input.operationId)),
      ]);
      const run = repository.owned(runDoc.data(), accountId);
      const prior = priorDoc.data();
      if (prior) {
        repository.owned(prior, accountId);
        if (prior.kind !== 'adoption' || prior.fingerprint !== fingerprint)
          throw new ConflictException('OPERATION_PAYLOAD_CONFLICT');
        return;
      }
      repository.artifactsLive(run);
      if (
        run.status !== 'completed' ||
        run.version !== input.expectedVersion ||
        run.adoptedBaselineId ||
        baselineDoc.exists
      )
        throw new ConflictException('RUN_VERSION_CONFLICT');
      const original = repository.owned(
        (await tx.get(repository.ref('baseline', run.baselineId))).data(),
        accountId,
      );
      const expiresAt = Timestamp.fromMillis(Date.now() + METADATA_TTL_MS);
      await this.event(
        tx,
        accountId,
        eventId,
        input.operationId,
        'baseline_approved',
        feature.featureVersion,
        occurredAt,
        run.isSynthetic,
      );
      tx.create(repository.ref('baseline', input.operationId), {
        id: input.operationId,
        operationId: input.operationId,
        accountId,
        name: original.name,
        version: 1,
        status: 'approved',
        labelSize: run.labelSize,
        renderer: run.renderer,
        source: run.source,
        image: run.image,
        width: run.visual.candidateWidth,
        height: run.visual.candidateHeight,
        createdAt: occurredAt,
        approvedAt: occurredAt,
        approvedBy: accountId,
        approvalNote: note,
        artifactsExpireAt: run.artifactsExpireAt,
        expiresAt,
        errorCode: null,
        fixtureId: null,
        fixtureVersion: null,
        isSynthetic: run.isSynthetic,
        adoptedFromRunId: id,
      });
      tx.create(repository.ref('operation', input.operationId), {
        id: input.operationId,
        operationId: input.operationId,
        accountId,
        kind: 'adoption',
        fingerprint,
        status: 'completed',
        leaseUntil: 0,
        createdAt: occurredAt,
        expiresAt,
      });
      tx.update(repository.ref('run', id), {
        adoptedBaselineId: input.operationId,
        version: run.version + 1,
      });
    });
    const [baseline, run] = await Promise.all([
      this.get('baseline', accountId, input.operationId),
      this.get('run', accountId, id),
    ]);
    return { schemaVersion: 1, baseline: baseline.baseline, run: run.run };
  }
  /** Invoked by the root-owned scheduler/OIDC endpoint. No public recovery route. */
  async recover() {
    const repository = this.repository();
    const rows = await repository.db
      .collection(COLLECTIONS.operation)
      .where('status', 'in', ['processing', 'failed'])
      .where('leaseUntil', '>', 0)
      .where('leaseUntil', '<=', Date.now())
      .limit(50)
      .get();
    let recovered = 0,
      failed = 0;
    for (const doc of rows.docs) {
      const op = doc.data();
      if (!['baseline', 'run'].includes(op.kind)) continue;
      let claimedToken: string;
      try {
        const feature = await this.feature(op.accountId);
        const claim = await repository.claim(
          op.kind,
          op.accountId,
          op.input,
          op.fingerprint,
          feature.featureVersion,
        );
        if (!claim.completed) {
          claimedToken = claim.op.token;
          const source = await this.read(
            op.accountId,
            {
              path: this.sourcePath(op.accountId, op),
              sha256: op.input.sourceHash,
            },
            MAX_INPUT_BYTES,
          );
          validateLabel(source.toString('utf8'), op.input.labelSize);
          await this.execute(op.accountId, claim.op, source.toString('utf8'));
        }
        recovered++;
      } catch {
        if (claimedToken) {
          try {
            await repository.fail(op.accountId, op.id, claimedToken);
          } catch {
            /* Account deletion or database outage. */
          }
        } else if (
          op.attempts >= 8 ||
          Date.parse(op.artifactsExpireAt) <= Date.now()
        ) {
          try {
            await repository.fail(op.accountId, op.id, op.token, true);
          } catch {
            /* A newer lease or tombstone still wins. */
          }
        }
        // execute handles a claimed attempt; pre-execution failure is fenced by
        // the current token so a competing recovery can never be failed here.
        failed++;
      }
    }
    return { scanned: rows.size, recovered, failed };
  }
}
