import { withOperationLease } from './operation-lease.js';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ZplService } from '../zpl/zpl.service.js';
import { OutputFormat } from '../zpl/enums/output-format.enum.js';
import {
  PACKING_FEATURE_ID,
  PACKING_FEATURE_VERSION,
  WORKFLOW_LIMITS,
} from './workflows.constants.js';
import { WorkflowErrorCodes } from './workflow-error-codes.js';
import { WORKFLOW_REPOSITORY } from './workflows.types.js';
import type {
  ExportRecord,
  WorkflowOutputFormat,
  WorkflowRepositoryPort,
} from './workflows.types.js';
import { buildExportZpl, sha256Hex } from './zpl-label-parser.js';
import { asAccountDeletedResponse } from './label-event.outbox.js';
import { deterministicUuidV4 } from './deterministic-uuid.js';
import { WorkflowsService } from './workflows.service.js';
import type { WorkflowActor } from './workflows.service.js';
import type { CreateExportDto } from './dto/workflow-request.dto.js';
import type { WorkflowExportDto } from './dto/workflow-response.dto.js';

@Injectable()
export class WorkflowExportsService {
  private readonly logger = new Logger(WorkflowExportsService.name);

  constructor(
    @Inject(WORKFLOW_REPOSITORY)
    private readonly repository: WorkflowRepositoryPort,
    private readonly workflows: WorkflowsService,
    private readonly zplService: ZplService,
  ) {}

  /**
   * Identidad de la **intención**: qué se va a producir, no cómo se pidió.
   *
   * Una versión del lote fija su orden, su selección y sus copias, así que
   * (lote, versión, formato, reimpresión-de) determina el archivo por completo.
   * No se incluye el estado vivo a propósito: si dependiera de él, un reintento
   * después de que la exportación anterior subiera la versión calcularía otra
   * intención y volvería a consumir cuota.
   */
  private intentHash(
    workflowId: string,
    workflowVersion: number,
    outputFormat: WorkflowOutputFormat,
    reexportOf?: string,
  ): string {
    return sha256Hex(
      JSON.stringify({
        workflowId,
        workflowVersion,
        outputFormat,
        reexportOf: reexportOf ?? null,
      }),
    );
  }

  /**
   * El id del documento ES la identidad de la operación: cuenta + clave. Va en
   * formato UUIDv4 porque también es el `operationId` del puente de conversión
   * y del registro de eventos, que validan ese formato. La clave de otra cuenta
   * nunca colisiona porque el `accountId` entra en la semilla.
   */
  private exportIdFor(accountId: string, idempotencyKey: string): string {
    return deterministicUuidV4(
      `workflow-export:${accountId}:${idempotencyKey}`,
    );
  }

  async createExport(
    actor: WorkflowActor,
    workflowId: string,
    idempotencyKey: string,
    dto: CreateExportDto,
  ): Promise<{ export: WorkflowExportDto; created: boolean }> {
    await this.workflows.assertFeature(actor.uid);

    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      throw new BadRequestException({
        error: WorkflowErrorCodes.IDEMPOTENCY_KEY_REQUIRED,
        message: 'Falta la cabecera Idempotency-Key',
      });
    }
    if (idempotencyKey.length > 200) {
      throw new BadRequestException({
        error: WorkflowErrorCodes.IDEMPOTENCY_KEY_REQUIRED,
        message: 'La cabecera Idempotency-Key es demasiado larga',
        data: { maxLength: 200 },
      });
    }

    // La reserva va PRIMERO: un reintento idéntico se resuelve antes de tocar
    // el lote, así que no puede chocar con el CAS ni consumir cuota otra vez.
    const exportId = this.exportIdFor(actor.uid, idempotencyKey);
    const prior = await this.repository.getExport(actor.uid, exportId);
    if (prior && prior.status !== 'accepted' && !prior.workflowSnapshot) {
      throw new ConflictException({
        error: 'OPERATION_REPLAY_CONTEXT_MISSING',
        message:
          'La reserva antigua no conserva el contexto necesario para reintentar con seguridad',
      });
    }
    const workflowPeek = await this.workflows.getOwnedWorkflow(
      actor.uid,
      workflowId,
    );
    const outputFormat =
      dto.outputFormat ?? prior?.outputFormat ?? workflowPeek.outputFormat;
    const intentHash = this.intentHash(
      workflowId,
      dto.expectedVersion,
      outputFormat,
      dto.reexportOf,
    );
    const now = new Date();

