import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';
import { AdminAuthGuard } from '../../common/guards/admin-auth.guard.js';
import { FeatureFlagsService } from './feature-flags.service.js';
import { ProductObservabilityService } from './product-observability.service.js';
import { WebProductEventsDto } from './product-event.dto.js';

@ApiTags('product-observability')
@ApiBearerAuth()
@Controller()
export class ProductObservabilityController {
  constructor(
    private readonly flags: FeatureFlagsService,
    private readonly events: ProductObservabilityService,
  ) {}
  @Get('users/me/features')
  @UseGuards(FirebaseAuthGuard)
  features(@Req() req: { user: { uid: string } }) {
    return this.flags.getFeatures(req.user.uid);
  }
  @Post('product-events/web')
  @HttpCode(202)
  @UseGuards(FirebaseAuthGuard)
  @ApiBody({ type: WebProductEventsDto })
  web(@Req() req: { user: { uid: string } }, @Body() body: unknown) {
    return this.events.recordWebEvents(req.user.uid, body);
  }
  @Get('admin/observability/quality')
  @UseGuards(AdminAuthGuard)
  quality() {
    return this.events.quality();
  }
  @Get('admin/observability/snapshots')
  @UseGuards(AdminAuthGuard)
  snapshots() {
    return this.events.snapshots();
  }
}
