import { WorkflowPreviewService } from './workflow-preview.service.js';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { FirebaseUser } from '../../common/decorators/current-user.decorator.js';
import { WorkflowsService } from './workflows.service.js';
import { WorkflowExportsService } from './workflow-exports.service.js';
import {
  ArchiveWorkflowDto,
  WorkflowPreviewDto,
  CreateExportDto,
  CreateWorkflowDto,
  ListWorkflowsQueryDto,
  ReconcileDto,
  UpdateCopiesDto,
  UpdateOrderDto,
  UpdateSelectionDto,
} from './dto/workflow-request.dto.js';
import {
  WorkflowDto,
  WorkflowExportDto,
  WorkflowListDto,
} from './dto/workflow-response.dto.js';

@ApiTags('workflows')
@ApiBearerAuth()
@Controller('workflows')
@UseGuards(FirebaseAuthGuard)
export class WorkflowsController {
  constructor(
    private readonly workflowsService: WorkflowsService,
    private readonly exportsService: WorkflowExportsService,
    private readonly previews: WorkflowPreviewService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Crear un lote de etiquetas',
    description:
      'Divide el ZPL en etiquetas conservando el orden y las copias ^PQ. Admite ZPL directo o recuperarlo del historial sin volver a subirlo.',
  })
  @ApiResponse({ status: 201, type: WorkflowDto })
  create(
    @CurrentUser() user: FirebaseUser,
    @Body() dto: CreateWorkflowDto,
  ): Promise<WorkflowDto> {
    return this.workflowsService.createWorkflow(
      { uid: user.uid, email: user.email },
      dto,
    );
  }

  @Get()
  @ApiOperation({ summary: 'Listar los lotes de la cuenta' })
  @ApiResponse({ status: 200, type: WorkflowListDto })
  list(
    @CurrentUser() user: FirebaseUser,
    @Query() query: ListWorkflowsQueryDto,
  ): Promise<WorkflowListDto> {
    return this.workflowsService.listWorkflows(user.uid, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Leer un lote con sus etiquetas ya ordenadas' })
  @ApiResponse({ status: 200, type: WorkflowDto })
  get(
    @CurrentUser() user: FirebaseUser,
    @Param('id') id: string,
  ): Promise<WorkflowDto> {
    return this.workflowsService.getWorkflow(user.uid, id);
  }

  @Patch(':id/order')
  @ApiOperation({
    summary: 'Reordenar el lote',
    description:
      'Exige una permutación completa de los labelIds y la versión vigente (CAS). No cambia las copias.',
  })
  @ApiResponse({ status: 200, type: WorkflowDto })
  @ApiResponse({ status: 409, description: 'WORKFLOW_VERSION_CONFLICT' })
  updateOrder(
    @CurrentUser() user: FirebaseUser,
    @Param('id') id: string,
    @Body() dto: UpdateOrderDto,
  ): Promise<WorkflowDto> {
    return this.workflowsService.updateOrder(
      user.uid,
      id,
      dto.expectedVersion,
      dto.labelIds,
    );
  }

  @Patch(':id/selection')
  @ApiOperation({
    summary: 'Cambiar la selección',
    description:
      'Por etiqueta o por grupo de copias. La selección no puede quedar vacía.',
  })
  @ApiResponse({ status: 200, type: WorkflowDto })
  updateSelection(
    @CurrentUser() user: FirebaseUser,
    @Param('id') id: string,
    @Body() dto: UpdateSelectionDto,
  ): Promise<WorkflowDto> {
    return this.workflowsService.updateSelection(
      user.uid,
      id,
      dto.expectedVersion,
      dto,
    );
  }

  @Patch(':id/copies')
  @ApiOperation({
    summary: 'Fijar las copias de etiquetas concretas',
    description:
      'CAS con expectedVersion. Rechaza etiquetas serializadas (^SN/^SF) y respeta el tope del plan contando copias.',
  })
  @ApiResponse({ status: 200, type: WorkflowDto })
  @ApiResponse({ status: 409, description: 'WORKFLOW_VERSION_CONFLICT' })
  @ApiResponse({ status: 422, description: 'WORKFLOW_SERIALIZED_LABEL' })
  updateCopies(
    @CurrentUser() user: FirebaseUser,
    @Param('id') id: string,
    @Body() dto: UpdateCopiesDto,
  ): Promise<WorkflowDto> {
    return this.workflowsService.updateCopies(
      user.uid,
      id,
      dto.expectedVersion,
      dto.items,
    );
  }

  @Post(':id/reconcile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cotejar el lote contra un CSV de pedidos',
    description:
      'Dos formatos explícitos. Marca no identificado, repetido y sobrante por etiqueta y faltante por fila; no borra nada.',
  })
  reconcile(
    @CurrentUser() user: FirebaseUser,
    @Param('id') id: string,
    @Body() dto: ReconcileDto,
  ) {
    return this.workflowsService.reconcile(
      { uid: user.uid, email: user.email },
      id,
      dto,
    );
  }

  @Post(':id/preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Previsualizar hasta 10 etiquetas privadas del lote sin generar PDF',
  })
  preview(
    @CurrentUser() user: FirebaseUser,
    @Param('id') id: string,
    @Body() dto: WorkflowPreviewDto,
  ) {
    return this.previews.preview(user.uid, id, dto.labelIds);
  }

  @Post(':id/exports')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Repetir la misma clave con la misma intención devuelve la misma operación, sin consumir cuota otra vez.',
  })
  @ApiOperation({
    summary: 'Exportar la selección del lote',
    description:
      'Reutiliza el conversor existente: el seguimiento y la descarga siguen en /zpl/status/:jobId y /zpl/download/:jobId.',
  })
  @ApiResponse({ status: 201, type: WorkflowExportDto })
  @ApiResponse({
    status: 200,
    type: WorkflowExportDto,
    description: 'Repetición idempotente',
  })
  async createExport(
    @CurrentUser() user: FirebaseUser,
    @Param('id') id: string,
    @Body() dto: CreateExportDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WorkflowExportDto> {
    const idempotencyKey =
      (response.req.headers['idempotency-key'] as string) ?? '';

    const result = await this.exportsService.createExport(
      { uid: user.uid, email: user.email },
      id,
      idempotencyKey,
      dto,
    );

    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return result.export;
  }

  @Get(':id/exports')
  @ApiOperation({ summary: 'Listar las exportaciones del lote' })
  listExports(@CurrentUser() user: FirebaseUser, @Param('id') id: string) {
    return this.exportsService.listExports(user.uid, id);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Archivar el lote',
    description: 'Baja lógica; conserva las exportaciones ya aceptadas.',
  })
  archive(
    @CurrentUser() user: FirebaseUser,
    @Param('id') id: string,
    @Body() dto: ArchiveWorkflowDto,
  ): Promise<WorkflowDto> {
    return this.workflowsService.archiveWorkflow(
      user.uid,
      id,
      dto.expectedVersion,
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Borrar el lote y sus etiquetas',
    description:
      'Las exportaciones se conservan marcadas: son el registro de lo ya aceptado.',
  })
  async remove(
    @CurrentUser() user: FirebaseUser,
    @Param('id') id: string,
  ): Promise<void> {
    await this.workflowsService.deleteWorkflow(user.uid, id);
  }
}
