import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ErrorCodes } from '../../common/constants/error-codes.js';
import { DEFAULT_PLAN_LIMITS } from '../../common/interfaces/user.interface.js';
import { UsersService } from '../users/users.service.js';
import {
  normalizeLabelSize,
  isKnownLabelSize,
} from '../zpl/enums/label-size.enum.js';
import { FEATURE_GATE } from './ports/feature-gate.port.js';
import type { FeatureGatePort } from './ports/feature-gate.port.js';
import { LabelEventPublisher } from './label-event.publisher.js';
import { AccountDeletedError } from './label-event.outbox.js';
import type { OutboxEventRecord } from './label-event.outbox.js';
import type { LabelServerEvent } from './ports/label-event-recorder.port.js';
import {
  PACKING_FEATURE_ID,
  PACKING_FEATURE_VERSION,
  WORKFLOW_LIMITS,
  WORKFLOW_SOURCE_RETENTION_MS,
} from './workflows.constants.js';
import { WorkflowErrorCodes } from './workflow-error-codes.js';
import {
  WORKFLOW_REPOSITORY,
  WorkflowMissingError,
  WorkflowVersionConflictError,
} from './workflows.types.js';
import type {
  WorkflowLabelRecord,
  WorkflowRecord,
  WorkflowRepositoryPort,
  WorkflowStatus,
} from './workflows.types.js';
import { buildLabelId, parseZplLabels, sha256Hex } from './zpl-label-parser.js';
import { ReconcileInputError, reconcileWorkflow } from './reconcile.js';
import type {
  CreateWorkflowDto,
  ReconcileDto,
} from './dto/workflow-request.dto.js';
import type { LabelRefDto, WorkflowDto } from './dto/workflow-response.dto.js';

export interface WorkflowActor {
  uid: string;
  email?: string;
}

@Injectable()
export class WorkflowsService {
  private readonly logger = new Logger(WorkflowsService.name);

  constructor(
    @Inject(WORKFLOW_REPOSITORY)
    private readonly repository: WorkflowRepositoryPort,
    private readonly usersService: UsersService,
    @Inject(FEATURE_GATE) private readonly featureGate: FeatureGatePort,
    private readonly events: LabelEventPublisher,
  ) {}

  // ============== helpers compartidos con el servicio de exportación ==============

  /**
   * Construye el hecho canónico que la transacción de negocio va a escribir con
   * ella. No entrega nada: solo fija `eventId` y `occurredAt`.
   */
  prepareEvent(
    event: Omit<LabelServerEvent, 'eventId' | 'schemaVersion' | 'occurredAt'>,
  ): OutboxEventRecord {
    return this.events.prepare(event);
  }

  /**
   * Intenta entregar un hecho ya confirmado. Nunca lanza: el dato está a salvo
   * en la cola y el drenado lo reintentará.
   */
  async deliverEvent(record: OutboxEventRecord): Promise<void> {
    await this.events.deliverAfterCommit(record);
  }

  async assertFeature(accountId: string): Promise<void> {
    await this.featureGate.assertFeatureAvailable(
      accountId,
      PACKING_FEATURE_ID,
    );
  }

  /** Tope de etiquetas (contando copias) que el plan admite en una salida. */
  async getPlanLabelLimit(userId: string): Promise<number> {
    const user = await this.usersService.getUserById(userId);
    if (!user) {
      throw new NotFoundException({
        error: ErrorCodes.USER_NOT_FOUND,
        message: 'Usuario no encontrado',
      });
    }
    const plan = this.usersService.getEffectivePlan(user);
    return DEFAULT_PLAN_LIMITS[plan].maxLabelsPerPdf;
  }

  async getOwnedWorkflow(
    accountId: string,
    workflowId: string,
  ): Promise<WorkflowRecord> {
    const workflow = await this.repository.getWorkflow(accountId, workflowId);
    if (!workflow) {
      // Mismo error para "no existe" y "no es tuyo": distinguirlos confirmaría
      // el id de otra cuenta.
      throw new NotFoundException({
        error: WorkflowErrorCodes.WORKFLOW_NOT_FOUND,
        message: 'Lote no encontrado',
      });
    }
    return workflow;
  }

