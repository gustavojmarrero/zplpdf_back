import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { FirebaseUser } from '../../common/decorators/current-user.decorator.js';
import { FeedbackService } from './feedback.service.js';
import { CreateFeedbackDto } from './dto/create-feedback.dto.js';

@ApiTags('feedback')
@Controller('feedback')
export class FeedbackController {
  constructor(private readonly feedbackService: FeedbackService) {}

  @Get('status')
  @UseGuards(FirebaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Estado de la encuesta mensual',
    description: 'Indica si debe mostrarse la encuesta (cadencia 30 días rolling).',
  })
  getStatus(@CurrentUser() user: FirebaseUser) {
    return this.feedbackService.getStatus(user.uid);
  }

  @Post()
  @UseGuards(FirebaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Enviar una respuesta de feedback' })
  @ApiResponse({ status: 201, description: 'Feedback registrado correctamente' })
  submit(@CurrentUser() user: FirebaseUser, @Body() dto: CreateFeedbackDto) {
    return this.feedbackService.submit(user.uid, user.email, dto);
  }
}
