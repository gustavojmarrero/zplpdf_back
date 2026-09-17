import {
  inferDelimiter,
  isEmptyRecord,
  parseDelimitedText,
  stripBom,
} from './csv.js';

describe('parseDelimitedText', () => {
  it('conserva los ceros iniciales: nunca pasa por Number()', () => {
    const { records } = parseDelimitedText('sku\n00751\n0\n007.50\n', ',');
    expect(records.map((record) => record.values[0])).toEqual([
      'sku',
      '00751',
      '0',
      '007.50',
    ]);
  });

  it('conserva acentos y elimina el BOM', () => {
    const { records } = parseDelimitedText('﻿nombre\nCafé Ñoño\n', ',');
    expect(records[0].values[0]).toBe('nombre');
    expect(records[1].values[0]).toBe('Café Ñoño');
  });

  it('respeta las comillas, los delimitadores dentro del campo y las comillas escapadas', () => {
    const { records } = parseDelimitedText(
      'a,b\n"uno, dos","con ""comillas"""\n',
      ',',
    );
    expect(records[1].values).toEqual(['uno, dos', 'con "comillas"']);
  });

  it('admite saltos de línea dentro de un campo entrecomillado', () => {
    const { records } = parseDelimitedText('a\n"linea1\nlinea2"\n', ',');
    expect(records).toHaveLength(2);
    expect(records[1].values[0]).toBe('linea1\nlinea2');
  });

  it('trata CRLF, LF y CR suelto como fin de registro', () => {
    expect(parseDelimitedText('a\r\nb\nc\rd\n', ',').records).toHaveLength(4);
  });

  it('cierra el último registro aunque no acabe en salto de línea', () => {
    const { records } = parseDelimitedText('a,b\n1,2', ',');
    expect(records).toHaveLength(2);
    expect(records[1].values).toEqual(['1', '2']);
  });

  it('reconoce los registros vacíos sin descartarlos por su cuenta', () => {
    const { records } = parseDelimitedText('a,b\n,\n1,2\n', ',');
    expect(records).toHaveLength(3);
    expect(isEmptyRecord(records[1])).toBe(true);
    expect(isEmptyRecord(records[2])).toBe(false);
  });

  it('funciona con punto y coma y con tabulador', () => {
    expect(parseDelimitedText('a;b\n1;2\n', ';').records[1].values).toEqual([
      '1',
      '2',
    ]);
    expect(parseDelimitedText('a\tb\n1\t2\n', '\t').records[1].values).toEqual([
      '1',
      '2',
    ]);
  });

  it('numera la primera línea física de cada registro', () => {
    const { records } = parseDelimitedText('a\n"x\ny"\nz\n', ',');
    expect(records.map((record) => record.line)).toEqual([1, 2, 4]);
  });
});

describe('inferDelimiter', () => {
  it('lo deduce cuando solo un candidato parte la cabecera', () => {
    expect(inferDelimiter('sku,nombre,precio\n1,2,3')).toBe(',');
    expect(inferDelimiter('sku;nombre;precio\n1;2;3')).toBe(';');
    expect(inferDelimiter('sku\tnombre\n1\t2')).toBe('\t');
  });

  it('devuelve null cuando es ambiguo o cuando no hay ninguno', () => {
    // Coma y punto y coma partirían la cabecera: elegir sería adivinar.
    expect(inferDelimiter('sku,nombre;precio\n')).toBeNull();
    expect(inferDelimiter('sku\n1\n')).toBeNull();
  });
});

describe('stripBom', () => {
  it('solo quita el BOM inicial', () => {
    expect(stripBom('﻿abc')).toBe('abc');
    expect(stripBom('abc')).toBe('abc');
  });
});
