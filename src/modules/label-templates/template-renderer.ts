import { createHash } from 'node:crypto';
import { TEMPLATE_LIMITS } from './label-templates.constants.js';
import { renderZplField, containsZplCommandChars } from './zpl-escape.js';
import type { TemplateField } from './label-templates.types.js';

const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const PLACEHOLDER = /\{\{([a-z][a-z0-9_]{0,39})\}\}/g;
/** Forma exacta que debe tener un marcador para poder escaparse con seguridad. */
const FIELD_MARKER = /\^FD\{\{([a-z][a-z0-9_]{0,39})\}\}\^FS/g;

export interface TemplateValidationResult {
  reasons: string[];
  usedKeys: string[];
}

export function templateChecksum(
  labelSize: string,
  fields: TemplateField[],
  zplTemplate: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ labelSize, fields, zplTemplate }), 'utf8')
    .digest('hex');
}

export function validateFields(fields: TemplateField[]): string[] {
  const reasons: string[] = [];

  if (!Array.isArray(fields) || fields.length === 0) {
    return ['La plantilla debe declarar al menos un campo'];
  }
  if (fields.length > TEMPLATE_LIMITS.maxFields) {
    reasons.push(`Máximo ${TEMPLATE_LIMITS.maxFields} campos`);
  }

  const seen = new Set<string>();
  for (const field of fields) {
    if (!FIELD_KEY_PATTERN.test(field.key ?? '')) {
      reasons.push(`Clave de campo no válida: ${field.key}`);
      continue;
    }
    if (seen.has(field.key)) {
      reasons.push(`Clave de campo repetida: ${field.key}`);
    }
    seen.add(field.key);

    if (field.type === 'barcode' && !field.barcodeSymbology) {
      reasons.push(`El campo ${field.key} debe declarar barcodeSymbology`);
    }
    if (field.maxLength !== undefined && field.maxLength <= 0) {
      reasons.push(`maxLength de ${field.key} debe ser positivo`);
    }
  }

  return reasons;
}

/**
 * Valida el ZPL de la plantilla.
 *
 * La regla clave es la forma del marcador: solo se admite `^FD{{clave}}^FS`
 * exacto, porque es lo que permite sustituir el bloque entero por un campo con
 * `^FH`. Un `{{clave}}` en cualquier otra posición se rechaza en vez de
 * interpolarse: interpolar fuera de un campo sería inyectar comandos.
 */
export function validateZplTemplate(
  zplTemplate: string,
  fields: TemplateField[],
): TemplateValidationResult {
  const reasons: string[] = [];
  const template = (zplTemplate ?? '').trim();

  if (!template) {
    return { reasons: ['La plantilla ZPL está vacía'], usedKeys: [] };
  }
  if (Buffer.byteLength(template, 'utf8') > TEMPLATE_LIMITS.maxZplBytes) {
    reasons.push(
      `La plantilla ZPL supera ${TEMPLATE_LIMITS.maxZplBytes} bytes`,
    );
  }
  if (!template.startsWith('^XA') || !template.endsWith('^XZ')) {
    reasons.push('La plantilla debe empezar por ^XA y terminar en ^XZ');
  }
  if (template.includes('~')) {
    // Los comandos de control (~JA, ~DG…) actúan sobre la impresora, no sobre
    // la etiqueta. Fuera del alcance de esta fase.
    reasons.push('La plantilla no admite comandos de control (~)');
  }
  if (/\^FH/i.test(template)) {
    // El escapado lo pone el renderizador; declararlo a mano cambiaría el
    // indicador hexadecimal y rompería el escapado de los valores.
    reasons.push('La plantilla no debe declarar ^FH: lo añade el renderizador');
  }

  const markers = [...template.matchAll(FIELD_MARKER)].map((m) => m[1]);
  const usedKeys = [...new Set(markers)];

  // Cualquier marcador que no esté en la forma exacta sobra al quitar los
  // válidos: si queda algo, es un `{{…}}` mal colocado.
  const withoutMarkers = template.replace(FIELD_MARKER, '');
  if (withoutMarkers.includes('{{') || withoutMarkers.includes('}}')) {
    const stray = [...withoutMarkers.matchAll(PLACEHOLDER)].map((m) => m[1]);
    reasons.push(
      `Los marcadores solo se admiten como ^FD{{clave}}^FS${
        stray.length ? ` (revisa: ${stray.join(', ')})` : ''
      }`,
    );
  }

  const declared = new Set(fields.map((field) => field.key));
  const undeclared = usedKeys.filter((key) => !declared.has(key));
  const unused = [...declared].filter((key) => !usedKeys.includes(key));

  if (undeclared.length > 0) {
    reasons.push(`Marcadores sin campo declarado: ${undeclared.join(', ')}`);
  }
  if (unused.length > 0) {
    reasons.push(`Campos declarados que no se usan: ${unused.join(', ')}`);
  }

  return { reasons, usedKeys };
}

/**
 * Sustituye cada marcador por su campo escapado y devuelve la etiqueta.
 *
 * Si la plantilla no declara `^CI` se le añade `^CI28` (UTF-8): sin él los
 * bytes hexadecimales de un acento se imprimirían como otro carácter.
 */
export function renderTemplate(
  zplTemplate: string,
  values: Record<string, string>,
  copies = 1,
): string {
  let label = zplTemplate
    .trim()
    .replace(FIELD_MARKER, (_match, key: string) =>
      renderZplField(values[key] ?? ''),
    );

  if (!/\^CI\d/i.test(label)) {
    label = label.replace(/^\^XA/, '^XA^CI28');
  }

  if (copies > 1) {
    label = label.replace(/\^XZ$/, `^PQ${copies}^XZ`);
  }

  return label;
}

/**
 * Comprueba que ningún valor haya conseguido colar un comando.
 *
 * Se ejecuta sobre cada etiqueta generada: el coste es una expresión regular
 * por campo y el beneficio es que una regresión en el escapado se detiene aquí
 * en vez de llegar a la impresora.
 */
export function assertNoInjection(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    const rendered = renderZplField(value);
    // El propio campo lleva ^FH/^FD/^FS; se comprueba solo el dato codificado.
    const payload = rendered.slice(rendered.indexOf('^FD') + 3, -3);
    if (containsZplCommandChars(payload)) {
      throw new Error(
        `El valor del campo ${key} no quedó escapado correctamente`,
      );
    }
  }
}
