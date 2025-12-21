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

class UserNearLabelLimitDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  email: string;

  @ApiProperty({ enum: ['free', 'pro', 'enterprise'] })
  plan: string;

  @ApiProperty({ description: 'Current label count in period' })
  labelCount: number;

  @ApiProperty({ description: 'Monthly label limit (maxPdfsPerMonth * maxLabelsPerPdf)' })
  labelLimit: number;

  @ApiProperty({ description: 'Percentage of label limit used' })
  percentUsed: number;

  @ApiProperty()
  periodEnd: Date;
}

class LabelUsageDistributionDto {
  @ApiProperty({ description: 'Users using 0-25% of label limit' })
  '0-25': number;

  @ApiProperty({ description: 'Users using 25-50% of label limit' })
  '25-50': number;

  @ApiProperty({ description: 'Users using 50-75% of label limit' })
  '50-75': number;

  @ApiProperty({ description: 'Users using 75-100% of label limit' })
  '75-100': number;
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

  @ApiProperty({ type: [UserNearLimitDto], description: 'Users near PDF limit' })
  usersNearLimit: UserNearLimitDto[];

  @ApiProperty({ type: [UserNearLabelLimitDto], description: 'Users near label limit' })
  usersNearLabelLimit: UserNearLabelLimitDto[];

  @ApiProperty({ type: LabelUsageDistributionDto, description: 'Distribution of label usage by percentage ranges' })
  labelUsageDistribution: LabelUsageDistributionDto;

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
