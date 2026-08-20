import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  HttpCode,
  HttpStatus,
  Req,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import {
  UsersService,
  DEFAULT_HISTORY_LIMIT,
  MAX_HISTORY_SCAN,
  MAX_PROFILE_PHOTO_BYTES,
  PROFILE_PHOTO_SIZE_PX,
  ALLOWED_PROFILE_PHOTO_FORMATS,
} from './users.service.js';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { FirebaseUser } from '../../common/decorators/current-user.decorator.js';
import { AccountDeletionService } from './account-deletion.service.js';
import { UserProfileDto } from './dto/user-profile.dto.js';
import { DeleteAccountResponseDto } from './dto/delete-account.dto.js';
import {
  NotificationPreferencesResponseDto,
  UpdatePreferencesDto,
} from './dto/notification-preferences.dto.js';
import { UserLimitsDto } from './dto/user-limits.dto.js';
import { VerificationStatusDto } from './dto/verification-status.dto.js';
import { ProfilePhotoResponseDto } from './dto/profile-photo.dto.js';
import { PhotoUploadErrorInterceptor } from './interceptors/photo-upload-error.interceptor.js';
import { ZPL_RETENTION_DAYS } from '../../common/interfaces/conversion-history.interface.js';
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
  constructor(
    private readonly usersService: UsersService,
    private readonly accountDeletionService: AccountDeletionService,
  ) {}

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
      photoURL: this.usersService.resolveProfilePhotoURL(
        syncedUser,
        user.picture,
      ),
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

  @Post('me/photo')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    // El traductor de errores va primero para poder envolver al de subida: es
    // multer quien corta por tamaño, y su excepción genérica no trae el código
    // que el frontend necesita.
    PhotoUploadErrorInterceptor,
    FileInterceptor('file', { limits: { fileSize: MAX_PROFILE_PHOTO_BYTES } }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload the profile photo',
    description:
      `Acepta ${ALLOWED_PROFILE_PHOTO_FORMATS.join(', ').toUpperCase()} de hasta ` +
      `${MAX_PROFILE_PHOTO_BYTES / (1024 * 1024)} MB. La imagen se recorta a ` +
      `cuadrado y se reescala a ${PROFILE_PHOTO_SIZE_PX} px antes de guardarla en ` +
      'WebP, siempre en la misma ruta del usuario: cada subida sustituye a la ' +
      'anterior. La URL se guarda en el perfil y en Firebase Auth, de modo que el ' +
      'claim `picture` del token deja de apuntar a la foto del proveedor de acceso.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Imagen JPEG, PNG o WebP (max 2MB)',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Photo stored',
    type: ProfilePhotoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Sin archivo (`NO_FILES`) o formato no admitido (`UNSUPPORTED_IMAGE_TYPE`). ' +
      'El formato se decide por el contenido del archivo, no por su Content-Type',
  })
  @ApiResponse({
    status: 413,
    description: 'La imagen supera el máximo permitido (`IMAGE_TOO_LARGE`)',
  })
  async uploadPhoto(
    @CurrentUser() user: FirebaseUser,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<ProfilePhotoResponseDto> {
    return this.usersService.uploadProfilePhoto(user.uid, file);
  }

  @Delete('me/photo')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove the profile photo',
    description:
      'Borra el objeto de Storage y deja el perfil sin foto, también en Firebase ' +
      'Auth. Es la forma de volver a las iniciales sin subir otra imagen. ' +
      'Idempotente: quitar una foto que ya no existe responde igualmente 204.',
  })
  @ApiResponse({ status: 204, description: 'Photo removed' })
  async deletePhoto(@CurrentUser() user: FirebaseUser): Promise<void> {
    await this.usersService.deleteProfilePhoto(user.uid);
  }

  @Delete('me')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete the authenticated account',
    description:
      'Cancela la suscripción de Stripe, borra el historial de conversiones y sus ' +
      'archivos, el uso, el perfil fiscal, el documento de usuario y la cuenta de ' +
      'Firebase Auth. Los CFDI timbrados y las facturas de Stripe NO se borran: se ' +
      'conservan cinco años por obligación fiscal y solo se desvinculan del usuario. ' +
      'La cancelación es inmediata, no al final del periodo. La operación no es ' +
      'reversible.',
  })
  @ApiResponse({
    status: 200,
    description:
      'Cuenta borrada. `retained.reason` es un código estable, no una frase.',
    type: DeleteAccountResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: '`USER_NOT_FOUND` — no hay perfil que borrar',
  })
  @ApiResponse({
    status: 409,
    description:
      '`SUBSCRIPTION_CANCEL_FAILED` — Stripe rechazó cancelar la suscripción y, ' +
      'por tanto, NO se ha borrado nada',
  })
  @ApiResponse({
    status: 500,
    description:
      '`ACCOUNT_DELETION_PARTIAL` — la suscripción quedó cancelada pero el borrado ' +
      'se interrumpió. `data.accountDeleted` dice si la cuenta llegó a desaparecer y ' +
      '`data.failedSteps` qué quedó pendiente.',
  })
  async deleteAccount(
    @CurrentUser() user: FirebaseUser,
  ): Promise<DeleteAccountResponseDto> {
    return this.accountDeletionService.deleteAccount(user.uid);
  }

  @Get('me/preferences')
  @ApiOperation({
    summary: 'Get notification preferences',
    description:
      'Las tres claves vienen siempre resueltas: una cuenta que nunca las tocó ' +
      'las recibe todas en `true`.',
  })
  @ApiResponse({
    status: 200,
    description: 'Notification preferences',
    type: NotificationPreferencesResponseDto,
  })
  async getPreferences(
    @CurrentUser() user: FirebaseUser,
  ): Promise<NotificationPreferencesResponseDto> {
    const notifications = await this.usersService.getNotificationPreferences(
      user.uid,
    );
    return { notifications };
  }

  @Put('me/preferences')
  @ApiOperation({
    summary: 'Update notification preferences',
    description:
      'Actualización parcial: las claves que no vengan conservan su valor. ' +
      'La respuesta trae siempre el estado completo resultante.',
  })
  @ApiResponse({
    status: 200,
    description: 'Preferencias actualizadas',
    type: NotificationPreferencesResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Body inválido' })
  async updatePreferences(
    @CurrentUser() user: FirebaseUser,
    @Body() body: UpdatePreferencesDto,
  ): Promise<NotificationPreferencesResponseDto> {
    const notifications = await this.usersService.updateNotificationPreferences(
      user.uid,
      body.notifications,
    );
    return { notifications };
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
      'Búsqueda por subcadena, case-insensitive, sobre jobId, labelSize y ' +
      'outputFormat; también compara contra labelCount cuando el término es ' +
      'numérico',
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
    type: String,
    description:
      `Filtra por tamaño de etiqueta. No es un enum cerrado: las conversiones batch ` +
      `guardan el tamaño sin normalizar, así que además de ${Object.values(LabelSize).join(', ')} ` +
      'acepta cualquier valor de facets.labelSizes',
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
    description:
      'Conversion history. Cada ítem trae `id` —la clave para borrarlo o ' +
      'recuperar su ZPL— y `canReconvert`, que indica si el ZPL original sigue ' +
      `disponible dentro de la ventana de retención de ${ZPL_RETENTION_DAYS} días.`,
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
