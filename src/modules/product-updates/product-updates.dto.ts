import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, Matches, Min } from 'class-validator';
import { TOUR_ACTIONS } from './product-updates.types.js';
import type { TourAction } from './product-updates.types.js';
import { TOUR_ID_PATTERN } from './release-config.js';

export class TourProgressDto {
  @ApiProperty({ format: 'uuid', description: 'UUID v4; idempotencia' })
  @Matches(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    { message: 'eventId must be a v4 UUID' },
  )
  eventId: string;

  @ApiProperty({
    minimum: 0,
    description: 'Revisión conocida por el cliente (CAS); 0 si no hay progreso',
  })
  @IsInt()
  @Min(0)
  expectedRevision: number;

  @ApiProperty({ enum: TOUR_ACTIONS })
  @IsIn(TOUR_ACTIONS)
  action: TourAction;

  @ApiPropertyOptional({
    description:
      'Obligatorio en view_step; debe estar en la config del release',
  })
  @IsOptional()
  @Matches(TOUR_ID_PATTERN, { message: 'stepId has an unsupported format' })
  stepId?: string;
}
