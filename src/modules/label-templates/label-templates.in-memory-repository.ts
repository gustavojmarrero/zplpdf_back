import {
  assertOperationLease,
  reserveOperation,
} from '../workflows/operation-lease.js';
import { RUN_LEASE_MS } from './label-templates.constants.js';
import { AccountDeletedError } from '../workflows/label-event.outbox.js';
import type { InMemoryLabelEventOutbox } from '../workflows/label-event.store.js';
import {
  TemplateMissingError,
  TemplateVersionConflictError,
} from './label-templates.types.js';
import type { BusinessOutboxEvent } from './label-templates.types.js';
import type {
  LabelTemplateRecord,
  ReserveRunResult,
  TemplateRepositoryPort,
  TemplateRunRecord,
  TemplateVersionRecord,
} from './label-templates.types.js';

/**
 * Implementación en memoria del mismo contrato: CAS de metadata, versiones
 * inmutables, propiedad comprobada en cada operación y reserva de ejecución por
 * intención. La usan las pruebas y sirve para levantar el módulo en local sin
 * credenciales.
 */
export class InMemoryTemplateRepository implements TemplateRepositoryPort {
  private readonly templates = new Map<string, LabelTemplateRecord>();
  private readonly versions = new Map<string, TemplateVersionRecord>();
  private readonly runs = new Map<string, TemplateRunRecord>();

  /** Reproduce las dos garantías de la transacción de Firestore. */
  constructor(
    private readonly outbox?: InMemoryLabelEventOutbox,
    private readonly deletedAccounts: Set<string> = new Set(),
  ) {}

  markAccountDeleted(accountId: string): void {
    this.deletedAccounts.add(accountId);
  }

  private assertAlive(accountId: string): void {
    if (this.deletedAccounts.has(accountId)) {
      throw new AccountDeletedError(accountId);
    }
  }

  async assertAccountActive(accountId: string): Promise<void> {
    this.assertAlive(accountId);
  }

  private pendingCommitFailure?: Error;

  /**
   * Hace fallar la siguiente confirmación. Sirve para probar la caída a mitad
   * de la transacción: ni la transición ni el hecho llegan a escribirse.
   */
  failNextCommit(error = new Error('crash antes de confirmar')): void {
    this.pendingCommitFailure = error;
  }

  /** Punto de confirmación: transición y hecho, o ninguno de los dos. */
  private commit(write: () => void, outbox?: BusinessOutboxEvent): void {
    if (this.pendingCommitFailure) {
      const failure = this.pendingCommitFailure;
      this.pendingCommitFailure = undefined;
      throw failure;
    }
    write();
    if (outbox) this.outbox?.write(outbox);
  }

  private versionKey(templateId: string, versionNumber: number): string {
    return `${templateId}:${versionNumber}`;
  }

  async createTemplate(
    template: LabelTemplateRecord,
    version: TemplateVersionRecord,
    outbox?: BusinessOutboxEvent,
  ): Promise<LabelTemplateRecord> {
    if (this.templates.has(template.id)) {
      throw new Error(`Template ${template.id} already exists`);
    }
    this.assertAlive(template.ownerId);

    this.commit(() => {
      this.templates.set(template.id, { ...template });
      this.versions.set(this.versionKey(template.id, version.versionNumber), {
        ...version,
      });
    }, outbox);
    return { ...template };
  }

  async getTemplate(
    accountId: string,
    templateId: string,
  ): Promise<LabelTemplateRecord | null> {
    const record = this.templates.get(templateId);
    if (!record || record.ownerId !== accountId) return null;
    return { ...record };
  }

