import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request, Response } from 'express';

/**
 * Interceptor que genera y agrega un X-Request-Id único a cada request.
 * Este ID se usa para correlación de logs y debugging.
 */
@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const ctx = context.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    // Generar o usar el requestId existente (por si viene de un proxy/load balancer)
    const requestId = (request.headers['x-request-id'] as string) || this.generateRequestId();

    // Agregar al request para que esté disponible en los controllers y servicios
    request.headers['x-request-id'] = requestId;

    // Agregar al response header
    response.setHeader('X-Request-Id', requestId);

    return next.handle().pipe(
      tap({
        // Asegurar que el header esté presente incluso después del manejo
        finalize: () => {
          if (!response.headersSent) {
            response.setHeader('X-Request-Id', requestId);
          }
        },
      }),
    );
  }

  /**
   * Genera un request ID único con formato: req_[timestamp]_[random]
   */
  private generateRequestId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 9);
    return `req_${timestamp}_${random}`;
  }
}

/**
 * Helper para obtener el requestId del request actual
 */
export function getRequestId(request: Request): string {
  return (request.headers['x-request-id'] as string) || 'unknown';
}
