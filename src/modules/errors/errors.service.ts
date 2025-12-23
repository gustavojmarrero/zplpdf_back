import { Injectable, Logger } from '@nestjs/common';
import { FirestoreService } from '../cache/firestore.service.js';
import { CreateErrorDto, CreateErrorResponseDto } from './dto/create-error.dto.js';
import type { FirebaseUser } from '../../common/decorators/current-user.decorator.js';

@Injectable()
export class ErrorsService {
  private readonly logger = new Logger(ErrorsService.name);

  constructor(private readonly firestoreService: FirestoreService) {}

  /**
   * Report an error from frontend
   */
  async reportError(
    dto: CreateErrorDto,
    user: FirebaseUser,
    userAgent?: string,
  ): Promise<CreateErrorResponseDto> {
    this.logger.log(`User ${user.email} reporting error: ${dto.code}`);

    const errorId = await this.firestoreService.saveErrorLog({
      type: dto.type || 'FRONTEND',
      code: dto.code,
      message: dto.message,
      severity: dto.severity || 'error',
      userId: user.uid,
      userEmail: user.email,
      source: 'frontend',
      url: dto.url,
      stackTrace: dto.stackTrace,
      userAgent,
      context: dto.context,
    });

    if (!errorId) {
      this.logger.error('Failed to save error log');
      // Still return success to frontend, but log the failure
      return {
        success: true,
        data: {
          errorId: 'ERR-UNKNOWN',
          message: 'Error registrado (con advertencia)',
        },
      };
    }

    this.logger.log(`Error registered with ID: ${errorId}`);

    return {
      success: true,
      data: {
        errorId,
        message: 'Error registrado correctamente',
      },
    };
  }
}
