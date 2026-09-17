import {
  operationFromFirestore,
  operationToFirestore,
} from '../workflows/operation-lease.firestore.js';
import {
  assertOperationLease,
  reserveOperation,
} from '../workflows/operation-lease.js';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Provider } from '@nestjs/common';
import { Firestore, Timestamp } from '@google-cloud/firestore';
import { FirestoreService } from '../cache/firestore.service.js';
import {
  EXPORT_LEASE_MS,
  WORKFLOWS_COLLECTION,
  WORKFLOW_EXPORTS_COLLECTION,
  WORKFLOW_LABELS_SUBCOLLECTION,
} from './workflows.constants.js';
import {
  WorkflowMissingError,
  WorkflowVersionConflictError,
} from './workflows.types.js';
import { assertAccountAlive, writeOutboxRecord } from './label-event.store.js';
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

export const WORKFLOWS_FIRESTORE = Symbol('WORKFLOWS_FIRESTORE');

/**
 * Reutiliza el cliente ya configurado de `FirestoreService`: mismas
 * credenciales, mismo proyecto y misma configuración de emulador. No se abre una
 * segunda conexión ni se lee otra variable de entorno, así que no hay forma de
 * que estos módulos acaben escribiendo en un proyecto distinto del resto.
 */
export const WorkflowsFirestoreProvider: Provider = {
  provide: WORKFLOWS_FIRESTORE,
  inject: [FirestoreService],
  useFactory: (store: FirestoreService) => store.getClient(),
};

/** Límite de escrituras por lote en Firestore es 500; se deja margen. */
const WRITE_BATCH_SIZE = 400;

