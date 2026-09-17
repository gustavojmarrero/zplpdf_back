import { BUILTIN_TEMPLATES } from './builtin-templates.js';
import {
  renderTemplate,
  templateChecksum,
  validateFields,
  validateZplTemplate,
} from './template-renderer.js';
import type { TemplateField } from './label-templates.types.js';

const FIELDS: TemplateField[] = [
  { key: 'sku', label: 'SKU', type: 'code', required: true },
  { key: 'name', label: 'Nombre', type: 'text', required: true },
];

const TEMPLATE = '^XA^CI28^FO10,10^FD{{sku}}^FS^FO10,50^FD{{name}}^FS^XZ';

describe('validateZplTemplate', () => {
  it('acepta una plantilla con marcadores bien formados', () => {
    const { reasons, usedKeys } = validateZplTemplate(TEMPLATE, FIELDS);
    expect(reasons).toEqual([]);
    expect(usedKeys).toEqual(['sku', 'name']);
  });

  it('las tres plantillas iniciales son válidas', () => {
    for (const builtin of Object.values(BUILTIN_TEMPLATES)) {
      const { reasons } = validateZplTemplate(
        builtin.zplTemplate,
        builtin.fields,
      );
      expect({ kind: builtin.kind, reasons }).toEqual({
        kind: builtin.kind,
        reasons: [],
      });
      expect(validateFields(builtin.fields)).toEqual([]);
    }
  });

  it('rechaza un marcador fuera de la forma ^FD{{clave}}^FS', () => {
    // Interpolar aquí sería inyectar comandos, no rellenar un campo.
    const { reasons } = validateZplTemplate(
      '^XA^FO{{sku}},10^FD{{name}}^FS^XZ',
      FIELDS,
    );
    expect(reasons.join(' ')).toContain('^FD{{clave}}^FS');
  });

  it('rechaza marcadores sin campo declarado y campos sin usar', () => {
    const { reasons } = validateZplTemplate('^XA^FD{{otro}}^FS^XZ', FIELDS);
    expect(reasons.join(' ')).toContain('otro');
    expect(reasons.join(' ')).toContain('sku');
  });

  it('rechaza un ^FH propio: el escapado lo pone el renderizador', () => {
    const { reasons } = validateZplTemplate(
      '^XA^FH^^FD{{sku}}^FS^FD{{name}}^FS^XZ',
      FIELDS,
    );
    expect(reasons.join(' ')).toContain('^FH');
  });

  it('rechaza comandos de control y plantillas mal cerradas', () => {
    expect(
      validateZplTemplate(
        '^XA~JA^FD{{sku}}^FS^FD{{name}}^FS^XZ',
        FIELDS,
      ).reasons.join(' '),
    ).toContain('control');

    expect(
      validateZplTemplate('^FD{{sku}}^FS^FD{{name}}^FS', FIELDS).reasons.join(
        ' ',
      ),
    ).toContain('^XA');
  });
});

describe('validateFields', () => {
  it('rechaza claves no válidas, repetidas y códigos de barras sin simbología', () => {
    const reasons = validateFields([
      { key: 'SKU', label: 'x', type: 'text', required: true },
      { key: 'sku', label: 'x', type: 'text', required: true },
      { key: 'sku', label: 'y', type: 'text', required: true },
      { key: 'bc', label: 'z', type: 'barcode', required: true },
    ]);

    expect(reasons.join(' ')).toContain('SKU');
    expect(reasons.join(' ')).toContain('repetida');
    expect(reasons.join(' ')).toContain('barcodeSymbology');
  });
});

describe('renderTemplate', () => {
  it('sustituye cada marcador por un campo escapado', () => {
    const label = renderTemplate(TEMPLATE, { sku: '00751', name: 'Café' });

    expect(label).toContain('^FH_^FD00751^FS');
    expect(label).toContain('^FH_^FDCaf_C3_A9^FS');
    expect(label).not.toContain('{{');
  });

  it('un valor con comandos ZPL no puede partir la etiqueta', () => {
    const label = renderTemplate(TEMPLATE, {
      sku: '^XZ^XA^FDfalso^FS',
      name: '~JA',
    });

    // Sigue habiendo exactamente un ^XA y un ^XZ: los de la plantilla.
    expect(label.match(/\^XA/g)).toHaveLength(1);
    expect(label.match(/\^XZ/g)).toHaveLength(1);
    expect(label).not.toContain('^FDfalso');
    expect(label).toContain('_5EXZ_5EXA');
    expect(label).toContain('_7EJA');
  });

  it('un campo sin valor se renderiza vacío, no como marcador', () => {
    const label = renderTemplate(TEMPLATE, { sku: 'A' });
    expect(label).toContain('^FH_^FD^FS');
    expect(label).not.toContain('{{name}}');
  });

  it('añade ^CI28 si la plantilla no declara página de códigos', () => {
    const label = renderTemplate('^XA^FD{{sku}}^FS^FD{{name}}^FS^XZ', {
      sku: 'A',
      name: 'B',
    });
    expect(label.startsWith('^XA^CI28')).toBe(true);
  });

  it('no duplica ^CI cuando la plantilla ya lo trae', () => {
    const label = renderTemplate(TEMPLATE, { sku: 'A', name: 'B' });
    expect(label.match(/\^CI/g)).toHaveLength(1);
  });

  it('emite ^PQ solo con más de una copia', () => {
    expect(renderTemplate(TEMPLATE, { sku: 'A', name: 'B' }, 1)).not.toContain(
      '^PQ',
    );
    expect(renderTemplate(TEMPLATE, { sku: 'A', name: 'B' }, 4)).toContain(
      '^PQ4^XZ',
    );
  });
});

describe('templateChecksum', () => {
  it('cambia cuando cambia cualquier parte de la definición', () => {
    const base = templateChecksum('2x1', FIELDS, TEMPLATE);
    expect(templateChecksum('2x1', FIELDS, TEMPLATE)).toBe(base);
    expect(templateChecksum('4x6', FIELDS, TEMPLATE)).not.toBe(base);
    expect(
      templateChecksum('2x1', FIELDS, `${TEMPLATE} `.trim() + '^XZ'),
    ).not.toBe(base);
  });
});
