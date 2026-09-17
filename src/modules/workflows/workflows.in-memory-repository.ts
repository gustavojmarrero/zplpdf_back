import {
  assertOperationLease,
  reserveOperation,
} from '../workflows/operation-lease.js';
import { EXPORT_LEASE_MS } from './workflows.constants.js';
import { AccountDeletedError } from './label-event.outbox.js';
import type { InMemoryLabelEventOutbox } from './label-event.store.js';
import {
  WorkflowMissingError,
  WorkflowVersionConflictError,
} from './workflows.types.js';
import type { BusinessOutboxEvent } from './workflows.types.js';
import type {
  ExportRecord,
  WorkflowJobRef,
  ListWorkflowsOptions,
  ListWorkflowsResult,
  ReserveExportResult,
  WorkflowLabelRecord,
  WorkflowRecord,
  WorkflowRepositoryPort,
} from './workflows.types.js';

/**
 * Implementación en memoria del mismo contrato: CAS sobre `version`, propiedad
 * comprobada en cada operación y reserva de exportación por intención.
 *
 * La usan las pruebas (no hay emulador de Firestore en el pipeline) y sirve
 * también para levantar el módulo en local sin credenciales. Es una
 * implementación real del puerto, no un mock vacío: las reglas que se prueban
 * —conflicto de versión, aislamiento entre cuentas, idempotencia— viven aquí
 * con la misma semántica que la transacción de Firestore.
 */
export class InMemoryWorkflowRepository implements WorkflowRepositoryPort {
  private readonly workflows = new Map<string, WorkflowRecord>();
  private readonly labels = new Map<string, WorkflowLabelRecord[]>();
  private readonly exports = new Map<string, ExportRecord>();

  /**
   * `outbox` y `deletedAccounts` reproducen las dos garantías que en Firestore
   * da la transacción: el hecho se escribe con la transición y una cuenta con
   * lápida no admite escrituras nuevas.
   */
  constructor(
    private readonly outbox?: InMemoryLabelEventOutbox,
    private readonly deletedAccounts: Set<string> = new Set(),
  ) {}

  /** Marca la cuenta como borrada, como haría `deleted_accounts`. */
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

  /**
   * Punto de confirmación: escribe la transición y el hecho a la vez. Un fallo
   * simulado aquí deja las dos cosas sin escribir, igual que una transacción.
   */
  private commit(write: () => void, outbox?: BusinessOutboxEvent): void {
    if (this.pendingCommitFailure) {
      const failure = this.pendingCommitFailure;
      this.pendingCommitFailure = undefined;
      throw failure;
    }
    write();
    if (outbox) this.outbox?.write(outbox);
  }

  async createWorkflow(
    workflow: WorkflowRecord,
    labels: WorkflowLabelRecord[],
  ): Promise<WorkflowRecord> {
    if (this.workflows.has(workflow.id)) {
      throw new Error(`Workflow ${workflow.id} already exists`);
    }
    this.assertAlive(workflow.ownerId);
    this.workflows.set(workflow.id, { ...workflow });
    this.labels.set(
      workflow.id,
      labels.map((label) => ({ ...label })),
    );
    return { ...workflow };
  }

  async getWorkflow(
    accountId: string,
    workflowId: string,
  ): Promise<WorkflowRecord | null> {
    const record = this.workflows.get(workflowId);
    if (!record) return null;
    if (record.ownerId !== accountId) return null;
    return { ...record };
  }

  async listWorkflows(
    accountId: string,
    options: ListWorkflowsOptions,
  ): Promise<ListWorkflowsResult> {
    const all = [...this.workflows.values()]
      .filter((record) => record.ownerId === accountId)
      .filter((record) => !options.status || record.status === options.status)
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? b.id.localeCompare(a.id)
          : b.createdAt.localeCompare(a.createdAt),
      );

    const start = options.cursor
      ? all.findIndex(
          (record) =>
            record.id ===
            Buffer.from(options.cursor, 'base64url')
              .toString('utf8')
              .split('|')[1],
        ) + 1
      : 0;

    const items = all
      .slice(start, start + options.limit)
      .map((r) => ({ ...r }));
    const hasMore = all.length > start + options.limit;