  async listTemplates(accountId: string): Promise<LabelTemplateRecord[]> {
    return [...this.templates.values()]
      .filter((record) => record.ownerId === accountId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((record) => ({ ...record }));
  }

  async countTemplates(accountId: string): Promise<number> {
    return (await this.listTemplates(accountId)).length;
  }

  async updateTemplate(
    accountId: string,
    templateId: string,
    expectedVersion: number,
    mutate: (current: LabelTemplateRecord) => Partial<LabelTemplateRecord>,
  ): Promise<LabelTemplateRecord> {
    const current = this.templates.get(templateId);
    if (!current || current.ownerId !== accountId) {
      throw new TemplateMissingError(templateId);
    }
    this.assertAlive(accountId);
    if (current.version !== expectedVersion) {
      throw new TemplateVersionConflictError(expectedVersion, current.version);
    }

    const next: LabelTemplateRecord = {
      ...current,
      ...mutate({ ...current }),
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };
    this.templates.set(templateId, next);
    return { ...next };
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
    const current = this.templates.get(templateId);
    if (!current || current.ownerId !== accountId) {
      throw new TemplateMissingError(templateId);
    }
    this.assertAlive(accountId);
    if (current.version !== expectedVersion) {
      throw new TemplateVersionConflictError(expectedVersion, current.version);
    }

    const version = build(current.currentVersion);
    const key = this.versionKey(templateId, version.versionNumber);
    if (this.versions.has(key)) {
      throw new Error(`Version ${key} already exists`);
    }

    const next: LabelTemplateRecord = {
      ...current,
      currentVersion: version.versionNumber,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };

    this.commit(() => {
      this.versions.set(key, { ...version });
      this.templates.set(templateId, next);
    }, outbox);
    return { template: { ...next }, version: { ...version } };
  }

  async getVersion(
    accountId: string,
    templateId: string,
    versionNumber: number,
  ): Promise<TemplateVersionRecord | null> {
    const record = this.versions.get(
      this.versionKey(templateId, versionNumber),
    );
    if (!record || record.ownerId !== accountId) return null;
    return { ...record };
  }

  async listVersions(
    accountId: string,
    templateId: string,
  ): Promise<TemplateVersionRecord[]> {
    return [...this.versions.values()]
      .filter(
        (record) =>
          record.ownerId === accountId && record.templateId === templateId,
      )
      .sort((a, b) => b.versionNumber - a.versionNumber)
      .map((record) => ({ ...record }));
  }

  async reserveRun(
    candidate: TemplateRunRecord,
    now: Date,
  ): Promise<ReserveRunResult> {
    this.assertAlive(candidate.accountId);
    const existing = this.runs.get(candidate.runId);

    const result = reserveOperation(candidate, existing, now, RUN_LEASE_MS);
    if (result.outcome === 'reserved')
      this.runs.set(candidate.runId, structuredClone(result.record));
    return structuredClone(result) as ReserveRunResult;
  }

  async renewRun(runId: string, token: string): Promise<void> {
    const current = this.runs.get(runId);
    if (!current) throw new TemplateMissingError(runId);
    this.assertAlive(current.accountId);
    assertOperationLease(current, token);
    this.runs.set(runId, {
      ...current,
      leaseExpiresAt: new Date(Date.now() + RUN_LEASE_MS).toISOString(),
    });
  }

  async completeRun(
    runId: string,
    token: string,
    patch: { jobId: string },
    outbox?: BusinessOutboxEvent,
  ): Promise<TemplateRunRecord> {
    const existing = this.runs.get(runId);
    if (!existing) throw new TemplateMissingError(runId);
    this.assertAlive(existing.accountId);
    if (existing.status === 'accepted') return structuredClone(existing);
    assertOperationLease(existing, token);

    const next: TemplateRunRecord = {
      ...existing,
      ...patch,
      status: 'accepted',
      completionEvent: outbox,
      errorCode: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      updatedAt: new Date().toISOString(),
    };
    this.commit(() => this.runs.set(runId, structuredClone(next)), outbox);
    return structuredClone(next);
  }

  async failRun(
    runId: string,
    token: string,
    errorCode: string,
  ): Promise<TemplateRunRecord> {
    const existing = this.runs.get(runId);
    if (!existing) throw new TemplateMissingError(runId);
    this.assertAlive(existing.accountId);
    if (existing.status === 'accepted') return structuredClone(existing);
    assertOperationLease(existing, token);
    const next: TemplateRunRecord = {
      ...existing,
      status: 'failed',
      leaseToken: undefined,
      errorCode,
      leaseExpiresAt: undefined,
      updatedAt: new Date().toISOString(),
    };
    this.runs.set(runId, next);
    return structuredClone(next);
  }

  async getRun(
    accountId: string,
    runId: string,
  ): Promise<TemplateRunRecord | null> {
    const record = this.runs.get(runId);
    if (!record || record.accountId !== accountId) return null;
    return structuredClone(record);
  }

  async listRuns(
    accountId: string,
    templateId?: string,
  ): Promise<TemplateRunRecord[]> {
    return [...this.runs.values()]
      .filter(
        (record) =>
          record.accountId === accountId &&
          (!templateId || record.templateId === templateId),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((record) => structuredClone(record));
  }
}
