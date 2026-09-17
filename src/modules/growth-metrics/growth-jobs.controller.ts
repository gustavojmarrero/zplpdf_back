import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { GrowthSchedulerGuard } from '../../common/guards/growth-scheduler.guard.js';
import { AdminAuthGuard } from '../../common/guards/admin-auth.guard.js';
import { FirestoreService } from '../cache/firestore.service.js';
import { GrowthJobsService } from './growth-jobs.service.js';
@Controller()
export class GrowthJobsController {
  constructor(
    private readonly jobs: GrowthJobsService,
    private readonly firestore: FirestoreService,
  ) {}
  @Post('cron/growth/:job')
  @UseGuards(GrowthSchedulerGuard)
  run(
    @Param('job') job: string,
    @Headers('x-cloudscheduler-scheduletime') scheduledAt?: string,
  ) {
    if (
      ![
        'outbox',
        'quality',
        'aggregate',
        'billing-reconcile',
        'retention',
        'panel',
        'feedback',
      ].includes(job)
    )
      throw new BadRequestException('Unknown growth job');
    return this.jobs.run(
      job as Parameters<GrowthJobsService['run']>[0],
      scheduledAt,
    );
  }
  @Get('admin/growth/snapshot')
  @UseGuards(AdminAuthGuard)
  async snapshot() {
    const row = await this.firestore
      .getClient()
      .collection('growth_snapshots')
      .doc('latest')
      .get();
    if (!row.exists)
      return {
        schemaVersion: 2,
        calculationVersion: 'growth-v2',
        status: 'insufficient_data',
        sourceWatermark: null,
        features: [],
      };
    const result = row.data();
    const generatedAt = Date.parse(result.generatedAt);
    const watermark = Date.parse(result.sourceWatermark);
    const now = Date.now();
    const stale =
      !Number.isFinite(generatedAt) ||
      generatedAt > now ||
      now - generatedAt > 36 * 3600000 ||
      (result.status === 'observed' &&
        (!Number.isFinite(watermark) ||
          watermark > now ||
          now - watermark > 36 * 3600000));
    return {
      ...result,
      status: stale ? 'stale' : result.status,
    };
  }
}
