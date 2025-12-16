import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsBoolean, IsIn } from 'class-validator';

export class ValidateZplDto {
  @ApiProperty({
    description: 'Contenido ZPL a validar (opcional si se envia archivo)',
    example: '^XA^FO50,50^A0N,50,50^FDHello World^FS^XZ',
    required: false,
  })
  @IsString()
  @IsOptional()
  zplContent?: string;

  @ApiProperty({
    description: 'Idioma para mensajes de error (es/en)',
    example: 'es',
    default: 'es',
    enum: ['es', 'en'],
  })
  @IsIn(['es', 'en'])
  @IsOptional()
  language?: 'es' | 'en';

  @ApiProperty({
    description: 'Modo estricto: warnings se tratan como errores',
    example: false,
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  strictMode?: boolean;
}
