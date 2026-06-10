import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminAuthGuard } from '../../common/guards/admin-auth.guard.js';
import { FeedbackService } from './feedback.service.js';
import { QueryFeedbackDto } from './dto/query-feedback.dto.js';

@ApiTags('admin')
@Controller('admin/feedback')
export class FeedbackAdminController {
  constructor(private readonly feedbackService: FeedbackService) {}

  @Get()
  @UseGuards(AdminAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Listado de feedback (admin)',
    description: 'Devuelve respuestas paginadas, filtros y resumen por sentimiento.',
  })
  list(@Query() query: QueryFeedbackDto) {
    return this.feedbackService.getAdminList(query);
  }
}
