/**
 * Códigos de error estandarizados para la API ZPL
 * Estos códigos se usan en todas las respuestas de error para
 * facilitar el tracking en GA4 y mostrar mensajes específicos al usuario.
 */
export const ErrorCodes = {
  // Errores de validación ZPL (400)
  INVALID_ZPL: 'INVALID_ZPL',
  INVALID_LABEL_SIZE: 'INVALID_LABEL_SIZE',
  INVALID_INPUT: 'INVALID_INPUT',
  NO_FILES: 'NO_FILES',

  // Errores de límites (400/403)
  LABEL_LIMIT_EXCEEDED: 'LABEL_LIMIT_EXCEEDED',
  MONTHLY_LIMIT_EXCEEDED: 'MONTHLY_LIMIT_EXCEEDED',
  BATCH_LIMIT_EXCEEDED: 'BATCH_LIMIT_EXCEEDED',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',

  // Errores de permisos (403)
  IMAGE_FORMAT_PRO_ONLY: 'IMAGE_FORMAT_PRO_ONLY',
  BATCH_NOT_ALLOWED: 'BATCH_NOT_ALLOWED',
  ACCESS_DENIED: 'ACCESS_DENIED',

  // Errores de recursos (404/410)
  JOB_NOT_FOUND: 'JOB_NOT_FOUND',
  JOB_EXPIRED: 'JOB_EXPIRED',
  BATCH_NOT_FOUND: 'BATCH_NOT_FOUND',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  DOWNLOAD_NOT_AVAILABLE: 'DOWNLOAD_NOT_AVAILABLE',

  // Errores de estado (400)
  BATCH_PROCESSING: 'BATCH_PROCESSING',
  JOB_NOT_COMPLETE: 'JOB_NOT_COMPLETE',

  // Errores de servidor (500/503/504)
  SERVER_ERROR: 'SERVER_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  PROCESSING_TIMEOUT: 'PROCESSING_TIMEOUT',

  // Errores de autenticación (401)
  UNAUTHORIZED: 'UNAUTHORIZED',
  INVALID_TOKEN: 'INVALID_TOKEN',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/**
 * Mapeo de códigos de error a HTTP status codes
 */
export const ErrorHttpStatus: Record<ErrorCode, number> = {
  // 400 Bad Request
  [ErrorCodes.INVALID_ZPL]: 400,
  [ErrorCodes.INVALID_LABEL_SIZE]: 400,
  [ErrorCodes.INVALID_INPUT]: 400,
  [ErrorCodes.NO_FILES]: 400,
  [ErrorCodes.LABEL_LIMIT_EXCEEDED]: 400,
  [ErrorCodes.BATCH_PROCESSING]: 400,
  [ErrorCodes.JOB_NOT_COMPLETE]: 400,

  // 401 Unauthorized
  [ErrorCodes.UNAUTHORIZED]: 401,
  [ErrorCodes.INVALID_TOKEN]: 401,

  // 403 Forbidden
  [ErrorCodes.MONTHLY_LIMIT_EXCEEDED]: 403,
  [ErrorCodes.BATCH_LIMIT_EXCEEDED]: 403,
  [ErrorCodes.IMAGE_FORMAT_PRO_ONLY]: 403,
  [ErrorCodes.BATCH_NOT_ALLOWED]: 403,
  [ErrorCodes.ACCESS_DENIED]: 403,

  // 404 Not Found
  [ErrorCodes.JOB_NOT_FOUND]: 404,
  [ErrorCodes.BATCH_NOT_FOUND]: 404,
  [ErrorCodes.USER_NOT_FOUND]: 404,
  [ErrorCodes.DOWNLOAD_NOT_AVAILABLE]: 404,

  // 410 Gone
  [ErrorCodes.JOB_EXPIRED]: 410,

  // 413 Payload Too Large
  [ErrorCodes.FILE_TOO_LARGE]: 413,

  // 500 Internal Server Error
  [ErrorCodes.SERVER_ERROR]: 500,

  // 503 Service Unavailable
  [ErrorCodes.SERVICE_UNAVAILABLE]: 503,

  // 504 Gateway Timeout
  [ErrorCodes.PROCESSING_TIMEOUT]: 504,
};

/**
 * Mensajes de error en español
 */
export const ErrorMessagesEs: Record<ErrorCode, string> = {
  [ErrorCodes.INVALID_ZPL]: 'El código ZPL contiene errores de sintaxis',
  [ErrorCodes.INVALID_LABEL_SIZE]: 'El tamaño de etiqueta no es válido',
  [ErrorCodes.INVALID_INPUT]: 'Los datos de entrada no son válidos',
  [ErrorCodes.NO_FILES]: 'Se requiere al menos un archivo',
  [ErrorCodes.LABEL_LIMIT_EXCEEDED]: 'Se excedió el límite de etiquetas por PDF',
  [ErrorCodes.MONTHLY_LIMIT_EXCEEDED]: 'Se agotó la cuota mensual de conversiones',
  [ErrorCodes.BATCH_LIMIT_EXCEEDED]: 'Se excedió el límite de archivos por batch',
  [ErrorCodes.FILE_TOO_LARGE]: 'El archivo excede el tamaño máximo permitido',
  [ErrorCodes.IMAGE_FORMAT_PRO_ONLY]: 'El formato de imagen seleccionado requiere plan Pro',
  [ErrorCodes.BATCH_NOT_ALLOWED]: 'El procesamiento batch requiere plan Pro',
  [ErrorCodes.ACCESS_DENIED]: 'No tienes acceso a este recurso',
  [ErrorCodes.JOB_NOT_FOUND]: 'Trabajo no encontrado',
  [ErrorCodes.JOB_EXPIRED]: 'El trabajo ha expirado y ya no está disponible',
  [ErrorCodes.BATCH_NOT_FOUND]: 'Batch no encontrado',
  [ErrorCodes.USER_NOT_FOUND]: 'Usuario no encontrado',
  [ErrorCodes.DOWNLOAD_NOT_AVAILABLE]: 'No hay archivos disponibles para descargar',
  [ErrorCodes.BATCH_PROCESSING]: 'El batch aún está procesándose',
  [ErrorCodes.JOB_NOT_COMPLETE]: 'La conversión no está completa',
  [ErrorCodes.SERVER_ERROR]: 'Error interno del servidor',
  [ErrorCodes.SERVICE_UNAVAILABLE]: 'Servicio temporalmente no disponible',
  [ErrorCodes.PROCESSING_TIMEOUT]: 'La conversión tomó demasiado tiempo',
  [ErrorCodes.UNAUTHORIZED]: 'Autenticación requerida',
  [ErrorCodes.INVALID_TOKEN]: 'Token de acceso inválido o expirado',
};

/**
 * Mensajes de error en inglés
 */
export const ErrorMessagesEn: Record<ErrorCode, string> = {
  [ErrorCodes.INVALID_ZPL]: 'ZPL code contains syntax errors',
  [ErrorCodes.INVALID_LABEL_SIZE]: 'Label size is not valid',
  [ErrorCodes.INVALID_INPUT]: 'Invalid input data',
  [ErrorCodes.NO_FILES]: 'At least one file is required',
  [ErrorCodes.LABEL_LIMIT_EXCEEDED]: 'Label limit per PDF exceeded',
  [ErrorCodes.MONTHLY_LIMIT_EXCEEDED]: 'Monthly conversion quota exhausted',
  [ErrorCodes.BATCH_LIMIT_EXCEEDED]: 'Batch file limit exceeded',
  [ErrorCodes.FILE_TOO_LARGE]: 'File exceeds maximum allowed size',
  [ErrorCodes.IMAGE_FORMAT_PRO_ONLY]: 'Selected image format requires Pro plan',
  [ErrorCodes.BATCH_NOT_ALLOWED]: 'Batch processing requires Pro plan',
  [ErrorCodes.ACCESS_DENIED]: 'Access denied to this resource',
  [ErrorCodes.JOB_NOT_FOUND]: 'Job not found',
  [ErrorCodes.JOB_EXPIRED]: 'Job has expired and is no longer available',
  [ErrorCodes.BATCH_NOT_FOUND]: 'Batch not found',
  [ErrorCodes.USER_NOT_FOUND]: 'User not found',
  [ErrorCodes.DOWNLOAD_NOT_AVAILABLE]: 'No files available for download',
  [ErrorCodes.BATCH_PROCESSING]: 'Batch is still processing',
  [ErrorCodes.JOB_NOT_COMPLETE]: 'Conversion is not complete',
  [ErrorCodes.SERVER_ERROR]: 'Internal server error',
  [ErrorCodes.SERVICE_UNAVAILABLE]: 'Service temporarily unavailable',
  [ErrorCodes.PROCESSING_TIMEOUT]: 'Conversion took too long',
  [ErrorCodes.UNAUTHORIZED]: 'Authentication required',
  [ErrorCodes.INVALID_TOKEN]: 'Invalid or expired access token',
};

/**
 * Obtiene el mensaje de error según el idioma
 */
export function getErrorMessage(code: ErrorCode, language: 'es' | 'en' = 'es'): string {
  return language === 'es' ? ErrorMessagesEs[code] : ErrorMessagesEn[code];
}
