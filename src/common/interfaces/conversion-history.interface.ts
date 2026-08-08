export interface ConversionHistory {
  userId: string;
  jobId: string;
  labelCount: number;
  labelSize: string;
  status: 'completed' | 'failed';
  outputFormat: 'pdf' | 'png' | 'jpeg';
  fileUrl?: string;
  createdAt: Date;
}

/**
 * Registro de historial tal y como vive en Firestore: incluye el id del
 * documento, necesario para las acciones por fila del frontend.
 */
export interface ConversionHistoryRecord extends ConversionHistory {
  id: string;
}

/**
 * Días que sobrevive el ZPL original de una conversión.
 *
 * No es una decisión de la aplicación: la impone una regla de lifecycle del
 * bucket `zplpdf-app-files` que borra todo lo que cuelga del prefijo
 * `debug-zpl/` al cumplir 15 días. El código no puede consultar esa regla en
 * caliente, así que la refleja aquí; si algún día se cambia el lifecycle en
 * GCS, hay que cambiar también esta constante.
 *
 *   gsutil lifecycle get gs://zplpdf-app-files
 *
 * Acota la ventana de "reconvertir" (`canReconvert` en cada ítem del historial,
 * 410 en `GET /users/history/:id/zpl`). El borrado real lo ejecuta GCS de forma
 * asíncrona y puede tardar hasta 24h más, de modo que el flag peca de
 * conservador: un ZPL marcado como no reconvertible puede seguir existiendo un
 * rato, nunca al revés.
 */
export const ZPL_RETENTION_DAYS = 15;
