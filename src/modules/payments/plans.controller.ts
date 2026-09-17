import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { PlanCatalogService } from './plan-catalog.service.js';
import { PlansQueryDto, PlansResponseDto } from './dto/plans.dto.js';

/**
 * Rutas públicas de pagos. Van en un controller aparte porque
 * `PaymentsController` aplica `FirebaseAuthGuard` a toda la clase, y la página
 * de precios la visitan anónimos.
 */
@ApiTags('payments')
@Controller('payments')
export class PlansController {
  constructor(private readonly planCatalogService: PlanCatalogService) {}

  @Get('plans')
  // Fuera del throttler global: detrás del rewrite de Vercel todos los
  // anónimos comparten tracker `ip:`, así que 100/min se repartirían entre
  // todos los visitantes de la página de precios. Aquí no hay coste por
  // petición que proteger: la caché en memoria absorbe las visitas y Stripe se
  // consulta como mucho una vez por hora, o una por minuto si está fallando.
  @SkipThrottle()
  @ApiOperation({
    summary: 'Public plan prices (monthly and yearly) for the pricing page',
    description:
      'No authentication. Amounts come from Stripe, in the smallest currency unit. ' +
      '`yearly` is null while yearly billing is not available for that plan and currency.',
  })
  @ApiResponse({ status: 200, type: PlansResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid country code' })
  @ApiResponse({
    status: 503,
    description:
      'Prices could not be read from Stripe and there is no cached copy. Keep the ' +
      'static prices and the yearly tab disabled.',
  })
  async getPlans(
    @Query() query: PlansQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PlansResponseDto> {
    const plans = await this.planCatalogService.getPlans(query.country);
    // Solo en la respuesta buena: con `@Header` la cabecera también saldría en
    // el 503, y un CDN podría guardar el error cinco minutos.
    res.setHeader(
      'Cache-Control',
      'public, max-age=300, stale-while-revalidate=3600',
    );
    return plans;
  }
}
