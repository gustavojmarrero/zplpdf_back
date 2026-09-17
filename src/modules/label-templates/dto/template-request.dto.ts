import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { TEMPLATE_LIMITS } from '../label-templates.constants.js';

const KINDS = ['product', 'location', 'lot'] as const;
const FIELD_TYPES = [
  'text',
  'code',
  'integer',
  'decimal',
  'date',
  'barcode',
] as const;
const CHARSETS = ['digits', 'alnum', 'alnum_dash', 'any'] as const;
const SYMBOLOGIES = [
  'code128',
  'code39',
  'ean13',
  'upca',
  'qr',
  'datamatrix',
] as const;
const FORMATS = ['csv', 'xlsx'] as const;
const OUTPUT_FORMATS = ['pdf', 'png', 'jpeg'] as const;

export class TemplateFieldDto {
  @ApiProperty({ description: 'Clave del campo: ^[a-z][a-z0-9_]{0,39}$' })
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{0,39}$/)
  key: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  label: string;

  @ApiProperty({
    enum: FIELD_TYPES,
    description:
      '`code` conserva los ceros iniciales y nunca se lee como número',
  })
  @IsEnum(FIELD_TYPES)
  type: (typeof FIELD_TYPES)[number];

  @ApiProperty()
  @IsBoolean()
  required: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4000)
  maxLength?: number;

  @ApiPropertyOptional({
    enum: CHARSETS,
    description: 'Enumerado cerrado: no se aceptan expresiones regulares',
  })
  @IsOptional()
  @IsEnum(CHARSETS)
  charset?: (typeof CHARSETS)[number];

  @ApiPropertyOptional({ enum: SYMBOLOGIES })
  @IsOptional()
  @IsEnum(SYMBOLOGIES)
  barcodeSymbology?: (typeof SYMBOLOGIES)[number];
}

export class ColumnMappingDto {
  @ApiProperty({
    description: 'clave de campo -> nombre de columna del archivo',
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsObject()
  fields: Record<string, string>;

  @ApiPropertyOptional({ description: 'Columna con las copias por fila' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  quantityColumn?: string;
}

export class CreateTemplateDto {
  @ApiPropertyOptional({
    enum: KINDS,
    description: 'Crea una copia de la plantilla inicial indicada',
  })
  @IsOptional()
  @IsEnum(KINDS)
  fromBuiltin?: (typeof KINDS)[number];

  @ApiPropertyOptional({ enum: KINDS })
  @IsOptional()
  @IsEnum(KINDS)
  kind?: (typeof KINDS)[number];

  @ApiPropertyOptional({ maxLength: TEMPLATE_LIMITS.maxNameLength })
  @IsOptional()
  @IsString()
  @MaxLength(TEMPLATE_LIMITS.maxNameLength)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  labelSize?: string;

  @ApiPropertyOptional({ type: [TemplateFieldDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(TEMPLATE_LIMITS.maxFields)
  @ValidateNested({ each: true })
  @Type(() => TemplateFieldDto)
  fields?: TemplateFieldDto[];

  @ApiPropertyOptional({
    description: 'ZPL con marcadores exactamente como ^FD{{clave}}^FS',
  })
  @IsOptional()
  @IsString()
  zplTemplate?: string;
}

export class CreateVersionDto {
  @ApiProperty({
    description: 'Versión de metadata que el cliente cree vigente',
  })
  @IsInt()
  @Min(1)
  expectedVersion: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  labelSize?: string;

  @ApiProperty({ type: [TemplateFieldDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(TEMPLATE_LIMITS.maxFields)
  @ValidateNested({ each: true })
  @Type(() => TemplateFieldDto)
  fields: TemplateFieldDto[];

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  zplTemplate: string;
}

export class UpdateTemplateDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  expectedVersion: number;

  @ApiPropertyOptional({ maxLength: TEMPLATE_LIMITS.maxNameLength })
  @IsOptional()
  @IsString()
  @MaxLength(TEMPLATE_LIMITS.maxNameLength)
  name?: string;

  @ApiPropertyOptional({ type: ColumnMappingDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ColumnMappingDto)
  savedMapping?: ColumnMappingDto;

  @ApiPropertyOptional({ enum: ['active', 'archived'] })
  @IsOptional()
  @IsEnum(['active', 'archived'])
  status?: 'active' | 'archived';
}

export class ValidateRunDto {
  @ApiProperty({
    description:
      'Obligatorio para validar y ejecutar; opcional en /inspect, donde solo sirve para proponer el mapeo.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  templateId?: string;

  @ApiPropertyOptional({ description: 'Por defecto, la versión vigente' })
  @IsOptional()
  @IsInt()
  @Min(1)
  templateVersion?: number;

  @ApiProperty({ enum: FORMATS })
  @IsEnum(FORMATS)
  format: (typeof FORMATS)[number];

  @ApiProperty({
    description: 'csv: texto del archivo · xlsx: contenido en base64',
  })
  @IsString()
  @IsNotEmpty()
  content: string;

  @ApiPropertyOptional({
    enum: [',', ';', '\t'],
    description: 'Si falta, se infiere solo cuando es inequívoco',
  })
  @IsOptional()
  @IsEnum([',', ';', '\t'])
  delimiter?: ',' | ';' | '\t';

  @ApiPropertyOptional({ enum: ['.', ','], default: '.' })
  @IsOptional()
  @IsEnum(['.', ','])
  decimalSeparator?: '.' | ',';

  @ApiPropertyOptional({ description: 'Nombre o posición de la hoja (xlsx)' })
  @IsOptional()
  sheet?: string | number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  hasHeader?: boolean;

  @ApiPropertyOptional({ type: ColumnMappingDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ColumnMappingDto)
  mapping?: ColumnMappingDto;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: TEMPLATE_LIMITS.maxPreviewRows,
    default: TEMPLATE_LIMITS.defaultPreviewRows,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(TEMPLATE_LIMITS.maxPreviewRows)
  previewRows?: number;
}

export class InspectTableDto extends ValidateRunDto {}

export class CreateRunDto extends ValidateRunDto {
  @ApiPropertyOptional({ enum: OUTPUT_FORMATS, default: 'pdf' })
  @IsOptional()
  @IsEnum(OUTPUT_FORMATS)
  outputFormat?: (typeof OUTPUT_FORMATS)[number];

  @ApiPropertyOptional({
    enum: ['reject', 'skip'],
    default: 'reject',
    description:
      '`reject` no genera nada si hay filas inválidas; `skip` las deja fuera y las informa',
  })
  @IsOptional()
  @IsEnum(['reject', 'skip'])
  onInvalidRows?: 'reject' | 'skip';

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  saveMapping?: boolean;
}