  assertSourceAlive(workflow: WorkflowRecord): void {
    // El TTL de Firestore no borra al instante, así que la caducidad se
    // comprueba también al leer.
    if (new Date(workflow.sourceExpiresAt).getTime() <= Date.now()) {
      throw new GoneException({
        error: WorkflowErrorCodes.WORKFLOW_SOURCE_EXPIRED,
        message: 'El ZPL de origen de este lote ya expiró',
        data: { sourceExpiresAt: workflow.sourceExpiresAt },
      });
    }
  }

  translateRepositoryError(error: unknown): never {
    if (error instanceof AccountDeletedError) {
      // La lápida la comprueba la propia transacción de negocio, así que aquí
      // solo se traduce: la cuenta desapareció entre la lectura y la escritura.
      throw new GoneException({
        error: WorkflowErrorCodes.ACCOUNT_DELETED,
        message: 'La cuenta ya no existe',
      });
    }
    if (error instanceof WorkflowVersionConflictError) {
      throw new ConflictException({
        error: WorkflowErrorCodes.WORKFLOW_VERSION_CONFLICT,
        message:
          'El lote cambió desde la última lectura; vuelve a cargarlo antes de reintentar',
        data: {
          expectedVersion: error.expectedVersion,
          currentVersion: error.currentVersion,
        },
      });
    }
    if (error instanceof WorkflowMissingError) {
      throw new NotFoundException({
        error: WorkflowErrorCodes.WORKFLOW_NOT_FOUND,
        message: 'Lote no encontrado',
      });
    }
    throw error as Error;
  }

  // ============== creación ==============

