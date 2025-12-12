import { Controller, Post, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiHeader } from '@nestjs/swagger';
import { CronService, ResetUsageResult } from './cron.service.js';
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
}
