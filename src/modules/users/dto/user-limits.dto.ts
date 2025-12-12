import { ApiProperty } from '@nestjs/swagger';
import type { PlanType } from '../../../common/interfaces/user.interface.js';

export class PlanLimitsDto {
  @ApiProperty({ description: 'Maximum labels per PDF' })
  maxLabelsPerPdf: number;

  @ApiProperty({ description: 'Maximum PDFs per month' })
  maxPdfsPerMonth: number;

  @ApiProperty({ description: 'Can download images (PNG/JPEG) - Pro and Enterprise only' })
  canDownloadImages: boolean;
}

export class CurrentUsageDto {
  @ApiProperty({ description: 'PDFs generated this period' })
  pdfCount: number;

  @ApiProperty({ description: 'Total labels generated this period' })
  labelCount: number;
}

export class UserLimitsDto {
  @ApiProperty({ description: 'Current plan', enum: ['free', 'pro', 'enterprise'] })
  plan: PlanType;

  @ApiProperty({ description: 'Plan limits', type: PlanLimitsDto })
  limits: PlanLimitsDto;

  @ApiProperty({ description: 'Current usage', type: CurrentUsageDto })
  currentUsage: CurrentUsageDto;

  @ApiProperty({ description: 'Period end date' })
  periodEndsAt: Date;
}
