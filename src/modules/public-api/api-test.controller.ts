import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { ApiKeyGuard, RequireApiScope } from './api-key.guard.js';
import { FeatureFlagsService } from '../product-observability/feature-flags.service.js';
import type { ApiPrincipal } from './public-api.types.js';

export const API_TEST_FIXTURE = {
  id: 'zpl-label-v1',
  zplContent:
    '^XA^FO30,30^A0N,30,30^FDZPLPDF SYNTHETIC API TEST^FS^FO30,90^BY2^BCN,80,Y,N,N^FDSYNTHETIC-001^FS^XZ',
  labelSize: '4x6',
};
/** Authenticated connectivity/schema check; never claims a rendered or paid job. */
@ApiTags('public-api-v1')
@ApiBearerAuth()
@Controller('v1/test')
@UseGuards(ApiKeyGuard)
export class ApiTestController {
  constructor(private readonly flags: FeatureFlagsService) {}
  @Post()
  @HttpCode(200)
  @RequireApiScope('jobs:write')
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['fixtureId'],
      properties: { fixtureId: { type: 'string', enum: ['zpl-label-v1'] } },
    },
  })
  async test(
    @Req() req: { apiPrincipal: ApiPrincipal },
    @Body() body: unknown,
  ) {
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some((k) => k !== 'fixtureId') ||
      (body as any).fixtureId !== API_TEST_FIXTURE.id
    )
      throw new BadRequestException('API_TEST_FIXTURE_REQUIRED');
    await this.flags.assertFeatureAvailable(
      req.apiPrincipal.accountId,
      'self_service_api',
    );
    return {
      schemaVersion: 1,
      mode: 'test',
      status: 'validated',
      execution: 'authentication_and_schema_only',
      fixture: API_TEST_FIXTURE,
      quotaConsumed: 0,
      usageCounted: false,
    };
  }
}
