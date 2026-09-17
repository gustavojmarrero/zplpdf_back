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
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { FirebaseUser } from '../../common/decorators/current-user.decorator.js';
import { LabelTemplatesService } from './label-templates.service.js';
import { TemplateRunsService } from './template-runs.service.js';
import {
  CreateRunDto,
  CreateTemplateDto,
  CreateVersionDto,
  InspectTableDto,
  UpdateTemplateDto,
  ValidateRunDto,
} from './dto/template-request.dto.js';
import {
  ArchiveTemplateDto,
  BuiltinTemplateListDto,
  LabelTemplateDto,
  TemplateDetailDto,
  TemplateListDto,
  TemplateRunDto,
  TemplateVersionDto,
} from './dto/template-response.dto.js';

@ApiTags('label-templates')
@ApiBearerAuth()
@Controller('label-templates')
@UseGuards(FirebaseAuthGuard)
export class LabelTemplatesController {
  constructor(private readonly templatesService: LabelTemplatesService) {}

  @Get('builtin')
  @ApiOperation({
    summary: 'Las tres plantillas iniciales (producto, ubicación y lote)',
    description:
      'Definiciones de partida. Crear una copia propia con POST /label-templates y fromBuiltin.',
  })
  @ApiResponse({ status: 200, type: BuiltinTemplateListDto })
  builtin(): BuiltinTemplateListDto {
    return this.templatesService.listBuiltins() as BuiltinTemplateListDto;
  }

  @Post()
  @ApiOperation({
    summary: 'Crear una plantilla y su versión 1',
    description:
      'Con `fromBuiltin`, o con kind/labelSize/fields/zplTemplate propios.',
  })
  @ApiResponse({ status: 201, type: TemplateDetailDto })
  create(@CurrentUser() user: FirebaseUser, @Body() dto: CreateTemplateDto) {
    return this.templatesService.createTemplate(
      { uid: user.uid, email: user.email },
      dto,
    );
  }

  @Get()
  @ApiOperation({ summary: 'Listar las plantillas de la cuenta' })
  @ApiResponse({ status: 200, type: TemplateListDto })
  list(@CurrentUser() user: FirebaseUser) {
    return this.templatesService.listTemplates(user.uid);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Leer una plantilla con todas sus versiones' })
  @ApiResponse({ status: 200, type: TemplateDetailDto })
  get(@CurrentUser() user: FirebaseUser, @Param('id') id: string) {
    return this.templatesService.getTemplate(user.uid, id);
  }

  @Post(':id/versions')
  @ApiOperation({
    summary: 'Crear una versión nueva',
    description:
      'Las versiones son inmutables: las ejecuciones anteriores siguen apuntando a la suya.',
  })
  @ApiResponse({ status: 201, type: TemplateVersionDto })
  addVersion(
    @CurrentUser() user: FirebaseUser,
    @Param('id') id: string,
    @Body() dto: CreateVersionDto,
  ) {
    return this.templatesService.addVersion(
      { uid: user.uid, email: user.email },
      id,
      dto,
    );
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Cambiar nombre, mapeo guardado o estado',
    description: 'Campos y ZPL no se editan aquí: eso es una versión nueva.',
  })
  @ApiResponse({ status: 200, type: LabelTemplateDto })
  update(
    @CurrentUser() user: FirebaseUser,
    @Param('id') id: string,
    @Body() dto: UpdateTemplateDto,
  ) {
    return this.templatesService.updateTemplate(user.uid, id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Archivar la plantilla',
    description:
      'No borra versiones: una ejecución pasada debe seguir siendo explicable.',
  })
  @ApiResponse({ status: 200, type: LabelTemplateDto })
  archive(
    @CurrentUser() user: FirebaseUser,
    @Param('id') id: string,
    @Body() dto: ArchiveTemplateDto,
  ) {
    return this.templatesService.archiveTemplate(
      user.uid,
      id,
      dto.expectedVersion,
    );
  }
}

@ApiTags('template-runs')
@ApiBearerAuth()
@Controller('template-runs')
@UseGuards(FirebaseAuthGuard)
export class TemplateRunsController {
  constructor(private readonly runsService: TemplateRunsService) {}

  @Post('inspect')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Inspeccionar un archivo antes de mapear',
    description:
      'Columnas, tipos de celda reales, hojas del libro y filas de muestra. Con templateId propone el mapeo. No convierte ni consume cuota.',
  })
  inspect(@CurrentUser() user: FirebaseUser, @Body() dto: InspectTableDto) {
    return this.runsService.inspectTable(
      { uid: user.uid, email: user.email },
      dto,
    );
  }

  @Post('validate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Validar datos contra una versión de plantilla',
    description:
      'Devuelve diagnóstico por fila, el mapeo resuelto y una previsualización. No consume cuota ni crea trabajo.',
  })
  validate(@CurrentUser() user: FirebaseUser, @Body() dto: ValidateRunDto) {
    return this.runsService.validateRun(
      { uid: user.uid, email: user.email },
      dto,
    );
  }

  @Post()
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Repetir la misma clave con la misma intención devuelve la misma ejecución, sin consumir cuota otra vez.',
  })
  @ApiOperation({
    summary: 'Ejecutar una plantilla contra los datos',
    description:
      'Reutiliza el conversor existente: el seguimiento y la descarga siguen en /zpl/status/:jobId y /zpl/download/:jobId.',
  })
  @ApiResponse({ status: 201, type: TemplateRunDto })
  @ApiResponse({
    status: 200,
    type: TemplateRunDto,
    description: 'Repetición idempotente',
  })
  async create(
    @CurrentUser() user: FirebaseUser,
    @Body() dto: CreateRunDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const idempotencyKey =
      (response.req.headers['idempotency-key'] as string) ?? '';

    const result = await this.runsService.createRun(
      { uid: user.uid, email: user.email },
      idempotencyKey,
      dto,
    );

    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return result.run;
  }

  @Get()
  @ApiQuery({ name: 'templateId', required: false })
  @ApiOperation({ summary: 'Listar ejecuciones de la cuenta' })
  list(
    @CurrentUser() user: FirebaseUser,
    @Query('templateId') templateId?: string,
  ) {
    return this.runsService.listRuns(user.uid, templateId);
  }

  @Get(':runId')
  @ApiOperation({ summary: 'Leer una ejecución' })
  @ApiResponse({ status: 200, type: TemplateRunDto })
  get(@CurrentUser() user: FirebaseUser, @Param('runId') runId: string) {
    return this.runsService.getRun(user.uid, runId);
  }
}
