export interface ConversionHistory {
  /**
   * Doc id de `conversion_history`. Opcional porque al guardar aún no existe:
   * lo asigna Firestore. Al leer siempre viene informado — es la clave con la
   * que el frontend borra la fila o recupera su ZPL.
   */
  id?: string;
  userId: string;
  jobId: string;
  labelCount: number;
  labelSize: string;
  status: 'completed' | 'failed';
  outputFormat: 'pdf' | 'png' | 'jpeg';
  fileUrl?: string;
  createdAt: Date;
  /**
   * Si el ZPL original sigue dentro de la ventana de retención y, por tanto,
   * la fila admite "reconvertir". Se deriva de la edad del registro para no
   * pagar una lectura por fila; ver ZPL_RETENTION_DAYS.
   */
  canReconvert?: boolean;
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
 * Se usa para calcular `canReconvert` sin tocar Storage. El borrado real lo
 * ejecuta GCS de forma asíncrona (puede tardar hasta 24h más), de modo que el
 * flag peca de conservador: un ZPL marcado como no reconvertible puede seguir
 * existiendo un rato, nunca al revés.
 */
export const ZPL_RETENTION_DAYS = 15;
