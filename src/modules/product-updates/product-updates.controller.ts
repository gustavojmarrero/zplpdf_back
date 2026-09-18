import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';
import { TourProgressDto } from './product-updates.dto.js';
import { ProductUpdatesService } from './product-updates.service.js';

@ApiTags('product-updates')
@Controller()
export class ProductUpdatesController {
  constructor(private readonly updates: ProductUpdatesService) {}

  @Get('product-updates/catalog')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Public catalog of approved, globally released features',
  })
  @ApiResponse({
    status: 200,
    description: 'Read-only catalog; empty when no features can be advertised.',
    schema: {
      type: 'object',
      required: ['schemaVersion', 'releaseId', 'manifestVersion', 'features'],
      properties: {
        schemaVersion: { type: 'integer', enum: [1] },
        releaseId: { type: 'string', nullable: true },
        manifestVersion: { type: 'string', nullable: true },
        features: {
          type: 'array',
          items: {
            type: 'object',
            required: ['featureId', 'minimumPlan'],
            properties: {
              featureId: { type: 'string' },
              minimumPlan: { type: 'string' },
            },
          },
        },
      },
    },
  })
  catalog() {
    return this.updates.getPublicCatalog();
  }

  @Get('users/me/product-updates')
  @UseGuards(FirebaseAuthGuard)
  @ApiBearerAuth()
  manifest(@Req() req: { user: { uid: string } }) {
    return this.updates.getProductUpdates(req.user.uid);
  }

  /** El uid sale siempre del token: el path solo identifica release y versión. */
  @Patch('users/me/product-updates/:releaseId/:tourVersion/progress')
  @UseGuards(FirebaseAuthGuard)
  @ApiBearerAuth()
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
