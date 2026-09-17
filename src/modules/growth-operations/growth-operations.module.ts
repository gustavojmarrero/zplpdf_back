import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { AdminAuthGuard } from '../../common/guards/admin-auth.guard.js';
import { CacheModule } from '../cache/cache.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { FirestoreService } from '../cache/firestore.service.js';
import { PublicApiModule } from '../public-api/public-api.module.js';
import { ApiCallbacksService } from '../public-api/api-callbacks.service.js';
import { FirestoreLabelEventOutbox } from '../workflows/label-event.store.js';
import { retryDriveRevocation } from '../folder-automation/drive-revocation.repository.js';
import { ProductEventOutboxService } from '../product-observability/product-event-outbox.service.js';

const QUEUES = {
  product_events: {
    collection: 'event_outbox',
    field: 'state',
    failed: 'dead',
  },
  label_events: {
    collection: 'label_event_retries',
    field: 'status',
    failed: 'dead',
  },
  drive_revocations: {
    collection: 'drive_revocations',
    field: 'status',
    failed: 'failed',
  },
  api_callbacks: {
    collection: 'api_callback_deliveries',
    field: 'state',
    failed: 'dead',
  },
} as const;
function queue(name: string) {
  if (!Object.prototype.hasOwnProperty.call(QUEUES, name))
    throw new BadRequestException('UNKNOWN_INCIDENT_QUEUE');
  return QUEUES[name as keyof typeof QUEUES];
}
@Controller('admin/growth/incidents')
@UseGuards(AdminAuthGuard)
export class GrowthOperationsController {
  constructor(
    private readonly store: FirestoreService,
    private readonly callbacks: ApiCallbacksService,
  ) {}
  @Get()
  async list(@Query('queue') name: string) {
    const spec = queue(name);
    const rows = await this.store
      .getClient()
      .collection(spec.collection)
      .where(spec.field, '==', spec.failed)
      .limit(51)
      .get();
    return {
      schemaVersion: 1,
      queue: name,
      truncated: rows.size > 50,
      items: rows.docs.slice(0, 50).map((doc) => {
        const row = doc.data();
        const error = row.errorCode ?? row.lastErrorCode;
        return {
          id: doc.id,
          status: spec.failed,
          attempts: Number.isSafeInteger(row.attempts) ? row.attempts : null,
          errorCode:
            typeof error === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(error)
              ? error
              : null,
          createdAt:
            typeof row.createdAt === 'string' &&
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
              row.createdAt,
            ) &&
            Number.isFinite(Date.parse(row.createdAt))
              ? row.createdAt
              : null,
        };
      }),
    };
  }
  @Post(':queue/:id/retry')
  @HttpCode(202)
  async retry(@Param('queue') name: string, @Param('id') id: string) {
    const spec = queue(name);
    if (
      name === 'product_events' ? !/^[a-f0-9]{64}$/.test(id) : !isUUID(id, '4')
    )
      throw new BadRequestException('INVALID_INCIDENT_ID');
    const db = this.store.getClient(),
      row = (await db.collection(spec.collection).doc(id).get()).data();
    if (!row) throw new NotFoundException('INCIDENT_NOT_FOUND');
    if (name === 'product_events') {
      if (!(await new ProductEventOutboxService(db).retryDead(id)))
        throw new ConflictException('INCIDENT_NOT_RETRYABLE');
    } else if (name === 'label_events') {
      if (
        !(await new FirestoreLabelEventOutbox(db).requeueDead(
          row.accountId,
          id,
          new Date(),
        ))
      )
        throw new ConflictException('INCIDENT_NOT_RETRYABLE');
    } else if (name === 'drive_revocations') await retryDriveRevocation(db, id);
    else
      await this.callbacks.retryDeadDelivery(row.accountId, row.callbackId, id);
    return { schemaVersion: 1, queue: name, id, status: 'queued' };
  }
}
@Module({
  imports: [CacheModule, AuthModule, PublicApiModule],
  controllers: [GrowthOperationsController],
})
export class GrowthOperationsModule {}
