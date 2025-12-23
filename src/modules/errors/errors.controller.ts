import {
  Controller,
  Post,
  Body,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiHeader,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { FirebaseUser } from '../../common/decorators/current-user.decorator.js';
import { ErrorsService } from './errors.service.js';
import { CreateErrorDto, CreateErrorResponseDto } from './dto/create-error.dto.js';

@ApiTags('errors')
@ApiBearerAuth()
@Controller('errors')
export class ErrorsController {
  constructor(private readonly errorsService: ErrorsService) {}

  @Post()
  @UseGuards(FirebaseAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Report an error from frontend',
    description:
      'Allows authenticated users to report errors from the frontend. Returns a unique error ID that can be communicated to support.',
  })
  @ApiHeader({
    name: 'Authorization',
    description: 'Firebase ID token',
    required: true,
  })
  @ApiResponse({
    status: 201,
    description: 'Error reported successfully',
    type: CreateErrorResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized - Invalid or missing token',
  })
  async reportError(
    @Body() dto: CreateErrorDto,
    @CurrentUser() user: FirebaseUser,
    @Req() request: Request,
  ): Promise<CreateErrorResponseDto> {
    const userAgent = request.headers['user-agent'];
    return this.errorsService.reportError(dto, user, userAgent);
  }
}
