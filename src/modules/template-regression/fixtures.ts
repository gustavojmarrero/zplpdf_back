import { LabelSize } from '../zpl/enums/label-size.enum.js';

/** Synthetic, versioned fixtures. They contain no customer data or physical-print certification. */
export const REGRESSION_FIXTURES = [
  ['text-basic', 'Texto básico', '^FO30,30^A0N,30,30^FDSYNTHETIC 001^FS'],
  [
    'text-multiline',
    'Texto en dos líneas',
    '^FO20,20^A0N,22,22^FDFIRST LINE^FS^FO20,60^A0N,22,22^FDSECOND LINE^FS',
  ],
  ['box-border', 'Marco rectangular', '^FO15,15^GB350,160,3^FS'],
  [
    'grid-lines',
    'Cuadrícula',
    '^FO20,20^GB340,150,2^FS^FO20,95^GB340,0,2^FS^FO190,20^GB0,150,2^FS',
  ],
  [
    'code128',
    'Code 128 sintético',
    '^FO25,25^BY2^BCN,80,Y,N,N^FDTEST000123^FS',
  ],
  ['qr', 'QR sintético', '^FO25,25^BQN,2,4^FDLA,SYNTHETIC-QR-001^FS'],
  ['rotated-text', 'Texto rotado', '^FO70,20^A0R,25,25^FDROTATED^FS'],
  [
    'reverse-text',
    'Texto invertido',
    '^FO20,20^GB340,70,70^FS^FO30,35^FR^A0N,30,30^FDREVERSE^FS',
  ],
  [
    'variable-date',
    'Fecha sintética para máscara',
    '^FO20,20^A0N,25,25^FDFIXTURE DATE^FS^FO20,70^A0N,25,25^FD2026-01-01^FS',
  ],
  [
    'metric-layout',
    'Diseño métrico',
    '^FO20,20^GB350,580,2^FS^FO35,50^A0N,30,30^FDMETRIC 50x80^FS',
  ],
].map(([id, name, commands]) => ({
  id,
  version: 1 as const,
  name,
  zpl: `^XA${commands}^PQ1^XZ`,
  labelSize:
    id === 'metric-layout'
      ? LabelSize.FIFTY_BY_EIGHTY_MM
      : LabelSize.TWO_BY_ONE,
}));
