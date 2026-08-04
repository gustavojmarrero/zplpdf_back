/**
 * Perfil fiscal del usuario.
 *
 * Sostiene dos flujos distintos según el país:
 *
 * - **México (`mx`)** — datos del receptor de un CFDI 4.0. Alimentan el timbrado
 *   automático tras cada cobro.
 * - **Resto del mundo (`international`)** — datos que se propagan al customer de
 *   Stripe para que salgan impresos en el PDF que Stripe ya genera. No hay
 *   timbrado ni PAC involucrado.
 *
 * El `type` lo decide el backend a partir de `user.country`, nunca el cliente:
 * si el frontend pudiera elegirlo, un usuario mexicano podría saltarse el CFDI
 * declarándose internacional.
 */

export type TaxProfileType = 'mx' | 'international';

/** Persona física (RFC de 13) o moral (RFC de 12), según el catálogo del SAT. */
export type SatPersonType = 'natural' | 'moral';

export interface TaxProfileAddress {
  line1: string;
  line2?: string | null;
  city: string;
  state?: string | null;
  postalCode: string;
  /** ISO 3166-1 alpha-2 */
  country: string;
}

/**
 * Documento de la colección `tax_profiles` (docId = userId).
 *
 * Vive aparte de `users` porque el doc de usuario se lee en casi cada request y
 * el perfil fiscal solo hace falta en billing y al timbrar.
 */
export interface TaxProfile {
  userId: string;
  type: TaxProfileType;
  /** País que dio origen al `type`. Se guarda para detectar cambios posteriores. */
  country: string;

  // ---- México ----
  /** 12 caracteres (moral) o 13 (física). Siempre en mayúsculas. */
  rfc?: string;
  /** Clave de c_RegimenFiscal. */
  taxRegime?: string;
  /** Clave de c_UsoCFDI. */
  cfdiUse?: string;

  // ---- Comunes ----
  /** Razón social SIN régimen de capital (lo exige CFDI 4.0). */
  legalName?: string;
  /** Domicilio fiscal del receptor. En MX son los 5 dígitos del CP. */
  postalCode?: string;
  billingEmail?: string;

  // ---- Internacional ----
  /** Tipo de tax ID de Stripe: 'eu_vat', 'br_cnpj', 'gb_vat', ... */
  taxIdType?: string | null;
  taxIdValue?: string | null;
  address?: TaxProfileAddress | null;

