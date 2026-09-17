import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class LabelRefDto {
  @ApiProperty({ description: 'Estable: no cambia al reordenar ni reexportar' })
  labelId: string;

  @ApiProperty({ description: 'Mismo contenido ⇒ mismo grupo' })
  groupId: string;

  @ApiProperty({ description: 'Posición original, inmutable' })
  sequence: number;

  @ApiProperty({ description: 'Posición actual' })
  order: number;

  @ApiProperty({
    description:
      'Copias que se imprimirán: el override si existe, o las de ^PQ',
  })
  copies: number;

  @ApiProperty({ description: 'Copias declaradas originalmente por ^PQ' })
  originalCopies: number;

  @ApiProperty({ description: 'true si las copias se fijaron a mano' })
  copiesOverridden: boolean;

  @ApiProperty({
    description:
      'Usa ^SN/^SF: no admite cambiar copias, la serie impresa depende de ellas',
  })
  serialized: boolean;

  @ApiProperty()
  selected: boolean;

  @ApiProperty()
  contentHash: string;

  @ApiProperty()
  byteSize: number;

  @ApiProperty({
    description: 'Valores ^FD legibles con clave fdN. No se inventan campos.',
  })
  fields: Record<string, string>;

  @ApiPropertyOptional({
    enum: ['matched', 'duplicate', 'unidentified', 'extra'],
  })
  reconcileStatus?: 'matched' | 'duplicate' | 'unidentified' | 'extra';

  @ApiPropertyOptional()
  reconcileOrderId?: string;

  @ApiPropertyOptional()
  reconcileTracking?: string;
}

export class WorkflowJobRefDto {
  @ApiProperty() exportId: string;
  @ApiProperty() jobId: string;
  @ApiProperty() createdAt: string;
  @ApiProperty({ description: 'Etiquetas incluidas, contando copias' })
  labelCount: number;
  @ApiPropertyOptional() reexportOf?: string;
}

export class ReconcileSummaryDto {
  @ApiProperty() reconcileId: string;
  @ApiProperty() format: string;
  @ApiProperty() completedAt: string;
  @ApiProperty() rowCount: number;
  @ApiProperty({
    description:
      'matched/duplicate/unidentified/extra son etiquetas; missing son filas del CSV',
  })
  counts: {
    matched: number;
    duplicate: number;
    unidentified: number;
    extra: number;
    missing: number;
  };
  @ApiProperty({ type: 'array', items: { type: 'object' } })
  missingRows: { rowNumber: number; orderId: string; tracking?: string }[];
  @ApiProperty({ type: 'array', items: { type: 'object' } })
  duplicateRows: { rowNumber: number; orderId: string; labelIds: string[] }[];
}

export class WorkflowDto {
  @ApiProperty() id: string;
  @ApiProperty() accountId: string;
  @ApiProperty({ enum: ['packing_workflow'] }) featureId: string;
  @ApiProperty() featureVersion: string;
  @ApiProperty({ enum: ['draft', 'ready', 'archived'] })
  status: 'draft' | 'ready' | 'archived';
  @ApiPropertyOptional() name?: string;
  @ApiProperty() labelSize: string;
  @ApiProperty({ enum: ['pdf', 'png', 'jpeg'] })
  outputFormat: 'pdf' | 'png' | 'jpeg';
  @ApiProperty({ description: 'CAS: se envía como expectedVersion al mutar' })
  version: number;
  @ApiProperty() totalLabels: number;
  @ApiProperty() totalCopies: number;
  @ApiProperty() selectedCount: number;
  @ApiProperty() selectedCopies: number;
  @ApiProperty({ type: 'array', items: { type: 'object' } })
  sourceRefs: unknown[];
  @ApiProperty({ type: [WorkflowJobRefDto] }) jobRefs: WorkflowJobRefDto[];
  @ApiPropertyOptional({ type: ReconcileSummaryDto })
  reconcile?: ReconcileSummaryDto;
  @ApiProperty() createdAt: string;
  @ApiProperty() updatedAt: string;
  @ApiProperty({ description: 'El ZPL de origen caduca a los 15 días' })
  sourceExpiresAt: string;
  @ApiPropertyOptional({ type: [LabelRefDto], description: 'Ya ordenado' })
  labels?: LabelRefDto[];
}

export class WorkflowListDto {
  @ApiProperty({ type: [WorkflowDto] }) items: WorkflowDto[];
  @ApiPropertyOptional() nextCursor?: string;
}

export class WorkflowExportDto {
  @ApiProperty() exportId: string;
  @ApiProperty() workflowId: string;
  @ApiProperty({ enum: ['accepted', 'failed'] }) status: string;
  @ApiPropertyOptional({
    description: 'Trabajo del conversor: se consulta en /zpl/status/:jobId',
  })
  jobId?: string;
  @ApiPropertyOptional() reexportOf?: string;
  @ApiProperty() workflowVersion: number;
  @ApiProperty({ description: 'Etiquetas contando copias' }) labelCount: number;
  @ApiProperty() uniqueLabelCount: number;
  @ApiProperty({ type: [String], description: 'Orden exacto exportado' })
  labelIds: string[];
  @ApiProperty() intentHash: string;
  @ApiProperty({
    description: 'true ⇒ respuesta reutilizada, sin nuevo consumo de cuota',
  })
  idempotent: boolean;
  @ApiProperty() createdAt: string;
  @ApiPropertyOptional() errorCode?: string;
}
