export enum OutputFormat {
  PDF = 'pdf',
  PNG = 'png',
  JPEG = 'jpeg',
}

/**
 * Traduce el formato guardado por el batch al enum que acepta la reconversión.
 *
 * El endpoint batch deja pasar strings libres y `processBatchFiles` solo trata
 * como PDF y PNG sus valores canónicos en minúsculas. Cualquier otro valor se
 * procesa como JPEG; por eso incluso `PDF` debe volver como JPEG, que es el
 * archivo que realmente produjo, mientras alias como `jpg` o `JPG` también
 * convergen en el valor canónico `jpeg`.
 */
export function normalizeOutputFormat(
  outputFormat: string | undefined,
): OutputFormat {
  if (outputFormat === OutputFormat.PDF) {
    return OutputFormat.PDF;
  }

  if (outputFormat === OutputFormat.PNG) {
    return OutputFormat.PNG;
  }

  return OutputFormat.JPEG;
}
