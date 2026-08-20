import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsObject,
  IsOptional,
  ValidateNested,
} from 'class-validator';

export class NotificationSettingsDto {
  @ApiPropertyOptional({
    description: 'Novedades y cambios del producto',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  product?: boolean;

  @ApiPropertyOptional({
    description: 'Cobros, fallos de pago y facturas',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  billing?: boolean;

  @ApiPropertyOptional({
    description: 'Avisos al acercarse al límite del plan',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  usageReminders?: boolean;
}

/**
 * Cuerpo de `PUT /users/me/preferences`.
 *
 * Las tres claves son opcionales y se fusionan con lo que ya hubiera guardado:
 * la pantalla de ajustes cambia un interruptor cada vez, y exigir el objeto
 * completo convertiría cada clic en una carrera capaz de revertir el interruptor
 * de al lado.
 */
export class UpdatePreferencesDto {
  @ApiProperty({ type: NotificationSettingsDto })
  @IsObject()
  @ValidateNested()
  @Type(() => NotificationSettingsDto)
  notifications: NotificationSettingsDto;
}

export class NotificationPreferencesResponseDto {
  @ApiProperty({
    type: NotificationSettingsDto,
    description:
      'Las tres claves vienen siempre resueltas: una cuenta que nunca tocó sus ' +
      'preferencias las recibe todas en `true`.',
  })
  notifications: {
    product: boolean;
    billing: boolean;
    usageReminders: boolean;
  };
}
