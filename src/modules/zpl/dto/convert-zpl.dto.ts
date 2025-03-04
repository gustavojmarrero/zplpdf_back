import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsEnum } from 'class-validator';
import { LabelSize } from '../enums/label-size.enum.js';

export class ConvertZplDto {
  @ApiProperty({
    description: 'Contenido ZPL a convertir a PDF (opcional si se envía archivo)',
    example: '^XA^FO50,50^A0N,50,50^FDHello World^FS^XZ',
    required: false,
  })
  @IsString()
  @IsOptional()
  zplContent?: string;

  @ApiProperty({
    description: 'Tamaño de la etiqueta (2x1 o 4x6 pulgadas)',
    example: LabelSize.TWO_BY_ONE,
    enum: LabelSize,
    default: LabelSize.TWO_BY_ONE,
  })
  @IsEnum(LabelSize)
  @IsNotEmpty()
  labelSize: LabelSize;

  @ApiProperty({
    description: 'Idioma para los mensajes',
    example: 'es',
    default: 'es',
  })
  @IsString()
  @IsOptional()
  language?: string;
} 