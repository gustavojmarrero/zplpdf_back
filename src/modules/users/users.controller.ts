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
import { UsersService } from './users.service.js';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { FirebaseUser } from '../../common/decorators/current-user.decorator.js';
import { UserProfileDto } from './dto/user-profile.dto.js';
import { UserLimitsDto } from './dto/user-limits.dto.js';
import { VerificationStatusDto } from './dto/verification-status.dto.js';

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
    const syncedUser = await this.usersService.syncUser(user, clientIP);
    return {
      id: syncedUser.id,
      email: syncedUser.email,
      displayName: syncedUser.displayName,
      emailVerified: syncedUser.emailVerified ?? false,
      plan: syncedUser.plan,
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
  @ApiOperation({ summary: 'Get user limits and current usage' })
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
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 50)' })
  @ApiResponse({
    status: 200,
    description: 'Conversion history',
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
}