  async createWorkflow(
    actor: WorkflowActor,
    dto: CreateWorkflowDto,
  ): Promise<WorkflowDto> {
    await this.assertFeature(actor.uid);

    if (
      (!dto.zplContent && !dto.historyId) ||
      (dto.zplContent && dto.historyId)
    ) {
      throw new BadRequestException({
        error: ErrorCodes.INVALID_INPUT,
        message: 'Indica zplContent o historyId, exactamente uno de los dos',
      });
    }

    let zplContent = dto.zplContent ?? '';
    let labelSize = dto.labelSize;
    const sourceRefs: WorkflowRecord['sourceRefs'] = [];

    if (dto.historyId) {
      // Reconvertir una selección no exige volver a subir el archivo. Reutiliza
      // la recuperación del original que ya existe (con su retención de 15 días
      // y su propio control de acceso).
      const original = await this.usersService.getHistoryZpl(
        actor.uid,
        dto.historyId,
      );
      zplContent = original.zplContent;
      labelSize = dto.labelSize || original.labelSize;
      sourceRefs.push({
        kind: 'history',
        historyId: dto.historyId,
        sha256: sha256Hex(zplContent),
        byteSize: Buffer.byteLength(zplContent, 'utf8'),
      });
    } else {
      sourceRefs.push({
        kind: 'inline_zpl',
        originalFilename: dto.originalFilename,
        sha256: sha256Hex(zplContent),
        byteSize: Buffer.byteLength(zplContent, 'utf8'),
      });
    }

    const byteSize = Buffer.byteLength(zplContent, 'utf8');
    if (byteSize > WORKFLOW_LIMITS.maxSourceBytes) {
      throw new PayloadTooLargeException({
        error: WorkflowErrorCodes.WORKFLOW_SOURCE_TOO_LARGE,
        message: 'El ZPL de origen supera el tamaño admitido',
        data: { maxBytes: WORKFLOW_LIMITS.maxSourceBytes, byteSize },
      });
    }

    if (!isKnownLabelSize(labelSize)) {
      throw new BadRequestException({
        error: ErrorCodes.INVALID_LABEL_SIZE,
        message: `Tamaño de etiqueta no reconocido: ${labelSize}`,
      });
    }

    const parsed = parseZplLabels(zplContent);
    if (parsed.length === 0) {
      throw new BadRequestException({
        error: ErrorCodes.INVALID_ZPL,
        message: 'No se encontraron etiquetas válidas en el contenido ZPL',
      });
    }

    if (parsed.length > WORKFLOW_LIMITS.maxLabelsPerWorkflow) {
      throw new ForbiddenException({
        error: WorkflowErrorCodes.WORKFLOW_LABEL_LIMIT_EXCEEDED,
        message: 'El lote supera el número de etiquetas admitido',
        data: {
          limit: WORKFLOW_LIMITS.maxLabelsPerWorkflow,
          actual: parsed.length,
          scope: 'absolute',
        },
      });
    }

    const oversized = parsed.find(
      (label) => label.copies > WORKFLOW_LIMITS.maxCopiesPerLabel,
    );
    if (oversized) {
      throw new ForbiddenException({
        error: WorkflowErrorCodes.WORKFLOW_COPIES_LIMIT_EXCEEDED,
        message: 'Una etiqueta declara más copias de las admitidas',
        data: {
          limit: WORKFLOW_LIMITS.maxCopiesPerLabel,
          actual: oversized.copies,
          sequence: oversized.sequence,
        },
      });
    }

    const totalCopies = parsed.reduce((sum, label) => sum + label.copies, 0);
    const planLimit = await this.getPlanLabelLimit(actor.uid);
    // Se compara contra las copias, que es lo que cuenta el conversor al
    // aceptar la exportación: así el rechazo llega al crear y no después.
    if (totalCopies > planLimit) {
      throw new ForbiddenException({
        error: WorkflowErrorCodes.WORKFLOW_LABEL_LIMIT_EXCEEDED,
        message: 'El lote supera el número de etiquetas que admite el plan',
        data: { limit: planLimit, actual: totalCopies, scope: 'plan' },
      });
    }

    const activeWorkflows = await this.repository.countActiveWorkflows(
      actor.uid,
    );
    if (activeWorkflows >= WORKFLOW_LIMITS.maxActiveWorkflowsPerAccount) {
      throw new ForbiddenException({
        error: WorkflowErrorCodes.WORKFLOW_QUOTA_EXCEEDED,
        message: 'Hay demasiados lotes activos; archiva o borra alguno',
        data: {
          limit: WORKFLOW_LIMITS.maxActiveWorkflowsPerAccount,
          actual: activeWorkflows,
        },
      });
    }

    // UUIDv4 sin prefijo: el registro de eventos canónicos valida el formato
    // de `workflowId`, así que no admite un id decorado.
    const workflowId = randomUUID();
    const now = new Date();
    const labels: WorkflowLabelRecord[] = parsed.map((label) => ({
      labelId: buildLabelId(workflowId, label.sequence, label.contentHash),
      workflowId,
      accountId: actor.uid,
      sequence: label.sequence,
      zpl: label.zpl,
      copies: label.copies,
      contentHash: label.contentHash,
      groupId: label.groupId,
      byteSize: label.byteSize,
      fields: label.fields,
      serialized: label.serialized,
    }));

    const workflow: WorkflowRecord = {
      id: workflowId,
      accountId: actor.uid,
      ownerId: actor.uid,
      featureId: PACKING_FEATURE_ID,
      featureVersion: PACKING_FEATURE_VERSION,
      status: 'draft',
      name: dto.name,
      labelSize: normalizeLabelSize(labelSize),
      outputFormat: dto.outputFormat ?? 'pdf',
      version: 1,
      totalLabels: labels.length,
      totalCopies,
      orderIds: labels.map((label) => label.labelId),
      selectedIds: labels.map((label) => label.labelId),
      sourceRefs,
      jobRefs: [],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      sourceExpiresAt: new Date(
        now.getTime() + WORKFLOW_SOURCE_RETENTION_MS,
      ).toISOString(),
    };

    try {
      await this.repository.createWorkflow(workflow, labels);
    } catch (error) {
      this.translateRepositoryError(error);
    }
    return this.toDto(workflow, labels);
  }