    return {
      items,
      nextCursor:
        hasMore && items.length > 0
          ? Buffer.from(
              `${items[items.length - 1].createdAt}|${items[items.length - 1].id}`,
              'utf8',
            ).toString('base64url')
          : undefined,
    };
  }

  async countActiveWorkflows(accountId: string): Promise<number> {
    return [...this.workflows.values()].filter(
      (record) => record.ownerId === accountId && record.status !== 'archived',
    ).length;
  }

  async getLabels(
    accountId: string,
    workflowId: string,
  ): Promise<WorkflowLabelRecord[]> {
    return (this.labels.get(workflowId) ?? [])
      .filter((label) => label.accountId === accountId)
      .map((label) => ({ ...label }))
      .sort((a, b) => a.sequence - b.sequence);
  }

  async updateWorkflow(
    accountId: string,
    workflowId: string,
    expectedVersion: number,
    mutate: (current: WorkflowRecord) => Partial<WorkflowRecord>,
    outbox?: BusinessOutboxEvent,
  ): Promise<WorkflowRecord> {
    const current = this.workflows.get(workflowId);
    if (!current || current.ownerId !== accountId) {
      throw new WorkflowMissingError(workflowId);
    }
    this.assertAlive(accountId);
    if (current.version !== expectedVersion) {
      throw new WorkflowVersionConflictError(expectedVersion, current.version);
    }

    const next: WorkflowRecord = {
      ...current,
      ...mutate({ ...current }),
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };
    this.commit(() => this.workflows.set(workflowId, next), outbox);
    return { ...next };
  }

  async appendJobRef(
    accountId: string,
    workflowId: string,
    jobRef: WorkflowJobRef,
  ): Promise<WorkflowRecord> {
    const current = this.workflows.get(workflowId);
    if (!current || current.ownerId !== accountId) {
      throw new WorkflowMissingError(workflowId);
    }
    this.assertAlive(accountId);
    if (current.jobRefs.some((ref) => ref.exportId === jobRef.exportId)) {
      return { ...current };
    }

    const next: WorkflowRecord = {
      ...current,
      jobRefs: [...current.jobRefs, jobRef],
      status: current.status === 'draft' ? 'ready' : current.status,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };
    this.workflows.set(workflowId, next);
    return { ...next };
  }

  async deleteWorkflow(accountId: string, workflowId: string): Promise<void> {
    const current = this.workflows.get(workflowId);
    if (!current) return;
    if (current.ownerId !== accountId) {
      throw new WorkflowMissingError(workflowId);
    }
    this.workflows.delete(workflowId);
    this.labels.delete(workflowId);
  }

  async reserveExport(
    candidate: ExportRecord,
    now: Date,
  ): Promise<ReserveExportResult> {
    this.assertAlive(candidate.accountId);
    const existing = this.exports.get(candidate.exportId);

    const result = reserveOperation(candidate, existing, now, EXPORT_LEASE_MS);
    if (result.outcome === 'reserved')
      this.exports.set(candidate.exportId, structuredClone(result.record));
    return structuredClone(result) as ReserveExportResult;
  }

  async renewExport(exportId: string, token: string): Promise<void> {
    const current = this.exports.get(exportId);
    if (!current) throw new WorkflowMissingError(exportId);
    this.assertAlive(current.accountId);
    assertOperationLease(current, token);
    this.exports.set(exportId, {
      ...current,
      leaseExpiresAt: new Date(Date.now() + EXPORT_LEASE_MS).toISOString(),
    });
  }

  async completeExport(
    exportId: string,
    token: string,
    patch: {
      jobId: string;
      labelIds: string[];
      labelCount: number;
      uniqueLabelCount: number;
    },
    outbox?: BusinessOutboxEvent,
  ): Promise<ExportRecord> {
    const existing = this.exports.get(exportId);
    if (!existing) throw new WorkflowMissingError(exportId);
    this.assertAlive(existing.accountId);
    if (existing.status === 'accepted') return structuredClone(existing);
    assertOperationLease(existing, token);

    const next: ExportRecord = {
      ...existing,
      ...patch,
      status: 'accepted',
      completionEvent: outbox,
      errorCode: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      updatedAt: new Date().toISOString(),
    };
    this.commit(
      () => this.exports.set(exportId, structuredClone(next)),
      outbox,
    );
    return structuredClone(next);
  }

  async failExport(
    exportId: string,
    token: string,
    errorCode: string,
  ): Promise<ExportRecord> {
    const existing = this.exports.get(exportId);
    if (!existing) throw new WorkflowMissingError(exportId);
    this.assertAlive(existing.accountId);
    if (existing.status === 'accepted') return structuredClone(existing);
    assertOperationLease(existing, token);
    const next: ExportRecord = {
      ...existing,
      status: 'failed',
      leaseToken: undefined,
      errorCode,
      leaseExpiresAt: undefined,
      updatedAt: new Date().toISOString(),
    };
    this.exports.set(exportId, next);
    return structuredClone(next);
  }

  async getExport(
    accountId: string,
    exportId: string,
  ): Promise<ExportRecord | null> {
    const record = this.exports.get(exportId);
    if (!record || record.accountId !== accountId) return null;
    return structuredClone(record);
  }

  async listExports(
    accountId: string,
    workflowId: string,
  ): Promise<ExportRecord[]> {
    return [...this.exports.values()]
      .filter(
        (record) =>
          record.accountId === accountId && record.workflowId === workflowId,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((record) => structuredClone(record));
  }

  async countExports(accountId: string, workflowId: string): Promise<number> {
    return (await this.listExports(accountId, workflowId)).length;
  }

  async markExportsWorkflowDeleted(
    accountId: string,
    workflowId: string,
  ): Promise<void> {
    for (const record of this.exports.values()) {
      if (record.accountId === accountId && record.workflowId === workflowId) {
        this.exports.set(record.exportId, { ...record, workflowDeleted: true });
      }
    }
  }
}
