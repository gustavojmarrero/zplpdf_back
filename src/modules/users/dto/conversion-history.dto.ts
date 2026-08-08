import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LabelSize } from '../../zpl/enums/label-size.enum.js';
import { OutputFormat } from '../../zpl/enums/output-format.enum.js';
import { HistoryStatus } from './get-history-query.dto.js';

export class ConversionHistoryItemDto {
  @ApiProperty({ description: 'Firestore document id' })
  id: string;

  @ApiProperty({ description: 'Conversion job id' })
  jobId: string;

  @ApiProperty({ description: 'Number of labels in the conversion' })
  labelCount: number;

  @ApiProperty({ description: 'Label size', enum: LabelSize })
  labelSize: string;

  @ApiProperty({ description: 'Conversion status', enum: HistoryStatus })
  status: 'completed' | 'failed';

  @ApiProperty({ description: 'Output format', enum: OutputFormat })
  outputFormat: 'pdf' | 'png' | 'jpeg';

  @ApiPropertyOptional({
    description: 'Fresh signed download URL (completed conversions only)',
  })
  fileUrl?: string;

  @ApiProperty({ description: 'Conversion date (ISO 8601)', nullable: true })
  createdAt: string | null;
}

export class ConversionHistoryPaginationDto {
  @ApiProperty({ description: 'Current page' })
  page: number;

  @ApiProperty({ description: 'Items per page' })
  limit: number;

  @ApiProperty({ description: 'Total items after applying filters' })
  total: number;

  @ApiProperty({ description: 'Total pages after applying filters' })
  totalPages: number;

  @ApiPropertyOptional({
    description:
      'True when the user has more conversions than the scan cap, so filters ' +
      'and totals only cover the most recent ones',
  })
  truncated?: boolean;
}

export class ConversionHistoryFacetsDto {
  @ApiProperty({
    description: 'Label sizes present in the scanned history',
    type: [String],
  })
  labelSizes: string[];

  @ApiProperty({
    description: 'Output formats present in the scanned history',
    type: [String],
  })
  outputFormats: string[];

  @ApiProperty({
    description: 'Statuses present in the scanned history',
    type: [String],
  })
  statuses: string[];
}

export class ConversionHistoryResponseDto {
  @ApiProperty({ default: true })
  success: true;

  @ApiProperty({ type: [ConversionHistoryItemDto] })
  data: ConversionHistoryItemDto[];

  @ApiProperty({ type: ConversionHistoryPaginationDto })
  pagination: ConversionHistoryPaginationDto;

  @ApiProperty({
    description:
      'Values actually present in the scanned history, so the frontend can ' +
      'populate the filter selects without hardcoding them',
    type: ConversionHistoryFacetsDto,
  })
  facets: ConversionHistoryFacetsDto;
}