  // ============== lectura ==============

  async getWorkflow(
    accountId: string,
    workflowId: string,
  ): Promise<WorkflowDto> {
    const workflow = await this.getOwnedWorkflow(accountId, workflowId);
    const labels = await this.repository.getLabels(accountId, workflowId);
    return this.toDto(workflow, labels);
  }

  async listWorkflows(
    accountId: string,
    options: { limit?: string; cursor?: string; status?: WorkflowStatus },
  ): Promise<{ items: WorkflowDto[]; nextCursor?: string }> {
    const parsedLimit = Number.parseInt(options.limit ?? '', 10);
    const limit = Math.min(
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? parsedLimit
        : WORKFLOW_LIMITS.defaultPageSize,
      WORKFLOW_LIMITS.maxPageSize,
    );

    const result = await this.repository.listWorkflows(accountId, {
      limit,
      cursor: options.cursor,
      status: options.status,
    });

    return {
      items: result.items.map((workflow) => this.toDto(workflow)),
      nextCursor: result.nextCursor,
    };
  }

  // ============== orden y selección ==============

  async updateOrder(
    accountId: string,
    workflowId: string,
    expectedVersion: number,
    labelIds: string[],
  ): Promise<WorkflowDto> {
    const workflow = await this.getOwnedWorkflow(accountId, workflowId);
    this.assertNotArchived(workflow);
    const labels = await this.repository.getLabels(accountId, workflowId);

    const known = new Set(labels.map((label) => label.labelId));
    const received = new Set(labelIds);
    const unknown = labelIds.filter((id) => !known.has(id));
    const missing = [...known].filter((id) => !received.has(id));

    // Se exige una permutación completa: reordenar no puede añadir, quitar ni
    // repetir etiquetas, y por tanto tampoco puede cambiar las copias.
    if (
      unknown.length > 0 ||
      missing.length > 0 ||
      received.size !== labelIds.length
    ) {
      throw new BadRequestException({
        error: WorkflowErrorCodes.WORKFLOW_ORDER_MISMATCH,
        message:
          'El orden debe ser una permutación completa de las etiquetas del lote',
        data: {
          unknown,
          missing,
          duplicated: labelIds.length - received.size,
        },
      });
    }

    try {
      const updated = await this.repository.updateWorkflow(
        accountId,
        workflowId,
        expectedVersion,
        () => ({ orderIds: [...labelIds] }),
      );
      return this.toDto(updated, labels);
    } catch (error) {
      this.translateRepositoryError(error);
    }
  }

