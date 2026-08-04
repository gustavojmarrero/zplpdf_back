import type { CfdiErrorCode } from '../facturama.constants.js';

/** Receptor del CFDI, tal como lo espera la API de Facturama. */
export interface FacturamaReceiver {
  Rfc: string;
  /** Razón social sin régimen de capital, en mayúsculas. */
  Name: string;
  /** c_UsoCFDI */
  CfdiUse: string;
  /** c_RegimenFiscal */
  FiscalRegime: string;
  /** CP del domicilio fiscal del receptor. */
  TaxZipCode: string;
}

export interface FacturamaItemTax {
  Total: string;
  Name: string;
  Base: string;
  Rate: string;
  IsRetention: boolean;
}

export interface FacturamaItem {
  ProductCode: string;
  Description: string;
  UnitCode: string;
  Unit: string;
  UnitPrice: string;
  Quantity: string;
  Subtotal: string;
  TaxObject: string;
  Taxes?: FacturamaItemTax[];
  Total: string;
}

export interface FacturamaCfdiRequest {
  Currency: string;
  CfdiType: string;
  ExpeditionPlace: string;
  Exportation: string;
  PaymentForm: string;
  PaymentMethod: string;
  /** ISO 8601 sin zona. Se omite para que Facturama use la hora del timbrado. */
  Date?: string;
  Receiver: FacturamaReceiver;
  Items: FacturamaItem[];
}

export interface FacturamaCfdiResponse {
  Id: string;
  Folio?: string;
  Serie?: string;
  Date?: string;
  Total?: number;
  Complement?: {
    TaxStamp?: {
      Uuid?: string;
      Date?: string;
      RfcProvCertif?: string;
    };
  };
}

/** Lo que necesita el servicio para construir un CFDI de suscripción. */
export interface StampSubscriptionParams {
  receiver: FacturamaReceiver;
  /** Total efectivamente cobrado, con IVA incluido, en unidades (no centavos). */
  total: number;
  currency: string;
  /** Texto del concepto, p. ej. «Suscripción ZPLPDF Plan PRO — 01/08/2026 a 31/08/2026». */
  description: string;
  /** c_FormaPago. Por defecto tarjeta de crédito. */
  paymentForm?: string;
  /** Fecha del cobro. Se usa si cae dentro de las 72 h que admite Facturama. */
  chargedAt?: Date;
}

/** Resultado de un timbrado, ya normalizado para persistir. */
export interface StampResult {
  facturamaId: string;
  uuid: string;
  stampedAt: Date;
}

/**
 * Error de Facturama ya traducido a un código estable.
 *
 * Se modela como clase para poder distinguirlo con `instanceof` de un fallo
 * cualquiera al capturarlo en el webhook.
 */
export class FacturamaError extends Error {
  constructor(
    readonly code: CfdiErrorCode,
    message: string,
    readonly raw?: unknown,
  ) {
    super(message);
    this.name = 'FacturamaError';
  }
}
