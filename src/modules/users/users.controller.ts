import {
  Controller,
  Delete,
  Get,
  Param,
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
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { UsersService } from './users.service.js';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { FirebaseUser } from '../../common/decorators/current-user.decorator.js';
import { UserProfileDto } from './dto/user-profile.dto.js';
import { UserLimitsDto } from './dto/user-limits.dto.js';
import { VerificationStatusDto } from './dto/verification-status.dto.js';
import { ZPL_RETENTION_DAYS } from '../../common/interfaces/conversion-history.interface.js';

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
  @ApiOperation({ summary: 'Get conversion history (Pro/Enterprise only)' })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (default: 1)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Items per page (default: 50)',
  })
  @ApiResponse({
    status: 200,
    description:
      'Conversion history. Cada ítem incluye `id` (para borrar o recuperar su ZPL) ' +
      'y `canReconvert`, que indica si el ZPL original sigue dentro de la ventana ' +
      `de retención de ${ZPL_RETENTION_DAYS} días.`,
  })
  @ApiResponse({
    status: 403,
    description: 'History is only available for Pro and Enterprise plans',
  })
  async getHistory(
    @CurrentUser() user: FirebaseUser,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.usersService.getUserHistory(
      user.uid,
      page ? Number(page) : 1,
      limit ? Number(limit) : 50,
    );
  }

  @Delete('history/:id')
  @ApiOperation({
    summary: 'Delete a conversion history record (Pro/Enterprise only)',
    description:
      'Borra el registro del historial del usuario autenticado. No modifica el uso ' +
      'mensual (`usage`) ni las métricas agregadas, y no borra el PDF de Cloud Storage: ' +
      'el historial es un registro de consulta, la cuota se lleva aparte.',
  })
  @ApiParam({
    name: 'id',
    description: 'Doc id del registro de `conversion_history`',
  })
  @ApiResponse({
    status: 200,
    description: 'Record deleted',
    schema: {
      example: { success: true, data: { id: 'abc123', deleted: true } },
    },
  })
  @ApiResponse({
    status: 403,
    description: 'History is only available for Pro and Enterprise plans',
  })
  @ApiResponse({
    status: 404,
    description:
      'El registro no existe o no pertenece al usuario autenticado (mismo código ' +
      'en ambos casos: distinguirlos confirmaría que el id existe)',
  })
  async deleteHistoryEntry(
    @CurrentUser() user: FirebaseUser,
    @Param('id') id: string,
  ) {
    const data = await this.usersService.deleteHistoryEntry(user.uid, id);
    return { success: true, data };
  }

  @Get('history/:id/zpl')
  @ApiOperation({
    summary: 'Get the original ZPL of a conversion (Pro/Enterprise only)',
    description:
      'Devuelve el ZPL original para precargarlo en el conversor. La reconversión ' +
      'pasa después por el flujo normal (`POST /zpl/convert`), que es donde se ' +
      `aplican los límites de plan. El ZPL solo se conserva ${ZPL_RETENTION_DAYS} días.`,
  })
  @ApiParam({
    name: 'id',
    description: 'Doc id del registro de `conversion_history`',
  })
  @ApiResponse({
    status: 200,
    description: 'Original ZPL content',
    schema: {
      example: {
        success: true,
        data: {
          zplContent: '^XA^FO50,50^ADN,36,20^FDHola^FS^XZ',
          labelSize: '4x6',
          outputFormat: 'pdf',
        },
      },
    },
  })
  @ApiResponse({
    status: 403,
    description: 'History is only available for Pro and Enterprise plans',
  })
  @ApiResponse({
    status: 404,
    description: 'El registro no existe o no pertenece al usuario autenticado',
  })
  @ApiResponse({
    status: 410,
    description: `El ZPL original ya salió de la ventana de retención de ${ZPL_RETENTION_DAYS} días`,
  })
  async getHistoryZpl(
    @CurrentUser() user: FirebaseUser,
    @Param('id') id: string,
  ) {
    const data = await this.usersService.getHistoryZpl(user.uid, id);
    return { success: true, data };
  }
}
