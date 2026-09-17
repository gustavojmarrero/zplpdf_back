import {
  ConflictException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import {
  Firestore,
  Timestamp,
  Transaction,
  DocumentData,
} from '@google-cloud/firestore';
import { randomUUID } from 'node:crypto';
import {
  ARTIFACT_TTL_MS,
  COLLECTIONS,
  LEASE_MS,
  METADATA_TTL_MS,
  RENDERER,
} from './template-regression.types.js';

export type ResourceKind = 'baseline' | 'run';
export class TemplateRegressionRepository {
  constructor(readonly db: Firestore) {}
  ref(kind: ResourceKind | 'operation', id: string) {
    return this.db.collection(COLLECTIONS[kind]).doc(id);
  }
  async guard(tx: Transaction, accountId: string) {
    const [deleted, user] = await Promise.all([
      tx.get(this.db.collection('deleted_accounts').doc(accountId)),
      tx.get(this.db.collection('users').doc(accountId)),
    ]);
    if (deleted.exists || !user.exists)
      throw new GoneException('ACCOUNT_UNAVAILABLE');
  }
  owned(row: DocumentData, accountId: string) {
    if (!row || row.accountId !== accountId) throw new NotFoundException();
    if (row.expiresAt.toMillis() <= Date.now())
      throw new GoneException('METADATA_EXPIRED');
    return row;
  }
  artifactsLive(row: DocumentData) {
    if (Date.parse(row.artifactsExpireAt) <= Date.now())
      throw new GoneException('ARTIFACTS_EXPIRED');
  }
  async get(kind: ResourceKind, id: string, accountId: string) {
    return this.db.runTransaction(async (tx) => {
      await this.guard(tx, accountId);
      return this.owned((await tx.get(this.ref(kind, id))).data(), accountId);
    });
  }
  async claim(
    kind: ResourceKind,
    accountId: string,
    input: DocumentData,
    fingerprint: string,
    featureVersion: string,
  ) {
    const id = input.operationId;
    return this.db.runTransaction(async (tx) => {
      await this.guard(tx, accountId);
      const [prior, resource] = await Promise.all([
        tx.get(this.ref('operation', id)),
        tx.get(this.ref(kind, id)),
      ]);
      const op = prior.data();
      if (op && op.accountId !== accountId) throw new NotFoundException();
      if (op && (op.fingerprint !== fingerprint || op.kind !== kind))
        throw new ConflictException('OPERATION_PAYLOAD_CONFLICT');
      if (op) this.owned(op, accountId);
      if (op?.status === 'completed') return { completed: true, op };
      if (op?.status === 'processing' && op?.leaseUntil > Date.now())
        throw new ConflictException('OPERATION_IN_PROGRESS');
      if ((op?.attempts ?? 0) >= 8)
        throw new ConflictException('OPERATION_ATTEMPTS_EXHAUSTED');
      if (op) this.artifactsLive(op);
      let baseline: DocumentData;
      if (kind === 'run') {
        baseline = this.owned(
          (await tx.get(this.ref('baseline', input.baselineId))).data(),
          accountId,
        );
        this.artifactsLive(baseline);
        if (
          baseline.status !== 'approved' ||
          baseline.version !== input.baselineVersion
        )
          throw new ConflictException('BASELINE_VERSION_CONFLICT');
      }
      const now = Date.now();
      const createdAt = op?.createdAt ?? new Date(now).toISOString();
      const artifactsExpireAt =
        op?.artifactsExpireAt ?? new Date(now + ARTIFACT_TTL_MS).toISOString();
      const expiresAt =
        op?.expiresAt ?? Timestamp.fromMillis(now + METADATA_TTL_MS);
      const token = randomUUID();
      const operation = {
        ...op,
        id,
        operationId: id,
        accountId,
        kind,
        fingerprint,
        input,
        featureVersion: op?.featureVersion ?? featureVersion,
        eventId: op?.eventId ?? randomUUID(),
        token,
        status: 'processing',
        leaseUntil: now + LEASE_MS,
        attempts: (op?.attempts ?? 0) + 1,
        createdAt,
        artifactsExpireAt,
        expiresAt,
      };
      tx.set(this.ref('operation', id), operation);
      const row = resource.data();
      tx.set(this.ref(kind, id), {
        ...(row ?? {}),
        id,
        operationId: id,
        accountId,
        version: row ? row.version + 1 : 1,
        status: 'processing',
        labelSize: input.labelSize,
        renderer: RENDERER,
        source: row?.source ?? null,
        image: row?.image ?? null,
        createdAt,
        artifactsExpireAt,
        expiresAt,
        errorCode: null,
        ...(kind === 'baseline'
          ? {
              name: input.name,
              approvedAt: null,
              approvedBy: null,
              approvalNote: null,
              width: null,
              height: null,
              fixtureId: input.fixtureId ?? null,
              fixtureVersion: input.fixtureId ? 1 : null,
            }
          : {
              baselineId: input.baselineId,
              baselineVersion: input.baselineVersion,
              baselineImage: baseline.image,
              baselineSource: baseline.source,
              baselineArtifactsExpireAt: baseline.artifactsExpireAt,
              options: input.options,
              visual: null,
              payload: null,
              diffImage: null,
              adoptedBaselineId: null,
              isSynthetic: Boolean(baseline.fixtureId || baseline.isSynthetic),
            }),
      });
      return { completed: false, op: operation };
    });
  }
  async active(tx: Transaction, accountId: string, id: string, token: string) {
    await this.guard(tx, accountId);
    const op = this.owned(
      (await tx.get(this.ref('operation', id))).data(),
      accountId,
    );
    if (
      op.token !== token ||
      op.status !== 'processing' ||
      op.leaseUntil <= Date.now()
    )
      throw new ConflictException('OPERATION_LEASE_LOST');
    this.artifactsLive(op);
    return op;
  }
  async stage(
    accountId: string,
    id: string,
    token: string,
    stage: DocumentData,
  ) {
    return this.db.runTransaction(async (tx) => {
      await this.active(tx, accountId, id, token);
      tx.update(this.ref('operation', id), {
        stage,
        leaseUntil: Date.now() + LEASE_MS,
      });
    });
  }
  async finish(
    accountId: string,
    id: string,
    token: string,
    event: (
      tx: Transaction,
      op: DocumentData,
      row: DocumentData,
    ) => Promise<void>,
  ) {
    return this.db.runTransaction(async (tx) => {
      const op = await this.active(tx, accountId, id, token);
      const row = this.owned(
        (await tx.get(this.ref(op.kind, id))).data(),
        accountId,
      );
      if (!op.stage) throw new ConflictException('RENDER_NOT_STAGED');
      // Observability may read its outbox/dedup docs; it must run before writes.
      await event(tx, op, row);
      tx.update(this.ref(op.kind, id), {
        ...op.stage,
        status: op.kind === 'baseline' ? 'ready' : 'completed',
        version: row.version + 1,
        errorCode: null,
      });
      tx.update(this.ref('operation', id), {
        status: 'completed',
        leaseUntil: 0,
        completedAt: op.stage.completedAt,
      });
    });
  }
  async fail(accountId: string, id: string, token: string, terminal = false) {
    await this.db.runTransaction(async (tx) => {
      await this.guard(tx, accountId);
      const op = (await tx.get(this.ref('operation', id))).data();
      if (
        !op ||
        op.accountId !== accountId ||
        op.token !== token ||
        (op.status !== 'processing' && !(terminal && op.status === 'failed'))
      )
        return;
      const row = (await tx.get(this.ref(op.kind, id))).data();
      tx.update(this.ref('operation', id), {
        status: 'failed',
        leaseUntil: terminal || op.attempts >= 8 ? 0 : Date.now() + 60000,
      });
      if (row)
        tx.update(this.ref(op.kind, id), {
          status: 'failed',
          version: row.version + 1,
          errorCode: 'RENDER_FAILED',
        });
    });
  }
}
