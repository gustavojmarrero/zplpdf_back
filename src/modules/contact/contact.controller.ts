import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ContactService } from './contact.service.js';
import {
  EnterpriseContactDto,
  EnterpriseContactResponseDto,
} from './dto/enterprise-contact.dto.js';

@ApiTags('contact')
@Controller('contact')
export class ContactController {
  constructor(private readonly contactService: ContactService) {}

  @Post('enterprise')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Submit enterprise contact request' })
  @ApiResponse({
    status: 200,
    description: 'Contact request submitted successfully',
    type: EnterpriseContactResponseDto,
  })
  async submitEnterpriseContact(
    @Body() dto: EnterpriseContactDto,
  ): Promise<EnterpriseContactResponseDto> {
    return this.contactService.submitEnterpriseContact(dto);
  }
}
