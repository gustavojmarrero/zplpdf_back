import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsEnum, MaxLength } from 'class-validator';
import { LabelSize } from '../enums/label-size.enum.js';

export class FontPreviewPublicDto {
  @ApiProperty({
    description: 'ZPL content to preview (max 2KB). Must contain ^XA and ^XZ.',
    example: '^XA^A0N,50,50^FO20,20^FDHello World^FS^XZ',
    maxLength: 2048,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  zplContent: string;

  @ApiProperty({
    description: 'Label size (default 4x6)',
    example: LabelSize.FOUR_BY_SIX,
    enum: LabelSize,
    default: LabelSize.FOUR_BY_SIX,
    required: false,
  })
  @IsEnum(LabelSize)
  @IsOptional()
  labelSize?: LabelSize;
}
