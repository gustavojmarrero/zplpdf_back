import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { WORKFLOW_LIMITS } from '../workflows.constants.js';

const OUTPUT_FORMATS = ['pdf', 'png', 'jpeg'] as const;
const RECONCILE_FORMATS = [
  'pedido_id_guia_v1',
  'order_id_tracking_v1',
] as const;

export class CreateWorkflowDto {
  @ApiPropertyOptional({
    description: 'Contenido ZPL. Excluyente con historyId.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  zplContent?: string;

  @ApiPropertyOptional({
    description:
      'Id del historial del que recuperar el ZPL original, para reconvertir sin volver a subir.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  historyId?: string;

  @ApiProperty({ description: 'Tamaño de etiqueta, p. ej. 4x6 o 50x80mm' })
  @IsString()
  @IsNotEmpty()
  labelSize: string;

  @ApiPropertyOptional({ enum: OUTPUT_FORMATS, default: 'pdf' })
  @IsOptional()
  @IsEnum(OUTPUT_FORMATS)
  outputFormat?: (typeof OUTPUT_FORMATS)[number];

  @ApiPropertyOptional({ maxLength: WORKFLOW_LIMITS.maxNameLength })
  @IsOptional()
  @IsString()
  @MaxLength(WORKFLOW_LIMITS.maxNameLength)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  originalFilename?: string;
}

export class UpdateOrderDto {
  @ApiProperty({ description: 'Versión que el cliente cree vigente (CAS)' })
  @IsInt()
  @Min(1)
  expectedVersion: number;

  @ApiProperty({
    type: [String],
    description:
      'Permutación COMPLETA de los labelIds del lote: mismos ids, misma cantidad.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(WORKFLOW_LIMITS.maxLabelsPerWorkflow)
  @IsString({ each: true })
  labelIds: string[];
}

export class UpdateSelectionDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  expectedVersion: number;

  @ApiProperty({ enum: ['replace', 'select', 'deselect'] })
  @IsEnum(['replace', 'select', 'deselect'])
  mode: 'replace' | 'select' | 'deselect';

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(WORKFLOW_LIMITS.maxLabelsPerWorkflow)
  @IsString({ each: true })
  labelIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'Selecciona o quita el grupo de copias completo.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(WORKFLOW_LIMITS.maxLabelsPerWorkflow)
  @IsString({ each: true })
  groupIds?: string[];
}

export class LabelCopiesDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  labelId: string;

  @ApiProperty({ minimum: 1, maximum: WORKFLOW_LIMITS.maxCopiesPerLabel })
  @IsInt()
  @Min(1)
  @Max(WORKFLOW_LIMITS.maxCopiesPerLabel)
  copies: number;
}

export class UpdateCopiesDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  expectedVersion: number;

  @ApiProperty({
    type: [LabelCopiesDto],
    description:
      'Copias por etiqueta. Volver al valor de ^PQ retira el override. Una etiqueta serializada se rechaza.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(WORKFLOW_LIMITS.maxLabelsPerWorkflow)
  @ValidateNested({ each: true })
  @Type(() => LabelCopiesDto)
  items: LabelCopiesDto[];
}

export class CreateExportDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  expectedVersion: number;

  @ApiPropertyOptional({
    description: 'exportId anterior: liga la reimpresión al trabajo original.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  reexportOf?: string;

  @ApiPropertyOptional({ enum: OUTPUT_FORMATS })
  @IsOptional()
  @IsEnum(OUTPUT_FORMATS)
  outputFormat?: (typeof OUTPUT_FORMATS)[number];
}

export class ReconcileDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  expectedVersion: number;

  @ApiProperty({
    enum: RECONCILE_FORMATS,
    description: 'Formato explícito: no se adivina.',
  })
  @IsEnum(RECONCILE_FORMATS)
  format: (typeof RECONCILE_FORMATS)[number];

  @ApiProperty({ description: 'Texto del CSV de pedidos.' })
  @IsString()
  @IsNotEmpty()
  csvContent: string;

  @ApiPropertyOptional({ enum: [',', ';', '\t'] })
  @IsOptional()
  @IsEnum([',', ';', '\t'])
  delimiter?: ',' | ';' | '\t';
}

export class ArchiveWorkflowDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  expectedVersion: number;
}

export class ListWorkflowsQueryDto {
  @ApiPropertyOptional({ default: WORKFLOW_LIMITS.defaultPageSize })
  @IsOptional()
  @IsString()
  limit?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ enum: ['draft', 'ready', 'archived'] })
  @IsOptional()
  @IsEnum(['draft', 'ready', 'archived'])
  status?: 'draft' | 'ready' | 'archived';
}

export class WorkflowPreviewDto {
  @ApiProperty({ type: [String], minItems: 1, maxItems: 10 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  labelIds: string[];
}
