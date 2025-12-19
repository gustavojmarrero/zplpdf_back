import { ApiProperty } from '@nestjs/swagger';

class RecentRegistrationDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  email: string;

  @ApiProperty({ required: false })
  displayName?: string;

  @ApiProperty()
  plan: string;

  @ApiProperty()
  createdAt: Date;
}

class UsersMetricsDto {
  @ApiProperty()
  total: number;

  @ApiProperty()
  activeToday: number;

  @ApiProperty()
  activeWeek: number;

  @ApiProperty()
  activeMonth: number;

  @ApiProperty()
  byPlan: {
    free: number;
    pro: number;
    enterprise: number;
  };

  @ApiProperty({ type: [RecentRegistrationDto] })
  recentRegistrations: RecentRegistrationDto[];
}

class ConversionTrendDto {
  @ApiProperty()
  date: string;

  @ApiProperty()
  count: number;

  @ApiProperty()
  labels: number;

  @ApiProperty()
  failures: number;
}

class ConversionsMetricsDto {
  @ApiProperty()
  pdfsToday: number;

  @ApiProperty()
  pdfsWeek: number;

  @ApiProperty()
  pdfsMonth: number;

  @ApiProperty()
  pdfsTotal: number;

  @ApiProperty()
  labelsToday: number;

  @ApiProperty()
  labelsTotal: number;

  @ApiProperty()
  successRate: number;

  @ApiProperty()
  failureRate: number;

  @ApiProperty({ type: [ConversionTrendDto] })
  trend: ConversionTrendDto[];
}

class ErrorContextDto {
  @ApiProperty({ required: false })
  line?: number;

  @ApiProperty({ required: false })
  command?: string;

  @ApiProperty({ required: false })
  input_length?: number;

  @ApiProperty({ required: false })
  label_count?: number;

  @ApiProperty({ required: false })
  elapsed_ms?: number;

  @ApiProperty({ required: false })
  service?: string;

  @ApiProperty({ required: false })
  error_code?: string;
}

class RecentErrorDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  type: string;

  @ApiProperty()
  code: string;

  @ApiProperty()
  message: string;

  @ApiProperty({ required: false })
  userId?: string;

  @ApiProperty({ required: false })
  userEmail?: string;

  @ApiProperty({ required: false })
  jobId?: string;

  @ApiProperty()
  timestamp: Date;

  @ApiProperty()
  severity: string;

  @ApiProperty({ type: ErrorContextDto, required: false })
  context?: ErrorContextDto;
}

class ErrorsMetricsDto {
  @ApiProperty({ type: [RecentErrorDto] })
  recentErrors: RecentErrorDto[];

  @ApiProperty()
  byType: Record<string, number>;

  @ApiProperty()
  criticalCount: number;
}

class UserNearLimitDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  email: string;

  @ApiProperty()
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

  @ApiProperty()
  plan: string;

  @ApiProperty()
  exceedCount: number;

  @ApiProperty()
  lastExceeded: Date;

  @ApiProperty()
  suggestedPlan: string;
}

class PlanDistributionItemDto {
  @ApiProperty()
  users: number;

  @ApiProperty()
  percentage: number;
}

class PlanUsageMetricsDto {
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

  @ApiProperty()
  upgradeOpportunities: {
    freeToProCandidates: number;
    proToEnterpriseCandidates: number;
  };
}

class MetricsDataDto {
  @ApiProperty({ type: UsersMetricsDto })
  users: UsersMetricsDto;

  @ApiProperty({ type: ConversionsMetricsDto })
  conversions: ConversionsMetricsDto;

  @ApiProperty({ type: ErrorsMetricsDto })
  errors: ErrorsMetricsDto;

  @ApiProperty({ type: PlanUsageMetricsDto })
  planUsage: PlanUsageMetricsDto;
}

export class AdminMetricsResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty({ type: MetricsDataDto })
  data: MetricsDataDto;

  @ApiProperty()
  generatedAt: Date;
}
