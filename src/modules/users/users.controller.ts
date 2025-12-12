import {
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { UsersService } from './users.service.js';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';
import { CurrentUser, FirebaseUser } from '../../common/decorators/current-user.decorator.js';
import { UserProfileDto, UserLimitsDto } from './dto/index.js';

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
  async syncUser(@CurrentUser() user: FirebaseUser): Promise<UserProfileDto> {
    const syncedUser = await this.usersService.syncUser(user);
    return {
      id: syncedUser.id,
      email: syncedUser.email,
      displayName: syncedUser.displayName,
      plan: syncedUser.plan,
      createdAt: syncedUser.createdAt,
      hasStripeSubscription: !!syncedUser.stripeSubscriptionId,
    };
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
