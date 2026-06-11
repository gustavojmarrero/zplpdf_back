import { PDFDocument } from 'pdf-lib';

// Mockear dependencias pesadas/nativas que el servicio importa a nivel de
// módulo pero que estos tests no ejercitan. Evita cargar binarios (sharp) y
// pdfjs (pdf-to-png-converter) en el entorno de jest.
jest.mock('sharp', () => jest.fn());
jest.mock('pdf-to-png-converter', () => ({ pdfToPng: jest.fn() }));
jest.mock('pdf-merger-js', () => jest.fn());
jest.mock('archiver', () => jest.fn());

// Evitar la conexión real a Google Cloud Storage al construir el servicio.
jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({
      exists: jest.fn().mockResolvedValue([true]),
      file: jest.fn(),
    }),
  })),
}));

import { ZplService, LabelSize } from './zpl.service';

/**
 * Regresión: una etiqueta de envío real (Amazon Logistics) que empieza con un
 * bloque de pura configuración `^XA^MCY^XZ` seguido del contenido. Labelary
 * descarta el bloque vacío y devuelve 1 sola página; el servicio antes contaba
 * 2 bloques y, al pedir copiar la página inexistente, vaciaba TODO el PDF
 * (resultado: una página A4 en blanco).
 */
const SHIPPING_LABEL_ZPL = `^FX Start of a new label-sheet
^XA^MCY^XZ
^XA
^LH0,0
^FO98,487^BY1,,102^BCN,102,N,N,N,N^FH^FD>:_54_42_52^FS
^CI28^FO81,595^A0,37,0^FB305,1,0,L,0^FH^FD_54_42_52_33_37_32^FS^CI0
^FO575,480^BXN,8,200,22,22,,~^FH^FD_54_42_52_33_37_32^FS
^XZ`;

describe('ZplService — bloques de configuración sin contenido', () => {
  let service: ZplService;

  beforeEach(() => {
    const configService: any = { get: jest.fn(() => 'test-bucket') };
    const firestoreService: any = {};
    const usersService: any = {};
    const labelaryQueueService: any = {};

    service = new ZplService(
      configService,
      firestoreService,
      usersService,
      {},
      labelaryQueueService,
    );
  });

  describe('blockProducesOutput', () => {
    it('clasifica un bloque solo de configuración como sin salida', () => {
      const fn = (service as any).blockProducesOutput.bind(service);
      expect(fn('^XA^MCY^XZ')).toBe(false);
      expect(fn('^XA^MCN^XZ')).toBe(false);
      expect(fn('^XA^LH0,0^CI28^XZ')).toBe(false);
      // ^BY es configuración de barcode (Bar Code Field Default), no dibuja.
      expect(fn('^XA^BY2,3,100^XZ')).toBe(false);
    });

    it('clasifica bloques con contenido dibujable como con salida', () => {
      const fn = (service as any).blockProducesOutput.bind(service);
      expect(fn('^XA^FO50,50^A0,30^FDhola^FS^XZ')).toBe(true); // texto
      expect(fn('^XA^FO0,0^GB100,100,2^FS^XZ')).toBe(true); // gráfico
      expect(fn('^XA^FO10,10^BCN,100^FD12345^FS^XZ')).toBe(true); // código de barras
      expect(fn('^XA^FO10,10^BXN,8,200^FDABC^FS^XZ')).toBe(true); // DataMatrix
      // ^SN imprime datos serializados sin necesitar ^FD/^FV.
      expect(fn('^XA^FO50,50^A0N,30,30^SN0001,1,Y^FS^XZ')).toBe(true);
      // Un bloque con ^BY de config + un barcode real sigue siendo imprimible.
      expect(fn('^XA^BY1,,102^FO98,487^BCN,102^FD123^FS^XZ')).toBe(true);
    });
  });

  describe('splitAndExtractCopies', () => {
    it('descarta el bloque ^XA^MCY^XZ y conserva la etiqueta real', () => {
      const blocks = (service as any).splitAndExtractCopies(SHIPPING_LABEL_ZPL);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].normalizedContent).toContain('^BCN');
      expect(blocks[0].normalizedContent).not.toContain('^MCY');
    });
  });

  describe('countLabels', () => {
    it('no cuenta la etiqueta de configuración como etiqueta facturable', async () => {
      const result = await service.countLabels(SHIPPING_LABEL_ZPL);
      expect(result.data.totalLabels).toBe(1);
      expect(result.data.totalUniqueLabels).toBe(1);
    });
  });

  describe('reconstructFinalPdf — robustez ante desajuste de páginas', () => {
    /** Crea un PDF de N páginas 4x6 con texto, simulando la salida de Labelary. */
    async function makePdf(pageCount: number): Promise<Buffer> {
      const doc = await PDFDocument.create();
      for (let i = 0; i < pageCount; i++) {
        const page = doc.addPage([288, 432]);
        page.drawText(`page ${i}`, { x: 20, y: 200, size: 24 });
      }
      return Buffer.from(await doc.save());
    }

    it('no vacía el PDF cuando se piden más páginas de las que existen', async () => {
      // El servicio cree que hay 2 bloques (originalSequence=[0,1]) pero
      // Labelary solo renderizó 1 página. El resultado debe conservar el
      // contenido real, no producir un PDF vacío/A4 en blanco.
      const labelaryPdf = await makePdf(1);
      const result: Buffer = await (service as any).reconstructFinalPdf(
        [labelaryPdf],
        [0, 1],
      );

      const out = await PDFDocument.load(result);
      expect(out.getPageCount()).toBe(1);
      const size = out.getPage(0).getSize();
      // 4x6 a 72pt/in = 288x432; NO el A4 (595x842) por defecto de pdf-lib.
      expect(Math.round(size.width)).toBe(288);
      expect(Math.round(size.height)).toBe(432);
    });

    it('replica páginas correctamente cuando los índices son válidos', async () => {
      const labelaryPdf = await makePdf(2);
      const result: Buffer = await (service as any).reconstructFinalPdf(
        [labelaryPdf],
        [0, 1, 0],
      );
      const out = await PDFDocument.load(result);
      expect(out.getPageCount()).toBe(3);
    });
  });

  describe('getLabelSize', () => {
    it('mapea 4x6 al enum correcto', () => {
      expect((service as any).getLabelSize('4x6')).toBe(LabelSize.FOUR_BY_SIX);
    });
  });
});

