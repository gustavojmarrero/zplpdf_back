import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  Equals,
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  IsUUID,
  Matches,
  ValidateNested,
} from 'class-validator';
import {
  ACTIONS,
  CONSENT_VERSION,
  FEATURE_IDS,
  WEB_EVENTS,
  SURFACES,
} from './observability.types.js';
import type { FeatureId } from './observability.types.js';

export class AnalyticsConsentDto {
  @ApiProperty({ enum: [true] })
  @Equals(true)
  analytics: true;
  @ApiProperty({ enum: [CONSENT_VERSION] })
  @Equals(CONSENT_VERSION)
  version: typeof CONSENT_VERSION;
}
export class WebProductEventDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  @Matches(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  )
  eventId: string;
  @ApiProperty({ enum: [1] })
  @Equals(1)
  schemaVersion: 1;
  @ApiProperty({ enum: WEB_EVENTS })
  @IsIn(WEB_EVENTS)
  eventName: (typeof WEB_EVENTS)[number];
  @ApiProperty({ format: 'date-time' })
  @IsISO8601({ strict: true })
  @Matches(/Z$/)
  occurredAt: string;
  @ApiProperty({ enum: FEATURE_IDS })
  @IsIn(FEATURE_IDS)
  featureId: FeatureId;
  @ApiProperty({ example: '1', maxLength: 40 })
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$/)
  featureVersion: string;
  @ApiProperty({ enum: SURFACES })
  @IsIn(SURFACES)
  surface: (typeof SURFACES)[number];

  @ApiPropertyOptional({ enum: ACTIONS })
  @IsOptional()
  @IsIn(ACTIONS)
  action?: (typeof ACTIONS)[number];
}
export class WebProductEventsDto {
  @ApiProperty({ format: 'date-time' })
  @IsISO8601({ strict: true })
  @Matches(/Z$/)
  sentAt: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') consentEpoch: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') sessionEpoch: string;
  @ApiProperty({ type: AnalyticsConsentDto })
  @ValidateNested()
  @Type(() => AnalyticsConsentDto)
  consent: AnalyticsConsentDto;
  @ApiProperty({ type: [WebProductEventDto], minItems: 1, maxItems: 20 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => WebProductEventDto)
  events: WebProductEventDto[];
}
