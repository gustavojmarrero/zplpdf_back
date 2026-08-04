import type { CfdiErrorCode } from '../../modules/facturama/facturama.constants.js';

/**
 * Estado del CFDI tal como lo pinta la UI.
 *
 * `not_applicable` y `null` se tratan igual en el frontend, pero se distinguen
 * en el backend: `not_applicable` es «este cobro no lleva CFDI y ya se evaluó»,
 * mientras que `null` es «no hay registro».
 */
export type CfdiStatus = 'pending' | 'stamped' | 'failed' | 'canceled';

/**
 * Documento de la colección `cfdis`.
 *
 * El docId es el `stripeInvoiceId`, y ahí está la idempotencia: Stripe reintenta
 * los webhooks, y un CFDI duplicado no se borra, se cancela a mano ante el SAT.
 * Con el id de la factura como clave del documento, el segundo intento choca
 * contra el propio Firestore en vez de contra una comprobación de aplicación que
 * dos webhooks simultáneos podrían pasar a la vez.
 */
export interface Cfdi {
  stripeInvoiceId: string;
  userId: string;
  status: CfdiStatus;

  /** Folio fiscal que asigna el SAT. Solo cuando `status: 'stamped'`. */
  uuid?: string | null;
  /** Id del comprobante dentro de Facturama, necesario para descargar y cancelar. */
  facturamaId?: string | null;

  /** Rutas en Cloud Storage. Las URLs firmadas se generan al leer. */
  pdfPath?: string | null;
  xmlPath?: string | null;

  /** Total cobrado, en la unidad de la moneda (no centavos). */
  amount: number;
  currency: string;

  error?: { code: CfdiErrorCode; message: string } | null;
  /** Intentos de timbrado, incluidos los reintentos manuales del usuario. */
  attempts: number;

  stampedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Resultado de tomar un CFDI para timbrarlo.
 *
 * Lleva los intentos acumulados para que quien lo obtiene no tenga que releer el
 * documento: en ese momento ya está en `pending`, y un fallo de lectura posterior
 * lo dejaría clavado ahí, bloqueando cualquier reintento futuro.
 *
 * El discriminante es texto y no un booleano porque el proyecto compila con
 * `strictNullChecks: false`, y sin esa opción TypeScript no estrecha uniones
 * discriminadas por literales booleanos.
 */
export type CfdiClaim =
  | { outcome: 'granted'; attempts: number }
  | { outcome: 'blocked'; blockedBy: CfdiStatus };
