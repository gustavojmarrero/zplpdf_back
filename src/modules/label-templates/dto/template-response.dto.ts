import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';

export class ArchiveTemplateDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  expectedVersion: number;
}

export class TemplateFieldResponseDto {
  @ApiProperty() key: string;
  @ApiProperty() label: string;
  @ApiProperty({
    enum: ['text', 'code', 'integer', 'decimal', 'date', 'barcode'],
    description: '`code` conserva los ceros iniciales',
  })
  type: string;
  @ApiProperty() required: boolean;
  @ApiPropertyOptional() maxLength?: number;
  @ApiPropertyOptional({ enum: ['digits', 'alnum', 'alnum_dash', 'any'] })
  charset?: string;
  @ApiPropertyOptional() barcodeSymbology?: string;
}

export class BuiltinTemplateDto {
  @ApiProperty({ enum: ['product', 'location', 'lot'] }) kind: string;
  @ApiProperty() name: string;
  @ApiProperty() labelSize: string;
  @ApiProperty({ type: [TemplateFieldResponseDto] })
  fields: TemplateFieldResponseDto[];
  @ApiProperty({ description: 'Marcadores como ^FD{{clave}}^FS' })
  zplTemplate: string;
}

export class BuiltinTemplateListDto {
  @ApiProperty({ type: [BuiltinTemplateDto] }) items: BuiltinTemplateDto[];
}

export class ColumnMappingResponseDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'clave de campo -> nombre de columna',
  })
  fields: Record<string, string>;
  @ApiPropertyOptional() quantityColumn?: string;
}

export class LabelTemplateDto {
  @ApiProperty() id: string;
  @ApiProperty() accountId: string;
  @ApiProperty({ enum: ['product', 'location', 'lot'] }) kind: string;
  @ApiProperty() name: string;
  @ApiProperty({ enum: ['active', 'archived'] }) status: string;
  @ApiProperty({ description: 'Número de versión vigente' })
  currentVersion: number;
  @ApiProperty({ description: 'CAS de la metadata' }) version: number;
  @ApiPropertyOptional({ type: ColumnMappingResponseDto })
  savedMapping?: ColumnMappingResponseDto;
  @ApiProperty() createdAt: string;
  @ApiProperty() updatedAt: string;
}

export class TemplateVersionDto {
  @ApiProperty() id: string;
  @ApiProperty() templateId: string;
  @ApiProperty() versionNumber: number;
  @ApiProperty() labelSize: string;
  @ApiProperty({ type: [TemplateFieldResponseDto] })
  fields: TemplateFieldResponseDto[];
  @ApiProperty() zplTemplate: string;
  @ApiProperty() checksum: string;
  @ApiProperty() createdAt: string;
}

export class TemplateDetailDto {
  @ApiProperty({ type: LabelTemplateDto }) template: LabelTemplateDto;
  @ApiPropertyOptional({ type: [TemplateVersionDto] })
  versions?: TemplateVersionDto[];
  @ApiPropertyOptional({ type: TemplateVersionDto })
  version?: TemplateVersionDto;
}

export class TemplateListDto {
  @ApiProperty({ type: [LabelTemplateDto] }) items: LabelTemplateDto[];
}

export class RowDiagnosticDto {
  @ApiProperty({ description: '1 = primera fila de datos' })
  rowNumber: number;
  @ApiPropertyOptional() column?: string;
  @ApiPropertyOptional() field?: string;
  @ApiProperty() code: string;
  @ApiProperty() message: string;
}

export class TemplateRunDto {
  @ApiPropertyOptional({ description: 'null en /validate' }) runId?: string;
  @ApiProperty() templateId: string;
  @ApiProperty({ description: 'Versión fija con la que se generó' })
  templateVersion: number;
  @ApiProperty({ enum: ['validated', 'accepted', 'failed'] }) status: string;
  @ApiPropertyOptional({
    description: 'Trabajo del conversor: se consulta en /zpl/status/:jobId',
  })
  jobId?: string;
  @ApiProperty({ enum: ['csv', 'xlsx'] }) format: string;
  @ApiProperty() labelSize: string;
  @ApiProperty({ enum: ['pdf', 'png', 'jpeg'] }) outputFormat: string;
  @ApiProperty({ description: 'Filas de datos leídas' }) rowCount: number;
  @ApiProperty() validRowCount: number;
  @ApiProperty() emptyRowCount: number;
  @ApiProperty() invalidRowCount: number;
  @ApiProperty({ description: 'Etiquetas contando copias' }) labelCount: number;
  @ApiProperty({ type: [RowDiagnosticDto] }) diagnostics: RowDiagnosticDto[];
  @ApiPropertyOptional({
    type: [String],
    description: 'Solo en /validate: primeras filas renderizadas',
  })
  previewZpl?: string[];
  @ApiProperty({ description: 'sha256 del archivo; el archivo NO se guarda' })
  sourceChecksum: string;
  @ApiPropertyOptional() intentHash?: string;
  @ApiPropertyOptional({
    description: 'true ⇒ respuesta reutilizada, sin nuevo consumo de cuota',
  })
  idempotent?: boolean;
  @ApiPropertyOptional() createdAt?: string;
  @ApiPropertyOptional() errorCode?: string;
}

export class TemplateRunListDto {
  @ApiProperty({ type: [TemplateRunDto] }) items: TemplateRunDto[];
}