    const reservation = await this.reserveOrTranslate(
      {
        exportId,
        accountId: actor.uid,
        workflowId,
        idempotencyKey,
        intentHash,
        status: 'pending',
        workflowVersion: dto.expectedVersion,
        workflowSnapshot: {
          ...workflowPeek,
          reconcile: undefined,
          jobRefs: [],
          sourceRefs: [],
        },
        outputFormat,
        labelIds: [],
        labelCount: 0,
        uniqueLabelCount: 0,
        reexportOf: dto.reexportOf,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      now,
    );

    if (reservation.outcome === 'existing') {
      await this.appendAcceptedJob(reservation.record);
      return {
        export: this.toDto(reservation.record, true),
        created: false,
      };
    }

    if (reservation.outcome === 'in_progress') {
      throw new ConflictException({
        error: WorkflowErrorCodes.EXPORT_IN_PROGRESS,
        message: 'La misma exportación está en curso',
        data: { exportId },
      });
    }

    if (reservation.outcome === 'key_reused') {
      throw new ConflictException({
        error: WorkflowErrorCodes.IDEMPOTENCY_KEY_REUSED,
        message: 'Esa Idempotency-Key ya se usó para otra exportación distinta',
        data: { exportId },
      });
    }

    try {
      return await this.runExport(
        actor,
        workflowId,
        exportId,
        dto,
        outputFormat,
        reservation.record,
      );
    } catch (error: any) {
      const gone = asAccountDeletedResponse(
        error,
        WorkflowErrorCodes.ACCOUNT_DELETED,
      );
      const errorCode = gone
        ? WorkflowErrorCodes.ACCOUNT_DELETED
        : (error?.response?.error ??
          error?.getResponse?.()?.error ??
          'SERVER_ERROR');
      // Se libera la reserva para que el cliente pueda reintentar con la misma
      // clave una vez resuelto el motivo (p. ej. cuota o conflicto de versión).
      const settled = await this.repository
        .failExport(exportId, reservation.record.leaseToken!, String(errorCode))
        .catch((failure) =>
          this.logger.error(
            `No se pudo marcar la exportación ${exportId} como fallida: ${failure?.message}`,
          ),
        );
      if (settled && settled.status === 'accepted')
        return { export: this.toDto(settled, true), created: false };
      throw gone ?? error;
    }
  }

  /**
   * La reserva ocurre fuera del `try` que libera la exportación, así que su
   * lápida se traduce aquí: una cuenta dada de baja no puede salir como 500.
   */
  private async reserveOrTranslate(
    candidate: Parameters<WorkflowRepositoryPort['reserveExport']>[0],
    now: Date,
  ) {
    try {
      return await this.repository.reserveExport(candidate, now);
    } catch (error) {
      const gone = asAccountDeletedResponse(
        error,
        WorkflowErrorCodes.ACCOUNT_DELETED,
      );
      if (gone) throw gone;
      throw error;
    }
  }