function encodeCursor(record: WorkflowRecord): string {
  return Buffer.from(`${record.createdAt}|${record.id}`, 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(
  cursor: string,
): { createdAt: string; id: string } | null {
  try {
    const [createdAt, id] = Buffer.from(cursor, 'base64url')
      .toString('utf8')
      .split('|');
    if (!createdAt || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

@Injectable()
export class FirestoreWorkflowRepository implements WorkflowRepositoryPort {
  private readonly logger = new Logger(FirestoreWorkflowRepository.name);

  constructor(@Inject(WORKFLOWS_FIRESTORE) private readonly db: Firestore) {}

  private workflowRef(workflowId: string) {
    return this.db.collection(WORKFLOWS_COLLECTION).doc(workflowId);
  }

  private exportRef(exportId: string) {
    return this.db.collection(WORKFLOW_EXPORTS_COLLECTION).doc(exportId);
  }

  /**
   * El ZPL de origen caduca a los 15 días; `expiresAt` es Timestamp nativo para
   * que el TTL de Firestore pueda usarlo. TTL no es borrado inmediato, así que
   * la caducidad se comprueba además en lectura.
   */
  private ttlFrom(sourceExpiresAt: string): Timestamp {
    return Timestamp.fromDate(new Date(sourceExpiresAt));
  }

  private toWorkflow(data: any): WorkflowRecord {
    const { expiresAt: _expiresAt, ...rest } = data ?? {};
    return rest as WorkflowRecord;
  }

  async assertAccountActive(accountId: string): Promise<void> {
    await this.db.runTransaction((transaction) =>
      assertAccountAlive(transaction, this.db, accountId),
    );
  }

  async createWorkflow(
    workflow: WorkflowRecord,
    labels: WorkflowLabelRecord[],
  ): Promise<WorkflowRecord> {
    const parentRef = this.workflowRef(workflow.id);
    const expiresAt = this.ttlFrom(workflow.sourceExpiresAt);

    // Las etiquetas se escriben antes que el documento padre: si algo falla a
    // mitad, lo que queda es contenido huérfano invisible para el listado, no un
    // lote visible al que le faltan etiquetas.
    for (let i = 0; i < labels.length; i += WRITE_BATCH_SIZE) {
      const batch = this.db.batch();
      for (const label of labels.slice(i, i + WRITE_BATCH_SIZE)) {
        batch.set(
          parentRef
            .collection(WORKFLOW_LABELS_SUBCOLLECTION)
            .doc(label.labelId),
          { ...label, expiresAt },
        );
      }
      await batch.commit();
    }

    // El documento padre es lo que hace visible el lote, así que su creación —y
    // no la de las etiquetas, que van en lotes de escritura— es la que se
    // protege contra la lápida de cuenta borrada.
    await this.db.runTransaction(async (transaction) => {
      await assertAccountAlive(transaction, this.db, workflow.ownerId);
      transaction.create(parentRef, { ...workflow, expiresAt });
    });

    return workflow;
  }

  async getWorkflow(
    accountId: string,
    workflowId: string,
  ): Promise<WorkflowRecord | null> {
    const snapshot = await this.workflowRef(workflowId).get();
    if (!snapshot.exists) return null;
    const data = this.toWorkflow(snapshot.data());
    // Un lote ajeno se trata como inexistente: distinguirlos confirmaría el id.
    if (data.ownerId !== accountId) return null;
    return data;
  }

  async listWorkflows(
    accountId: string,
    options: ListWorkflowsOptions,
  ): Promise<ListWorkflowsResult> {
    let query = this.db
      .collection(WORKFLOWS_COLLECTION)
      .where('ownerId', '==', accountId);

    if (options.status) {
      query = query.where('status', '==', options.status);
    }

    query = query.orderBy('createdAt', 'desc').orderBy('id', 'desc');

    if (options.cursor) {
      const decoded = decodeCursor(options.cursor);
      if (decoded) {
        query = query.startAfter(decoded.createdAt, decoded.id);
      }
    }

    const snapshot = await query.limit(options.limit + 1).get();
    const items = snapshot.docs
      .slice(0, options.limit)
      .map((doc) => this.toWorkflow(doc.data()));

    return {
      items,
      nextCursor:
        snapshot.docs.length > options.limit && items.length > 0
          ? encodeCursor(items[items.length - 1])
          : undefined,
    };
  }

  async countActiveWorkflows(accountId: string): Promise<number> {
    const snapshot = await this.db
      .collection(WORKFLOWS_COLLECTION)
      .where('ownerId', '==', accountId)
      .where('status', 'in', ['draft', 'ready'])
      .count()
      .get();
    return snapshot.data().count;
  }

  async getLabels(
    accountId: string,
    workflowId: string,
  ): Promise<WorkflowLabelRecord[]> {
    const snapshot = await this.workflowRef(workflowId)
      .collection(WORKFLOW_LABELS_SUBCOLLECTION)
      .get();

    return snapshot.docs
      .map((doc) => {
        const { expiresAt: _expiresAt, ...rest } = doc.data();
        return rest as WorkflowLabelRecord;
      })
      .filter((label) => label.accountId === accountId)
      .sort((a, b) => a.sequence - b.sequence);
  }

  async updateWorkflow(
    accountId: string,
    workflowId: string,
    expectedVersion: number,
    mutate: (current: WorkflowRecord) => Partial<WorkflowRecord>,
  ): Promise<WorkflowRecord> {
    const parentRef = this.workflowRef(workflowId);

    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(parentRef);
      if (!snapshot.exists) throw new WorkflowMissingError(workflowId);

      const current = this.toWorkflow(snapshot.data());
      if (current.ownerId !== accountId) {
        throw new WorkflowMissingError(workflowId);
      }
      if (current.version !== expectedVersion) {
        throw new WorkflowVersionConflictError(
          expectedVersion,
          current.version,
        );
      }

      const patch = mutate(current);
      const next: WorkflowRecord = {
        ...current,
        ...patch,
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      };

      transaction.set(parentRef, {
        ...next,
        expiresAt: this.ttlFrom(next.sourceExpiresAt),
      });
      return next;
    });
  }

  async appendJobRef(
    accountId: string,
    workflowId: string,
    jobRef: WorkflowJobRef,
  ): Promise<WorkflowRecord> {
    const parentRef = this.workflowRef(workflowId);

    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(parentRef);
      if (!snapshot.exists) throw new WorkflowMissingError(workflowId);
      await assertAccountAlive(transaction, this.db, accountId);

      const current = this.toWorkflow(snapshot.data());
      if (current.ownerId !== accountId) {
        throw new WorkflowMissingError(workflowId);
      }

      // Repetir el mismo exportId no duplica la referencia.
      if (current.jobRefs.some((ref) => ref.exportId === jobRef.exportId)) {
        return current;
      }

      const next: WorkflowRecord = {
        ...current,
        jobRefs: [...current.jobRefs, jobRef],
        status: current.status === 'draft' ? 'ready' : current.status,
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      };

      transaction.set(parentRef, {
        ...next,
        expiresAt: this.ttlFrom(next.sourceExpiresAt),
      });
      return next;
    });
  }

  async deleteWorkflow(accountId: string, workflowId: string): Promise<void> {
    const parentRef = this.workflowRef(workflowId);
    const snapshot = await parentRef.get();
    if (!snapshot.exists) return;
    if (this.toWorkflow(snapshot.data()).ownerId !== accountId) {
      throw new WorkflowMissingError(workflowId);
    }

    const labels = await parentRef
      .collection(WORKFLOW_LABELS_SUBCOLLECTION)
      .get();

    for (let i = 0; i < labels.docs.length; i += WRITE_BATCH_SIZE) {
      const batch = this.db.batch();
      for (const doc of labels.docs.slice(i, i + WRITE_BATCH_SIZE)) {
        batch.delete(doc.ref);
      }
      await batch.commit();
    }

    await parentRef.delete();
  }

  /**
   * Crear el documento ES reservar la operación: su id deriva de la cuenta, de
   * la `Idempotency-Key` y de la intención, así que dos peticiones iguales
   * compiten por el mismo documento dentro de una transacción.
   */
  async reserveExport(
    candidate: ExportRecord,
    now: Date,
  ): Promise<ReserveExportResult> {
    const ref = this.exportRef(candidate.exportId);

    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      await assertAccountAlive(transaction, this.db, candidate.accountId);

      const existing = snapshot.exists
        ? operationFromFirestore<ExportRecord>(snapshot.data())
        : undefined;
      const result = reserveOperation(
        candidate,
        existing,
        now,
        EXPORT_LEASE_MS,
      );
      if (result.outcome === 'reserved')
        transaction.set(ref, operationToFirestore(result.record));
      return result as ReserveExportResult;
    });
  }

  async renewExport(exportId: string, token: string): Promise<void> {
    const ref = this.exportRef(exportId);
    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new WorkflowMissingError(exportId);
      const current = operationFromFirestore<ExportRecord>(snapshot.data());
      await assertAccountAlive(transaction, this.db, current.accountId);
      assertOperationLease(current, token);
      transaction.update(ref, {
        leaseExpiresAt: new Date(Date.now() + EXPORT_LEASE_MS).toISOString(),
      });
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
    const ref = this.exportRef(exportId);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new WorkflowMissingError(exportId);

      const current = operationFromFirestore<ExportRecord>(snapshot.data());
      await assertAccountAlive(transaction, this.db, current.accountId);
      if (current.status === 'accepted') return structuredClone(current);
      assertOperationLease(current, token);

      const next: ExportRecord = {
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
      // La exportación pasa a `accepted` y su hecho nace en la misma
      // transacción: no hay ventana en la que una exista sin el otro.
      writeOutboxRecord(transaction, this.db, outbox);
      return next;
    });
  }

  async failExport(
    exportId: string,
    token: string,
    errorCode: string,
  ): Promise<ExportRecord> {
    const ref = this.exportRef(exportId);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new WorkflowMissingError(exportId);
      const current = operationFromFirestore<ExportRecord>(snapshot.data());
      await assertAccountAlive(transaction, this.db, current.accountId);
      if (current.status === 'accepted') return current;
      assertOperationLease(current, token);
      const next: ExportRecord = {
        ...operationFromFirestore<ExportRecord>(snapshot.data()),
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

  async getExport(
    accountId: string,
    exportId: string,
  ): Promise<ExportRecord | null> {
    const snapshot = await this.exportRef(exportId).get();
    if (!snapshot.exists) return null;
    const record = operationFromFirestore<ExportRecord>(snapshot.data());
    return record.accountId === accountId ? record : null;
  }

  async listExports(
    accountId: string,
    workflowId: string,
  ): Promise<ExportRecord[]> {
    const snapshot = await this.db
      .collection(WORKFLOW_EXPORTS_COLLECTION)
      .where('accountId', '==', accountId)
      .where('workflowId', '==', workflowId)
      .orderBy('createdAt', 'desc')
      .get();
    return snapshot.docs.map((doc) =>
      operationFromFirestore<ExportRecord>(doc.data()),
    );
  }

  async countExports(accountId: string, workflowId: string): Promise<number> {
    const snapshot = await this.db
      .collection(WORKFLOW_EXPORTS_COLLECTION)
      .where('accountId', '==', accountId)
      .where('workflowId', '==', workflowId)
      .count()
      .get();
    return snapshot.data().count;
  }

  /**
   * Borrar el lote no borra sus exportaciones: son el registro de lo que ya se
   * aceptó (y se cobró). Solo se marcan.
   */
  async markExportsWorkflowDeleted(
    accountId: string,
    workflowId: string,
  ): Promise<void> {
    const snapshot = await this.db
      .collection(WORKFLOW_EXPORTS_COLLECTION)
      .where('accountId', '==', accountId)
      .where('workflowId', '==', workflowId)
      .get();

    for (let i = 0; i < snapshot.docs.length; i += WRITE_BATCH_SIZE) {
      const batch = this.db.batch();
      for (const doc of snapshot.docs.slice(i, i + WRITE_BATCH_SIZE)) {
        batch.update(doc.ref, { workflowDeleted: true });
      }
      await batch.commit();
    }
  }
}