/**
 * Regresión: un fallo de la API de Labelary debe registrarse UNA sola vez y con
 * severidad "error" (no "critical"). callLabelary marca la excepción con
 * `loggedToDashboard` para que el catch genérico de processZplConversion no la
 * vuelva a guardar como SERVER_ERROR/critical (evita doble conteo y falsos
 * "critical" en el dashboard de admin).
 */
describe('ZplService — registro de errores de Labelary', () => {
  function buildService(saveErrorLog: jest.Mock, enqueue: jest.Mock) {
    const configService: any = { get: jest.fn(() => 'test-bucket') };
    return new ZplService(
      configService,
      { saveErrorLog } as any,
      {} as any,
      {} as any,
      { enqueue } as any,
    );
  }

  it('registra el fallo de Labelary una vez con severidad "error" y marca la excepción', async () => {
    const saveErrorLog = jest.fn().mockResolvedValue({ id: 'x', errorId: 'ERR-1' });
    const enqueue = jest.fn().mockRejectedValue(new Error('Labelary 503'));
    const service = buildService(saveErrorLog, enqueue);

    await expect(
      (service as any).callLabelary(
        '^XA^FO50,50^A0,30^FDtest^FS^XZ',
        LabelSize.FOUR_BY_SIX,
        'job1',
        'user1',
        'free',
        1,
      ),
    ).rejects.toMatchObject({ loggedToDashboard: true });

    // Un único registro, con severidad "error" (no "critical").
    expect(saveErrorLog).toHaveBeenCalledTimes(1);
    expect(saveErrorLog).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'SERVER_ERROR',
        code: 'LABELARY_API_ERROR',
        severity: 'error',
      }),
    );
  });

  it('no marca la excepción si el registro del error falló (deja actuar al fallback)', async () => {
    const saveErrorLog = jest.fn().mockRejectedValue(new Error('Firestore down'));
    const enqueue = jest.fn().mockRejectedValue(new Error('Labelary 503'));
    const service = buildService(saveErrorLog, enqueue);

    const err = await (service as any)
      .callLabelary(
        '^XA^FO50,50^A0,30^FDtest^FS^XZ',
        LabelSize.FOUR_BY_SIX,
        'job1',
        'user1',
        'free',
        1,
      )
      .catch((e: any) => e);

    // Sin confirmación de guardado, la excepción NO se marca: processZplConversion
    // hará el registro de respaldo en lugar de omitirlo silenciosamente.
    expect(err.loggedToDashboard).toBeUndefined();
  });
});
