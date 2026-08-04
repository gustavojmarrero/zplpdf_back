/**
 * Constantes del CFDI que emite ZPLPDF.
 *
 * El emisor (RFC, régimen y CSD) NO vive aquí: lo define la cuenta de Facturama
 * contra la que se autentica el servicio. La API web (`POST /3/cfdis`) toma el
 * emisor del certificado cargado en esa cuenta, así que cambiar de emisor es
 * cambiar de credenciales, no de código.
 */

/**
 * c_ClaveProdServ 43231510 — «Software para hacer etiquetas».
 *
 * Describe literalmente el producto: convertir ZPL (el lenguaje de etiquetas de
 * Zebra) a PDF. Es además la clave que ya se usa en la contabilidad del emisor,
 * así que el criterio se mantiene consistente.
 */
export const CFDI_PRODUCT_CODE = '43231510';

/** c_ClaveUnidad E48 — «Unidad de servicio». */
export const CFDI_UNIT_CODE = 'E48';
export const CFDI_UNIT_NAME = 'Unidad de servicio';

/** c_Impuesto 002 — IVA. Facturama lo espera por nombre. */
export const CFDI_TAX_NAME = 'IVA';
export const CFDI_TAX_RATE = 0.16;

/** c_ObjetoImp 02 — «Sí objeto de impuesto». */
export const CFDI_TAX_OBJECT = '02';

/** c_TipoDeComprobante I — Ingreso. */
export const CFDI_TYPE_INCOME = 'I';

/** c_Exportacion 01 — «No aplica». */
export const CFDI_EXPORTATION_NOT_APPLICABLE = '01';

/**
 * c_MetodoPago PUE — «Pago en una sola exhibición».
 *
 * El cobro con tarjeta se liquida en el acto, así que nunca es PPD y no hace
 * falta complemento de pago.
 */
export const CFDI_PAYMENT_METHOD_PUE = 'PUE';

/** c_FormaPago 04 — «Tarjeta de crédito». */
export const CFDI_PAYMENT_FORM_CREDIT_CARD = '04';

/** c_FormaPago 28 — «Tarjeta de débito». */
export const CFDI_PAYMENT_FORM_DEBIT_CARD = '28';

/**
 * Facturama rechaza un CFDI con fecha de expedición de más de 72 horas.
 *
 * Se usa para decidir si el comprobante lleva la fecha del cobro —lo deseable,
 * porque mantiene CFDI y cobro en el mismo mes cuando el cobro cae a fin de
 * mes— o la del momento del timbrado.
 */
export const CFDI_MAX_BACKDATE_MS = 72 * 60 * 60 * 1000;

/**
 * Códigos de error estables que consume el frontend.
 *
 * La app sirve en cuatro idiomas y el backend no conoce el del receptor, así que
 * el código es la fuente de verdad y la traducción vive en el cliente
 * (`src/lib/cfdi-errors.ts`). El `message` acompaña solo para logs y para que un
 * código nuevo degrade a texto sin traducir en vez de a un genérico inútil.
 */
export const CfdiErrorCodes = {
  RFC_NOT_FOUND: 'rfc_not_found',
  NAME_MISMATCH: 'name_mismatch',
  POSTAL_CODE_MISMATCH: 'postal_code_mismatch',
  REGIME_MISMATCH: 'regime_mismatch',
  CFDI_USE_INVALID: 'cfdi_use_invalid',
  PAC_UNAVAILABLE: 'pac_unavailable',
  INVOICE_NOT_STAMPABLE: 'invoice_not_stampable',
  UNKNOWN: 'unknown',
} as const;

export type CfdiErrorCode =
  (typeof CfdiErrorCodes)[keyof typeof CfdiErrorCodes];

/**
 * Traduce el rechazo del PAC a uno de los códigos estables.
 *
 * El emparejamiento va por texto y no solo por la clave `CFDI40xxx`: Facturama
 * antepone su propia validación a la del SAT y no siempre incluye la clave, así
 * que atarse a ella dejaría la mayoría de los rechazos en `unknown` —justo los
 * que el usuario puede corregir solo.
 */
export function mapPacErrorToCode(rawMessage: string): CfdiErrorCode {
  const message = (rawMessage || '').toLowerCase();

  const matches = (...needles: string[]): boolean =>
    needles.some((needle) => message.includes(needle));

  // El orden importa: un mensaje sobre el nombre del receptor también menciona
  // el RFC, así que las comprobaciones más específicas van primero.
  if (
    matches(
      'cfdi40158',
      'cfdi40157',
      'nombre del receptor',
      'razón social',
      'razon social',
    )
  ) {
    return CfdiErrorCodes.NAME_MISMATCH;
  }

  if (
    matches(
      'cfdi40161',
      'domiciliofiscalreceptor',
      'domicilio fiscal',
      'código postal',
      'codigo postal',
    )
  ) {
    return CfdiErrorCodes.POSTAL_CODE_MISMATCH;
  }

  // Antes que el régimen: un rechazo por uso de CFDI incompatible menciona
  // siempre el régimen —la incompatibilidad es justo entre ambos—, así que la
  // regla del régimen se lo tragaría y el usuario corregiría el campo que no es.
  if (matches('cfdi40163', 'usocfdi', 'uso del cfdi', 'uso de cfdi')) {
    return CfdiErrorCodes.CFDI_USE_INVALID;
  }

  if (
    matches(
      'cfdi40162',
      'regimenfiscalreceptor',
      'régimen fiscal',
      'regimen fiscal',
    )
  ) {
    return CfdiErrorCodes.REGIME_MISMATCH;
  }

  if (
    matches(
      'cfdi40147',
      'no se encuentra en la lista de rfc',
      'no está en la lista de rfc',
      'no esta en la lista de rfc',
      'rfc no localizado',
      'rfc inválido',
      'rfc invalido',
      'rfc del receptor',
    )
  ) {
    return CfdiErrorCodes.RFC_NOT_FOUND;
  }

  return CfdiErrorCodes.UNKNOWN;
}
