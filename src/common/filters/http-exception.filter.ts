import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ErrorCodes, ErrorHttpStatus, getErrorMessage, type ErrorCode } from '../constants/error-codes.js';

/**
 * Interfaz para respuestas de error estandarizadas
 */
export interface StandardErrorResponse {
  success: false;
  error: string;
  message: string;
  data?: Record<string, any>;
  requestId?: string;
}

/**
 * Filtro global de excepciones que estandariza todas las respuestas de error
 * siguiendo el formato requerido por el frontend para GA4 tracking.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // Obtener requestId del header (inyectado por RequestIdInterceptor)
    const requestId = request.headers['x-request-id'] as string || this.generateRequestId();

    // Obtener idioma del header Accept-Language
    const language = this.getLanguage(request);

    let status: number;
    let errorCode: string;
    let message: string;
    let data: Record<string, any> | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const responseObj = exceptionResponse as Record<string, any>;

        // Si ya tiene el formato con 'error' code, usarlo
        if (responseObj.error && typeof responseObj.error === 'string') {
          errorCode = responseObj.error;
          message = responseObj.message || getErrorMessage(errorCode as ErrorCode, language);

          // Extraer data correctamente
          if (responseObj.data) {
            data = responseObj.data;
          } else if (responseObj.errors) {
            // Para errores de validación ZPL
            data = { errors: responseObj.errors, summary: responseObj.summary };
          }
        } else {
          // Mapear a código de error basado en status
          errorCode = this.getErrorCodeFromStatus(status);
          message = responseObj.message || getErrorMessage(errorCode as ErrorCode, language);
        }
      } else {
        errorCode = this.getErrorCodeFromStatus(status);
        message = typeof exceptionResponse === 'string'
          ? exceptionResponse
          : getErrorMessage(errorCode as ErrorCode, language);
      }
    } else {
      // Error no HTTP (error interno)
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      errorCode = ErrorCodes.SERVER_ERROR;
      message = getErrorMessage(ErrorCodes.SERVER_ERROR, language);

      // Log del error completo para debugging
      this.logger.error(
        `Unhandled exception [${requestId}]: ${exception instanceof Error ? exception.message : 'Unknown error'}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    // Log estructurado del error
    this.logger.warn(
      `[${requestId}] ${request.method} ${request.url} - ${status} ${errorCode}: ${message}`,
      {
        requestId,
        method: request.method,
        url: request.url,
        status,
        errorCode,
        userId: (request as any).user?.uid,
        ip: request.ip,
      },
    );

    // Construir respuesta estandarizada
    const errorResponse: StandardErrorResponse = {
      success: false,
      error: errorCode,
      message,
      ...(data && { data }),
      requestId,
    };

    // Asegurar que el header X-Request-Id esté presente
    response.setHeader('X-Request-Id', requestId);

    response.status(status).json(errorResponse);
  }

  /**
   * Mapea HTTP status a código de error
   */
  private getErrorCodeFromStatus(status: number): ErrorCode {
    switch (status) {
      case 400:
        return ErrorCodes.INVALID_INPUT;
      case 401:
        return ErrorCodes.UNAUTHORIZED;
      case 403:
        return ErrorCodes.ACCESS_DENIED;
      case 404:
        return ErrorCodes.JOB_NOT_FOUND;
      case 410:
        return ErrorCodes.JOB_EXPIRED;
      case 413:
        return ErrorCodes.FILE_TOO_LARGE;
      case 503:
        return ErrorCodes.SERVICE_UNAVAILABLE;
      case 504:
        return ErrorCodes.PROCESSING_TIMEOUT;
      default:
        return ErrorCodes.SERVER_ERROR;
    }
  }

  /**
   * Obtiene el idioma preferido del request
   */
  private getLanguage(request: Request): 'es' | 'en' {
    const acceptLanguage = request.headers['accept-language'] || '';
    return acceptLanguage.toLowerCase().startsWith('en') ? 'en' : 'es';
  }

  /**
   * Genera un request ID único
   */
  private generateRequestId(): string {
    return `req_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 9)}`;
  }
}
