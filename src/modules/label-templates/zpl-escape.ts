/**
 * Escapado de datos de campo ZPL.
 *
 * El problema: dentro de `^FD…^FS` un `^` o un `~` abren un comando. Un valor
 * como `^XZ^XA^FDotra cosa` partiría la etiqueta en dos, y `~JA` cancelaría
 * trabajos en la impresora. Interpolar el valor en crudo —o filtrar caracteres
 * «peligrosos» a mano— es exactamente el agujero que hay que cerrar.
 *
 * La solución que da ZPL es `^FH`: declara un carácter indicador (aquí `_`) tras
 * el cual dos dígitos hexadecimales representan un byte literal. Así que el
 * campo se emite como `^FH_^FD<valor codificado>^FS` y **todo** byte que no sea
 * ASCII imprimible inofensivo viaja como `_XX`. Nada de lo que venga en el CSV
 * puede volver a interpretarse como comando.
 *
 * Los acentos viajan como sus bytes UTF-8 (`á` → `_C3_A1`), que es lo que la
 * impresora espera con `^CI28`.
 */
export const ZPL_HEX_INDICATOR = '_';

/** Caracteres ASCII imprimibles que NO se pueden dejar pasar tal cual. */
const UNSAFE_ASCII = new Set([
  0x5e, // ^  prefijo de comando de formato
  0x7e, // ~  prefijo de comando de control
  0x5f, // _  el propio indicador hexadecimal
  0x5c, // \  usado como escape en algunas variantes
  0x22, // "
]);

function isSafeByte(byte: number): boolean {
  return byte >= 0x20 && byte <= 0x7e && !UNSAFE_ASCII.has(byte);
}

export function escapeZplFieldData(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  let out = '';

  for (const byte of bytes) {
    out += isSafeByte(byte)
      ? String.fromCharCode(byte)
      : `${ZPL_HEX_INDICATOR}${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }

  return out;
}

/** Campo completo, listo para insertar en la plantilla. */
export function renderZplField(value: string): string {
  return `^FH${ZPL_HEX_INDICATOR}^FD${escapeZplFieldData(value)}^FS`;
}

/**
 * Comprobación de seguridad del resultado. No sustituye al escapado: es la red
 * que impide que un cambio futuro en `escapeZplFieldData` deje pasar un
 * comando sin que ninguna prueba se dé cuenta.
 */
export function containsZplCommandChars(rendered: string): boolean {
  return /[\^~]/.test(rendered);
}
