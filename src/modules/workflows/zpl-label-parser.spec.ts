import {
  buildExportZpl,
  buildLabelId,
  parseZplLabels,
} from './zpl-label-parser.js';

const LABEL_A = '^XA^FO20,20^A0N,30^FDPEDIDO-001^FS^XZ';
const LABEL_B = '^XA^FO20,20^A0N,30^FDPEDIDO-002^FS^XZ';

describe('parseZplLabels', () => {
  it('conserva el orden y no deduplica repeticiones legítimas', () => {
    const labels = parseZplLabels(`${LABEL_A}\n${LABEL_B}\n${LABEL_A}`);

    expect(labels).toHaveLength(3);
    expect(labels.map((label) => label.sequence)).toEqual([1, 2, 3]);
    expect(labels[0].fields.fd1).toBe('PEDIDO-001');
    expect(labels[1].fields.fd1).toBe('PEDIDO-002');
    // Dos bloques idénticos siguen siendo dos etiquetas, con el mismo grupo.
    expect(labels[0].groupId).toBe(labels[2].groupId);
    expect(
      buildLabelId('wf_1', labels[0].sequence, labels[0].contentHash),
    ).not.toBe(buildLabelId('wf_1', labels[2].sequence, labels[2].contentHash));
  });

  it('preserva las copias declaradas por ^PQ y las saca del contenido', () => {
    const labels = parseZplLabels(
      '^XA^FO10,10^FDCAJA^FS^PQ3^XZ' + '^XA^FO10,10^FDSUELTA^FS^XZ',
    );

    expect(labels[0].copies).toBe(3);
    expect(labels[0].zpl).not.toContain('^PQ');
    expect(labels[1].copies).toBe(1);
  });

  it('descarta bloques de pura configuración, que no producen página', () => {
    const labels = parseZplLabels(`^XA^CI28^LH0,0^XZ${LABEL_A}`);

    expect(labels).toHaveLength(1);
    expect(labels[0].fields.fd1).toBe('PEDIDO-001');
  });

  it('agrupa el mismo contenido llegue con CRLF o con LF', () => {
    const [flat] = parseZplLabels(LABEL_A);
    const [crlf] = parseZplLabels(
      '^XA\r\n^FO20,20^A0N,30\r\n^FDPEDIDO-001^FS\r\n^XZ',
    );
    const [lf] = parseZplLabels('^XA\n^FO20,20^A0N,30\n^FDPEDIDO-001^FS\n^XZ');

    expect(crlf.contentHash).toBe(flat.contentHash);
    expect(lf.contentHash).toBe(flat.contentHash);
  });

  it('la indentación sí cuenta como contenido distinto, igual que en el conversor', () => {
    // No es un descuido: la normalización es la misma que usa ZplService para
    // deduplicar, y allí los espacios se colapsan pero no desaparecen. Si aquí
    // se agrupara de otra forma, el recuento del lote y el del PDF divergirían.
    const [flat] = parseZplLabels(LABEL_A);
    const [indented] = parseZplLabels(
      '^XA\n  ^FO20,20^A0N,30\n  ^FDPEDIDO-001^FS\n^XZ',
    );

    expect(indented.contentHash).not.toBe(flat.contentHash);
  });

  it('devuelve [] cuando no hay bloques ZPL', () => {
    expect(parseZplLabels('esto no es zpl')).toEqual([]);
  });
});

describe('buildLabelId', () => {
  it('es estable frente al reordenado: depende de la posición original', () => {
    const labels = parseZplLabels(`${LABEL_A}${LABEL_B}`);
    const first = buildLabelId(
      'wf_x',
      labels[0].sequence,
      labels[0].contentHash,
    );
    const again = buildLabelId(
      'wf_x',
      labels[0].sequence,
      labels[0].contentHash,
    );

    expect(first).toBe(again);
    expect(first).not.toBe(
      buildLabelId('wf_y', labels[0].sequence, labels[0].contentHash),
    );
  });
});

describe('buildExportZpl', () => {
  it('devuelve ^PQ solo cuando hay más de una copia', () => {
    const zpl = buildExportZpl([
      { zpl: '^XA^FDA^FS^XZ', copies: 2 },
      { zpl: '^XA^FDB^FS^XZ', copies: 1 },
    ]);

    expect(zpl).toContain('^XA^FDA^FS^PQ2^XZ');
    expect(zpl).toContain('^XA^FDB^FS^XZ');
    expect(zpl.match(/\^PQ/g)).toHaveLength(1);
  });

  it('sobrevive el viaje de ida y vuelta: las copias se vuelven a leer igual', () => {
    const original = parseZplLabels('^XA^FDUNO^FS^PQ4^XZ^XA^FDDOS^FS^PQ2^XZ');
    const reparsed = parseZplLabels(buildExportZpl(original));

    expect(reparsed.map((label) => label.copies)).toEqual([4, 2]);
    expect(reparsed.map((label) => label.fields.fd1)).toEqual(['UNO', 'DOS']);
  });
});
