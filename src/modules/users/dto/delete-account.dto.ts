import { ApiProperty } from '@nestjs/swagger';
import type { PlanType } from '../../../common/interfaces/user.interface.js';

/**
 * Motivo por el que algo sobrevive a la baja. Código estable, no frase: la app
 * está en cuatro idiomas y el backend no conoce el del receptor.
 */
export const RETENTION_REASON_FISCAL = 'fiscal_retention';

export class DeletedSubscriptionDto {
  @ApiProperty({
    description:
      '`true` si esta baja canceló la suscripción. `false` cuando no había ' +
      'ninguna o Stripe ya la tenía cancelada.',
  })
  cancelled: boolean;

  @ApiProperty({
    description:
      'Plan que tenía la suscripción cancelada, o `null` si no había',
    nullable: true,
    example: 'pro',
  })
  plan: PlanType | null;

  @ApiProperty({
    description:
      'Momento en que la cancelación surte efecto, en ISO 8601. La baja cancela ' +
      'de inmediato —no al final del periodo—, así que es el instante de la ' +
      'petición. `null` si no se canceló nada.',
    nullable: true,
    example: '2026-09-01T00:00:00.000Z',
  })
  effectiveAt: string | null;
}

export class DeletedResourcesDto {
  @ApiProperty({ description: 'Registros de `conversion_history` borrados' })
  conversions: number;

  @ApiProperty({
    description:
      'Objetos borrados de Cloud Storage: los PDF/PNG/JPEG del historial y los ' +
      'ZPL originales que siguieran dentro de su ventana de retención. Puede ser ' +
      'menor que `conversions` porque los archivos de las conversiones antiguas ' +
      'ya habían caducado.',
  })
  storedFiles: number;

  @ApiProperty({
    description: '`true` si el usuario tenía perfil fiscal y se borró',
  })
  taxProfile: boolean;

  @ApiProperty({ type: DeletedSubscriptionDto })
  subscription: DeletedSubscriptionDto;
}

export class RetainedResourcesDto {
  @ApiProperty({
    description:
      'Facturas de Stripe y CFDI timbrados que se conservan. Se desvinculan del ' +
      'usuario, pero no se borran.',
  })
  invoices: number;

  @ApiProperty({
    description:
      'Código estable del motivo de retención; el texto lo traduce el frontend',
    example: RETENTION_REASON_FISCAL,
  })
  reason: string;
}

export class DeleteAccountResponseDto {
  @ApiProperty({ type: DeletedResourcesDto })
  deleted: DeletedResourcesDto;

  @ApiProperty({ type: RetainedResourcesDto })
  retained: RetainedResourcesDto;
}
