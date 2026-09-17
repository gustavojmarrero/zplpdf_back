import { ZplService } from '../zpl/zpl.service.js';
import { buildExportZpl, parseZplLabels } from './zpl-label-parser.js';

/**
 * Paridad con el conversor.
 *
 * El lote replica la normalización de bloques de `ZplService` para que su
 * recuento y su orden coincidan con las páginas del PDF. Si esa normalización
 * cambia allí y no aquí, el lote diría «4 etiquetas» y el PDF traería otra
 * cosa: exactamente el fallo que el criterio de aceptación de F1 prohíbe.
 *
 * `countLabels` es la vía pública a esas reglas: usa `splitAndExtractCopies`,
 * que solo depende de funciones puras. Se instancia el prototipo sin pasar por
 * el constructor a propósito: construir `ZplService` abriría un cliente de
 * Cloud Storage y comprobaría el bucket por red, que no es lo que se prueba.
 *
 * Ojo con el nombre: `totalUniqueLabels` de `countLabels` es el número de
 * bloques que producen salida, sin deduplicar. Es lo que cuenta el lote.
 */
const converter = Object.create(ZplService.prototype) as ZplService;

const CORPUS: { name: string; zpl: string }[] = [
  {
    name: 'dos etiquetas simples',
    zpl: '^XA^FO10,10^FDUNO^FS^XZ^XA^FO10,10^FDDOS^FS^XZ',
  },
  {
    name: 'copias ^PQ mezcladas',
    zpl: '^XA^FDA^FS^PQ3^XZ^XA^FDB^FS^XZ^XA^FDC^FS^PQ10^XZ',
  },
  {
    name: 'repeticiones legítimas del mismo contenido',
    zpl: '^XA^FDIGUAL^FS^XZ^XA^FDIGUAL^FS^XZ^XA^FDIGUAL^FS^PQ2^XZ',
  },
  {
    name: 'bloque de configuración sin salida',
    zpl: '^XA^CI28^LH0,0^XZ^XA^FDCON-SALIDA^FS^XZ',
  },
  {
    name: 'saltos de línea y CRLF',
    zpl: '^XA\r\n^FO10,10\r\n^FDCRLF^FS\r\n^XZ\n^XA\n^FDLF^FS\n^XZ',
  },
  {
    name: 'acentos y barcode',
    zpl: '^XA^CI28^FDÑoño^FS^BY2^BCN,50,Y,N,N^FD123456^FS^PQ4^XZ',
  },
  {
    name: 'ruido entre etiquetas',
    zpl: 'basura ^XA^FDUNO^FS^XZ sobra ^XA^FDDOS^FS^PQ2^XZ final',
  },
];

describe('paridad del lote con el conversor', () => {
  it.each(CORPUS)(
    'cuenta igual que ZplService.countLabels: $name',
    async ({ zpl }) => {
      const labels = parseZplLabels(zpl);
      const counted = await converter.countLabels(zpl);

      expect(labels).toHaveLength(counted.data.totalUniqueLabels);
      expect(labels.reduce((sum, label) => sum + label.copies, 0)).toBe(
        counted.data.totalLabels,
      );
    },
  );

  it.each(CORPUS)(
    'el ZPL exportado se vuelve a contar igual: $name',
    async ({ zpl }) => {
      const labels = parseZplLabels(zpl);
      const exported = buildExportZpl(labels);
      const counted = await converter.countLabels(exported);

      // Lo que el lote promete (etiquetas y copias) es lo que el conversor lee.
      expect(counted.data.totalUniqueLabels).toBe(labels.length);
      expect(counted.data.totalLabels).toBe(
        labels.reduce((sum, label) => sum + label.copies, 0),
      );
    },
  );

  it('una selección parcial conserva el orden y las copias al recontarse', async () => {
    const labels = parseZplLabels(
      '^XA^FDUNO^FS^PQ2^XZ^XA^FDDOS^FS^XZ^XA^FDTRES^FS^PQ5^XZ',
    );
    // Se exportan la tercera y la primera, en ese orden.
    const selection = [labels[2], labels[0]];
    const exported = buildExportZpl(selection);

    const reparsed = parseZplLabels(exported);
    expect(reparsed.map((label) => label.fields.fd1)).toEqual(['TRES', 'UNO']);
    expect(reparsed.map((label) => label.copies)).toEqual([5, 2]);

    const counted = await converter.countLabels(exported);
    expect(counted.data.totalUniqueLabels).toBe(2);
    expect(counted.data.totalLabels).toBe(7);
  });
});
