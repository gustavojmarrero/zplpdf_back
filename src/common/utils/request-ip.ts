/**
 * Identidades de red de una request, para rate limiting.
 *
 * Detras de Cloud Run el `X-Forwarded-For` que ve la app tiene esta forma:
 *
 *     X-Forwarded-For: <lo que mando el cliente>, <IP real del peer>
 *
 * La infraestructura de Google AÑADE la IP del peer TCP al final de lo que
 * llegue; nunca lo reemplaza. Eso parte la cabecera en dos mitades con
 * garantias muy distintas, y el rate limit publico usa las dos.
 */

interface RequestWithIp {
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
  ip?: string;
}

/**
 * Saltos de infraestructura al final del `X-Forwarded-For`. Con el domain
 * mapping de Cloud Run (api.zplpdf.com -> ghs.googlehosted.com) solo hay uno:
 * la IP del peer. Si algun dia se mete un balanceador o Cloud Armor delante,
 * este numero sube — si no, el tracker acabaria agrupando TODO el trafico en la
 * IP del balanceador y devolviendo 429 a todo el mundo.
 */
const TRUSTED_HOPS = 1;

function parseForwardedFor(req: RequestWithIp): string[] {
  const raw = req.headers?.['x-forwarded-for'];
  const value = Array.isArray(raw) ? raw.join(',') : raw;
  return (value ?? '')
    .split(',')
    .map((ip) => ip.trim())
    .filter(Boolean);
}

/**
 * IP del salto de confianza: la que añade la infraestructura al final del
 * `X-Forwarded-For`, es decir quien abrio la conexion de verdad (el edge de
 * Vercel para el trafico del frontend, o el propio cliente si llama directo al
 * servicio de Cloud Run).
 *
 * **No es falsificable**: lo que el cliente invente queda ANTES en la cabecera.
 * Por eso es la identidad con la que se pone el tope agregado que protege el
 * techo compartido de Labelary.
 */
export function getTrustedHopIp(req: RequestWithIp): string {
  const chain = parseForwardedFor(req);
  return (
    chain[chain.length - TRUSTED_HOPS] ??
    req.socket?.remoteAddress ??
    req.ip ??
    'unknown'
  );
}

/**
 * IP que el cliente dice tener: la primera entrada del `X-Forwarded-For`, que
 * detras del rewrite del frontend es la del visitante.
 *
 * Sirve para SEGMENTAR (que un visitante no gaste la cuota de los demas que
 * comparten edge), nunca como unico tope: quien llame directo al servicio de
 * Cloud Run puede inventarse una distinta en cada peticion y estrenar contador.
 * Siempre acompañada de un tope sobre `getTrustedHopIp`.
 */
export function getClientDeclaredIp(req: RequestWithIp): string {
  const chain = parseForwardedFor(req);
  return chain[0] ?? req.socket?.remoteAddress ?? req.ip ?? 'unknown';
}
