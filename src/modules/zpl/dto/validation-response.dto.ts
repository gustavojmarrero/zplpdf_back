import { ApiProperty } from '@nestjs/swagger';
import {
  ValidationIssue,
  ValidationSummary,
} from '../validation/zpl-validation.types.js';

export class ValidationIssueDto implements ValidationIssue {
  @ApiProperty({ example: 'ZPL_FIELD_001' })
  code: string;

  @ApiProperty({ example: 'field' })
  type: 'structure' | 'field' | 'position' | 'barcode' | 'command';

  @ApiProperty({ example: 'error' })
  severity: 'error' | 'warning' | 'info';

  @ApiProperty({ example: 'Desequilibrio de campos: 3 ^FD encontrados pero 2 ^FS' })
  message: string;

  @ApiProperty({ example: 1, required: false })
  line?: number;

  @ApiProperty({ example: 45, required: false })
  position?: number;

  @ApiProperty({ example: '...^FO50,50^FD...', required: false })
  context?: string;

  @ApiProperty({
    example: 'Verifique que cada ^FD tenga su correspondiente ^FS',
    required: false,
  })
  suggestion?: string;

  @ApiProperty({ example: '^FD', required: false })
  command?: string;
}

export class ValidationSummaryDto implements ValidationSummary {
  @ApiProperty({ example: 3 })
  totalBlocks: number;

  @ApiProperty({ example: 2 })
  validBlocks: number;

  @ApiProperty({ example: 1 })
  errorCount: number;

  @ApiProperty({ example: 2 })
  warningCount: number;

  @ApiProperty({ example: 0 })
  infoCount: number;

  @ApiProperty({
    example: {
      structure: true,
      field: false,
      position: true,
      barcode: true,
      command: true,
    },
  })
  validatorResults: Record<
    'structure' | 'field' | 'position' | 'barcode' | 'command',
    boolean
  >;
}

export class ValidationDataDto {
  @ApiProperty({ example: false })
  isValid: boolean;

  @ApiProperty({ type: [ValidationIssueDto] })
  errors: ValidationIssueDto[];

  @ApiProperty({ type: [ValidationIssueDto] })
  warnings: ValidationIssueDto[];

  @ApiProperty({ type: ValidationSummaryDto })
  summary: ValidationSummaryDto;
}

export class ValidationResponseDto {
  @ApiProperty({ example: true })
  success: boolean;

  @ApiProperty({ example: 'Se encontraron problemas en el ZPL' })
  message: string;

  @ApiProperty({ type: ValidationDataDto })
  data: ValidationDataDto;
}
