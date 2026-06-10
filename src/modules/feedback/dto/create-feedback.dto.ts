import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateFeedbackDto {
  @ApiProperty({
    enum: ['bad', 'neutral', 'good'],
    description: 'Sentimiento del usuario respecto a la experiencia',
  })
  @IsIn(['bad', 'neutral', 'good'])
  sentiment: 'bad' | 'neutral' | 'good';

  @ApiPropertyOptional({
    description: 'Texto libre opcional (sugerencia / qué mejorar o agregar)',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  message?: string;

  @ApiPropertyOptional({
    enum: ['en', 'es', 'zh', 'pt'],
    description: 'Idioma de la interfaz al enviar el feedback',
  })
  @IsOptional()
  @IsIn(['en', 'es', 'zh', 'pt'])
  locale?: string;
}