  async updateSelection(
    accountId: string,
    workflowId: string,
    expectedVersion: number,
    input: {
      mode: 'replace' | 'select' | 'deselect';
      labelIds?: string[];
      groupIds?: string[];
    },
  ): Promise<WorkflowDto> {
    const workflow = await this.getOwnedWorkflow(accountId, workflowId);
    this.assertNotArchived(workflow);
    const labels = await this.repository.getLabels(accountId, workflowId);

    const byId = new Map(labels.map((label) => [label.labelId, label]));
    const target = new Set<string>();

    for (const labelId of input.labelIds ?? []) {
      if (!byId.has(labelId)) {
        throw new BadRequestException({
          error: WorkflowErrorCodes.WORKFLOW_ORDER_MISMATCH,
          message: 'Hay etiquetas que no pertenecen a este lote',
          data: { unknown: [labelId] },
        });
      }
      target.add(labelId);
    }

    // Seleccionar por grupo cubre "todas las copias de esta etiqueta".
    const groups = new Set(input.groupIds ?? []);
    if (groups.size > 0) {
      const known = new Set(labels.map((label) => label.groupId));
      const unknownGroups = [...groups].filter((id) => !known.has(id));
      if (unknownGroups.length > 0) {
        throw new BadRequestException({
          error: WorkflowErrorCodes.WORKFLOW_ORDER_MISMATCH,
          message: 'Hay grupos que no pertenecen a este lote',
          data: { unknown: unknownGroups },
        });
      }
      for (const label of labels) {
        if (groups.has(label.groupId)) target.add(label.labelId);
      }
    }

    const current = new Set(workflow.selectedIds);
    let next: Set<string>;
    if (input.mode === 'replace') {
      next = target;
    } else if (input.mode === 'select') {
      next = new Set([...current, ...target]);
    } else {
      next = new Set([...current].filter((id) => !target.has(id)));
    }

    if (next.size === 0) {
      throw new BadRequestException({
        error: WorkflowErrorCodes.WORKFLOW_SELECTION_EMPTY,
        message: 'La selección no puede quedar vacía',
      });
    }

    // Se guarda en el orden del lote para que la respuesta sea estable.
    const selectedIds = workflow.orderIds.filter((id) => next.has(id));

    try {
      const updated = await this.repository.updateWorkflow(
        accountId,
        workflowId,
        expectedVersion,
        () => ({ selectedIds }),
      );
      return this.toDto(updated, labels);
    } catch (error) {
      this.translateRepositoryError(error);
    }
  }

  /**
   * Copias que se van a imprimir de una etiqueta: el override si existe y, si
   * no, las que declaró `^PQ`. El valor original nunca se pierde, así que el
   * cambio es explicable y reversible.
   */
  effectiveCopies(
    workflow: WorkflowRecord,
    label: Pick<WorkflowLabelRecord, 'labelId' | 'copies'>,
  ): number {
    return workflow.copiesOverrides?.[label.labelId] ?? label.copies;
  }

  private totalCopiesOf(
    workflow: WorkflowRecord,
    labels: WorkflowLabelRecord[],
  ): number {
    return labels.reduce(
      (sum, label) => sum + this.effectiveCopies(workflow, label),
      0,
    );
  }

  /**
   * Fija a mano las copias de etiquetas concretas.
   *
   * Se rechaza sobre una etiqueta serializada (`^SN`/`^SF`): la impresora
   * genera un valor distinto en cada copia, así que cambiar el número de copias
   * cambiaría la secuencia impresa. El frontend ve el motivo por adelantado en
   * `label.serialized`, pero el servidor no se fía de eso y lo vuelve a
   * comprobar.
   */
  async updateCopies(
    accountId: string,
    workflowId: string,
    expectedVersion: number,
    items: { labelId: string; copies: number }[],
  ): Promise<WorkflowDto> {
    const workflow = await this.getOwnedWorkflow(accountId, workflowId);
    this.assertNotArchived(workflow);
    const labels = await this.repository.getLabels(accountId, workflowId);
    const byId = new Map(labels.map((label) => [label.labelId, label]));

    const unknown = items
      .map((item) => item.labelId)
      .filter((labelId) => !byId.has(labelId));
    if (unknown.length > 0) {
      throw new BadRequestException({
        error: WorkflowErrorCodes.WORKFLOW_ORDER_MISMATCH,
        message: 'Hay etiquetas que no pertenecen a este lote',
        data: { unknown },
      });
    }

    const serialized = items
      .map((item) => byId.get(item.labelId))
      .filter((label) => label?.serialized)
      .map((label) => label.labelId);
    if (serialized.length > 0) {
      throw new UnprocessableEntityException({
        error: WorkflowErrorCodes.WORKFLOW_SERIALIZED_LABEL,
        message:
          'Una etiqueta con serialización (^SN/^SF) no admite cambiar sus copias: la secuencia impresa depende de ellas',
        data: { labelIds: serialized },
      });
    }

    const invalid = items.filter(
      (item) =>
        !Number.isInteger(item.copies) ||
        item.copies < 1 ||
        item.copies > WORKFLOW_LIMITS.maxCopiesPerLabel,
    );
    if (invalid.length > 0) {
      throw new BadRequestException({
        error: WorkflowErrorCodes.WORKFLOW_COPIES_LIMIT_EXCEEDED,
        message: `Las copias deben ser un entero entre 1 y ${WORKFLOW_LIMITS.maxCopiesPerLabel}`,
        data: { items: invalid },
      });
    }

    const copiesOverrides = { ...(workflow.copiesOverrides ?? {}) };
    for (const item of items) {
      const original = byId.get(item.labelId).copies;
      // Volver al valor de `^PQ` borra el override en vez de dejar un rastro
      // que diga lo mismo.
      if (item.copies === original) delete copiesOverrides[item.labelId];
      else copiesOverrides[item.labelId] = item.copies;
    }

    const projected: WorkflowRecord = { ...workflow, copiesOverrides };
    const totalCopies = this.totalCopiesOf(projected, labels);
    const planLimit = await this.getPlanLabelLimit(accountId);

    if (totalCopies > planLimit) {
      throw new ForbiddenException({
        error: WorkflowErrorCodes.WORKFLOW_LABEL_LIMIT_EXCEEDED,
        message: 'Con esas copias el lote supera lo que admite el plan',
        data: { limit: planLimit, actual: totalCopies, scope: 'plan' },
      });
    }

    try {
      const updated = await this.repository.updateWorkflow(
        accountId,
        workflowId,
        expectedVersion,
        () => ({ copiesOverrides, totalCopies }),
      );
      return this.toDto(updated, labels);
    } catch (error) {
      this.translateRepositoryError(error);
    }
  }