  private async runExport(
    actor: WorkflowActor,
    workflowId: string,
    exportId: string,
    dto: CreateExportDto,
    outputFormat: WorkflowOutputFormat,
    reservation: ExportRecord,
  ): Promise<{ export: WorkflowExportDto; created: boolean }> {
    const workflow =
      reservation.workflowSnapshot ??
      (await this.workflows.getOwnedWorkflow(actor.uid, workflowId));

    if (workflow.status === 'archived') {
      throw new ConflictException({
        error: WorkflowErrorCodes.WORKFLOW_ARCHIVED,
        message: 'El lote está archivado; no admite nuevas exportaciones',
      });
    }

    if (workflow.version !== dto.expectedVersion) {
      throw new ConflictException({
        error: WorkflowErrorCodes.WORKFLOW_VERSION_CONFLICT,
        message:
          'El lote cambió desde la última lectura; vuelve a cargarlo antes de exportar',
        data: {
          expectedVersion: dto.expectedVersion,
          currentVersion: workflow.version,
        },
      });
    }

    this.workflows.assertSourceAlive(workflow);

    const exportCount = await this.repository.countExports(
      actor.uid,
      workflowId,
    );
    if (exportCount >= WORKFLOW_LIMITS.maxExportsPerWorkflow) {
      throw new ForbiddenException({
        error: WorkflowErrorCodes.EXPORT_LIMIT_EXCEEDED,
        message: 'El lote alcanzó el número de exportaciones admitido',
        data: {
          limit: WORKFLOW_LIMITS.maxExportsPerWorkflow,
          actual: exportCount,
        },
      });
    }

    if (dto.reexportOf) {
      const previous = await this.repository.getExport(
        actor.uid,
        dto.reexportOf,
      );
      if (!previous || previous.workflowId !== workflowId) {
        throw new NotFoundException({
          error: WorkflowErrorCodes.EXPORT_NOT_FOUND,
          message: 'La exportación original no existe en este lote',
        });
      }
    }

    const labels = await this.repository.getLabels(actor.uid, workflowId);
    const byId = new Map(labels.map((label) => [label.labelId, label]));
    const selected = new Set(workflow.selectedIds);

    const ordered = workflow.orderIds
      .filter((labelId) => selected.has(labelId))
      .map((labelId) => byId.get(labelId))
      .filter((label): label is (typeof labels)[number] => !!label);

    if (ordered.length === 0) {
      throw new BadRequestException({
        error: WorkflowErrorCodes.WORKFLOW_SELECTION_EMPTY,
        message: 'No hay etiquetas seleccionadas para exportar',
      });
    }

    const labelCount = ordered.reduce(
      (sum, label) => sum + this.workflows.effectiveCopies(workflow, label),
      0,
    );
    const zplContent = buildExportZpl(
      ordered.map((label) => ({
        zpl: label.zpl,
        copies: this.workflows.effectiveCopies(workflow, label),
      })),
    );
    const startedAt = Date.now();

    // Puente duradero del conversor: espera a que la conversión termine,
    // reserva la cuota de forma atómica y es idempotente por `operationId`, que
    // aquí es el propio `exportId`. No hay un segundo renderizador ni un
    // segundo contador de cuota, y `jobId === exportId`.
    const conversion = await withOperationLease(
      () => this.repository.renewExport(exportId, reservation.leaseToken!),
      () =>
        this.zplService.runDurableConversion({
          operationId: exportId,
          userId: actor.uid,
          zplContent,
          labelSize: workflow.labelSize,
          outputFormat: outputFormat as OutputFormat,
          originalFilename: workflow.name ? `${workflow.name}.zpl` : undefined,
        }),
    );

    // El hecho se construye antes de confirmar —con su `eventId` y su
    // `occurredAt` definitivos— y se escribe DENTRO de la misma transacción que
    // pasa la exportación a `accepted`. La conversión ya terminó
    // (`runDurableConversion` devuelve `completed`), así que el hecho es cierto
    // en el momento en que se guarda.
    const outbox = this.workflows.prepareEvent({
      eventName: dto.reexportOf
        ? 'packing_reexport_succeeded'
        : 'packing_export_succeeded',
      accountId: actor.uid,
      featureId: PACKING_FEATURE_ID,
      featureVersion: PACKING_FEATURE_VERSION,
      operationId: exportId,
      source: 'api',
      workflowId,
      jobId: conversion.jobId,
      labelCount,
      durationMs: Date.now() - startedAt,
    });

    const record = await this.repository.completeExport(
      exportId,
      reservation.leaseToken!,
      {
        jobId: conversion.jobId,
        labelIds: ordered.map((label) => label.labelId),
        labelCount,
        uniqueLabelCount: new Set(ordered.map((label) => label.groupId)).size,
      },
      outbox,
    );

    await this.appendAcceptedJob(record);

    // Confirmado el negocio, se intenta entregar. Si falla o el proceso muere,
    // el hecho sigue en la cola y lo recoge el drenado.
    await this.workflows
      .deliverEvent(record.completionEvent)
      .catch((error) =>
        this.logger.warn(
          `El evento queda pendiente de entrega: ${error?.message}`,
        ),
      );

    const created = record.completionEvent?.id === outbox.id;
    return { export: this.toDto(record, !created), created };
  }

  private async appendAcceptedJob(record: ExportRecord): Promise<void> {
    if (!record.jobId) return;
    await this.repository
      .appendJobRef(record.accountId, record.workflowId, {
        exportId: record.exportId,
        jobId: record.jobId,
        createdAt: record.updatedAt,
        labelCount: record.labelCount,
        reexportOf: record.reexportOf,
      })
      .catch(() =>
        this.logger.warn(
          'No se pudo añadir la referencia de exportación; se reintentará al consultar la operación',
        ),
      );
  }

  async listExports(
    accountId: string,
    workflowId: string,
  ): Promise<{ items: WorkflowExportDto[] }> {
    await this.workflows.getOwnedWorkflow(accountId, workflowId);
    const records = await this.repository.listExports(accountId, workflowId);
    return {
      items: records
        .filter((record) => record.status !== 'pending')
        .map((record) => this.toDto(record, false)),
    };
  }

  private toDto(record: ExportRecord, idempotent: boolean): WorkflowExportDto {
    return {
      exportId: record.exportId,
      workflowId: record.workflowId,
      status: record.status === 'pending' ? 'failed' : record.status,
      jobId: record.jobId,
      reexportOf: record.reexportOf,
      workflowVersion: record.workflowVersion,
      labelCount: record.labelCount,
      uniqueLabelCount: record.uniqueLabelCount,
      labelIds: record.labelIds,
      intentHash: record.intentHash,
      idempotent,
      createdAt: record.createdAt,
      errorCode: record.errorCode,
    };
  }
}
