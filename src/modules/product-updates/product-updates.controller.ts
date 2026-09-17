import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';
import { TourProgressDto } from './product-updates.dto.js';
import { ProductUpdatesService } from './product-updates.service.js';

@ApiTags('product-updates')
@ApiBearerAuth()
@Controller()
export class ProductUpdatesController {
  constructor(private readonly updates: ProductUpdatesService) {}

  @Get('users/me/product-updates')
  @UseGuards(FirebaseAuthGuard)
  manifest(@Req() req: { user: { uid: string } }) {
    return this.updates.getProductUpdates(req.user.uid);
  }

  /** El uid sale siempre del token: el path solo identifica release y versión. */
  @Patch('users/me/product-updates/:releaseId/:tourVersion/progress')
  @UseGuards(FirebaseAuthGuard)
  @ApiBody({ type: TourProgressDto })
  progress(
    @Req() req: { user: { uid: string } },
    @Param('releaseId') releaseId: string,
    @Param('tourVersion') tourVersion: string,
    @Body() body: TourProgressDto,
  ) {
    return this.updates.updateProgress(
      req.user.uid,
      releaseId,
      tourVersion,
      body,
    );
  }
}
