import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  MaxLength,
} from 'class-validator';
import { LabelSize } from '../enums/label-size.enum.js';

/**
 * Etiquetas únicas que renderiza como mucho una petición anónima.
 *
 * Cada etiqueta única es una petición al plan free de Labelary (1 req/s para
 * TODA la plataforma), así que el tope protege capacidad, no facturación: el
 * archivo completo sigue requiriendo cuenta. El frontend ya recorta a este
 * mismo número (`ANONYMOUS_PREVIEW_LABEL_LIMIT`), pero el tope de verdad es
 * este porque es el que no se puede saltar.
 */
export const PUBLIC_PREVIEW_MAX_UNIQUE_LABELS = 2;

/** Tamaño máximo del ZPL aceptado en el endpoint público (caracteres). */
export const PUBLIC_PREVIEW_MAX_ZPL_LENGTH = 50_000;

export class PublicPreviewDto {
  @ApiProperty({
    description:
      'Contenido ZPL a previsualizar (max 50.000 caracteres). Debe contener ^XA y ^XZ. ' +
      `Solo se renderizan las primeras ${PUBLIC_PREVIEW_MAX_UNIQUE_LABELS} etiquetas unicas.`,
    example: '^XA^A0N,50,50^FO20,20^FDHello World^FS^XZ',
    maxLength: PUBLIC_PREVIEW_MAX_ZPL_LENGTH,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(PUBLIC_PREVIEW_MAX_ZPL_LENGTH)
  zplContent: string;

  @ApiProperty({
    description: 'Tamano de la etiqueta (por defecto 2x1)',
    example: LabelSize.TWO_BY_ONE,
    enum: LabelSize,
    default: LabelSize.TWO_BY_ONE,
    required: false,
  })
  @IsEnum(LabelSize)
  @IsOptional()
  labelSize?: LabelSize;
}
