import {
  operationFromFirestore,
  operationToFirestore,
} from '../workflows/operation-lease.firestore.js';
import {
  assertOperationLease,
  reserveOperation,
} from '../workflows/operation-lease.js';
import { Inject, Injectable } from '@nestjs/common';
import type { Provider } from '@nestjs/common';
import { Firestore } from '@google-cloud/firestore';
import { FirestoreService } from '../cache/firestore.service.js';
import {
  RUN_LEASE_MS,
  TEMPLATES_COLLECTION,
  TEMPLATE_RUNS_COLLECTION,
  TEMPLATE_VERSIONS_COLLECTION,
} from './label-templates.constants.js';
import {
  TemplateMissingError,
  TemplateVersionConflictError,
} from './label-templates.types.js';
import {
  assertAccountAlive,
  writeOutboxRecord,
} from '../workflows/label-event.store.js';
import type { BusinessOutboxEvent } from './label-templates.types.js';
import type {
  LabelTemplateRecord,
  ReserveRunResult,
  TemplateRepositoryPort,
  TemplateRunRecord,
  TemplateVersionRecord,
} from './label-templates.types.js';

export const TEMPLATES_FIRESTORE = Symbol('TEMPLATES_FIRESTORE');

/**
 * Reutiliza el cliente ya configurado de `FirestoreService`: mismas
 * credenciales y mismo proyecto que el resto de la aplicación, sin abrir una
 * segunda conexión.
 */
export const TemplatesFirestoreProvider: Provider = {
  provide: TEMPLATES_FIRESTORE,
  inject: [FirestoreService],
  useFactory: (store: FirestoreService) => store.getClient(),
};

@Injectable()
export class FirestoreTemplateRepository implements TemplateRepositoryPort {
  constructor(@Inject(TEMPLATES_FIRESTORE) private readonly db: Firestore) {}

  private templateRef(templateId: string) {
    return this.db.collection(TEMPLATES_COLLECTION).doc(templateId);
  }

  private versionRef(templateId: string, versionNumber: number) {
    return this.db
      .collection(TEMPLATE_VERSIONS_COLLECTION)
      .doc(`${templateId}:${versionNumber}`);
  }

  private runRef(runId: string) {
    return this.db.collection(TEMPLATE_RUNS_COLLECTION).doc(runId);
  }

  async assertAccountActive(accountId: string): Promise<void> {
    await this.db.runTransaction((transaction) =>
      assertAccountAlive(transaction, this.db, accountId),
    );
  }

  async createTemplate(
    template: LabelTemplateRecord,
    version: TemplateVersionRecord,
    outbox?: BusinessOutboxEvent,
  ): Promise<LabelTemplateRecord> {
    // Transacción y no lote de escritura: hace falta leer la lápida de la
    // cuenta antes de escribir, y el hecho tiene que ir con la plantilla.
    await this.db.runTransaction(async (transaction) => {
      await assertAccountAlive(transaction, this.db, template.ownerId);
      transaction.create(
        this.versionRef(template.id, version.versionNumber),
        version,
      );
      transaction.create(this.templateRef(template.id), template);
      writeOutboxRecord(transaction, this.db, outbox);
    });
    return template;
  }

  async getTemplate(
    accountId: string,
    templateId: string,
  ): Promise<LabelTemplateRecord | null> {
    const snapshot = await this.templateRef(templateId).get();
    if (!snapshot.exists) return null;
    const record = snapshot.data() as LabelTemplateRecord;
    // Una plantilla ajena se trata como inexistente.
    return record.ownerId === accountId ? record : null;
  }

  async listTemplates(accountId: string): Promise<LabelTemplateRecord[]> {
    const snapshot = await this.db
      .collection(TEMPLATES_COLLECTION)
      .where('ownerId', '==', accountId)
      .orderBy('createdAt', 'desc')
      .get();
    return snapshot.docs.map((doc) => doc.data() as LabelTemplateRecord);
  }

  async countTemplates(accountId: string): Promise<number> {
    const snapshot = await this.db
      .collection(TEMPLATES_COLLECTION)
      .where('ownerId', '==', accountId)
      .count()
      .get();
    return snapshot.data().count;
  }

