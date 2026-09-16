/**
 * Versión de texto plano de un correo HTML, para la parte `text/plain`.
 *
 * Antes solo se quitaban las etiquetas, y con ellas el `href` de cada enlace:
 * quien lee el texto plano veía «ajustes de tu cuenta» sin ninguna URL a la que
 * ir, incluido el enlace de baja (zplpdf_back#116). Ahora cada enlace se
 * convierte en «texto (URL)» antes de quitar el resto de etiquetas; si el texto
 * ya es la propia URL, no se duplica.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(
      /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_match, href: string, inner: string) => {
        const label = inner.replace(/<[^>]*>/g, '').trim();
        return !label || label === href ? href : `${label} (${href})`;
      },
    )
    .replace(
      /<\/?(?:br|p|div|li|ul|ol|tr|td|th|table|h[1-6]|section|header|footer|blockquote)\b[^>]*>/gi,
      ' ',
    )
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
