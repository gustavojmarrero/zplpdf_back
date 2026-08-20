import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  NestInterceptor,
  PayloadTooLargeException,
} from '@nestjs/common';
import { Observable, catchError, throwError } from 'rxjs';
import { ErrorCodes } from '../../../common/constants/error-codes.js';

/**
 * Traduce el corte por tamaño de multer al código estable `IMAGE_TOO_LARGE`.
 *
 * El límite se aplica en el interceptor de subida —así el proceso no llega a
 * bufferizar una imagen de 500 MB—, pero ese camino lanza un
 * `PayloadTooLargeException` genérico, que el filtro global resolvería como
 * `FILE_TOO_LARGE`, el código del ZPL y con otro límite. El frontend traduce a
 * cuatro idiomas a partir del código, así que tiene que llegarle el de la foto.
 *
 * Debe declararse ANTES que el `FileInterceptor` en `@UseInterceptors`: solo
 * así envuelve su ejecución y puede capturar el error.
 */
@Injectable()
export class PhotoUploadErrorInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      catchError((error) => {
        const isTooLarge =
          error instanceof PayloadTooLargeException ||
          error?.code === 'LIMIT_FILE_SIZE';

        if (!isTooLarge) {
          return throwError(() => error);
        }

        return throwError(
          () =>
            new HttpException(
              {
                error: ErrorCodes.IMAGE_TOO_LARGE,
                message: 'Photo exceeds the maximum allowed size',
              },
              HttpStatus.PAYLOAD_TOO_LARGE,
            ),
        );
      }),
    );
  }
}