  async updateTemplate(
    accountId: string,
    templateId: string,
    expectedVersion: number,
    mutate: (current: LabelTemplateRecord) => Partial<LabelTemplateRecord>,
  ): Promise<LabelTemplateRecord> {
    const ref = this.templateRef(templateId);

    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new TemplateMissingError(templateId);

      const current = snapshot.data() as LabelTemplateRecord;
      if (current.ownerId !== accountId) {
        throw new TemplateMissingError(templateId);
      }
      if (current.version !== expectedVersion) {
        throw new TemplateVersionConflictError(
          expectedVersion,
          current.version,
        );
      }

      const next: LabelTemplateRecord = {
        ...current,
        ...mutate(current),
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      };
      transaction.set(ref, next);
      return next;
    });
  }

  async addVersion(
    accountId: string,
    templateId: string,
    expectedVersion: number,
    build: (currentVersionNumber: number) => TemplateVersionRecord,
    outbox?: BusinessOutboxEvent,
  ): Promise<{
    template: LabelTemplateRecord;
    version: TemplateVersionRecord;
  }> {
    const ref = this.templateRef(templateId);

    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new TemplateMissingError(templateId);

      const current = snapshot.data() as LabelTemplateRecord;
      if (current.ownerId !== accountId) {
        throw new TemplateMissingError(templateId);
      }
      if (current.version !== expectedVersion) {
        throw new TemplateVersionConflictError(
          expectedVersion,
          current.version,
        );
      }

      const version = build(current.currentVersion);
      const next: LabelTemplateRecord = {
        ...current,
        currentVersion: version.versionNumber,
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      };

      // La versión se crea, nunca se sobrescribe: una ejecución anterior tiene
      // que seguir apuntando al ZPL exacto con el que se hizo.
      transaction.create(
        this.versionRef(templateId, version.versionNumber),
        version,
      );
      transaction.set(ref, next);
      writeOutboxRecord(transaction, this.db, outbox);
      return { template: next, version };
    });
  }

  async getVersion(
    accountId: string,
    templateId: string,
    versionNumber: number,
  ): Promise<TemplateVersionRecord | null> {
    const snapshot = await this.versionRef(templateId, versionNumber).get();
    if (!snapshot.exists) return null;
    const record = snapshot.data() as TemplateVersionRecord;
    return record.ownerId === accountId ? record : null;
  }

  async listVersions(
    accountId: string,
    templateId: string,
  ): Promise<TemplateVersionRecord[]> {
    const snapshot = await this.db
      .collection(TEMPLATE_VERSIONS_COLLECTION)
      .where('ownerId', '==', accountId)
      .where('templateId', '==', templateId)
      .orderBy('versionNumber', 'desc')
      .get();
    return snapshot.docs.map((doc) => doc.data() as TemplateVersionRecord);
  }

  async reserveRun(
    candidate: TemplateRunRecord,
    now: Date,
  ): Promise<ReserveRunResult> {
    const ref = this.runRef(candidate.runId);

    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      await assertAccountAlive(transaction, this.db, candidate.accountId);

      const existing = snapshot.exists
        ? operationFromFirestore<TemplateRunRecord>(snapshot.data())
        : undefined;
      const result = reserveOperation(candidate, existing, now, RUN_LEASE_MS);
      if (result.outcome === 'reserved')
        transaction.set(ref, operationToFirestore(result.record));
      return result as ReserveRunResult;
    });
  }

  async renewRun(runId: string, token: string): Promise<void> {
    const ref = this.runRef(runId);
    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new TemplateMissingError(runId);
      const current = operationFromFirestore<TemplateRunRecord>(
        snapshot.data(),
      );
      await assertAccountAlive(transaction, this.db, current.accountId);
      assertOperationLease(current, token);
      transaction.update(ref, {
        leaseExpiresAt: new Date(Date.now() + RUN_LEASE_MS).toISOString(),
      });
    });
  }

  async completeRun(
    runId: string,
    token: string,
    patch: { jobId: string },
    outbox?: BusinessOutboxEvent,
  ): Promise<TemplateRunRecord> {
    const ref = this.runRef(runId);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new TemplateMissingError(runId);

      const current = operationFromFirestore<TemplateRunRecord>(
        snapshot.data(),
      );
      await assertAccountAlive(transaction, this.db, current.accountId);
      if (current.status === 'accepted') return structuredClone(current);
      assertOperationLease(current, token);

      const next: TemplateRunRecord = {
        ...current,
        ...patch,
        status: 'accepted',
        completionEvent: outbox,
        errorCode: undefined,
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        updatedAt: new Date().toISOString(),
      };
      transaction.set(ref, operationToFirestore(next));
      // La ejecución pasa a `accepted` y su hecho nace con ella.
      writeOutboxRecord(transaction, this.db, outbox);
      return next;
    });
  }

  async failRun(
    runId: string,
    token: string,
    errorCode: string,
  ): Promise<TemplateRunRecord> {
    const ref = this.runRef(runId);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new TemplateMissingError(runId);
      const current = operationFromFirestore<TemplateRunRecord>(
        snapshot.data(),
      );
      await assertAccountAlive(transaction, this.db, current.accountId);
      if (current.status === 'accepted') return current;
      assertOperationLease(current, token);
      const next: TemplateRunRecord = {
        ...operationFromFirestore<TemplateRunRecord>(snapshot.data()),
        status: 'failed',
        leaseToken: undefined,
        errorCode,
        leaseExpiresAt: undefined,
        updatedAt: new Date().toISOString(),
      };
      transaction.set(ref, operationToFirestore(next));
      return next;
    });
  }

  async getRun(
    accountId: string,
    runId: string,
  ): Promise<TemplateRunRecord | null> {
    const snapshot = await this.runRef(runId).get();
    if (!snapshot.exists) return null;
    const record = operationFromFirestore<TemplateRunRecord>(snapshot.data());
    return record.accountId === accountId ? record : null;
  }

  async listRuns(
    accountId: string,
    templateId?: string,
  ): Promise<TemplateRunRecord[]> {
    let query = this.db
      .collection(TEMPLATE_RUNS_COLLECTION)
      .where('accountId', '==', accountId);

    if (templateId) {
      query = query.where('templateId', '==', templateId);
    }

    const snapshot = await query.orderBy('createdAt', 'desc').limit(100).get();
    return snapshot.docs.map((doc) =>
      operationFromFirestore<TemplateRunRecord>(doc.data()),
    );
  }
}
