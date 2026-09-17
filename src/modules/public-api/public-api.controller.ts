import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiBody, ApiHeader } from '@nestjs/swagger';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';
import { ApiCredentialsService } from './api-credentials.service.js';
import { ApiJobsService } from './api-jobs.service.js';
import { ApiCallbacksService } from './api-callbacks.service.js';
import { ApiKeyGuard, RequireApiScope } from './api-key.guard.js';
import {
  createKeySchema,
  createCallbackSchema,
  createJobSchema,
} from './public-api.schemas.js';
import type { ApiPrincipal } from './public-api.types.js';
@ApiTags('public-api-management')
@ApiBearerAuth()
@UseGuards(FirebaseAuthGuard)
@Controller('users/me')
export class PublicApiManagementController {
  constructor(
    private readonly credentials: ApiCredentialsService,
    private readonly callbacks: ApiCallbacksService,
    private readonly jobs: ApiJobsService,
  ) {}
  @Get('api-jobs') listJobs(
    @Req() req: { user: { uid: string } },
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.jobs.list(
      req.user.uid,
      cursor,
      limit === undefined ? 25 : Number(limit),
    );
  }
  @Get('api-usage') usage(@Req() req: { user: { uid: string } }) {
    return this.jobs.usage(req.user.uid);
  }
  @Get('api-jobs/:id') jobStatus(
    @Req() req: { user: { uid: string } },
    @Param('id') id: string,
  ) {
    return this.jobs.status(req.user.uid, id);
  }
  @Get('api-jobs/:id/result') jobResult(
    @Req() req: { user: { uid: string } },
    @Param('id') id: string,
  ) {
    return this.jobs.result(req.user.uid, id);
  }
  @Post('api-jobs/:id/cancel') cancelJob(
    @Req() req: { user: { uid: string } },
    @Param('id') id: string,
  ) {
    return this.jobs.cancel(req.user.uid, id);
  }
  @Post('api-jobs/:id/retry') @HttpCode(202) retryJob(
    @Req() req: { user: { uid: string } },
    @Param('id') id: string,
  ) {
    return this.jobs.retry(req.user.uid, id);
  }
  @Post('api-callbacks/:id/deliveries/:deliveryId/retry')
  @HttpCode(202)
  retryDelivery(
    @Req() req: { user: { uid: string } },
    @Param('id') id: string,
    @Param('deliveryId') deliveryId: string,
  ) {
    return this.callbacks.retryDeadDelivery(req.user.uid, id, deliveryId);
  }
  @ApiBody({ schema: createKeySchema })
  @Post('api-keys')
  createKey(@Req() req: { user: { uid: string } }, @Body() body: unknown) {
    return this.credentials.createKey(req.user.uid, body);
  }
  @Get('api-keys') keys(@Req() req: { user: { uid: string } }) {
    return this.credentials.list(req.user.uid, 'keys');
  }
  @Delete('api-keys/:id') revoke(
    @Req() req: { user: { uid: string } },
    @Param('id') id: string,
  ) {
    return this.credentials.revoke(req.user.uid, id, 'keys');
  }
  @ApiBody({ schema: createCallbackSchema })
  @Post('api-callbacks')
  createCallback(@Req() req: { user: { uid: string } }, @Body() body: unknown) {
    return this.credentials.createCallback(req.user.uid, body);
  }
  @Get('api-callbacks') endpoints(@Req() req: { user: { uid: string } }) {
    return this.credentials.list(req.user.uid, 'callbacks');
  }
  @Delete('api-callbacks/:id') revokeCallback(
    @Req() req: { user: { uid: string } },
    @Param('id') id: string,
  ) {
    return this.credentials.revoke(req.user.uid, id, 'callbacks');
  }
  @Get('api-callbacks/:id/deliveries') deliveries(
    @Req() req: { user: { uid: string } },
    @Param('id') id: string,
  ) {
    return this.callbacks.deliveries(req.user.uid, id);
  }
}
@ApiTags('public-api-v1')
@ApiBearerAuth()
@UseGuards(ApiKeyGuard)
@Controller('v1/jobs')
export class PublicApiJobsController {
  constructor(private readonly jobs: ApiJobsService) {}
  @ApiBody({ schema: createJobSchema })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      '1–128 characters: letters, digits, underscore, dot, colon or hyphen',
  })
  @Post()
  @HttpCode(202)
  @RequireApiScope('jobs:write')
  create(
    @Req() req: { apiPrincipal: ApiPrincipal },
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
  ) {
    return this.jobs.create(req.apiPrincipal.accountId, key, body);
  }
  @Get(':id') @RequireApiScope('jobs:read') status(
    @Req() req: { apiPrincipal: ApiPrincipal },
    @Param('id') id: string,
  ) {
    return this.jobs.status(req.apiPrincipal.accountId, id);
  }
  @Get(':id/result') @RequireApiScope('jobs:read') result(
    @Req() req: { apiPrincipal: ApiPrincipal },
    @Param('id') id: string,
  ) {
    return this.jobs.result(req.apiPrincipal.accountId, id);
  }
  @Post(':id/cancel') @RequireApiScope('jobs:write') cancel(
    @Req() req: { apiPrincipal: ApiPrincipal },
    @Param('id') id: string,
  ) {
    return this.jobs.cancel(req.apiPrincipal.accountId, id);
  }
  @Post(':id/retry') @HttpCode(202) @RequireApiScope('jobs:write') retry(
    @Req() req: { apiPrincipal: ApiPrincipal },
    @Param('id') id: string,
  ) {
    return this.jobs.retry(req.apiPrincipal.accountId, id);
  }
}