  // ============== cotejo ==============

  async reconcile(
    actor: WorkflowActor,
    workflowId: string,
    dto: ReconcileDto,
  ): Promise<{ workflow: WorkflowDto; ignoredColumns: string[] }> {
    await this.assertFeature(actor.uid);
    const workflow = await this.getOwnedWorkflow(actor.uid, workflowId);
    this.assertNotArchived(workflow);
    const labels = await this.repository.getLabels(actor.uid, workflowId);

    let result: ReturnType<typeof reconcileWorkflow>;
    try {
      result = reconcileWorkflow({
        format: dto.format,
        csvContent: dto.csvContent,
        delimiter: dto.delimiter,
        labels,
      });
    } catch (error) {
      if (error instanceof ReconcileInputError) {
        throw this.reconcileHttpError(error);
      }
      throw error;
    }

    const outbox = this.prepareEvent({
      eventName: 'packing_reconcile_completed',
      accountId: actor.uid,
      featureId: PACKING_FEATURE_ID,
      featureVersion: PACKING_FEATURE_VERSION,
      operationId: result.state.reconcileId,
      source: 'api',
      workflowId,
      labelCount: labels.length,
    });

    let updated: WorkflowRecord;
    try {
      // El cotejo no toca el orden, la selección ni las copias: solo añade
      // diagnóstico. Nada se borra, ni las repeticiones legítimas. El hecho va
      // en la misma transacción que el diagnóstico que lo justifica.
      updated = await this.repository.updateWorkflow(
        actor.uid,
        workflowId,
        dto.expectedVersion,
        () => ({ reconcile: result.state }),
        outbox,
      );
    } catch (error) {
      this.translateRepositoryError(error);
    }

    await this.deliverEvent(outbox);

    return {
      workflow: this.toDto(updated, labels),
      ignoredColumns: result.ignoredColumns,
    };
  }

  private reconcileHttpError(error: ReconcileInputError): HttpException {
    const body = {
      error: error.code,
      message: error.message,
      data: error.data,
    };

    switch (error.code) {
      case WorkflowErrorCodes.RECONCILE_TOO_LARGE:
        return new PayloadTooLargeException(body);
      case WorkflowErrorCodes.RECONCILE_ROW_ERRORS:
        return new UnprocessableEntityException(body);
      default:
        return new BadRequestException(body);
    }
  }

