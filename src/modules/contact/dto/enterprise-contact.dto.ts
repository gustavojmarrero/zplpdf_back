import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsEmail, IsNumber, Min, IsOptional } from 'class-validator';

export class EnterpriseContactDto {
  @ApiProperty({ description: 'Company name' })
  @IsString()
  companyName: string;

  @ApiProperty({ description: 'Contact person name' })
  @IsString()
  contactName: string;

  @ApiProperty({ description: 'Contact email' })
  @IsEmail()
  email: string;

  @ApiProperty({ description: 'Phone number', required: false })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiProperty({ description: 'Estimated labels per month', minimum: 1 })
  @IsNumber()
  @Min(1)
  estimatedLabelsPerMonth: number;

  @ApiProperty({ description: 'Additional message', required: false })
  @IsString()
  @IsOptional()
  message?: string;
}

export class EnterpriseContactResponseDto {
  @ApiProperty({ description: 'Success status' })
  success: boolean;

  @ApiProperty({ description: 'Response message' })
  message: string;
}
