import { ApiProperty } from '@nestjs/swagger';

class PlanDistributionItemDto {
  @ApiProperty()
  users: number;

  @ApiProperty()
  percentage: number;
}

class UserNearLimitDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  email: string;

  @ApiProperty({ enum: ['free', 'pro', 'enterprise'] })
  plan: string;

  @ApiProperty()
  pdfCount: number;

  @ApiProperty()
  pdfLimit: number;

  @ApiProperty()
  percentUsed: number;

  @ApiProperty()
  periodEnd: Date;
}

class UserExceedingFrequentlyDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  email: string;

  @ApiProperty({ enum: ['free', 'pro', 'enterprise'] })
  plan: string;

  @ApiProperty()
  exceedCount: number;

  @ApiProperty()
  lastExceeded: Date;

  @ApiProperty()
  suggestedPlan: string;
}

class UpgradeOpportunitiesDto {
  @ApiProperty()
  freeToProCandidates: number;

  @ApiProperty()
  proToEnterpriseCandidates: number;
}

class ConversionRatesDto {
  @ApiProperty()
  freeTrialToPro: number;

  @ApiProperty()
  proToEnterprise: number;
}

class PlanUsageDataDto {
  @ApiProperty()
  distribution: {
    free: PlanDistributionItemDto;
    pro: PlanDistributionItemDto;
    enterprise: PlanDistributionItemDto;
  };

  @ApiProperty({ type: [UserNearLimitDto] })
  usersNearLimit: UserNearLimitDto[];

  @ApiProperty({ type: [UserExceedingFrequentlyDto] })
  usersExceedingFrequently: UserExceedingFrequentlyDto[];

  @ApiProperty({ type: UpgradeOpportunitiesDto })
  upgradeOpportunities: UpgradeOpportunitiesDto;

  @ApiProperty({ type: ConversionRatesDto })
  conversionRates: ConversionRatesDto;
}

export class AdminPlanUsageResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty({ type: PlanUsageDataDto })
  data: PlanUsageDataDto;
}
