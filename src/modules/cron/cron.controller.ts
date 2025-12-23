import { Controller, Post, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiHeader } from '@nestjs/swagger';
import { CronService, ResetUsageResult, CleanupErrorsResult } from './cron.service.js';
import { CronAuthGuard } from '../../common/guards/cron-auth.guard.js';

@ApiTags('cron')
@Controller('cron')
export class CronController {
  constructor(private readonly cronService: CronService) {}

  @Post('reset-usage')
  @UseGuards(CronAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset expired user usage periods (Cloud Scheduler)' })
  @ApiHeader({
    name: 'X-Cron-Secret',
    description: 'Secret key for cron authentication',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'Usage reset completed',
    schema: {
      properties: {
        resetCount: { type: 'number', example: 5 },
        executedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid cron secret',
  })
  async resetUsage(): Promise<ResetUsageResult> {
    return this.cronService.resetExpiredUsage();
  }

  @Post('cleanup-errors')
  @UseGuards(CronAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete errors older than 90 days (Cloud Scheduler)',
    description: 'Removes error logs that are older than 90 days to maintain database hygiene.',
  })
  @ApiHeader({
    name: 'X-Cron-Secret',
    description: 'Secret key for cron authentication',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'Error cleanup completed',
    schema: {
      properties: {
        deletedCount: { type: 'number', example: 15 },
        executedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid cron secret',
  })
  async cleanupErrors(): Promise<CleanupErrorsResult> {
    return this.cronService.cleanupOldErrors();
  }
}