  // ---- Trazabilidad ----
  /** Id del cliente en Facturama, una vez dado de alta. Solo perfiles MX. */
  facturamaClientId?: string;
  /** Id del tax ID creado en Stripe, para poder reemplazarlo al cambiar. */
  stripeTaxIdId?: string | null;
  isComplete: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Tipos de tax ID que admite Stripe en `customers.createTaxId`.
 *
 * Se valida contra esta lista antes de guardar porque el valor acaba en un cast
 * al enum de Stripe: uno inválido se persistía como perfil completo, la
 * propagación fallaba en silencio y el usuario se topaba con un 503 genérico en
 * su siguiente intento de pago, sin saber que el problema era el campo que él
 * mismo eligió.
 *
 * Extraída de los tipos de `stripe@20`. Se excluye `unknown`, que Stripe acepta
 * pero no identifica a nadie.
 */
export const STRIPE_TAX_ID_TYPES: readonly string[] = [
  'ad_nrt',
  'ae_trn',
  'al_tin',
  'am_tin',
  'ao_tin',
  'ar_cuit',
  'au_abn',
  'au_arn',
  'aw_tin',
  'az_tin',
  'ba_tin',
  'bb_tin',
  'bd_bin',
  'bf_ifu',
  'bg_uic',
  'bh_vat',
  'bj_ifu',
  'bo_tin',
  'br_cnpj',
  'br_cpf',
  'bs_tin',
  'by_tin',
  'ca_bn',
  'ca_gst_hst',
  'ca_pst_bc',
  'ca_pst_mb',
  'ca_pst_sk',
  'ca_qst',
  'cd_nif',
  'ch_uid',
  'ch_vat',
  'cl_tin',
  'cm_niu',
  'cn_tin',
  'co_nit',
  'cr_tin',
  'cv_nif',
  'de_stn',
  'do_rcn',
  'ec_ruc',
  'eg_tin',
  'es_cif',
  'et_tin',
  'eu_oss_vat',
  'eu_vat',
  'gb_vat',
  'ge_vat',
  'gn_nif',
  'hk_br',
  'hr_oib',
  'hu_tin',
  'id_npwp',
  'il_vat',
  'in_gst',
  'is_vat',
  'jp_cn',
  'jp_rn',
  'jp_trn',
  'ke_pin',
  'kg_tin',
  'kh_tin',
  'kr_brn',
  'kz_bin',
  'la_tin',
  'li_uid',
  'li_vat',
  'ma_vat',
  'md_vat',
  'me_pib',
  'mk_vat',
  'mr_nif',
  'mx_rfc',
  'my_frp',
  'my_itn',
  'my_sst',
  'ng_tin',
  'no_vat',
  'no_voec',
  'np_pan',
  'nz_gst',
  'om_vat',
  'pe_ruc',
  'ph_tin',
  'ro_tin',
  'rs_pib',
  'ru_inn',
  'ru_kpp',
  'sa_vat',
  'sg_gst',
  'sg_uen',
  'si_tin',
  'sn_ninea',
  'sr_fin',
  'sv_nit',
  'th_vat',
  'tj_tin',
  'tr_tin',
  'tw_vat',
  'tz_vat',
  'ua_vat',
  'ug_tin',
  'us_ein',
  'uy_ruc',
  'uz_tin',
  'uz_vat',
  've_rif',
  'vn_tin',
  'za_vat',
  'zm_tin',
  'zw_tin',
];

/**
 * RFC según el SAT: 3 letras (moral) o 4 (física), fecha AAMMDD y homoclave.
 * La Ñ y el & son válidos en la raíz.
 */
export const RFC_REGEX = /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/;

/** RFC genérico para operaciones con público en general. No factura a un cliente. */
export const RFC_PUBLICO_GENERAL = 'XAXX010101000';

/** RFC genérico para residentes en el extranjero. */
export const RFC_EXTRANJERO = 'XEXX010101000';

/**
 * c_RegimenFiscal, con la aplicabilidad por tipo de persona que publica el SAT.
 *
 * Se lleva embebido en vez de consultarlo al PAC en cada `PUT`: es un catálogo
 * que cambia como mucho una vez al año y no justifica una llamada de red —ni un
 * fallo de validación cuando Facturama esté caído— en la ruta de guardado.
 */
export const SAT_FISCAL_REGIMES: Record<
  string,
  { name: string; natural: boolean; moral: boolean }
> = {
  '601': {
    name: 'General de Ley Personas Morales',
    natural: false,
    moral: true,
  },
  '603': {
    name: 'Personas Morales con Fines no Lucrativos',
    natural: false,
    moral: true,
  },
  '605': {
    name: 'Sueldos y Salarios e Ingresos Asimilados a Salarios',
    natural: true,
    moral: false,
  },
  '606': { name: 'Arrendamiento', natural: true, moral: false },
  '607': {
    name: 'Régimen de Enajenación o Adquisición de Bienes',
    natural: true,
    moral: false,
  },
  '608': { name: 'Demás ingresos', natural: true, moral: false },
  '610': {
    name: 'Residentes en el Extranjero sin Establecimiento Permanente en México',
    natural: true,
    moral: true,
  },
  '611': {
    name: 'Ingresos por Dividendos (socios y accionistas)',
    natural: true,
    moral: false,
  },
  '612': {
    name: 'Personas Físicas con Actividades Empresariales y Profesionales',
    natural: true,
    moral: false,
  },
  '614': { name: 'Ingresos por intereses', natural: true, moral: false },
  '615': {
    name: 'Régimen de los ingresos por obtención de premios',
    natural: true,
    moral: false,
  },
  '616': { name: 'Sin obligaciones fiscales', natural: true, moral: false },
  '620': {
    name: 'Sociedades Cooperativas de Producción que optan por diferir sus ingresos',
    natural: false,
    moral: true,
  },
  '621': { name: 'Incorporación Fiscal', natural: true, moral: false },
  '622': {
    name: 'Actividades Agrícolas, Ganaderas, Silvícolas y Pesqueras',
    natural: false,
    moral: true,
  },
  '623': {
    name: 'Opcional para Grupos de Sociedades',
    natural: false,
    moral: true,
  },
  '624': { name: 'Coordinados', natural: false, moral: true },
  '625': {
    name: 'Régimen de las Actividades Empresariales con ingresos a través de Plataformas Tecnológicas',
    natural: true,
    moral: false,
  },
  '626': {
    name: 'Régimen Simplificado de Confianza',
    natural: true,
    moral: true,
  },
};

/**
 * c_UsoCFDI, con la aplicabilidad por tipo de persona.
 *
 * Los deducibles personales (D01–D10) y la nómina (CN01) solo los puede usar una
 * persona física; el resto sirve a ambas.
 */
export const SAT_CFDI_USES: Record<
  string,
  { name: string; natural: boolean; moral: boolean }
> = {
  G01: { name: 'Adquisición de mercancías', natural: true, moral: true },
  G02: {
    name: 'Devoluciones, descuentos o bonificaciones',
    natural: true,
    moral: true,
  },
  G03: { name: 'Gastos en general', natural: true, moral: true },
  I01: { name: 'Construcciones', natural: true, moral: true },
  I02: {
    name: 'Mobiliario y equipo de oficina por inversiones',
    natural: true,
    moral: true,
  },
  I03: { name: 'Equipo de transporte', natural: true, moral: true },
  I04: { name: 'Equipo de cómputo y accesorios', natural: true, moral: true },
  I05: {
    name: 'Dados, troqueles, moldes, matrices y herramental',
    natural: true,
    moral: true,
  },
  I06: { name: 'Comunicaciones telefónicas', natural: true, moral: true },
  I07: { name: 'Comunicaciones satelitales', natural: true, moral: true },
  I08: { name: 'Otra maquinaria y equipo', natural: true, moral: true },
  D01: {
    name: 'Honorarios médicos, dentales y gastos hospitalarios',
    natural: true,
    moral: false,
  },
  D02: {
    name: 'Gastos médicos por incapacidad o discapacidad',
    natural: true,
    moral: false,
  },
  D03: { name: 'Gastos funerales', natural: true, moral: false },
  D04: { name: 'Donativos', natural: true, moral: false },
  D05: {
    name: 'Intereses reales efectivamente pagados por créditos hipotecarios',
    natural: true,
    moral: false,
  },
  D06: { name: 'Aportaciones voluntarias al SAR', natural: true, moral: false },
  D07: {
    name: 'Primas por seguros de gastos médicos',
    natural: true,
    moral: false,
  },
  D08: {
    name: 'Gastos de transportación escolar obligatoria',
    natural: true,
    moral: false,
  },
  D09: {
    name: 'Depósitos en cuentas para el ahorro, primas que tengan como base planes de pensiones',
    natural: true,
    moral: false,
  },
  D10: {
    name: 'Pagos por servicios educativos (colegiaturas)',
    natural: true,
    moral: false,
  },
  S01: { name: 'Sin efectos fiscales', natural: true, moral: true },
  CP01: { name: 'Pagos', natural: true, moral: true },
  CN01: { name: 'Nómina', natural: true, moral: false },
};

/**
 * Deriva el tipo de persona de la longitud del RFC: 12 es moral, 13 es física.
 * Devuelve `null` si el RFC no tiene un largo válido.
 */
export function getSatPersonType(rfc: string): SatPersonType | null {
  const normalized = rfc?.trim().toUpperCase() ?? '';
  if (normalized.length === 12) return 'moral';
  if (normalized.length === 13) return 'natural';
  return null;
}

/** ¿El régimen aplica al tipo de persona que denota el RFC? */
export function isRegimeValidForPerson(
  taxRegime: string,
  person: SatPersonType,
): boolean {
  const regime = SAT_FISCAL_REGIMES[taxRegime];
  if (!regime) return false;
  return person === 'moral' ? regime.moral : regime.natural;
}

/** ¿El uso de CFDI aplica al tipo de persona que denota el RFC? */
export function isCfdiUseValidForPerson(
  cfdiUse: string,
  person: SatPersonType,
): boolean {
  const use = SAT_CFDI_USES[cfdiUse];
  if (!use) return false;
  return person === 'moral' ? use.moral : use.natural;
}
