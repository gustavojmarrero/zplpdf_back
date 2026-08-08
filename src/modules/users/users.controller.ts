import {
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import {
  UsersService,
  DEFAULT_HISTORY_LIMIT,
  MAX_HISTORY_SCAN,
} from './users.service.js';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { FirebaseUser } from '../../common/decorators/current-user.decorator.js';
import { UserProfileDto } from './dto/user-profile.dto.js';
import { UserLimitsDto } from './dto/user-limits.dto.js';
import { VerificationStatusDto } from './dto/verification-status.dto.js';
import {
  GetHistoryQueryDto,
  HistorySortBy,
  HistorySortOrder,
  HistoryStatus,
} from './dto/get-history-query.dto.js';
import { ConversionHistoryResponseDto } from './dto/conversion-history.dto.js';
import { LabelSize } from '../zpl/enums/label-size.enum.js';
import { OutputFormat } from '../zpl/enums/output-format.enum.js';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
@UseGuards(FirebaseAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sync user from Firebase Auth' })
  @ApiResponse({
    status: 200,
    description: 'User synchronized successfully',
    type: UserProfileDto,
  })
  async syncUser(
    @CurrentUser() user: FirebaseUser,
    @Req() req: Request,
  ): Promise<UserProfileDto> {
    // Obtener IP del cliente (considera X-Forwarded-For para Cloud Run)
    const clientIP = this.getClientIP(req);
    // Obtener geo de headers de Vercel (más confiable que ip.guide)
    const vercelGeo = this.getVercelGeo(req);
    const syncedUser = await this.usersService.syncUser(
      user,
      clientIP,
      vercelGeo,
    );
    return {
      id: syncedUser.id,
      email: syncedUser.email,
      displayName: syncedUser.displayName,
      emailVerified: syncedUser.emailVerified ?? false,
      plan: this.usersService.getEffectivePlan(syncedUser),
      createdAt: syncedUser.createdAt,
      hasStripeSubscription: !!syncedUser.stripeSubscriptionId,
    };
  }

  /**
   * Extrae la IP real del cliente considerando proxies y Cloud Run
   */
  private getClientIP(req: Request): string | undefined {
    // Cloud Run usa X-Forwarded-For
    const forwardedFor = req.headers['x-forwarded-for'];
    if (forwardedFor) {
      const ips = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
      // El primer IP es el cliente real
      return ips.split(',')[0].trim();
    }
    // Fallback a IP directa
    return req.ip || req.socket?.remoteAddress;
  }

  /**
   * Extrae datos de geolocalización de los headers de Vercel
   * Vercel inyecta automáticamente x-vercel-ip-country y x-vercel-ip-city
   */
  private getVercelGeo(
    req: Request,
  ): { country: string; city?: string } | undefined {
    const country = req.headers['x-vercel-ip-country'] as string;
    const city = req.headers['x-vercel-ip-city'] as string;

    // Validar que sea un código ISO de 2 caracteres
    if (country && country.length === 2) {
      return { country: country.toUpperCase(), city: city || undefined };
    }
    return undefined;
  }

  @Get('me')
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({
    status: 200,
    description: 'User profile',
    type: UserProfileDto,
  })
  async getProfile(@CurrentUser() user: FirebaseUser): Promise<UserProfileDto> {
    return this.usersService.getUserProfile(user.uid);
  }

  @Get('verification-status')
  @ApiOperation({ summary: 'Get email verification status from Firebase Auth' })
  @ApiResponse({
    status: 200,
    description: 'Email verification status',
    type: VerificationStatusDto,
  })
  async getVerificationStatus(
    @CurrentUser() user: FirebaseUser,
  ): Promise<VerificationStatusDto> {
    return this.usersService.getVerificationStatus(user.uid);
  }

  @Get('limits')
  @ApiOperation({
    summary: 'Get user limits and current usage',
    description:
      'El período de uso es mensual desde la fecha de registro del usuario (createdAt), ' +
      'NO mes calendario. Free siempre calcula el período a partir de createdAt. Los planes con ' +
      'período de facturación de Stripe almacenado en Firestore (Lite/Pro/Pro Max/Enterprise) usan ' +
      'ese período de Stripe; si no hay período de Stripe disponible, se usa createdAt como fallback. ' +
      'Este mismo período se usa para el bloqueo de conversiones y para los emails de límite (80%, 100%, bloqueo).',
  })
  @ApiResponse({
    status: 200,
    description: 'User limits and usage',
    type: UserLimitsDto,
  })
  async getLimits(@CurrentUser() user: FirebaseUser): Promise<UserLimitsDto> {
    return this.usersService.getUserLimits(user.uid);
  }

  @Get('history')
  @ApiOperation({
    summary: 'Get conversion history (Pro/Pro Max/Enterprise only)',
    description:
      'Devuelve el historial de conversiones con filtros, orden y paginación real. ' +
      `Los filtros y el orden se aplican sobre las ${MAX_HISTORY_SCAN} conversiones más ` +
      'recientes del usuario; si tiene más, la respuesta incluye `pagination.truncated: true`. ' +
      '`facets` lista los valores presentes en ese bloque, para poblar los selects del frontend.',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number, min 1 (default: 1)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: `Items per page, min 1 max 100 (default: ${DEFAULT_HISTORY_LIMIT})`,
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description:
      'Filtra por jobId (coincidencia por prefijo, case-insensitive)',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: HistoryStatus,
    description: 'Filtra por estado de la conversión',
  })
  @ApiQuery({
    name: 'outputFormat',
    required: false,
    enum: OutputFormat,
    description: 'Filtra por formato de salida',
  })
  @ApiQuery({
    name: 'labelSize',
    required: false,
    enum: LabelSize,
    description: 'Filtra por tamaño de etiqueta',
  })
  @ApiQuery({
    name: 'dateFrom',
    required: false,
    type: String,
    description: 'createdAt >= dateFrom (ISO 8601)',
  })
  @ApiQuery({
    name: 'dateTo',
    required: false,
    type: String,
    description:
      'createdAt <= dateTo (ISO 8601). Una fecha sin hora (YYYY-MM-DD) incluye ' +
      'el día completo',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: HistorySortBy,
    description: 'Campo de orden (default: createdAt)',
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    enum: HistorySortOrder,
    description: 'Dirección del orden (default: desc)',
  })
  @ApiResponse({
    status: 200,
    description: 'Conversion history',
    type: ConversionHistoryResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Query parameters inválidos',
  })
  @ApiResponse({
    status: 403,
    description:
      'History is only available for Pro, Pro Max and Enterprise plans',
  })
  async getHistory(
    @CurrentUser() user: FirebaseUser,
    @Query() query: GetHistoryQueryDto,
  ): Promise<ConversionHistoryResponseDto> {
    return this.usersService.getUserHistory(user.uid, query);
  }
}