  // ============== ciclo de vida ==============

  async archiveWorkflow(
    accountId: string,
    workflowId: string,
    expectedVersion: number,
  ): Promise<WorkflowDto> {
    await this.getOwnedWorkflow(accountId, workflowId);
    try {
      const updated = await this.repository.updateWorkflow(
        accountId,
        workflowId,
        expectedVersion,
        () => ({ status: 'archived' as WorkflowStatus }),
      );
      return this.toDto(updated);
    } catch (error) {
      this.translateRepositoryError(error);
    }
  }

  async deleteWorkflow(accountId: string, workflowId: string): Promise<void> {
    await this.getOwnedWorkflow(accountId, workflowId);
    // Las exportaciones sobreviven: son el registro de lo que ya se aceptó.
    await this.repository.markExportsWorkflowDeleted(accountId, workflowId);
    await this.repository.deleteWorkflow(accountId, workflowId);
  }

  private assertNotArchived(workflow: WorkflowRecord): void {
    if (workflow.status === 'archived') {
      throw new ConflictException({
        error: WorkflowErrorCodes.WORKFLOW_ARCHIVED,
        message: 'El lote está archivado; no admite cambios',
      });
    }
  }

  // ============== presentación ==============

  toDto(workflow: WorkflowRecord, labels?: WorkflowLabelRecord[]): WorkflowDto {
    const selected = new Set(workflow.selectedIds);
    const byId = new Map((labels ?? []).map((label) => [label.labelId, label]));

    const ordered: LabelRefDto[] = labels
      ? workflow.orderIds
          .map((labelId, index) => {
            const label = byId.get(labelId);
            if (!label) return null;
            const outcome = workflow.reconcile?.byLabel?.[labelId];
            return {
              labelId,
              groupId: label.groupId,
              sequence: label.sequence,
              order: index + 1,
              copies: this.effectiveCopies(workflow, label),
              originalCopies: label.copies,
              copiesOverridden:
                workflow.copiesOverrides?.[labelId] !== undefined,
              serialized: label.serialized,
              selected: selected.has(labelId),
              contentHash: label.contentHash,
              byteSize: label.byteSize,
              fields: label.fields,
              reconcileStatus: outcome?.status,
              reconcileOrderId: outcome?.orderId,
              reconcileTracking: outcome?.tracking,
            } as LabelRefDto;
          })
          .filter((label): label is LabelRefDto => label !== null)
      : undefined;

    const selectedCopies = (labels ?? [])
      .filter((label) => selected.has(label.labelId))
      .reduce((sum, label) => sum + this.effectiveCopies(workflow, label), 0);

    const reconcile = workflow.reconcile
      ? {
          reconcileId: workflow.reconcile.reconcileId,
          format: workflow.reconcile.format,
          completedAt: workflow.reconcile.completedAt,
          rowCount: workflow.reconcile.rowCount,
          counts: workflow.reconcile.counts,
          missingRows: workflow.reconcile.missingRows,
          duplicateRows: workflow.reconcile.duplicateRows,
        }
      : undefined;

    return {
      id: workflow.id,
      accountId: workflow.accountId,
      featureId: workflow.featureId,
      featureVersion: workflow.featureVersion,
      status: workflow.status,
      name: workflow.name,
      labelSize: workflow.labelSize,
      outputFormat: workflow.outputFormat,
      version: workflow.version,
      totalLabels: workflow.totalLabels,
      totalCopies: workflow.totalCopies,
      selectedCount: workflow.selectedIds.length,
      selectedCopies: labels ? selectedCopies : undefined,
      sourceRefs: workflow.sourceRefs,
      jobRefs: workflow.jobRefs,
      reconcile,
      createdAt: workflow.createdAt,
      updatedAt: workflow.updatedAt,
      sourceExpiresAt: workflow.sourceExpiresAt,
      labels: ordered,
    } as WorkflowDto;
  }
}
