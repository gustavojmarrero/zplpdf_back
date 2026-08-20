/**
 * Extrae el path dentro del bucket de una URL firmada de Google Cloud Storage.
 *
 * Formato: `https://storage.googleapis.com/<bucket>/<path>?X-Goog-...`
 *
 * Devuelve `null` si la URL no tiene esa forma. El historial guarda la URL
 * firmada tal cual se generó, y las hay antiguas o vacías: quien llama decide
 * si eso es un error (no lo es al borrar una cuenta: sin path, no hay objeto
 * que borrar).
 */
export function extractStoragePathFromSignedUrl(
  signedUrl: string | undefined | null,
): string | null {
  if (!signedUrl) {
    return null;
  }

  const match = signedUrl.match(/googleapis\.com\/[^/]+\/([^?]+)/);
  return match ? match[1] : null;
}
