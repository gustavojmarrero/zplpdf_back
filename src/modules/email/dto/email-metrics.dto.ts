import { ApiProperty } from '@nestjs/swagger';

export class EmailMetricsDto {
  @ApiProperty({ example: 150, description: 'Total emails sent' })
  sent: number;

  @ApiProperty({ example: 148, description: 'Total emails delivered' })
  delivered: number;

  @ApiProperty({ example: 62, description: 'Total emails opened' })
  opened: number;

  @ApiProperty({ example: 25, description: 'Total emails clicked' })
  clicked: number;

  @ApiProperty({ example: 2, description: 'Total emails bounced' })
  bounced: number;

  @ApiProperty({ example: 0, description: 'Total spam complaints' })
  complained: number;

  @ApiProperty({ example: 41.89, description: 'Open rate percentage' })
  openRate: number;

  @ApiProperty({ example: 40.32, description: 'Click rate percentage (clicks/opens)' })
  clickRate: number;
}

export class AbVariantMetricsDto {
  @ApiProperty({ example: 'A', description: 'A/B variant identifier' })
  variant: string;

  @ApiProperty({ example: 50, description: 'Total emails sent for this variant' })
  sent: number;

  @ApiProperty({ example: 48, description: 'Total emails delivered for this variant' })
  delivered: number;

  @ApiProperty({ example: 22, description: 'Total emails opened for this variant' })
  opened: number;

  @ApiProperty({ example: 10, description: 'Total emails clicked for this variant' })
  clicked: number;

  @ApiProperty({ example: 44, description: 'Open rate percentage for this variant' })
  openRate: number;

  @ApiProperty({ example: 45.45, description: 'Click rate percentage for this variant' })
  clickRate: number;
}

export class AbTestResultDto {
  @ApiProperty({ example: 'welcome', description: 'Email type' })
  emailType: string;

  @ApiProperty({ type: [AbVariantMetricsDto], description: 'Metrics for each variant' })
  variants: AbVariantMetricsDto[];
}

export class EmailMetricsByTypeDto {
  @ApiProperty({ example: 'welcome', description: 'Email type' })
  emailType: string;

  @ApiProperty({ type: EmailMetricsDto, description: 'Metrics for this email type' })
  metrics: EmailMetricsDto;
}

export class OnboardingFunnelDto {
  @ApiProperty({ example: 1000, description: 'Total registered users in period' })
  registeredUsers: number;

  @ApiProperty({ example: 950, description: 'Users who received welcome email' })
  receivedWelcome: number;

  @ApiProperty({ example: 475, description: 'Users who opened welcome email' })
  openedWelcome: number;

  @ApiProperty({ example: 142, description: 'Users who clicked in welcome email' })
  clickedWelcome: number;

  @ApiProperty({ example: 300, description: 'Users who generated at least 1 PDF' })
  firstPdfGenerated: number;

  @ApiProperty({ example: 280, description: 'Users activated (≥1 PDF) within 7 days' })
  activatedIn7Days: number;
}
