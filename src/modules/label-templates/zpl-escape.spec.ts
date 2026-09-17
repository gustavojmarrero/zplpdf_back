import {
  containsZplCommandChars,
  escapeZplFieldData,
  renderZplField,
} from './zpl-escape.js';

describe('escapeZplFieldData', () => {
  it('deja pasar el texto ASCII inofensivo tal cual', () => {
    expect(escapeZplFieldData('SKU-001 Caja 12x4')).toBe('SKU-001 Caja 12x4');
  });

  it('codifica el prefijo de comando de formato', () => {
    // Sin escapar, `^XZ^XA` cerraría la etiqueta y abriría otra.
    const escaped = escapeZplFieldData('^XZ^XA^FDotra^FS');
    expect(escaped).toBe('_5EXZ_5EXA_5EFDotra_5EFS');
    expect(containsZplCommandChars(escaped)).toBe(false);
  });

  it('codifica el prefijo de comando de control', () => {
    // `~JA` cancela todos los trabajos de la impresora.
    const escaped = escapeZplFieldData('~JA');
    expect(escaped).toBe('_7EJA');
    expect(containsZplCommandChars(escaped)).toBe(false);
  });

  it('codifica el propio indicador hexadecimal', () => {
    // Si `_` pasara literal, el valor podría inyectar sus propios bytes.
    expect(escapeZplFieldData('_5EXA')).toBe('_5F5EXA');
  });

  it('codifica la barra invertida y las comillas', () => {
    expect(escapeZplFieldData('a\\b"c')).toBe('a_5Cb_22c');
  });

  it('codifica los acentos como sus bytes UTF-8', () => {
    // Con ^CI28 la impresora los recompone; `á` es C3 A1 en UTF-8.
    expect(escapeZplFieldData('á')).toBe('_C3_A1');
    expect(escapeZplFieldData('Ñoño')).toBe('_C3_91o_C3_B1o');
  });

  it('codifica saltos de línea y caracteres de control', () => {
    expect(escapeZplFieldData('a\nb\tc')).toBe('a_0Ab_09c');
  });

  it('nunca deja un ^ o un ~ en la salida, con cualquier entrada', () => {
    const payloads = [
      '^',
      '~',
      '^^~~',
      '^FS^FD',
      '~DGR:X',
      '^XA'.repeat(50),
      String.fromCharCode(0, 1, 2, 30, 31, 127),
      '😀 emoji',
      'çüö ÄÖÜ',
    ];

    for (const payload of payloads) {
      expect(containsZplCommandChars(escapeZplFieldData(payload))).toBe(false);
    }
  });
});

describe('renderZplField', () => {
  it('declara el indicador hexadecimal y cierra el campo', () => {
    expect(renderZplField('ABC')).toBe('^FH_^FDABC^FS');
  });

  it('el valor inyectado queda dentro del campo, no como comando', () => {
    const field = renderZplField('^XZ');
    expect(field).toBe('^FH_^FD_5EXZ^FS');
    // Los únicos ^ del resultado son los del propio campo.
    expect(field.match(/\^/g)).toHaveLength(3);
  });
});
