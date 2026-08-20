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

import { HttpException } from '@nestjs/common';
import { ZplService, LabelSize } from './zpl.service.js';
import { OutputFormat } from './enums/output-format.enum.js';

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

    it('mapea 50x80mm (Phomemo M110) al enum correcto (issue #101)', () => {
      expect((service as any).getLabelSize('50x80mm')).toBe(
        LabelSize.FIFTY_BY_EIGHTY_MM,
      );
    });
  });
});

/**
 * issue #100: el nombre de descarga para free/lite (`zplpdf_size_timestamp`)
 * salía con la hora cortada a la mitad y en UTC. `generateFilenames` arma
 * ahora el timestamp explícitamente en GMT-6 en vez de recortar un ISO a
 * ciegas.
 */
describe('ZplService — generateFilenames (issue #100: timestamp truncado)', () => {
  function buildService(): ZplService {
    const configService: any = { get: jest.fn(() => 'test-bucket') };
    return new ZplService(configService, {} as any, {} as any, {}, {} as any);
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  it('genera fecha y hora completas en GMT-6 (minutos incluidos), no un ISO recortado', () => {
    // 21:42:16.123Z UTC = 15:42 GMT-6 (Mérida)
    jest.useFakeTimers().setSystemTime(new Date('2026-08-19T21:42:16.123Z'));
    const service = buildService();

    const { downloadFilename } = (service as any).generateFilenames(
      'job-1',
      '4x2',
    );

    expect(downloadFilename).toBe('zplpdf_4x2_20260819T1542.pdf');
  });

  it('dos conversiones separadas por menos de 10 minutos producen nombres distintos', () => {
    const service = buildService();

    jest.useFakeTimers().setSystemTime(new Date('2026-08-19T21:40:00.000Z'));
    const first = (service as any).generateFilenames('job-1', '4x2');

    jest.setSystemTime(new Date('2026-08-19T21:45:00.000Z'));
    const second = (service as any).generateFilenames('job-2', '4x2');

    expect(first.downloadFilename).not.toBe(second.downloadFilename);
  });

  it('usa GMT-6 y no UTC: una conversión nocturna en México no salta al día siguiente', () => {
    // 19:00 hora local (Mérida) = 01:00 UTC del día siguiente
    jest.useFakeTimers().setSystemTime(new Date('2026-08-20T01:00:00.000Z'));
    const service = buildService();

    const { downloadFilename } = (service as any).generateFilenames(
      'job-1',
      '4x2',
    );

    expect(downloadFilename).toBe('zplpdf_4x2_20260819T1900.pdf');
  });

  it('sigue traduciendo los alias (large -> 4x6) igual que antes de unificar los mapas de tamaño', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-19T21:42:00.000Z'));
    const service = buildService();

    const { downloadFilename } = (service as any).generateFilenames(
      'job-1',
      'large',
    );

    expect(downloadFilename).toBe('zplpdf_4x6_20260819T1542.pdf');
  });

  it('el tamaño nuevo (50x80mm) sale legible en el nombre de descarga', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-19T21:42:00.000Z'));
    const service = buildService();

    const { downloadFilename } = (service as any).generateFilenames(
      'job-1',
      '50x80mm',
    );

    expect(downloadFilename).toBe('zplpdf_50x80mm_20260819T1542.pdf');
  });
});

/**
 * Un worker puede seguir convirtiendo cuando la baja ya barrió Firestore y
 * Storage. La comprobación debe vivir justo junto a la subida: el guard de la
 * request original ocurrió demasiado pronto para proteger este punto.
 */
describe('ZplService — la lápida bloquea subidas tardías', () => {
  function buildUploadService(marks: boolean[]) {
    const save = jest.fn().mockResolvedValue(undefined);
    const remove = jest.fn().mockResolvedValue(undefined);
    const file = jest.fn().mockReturnValue({ save, delete: remove });
    const isAccountDeletionMarked = jest
      .fn()
      .mockImplementation(async () => marks.shift() ?? false);
    const saveZplDebugFile = jest.fn().mockResolvedValue(undefined);

    const service = Object.create(ZplService.prototype) as any;
    Object.assign(service, {
      logger: {
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      },
      bucket: 'test-bucket',
      jobs: new Map(),
      storage: { bucket: () => ({ file }) },
      firestoreService: {
        isAccountDeletionMarked,
        saveZplDebugFile,
        updateConversionStatus: jest.fn().mockResolvedValue(undefined),
      },
      usersService: {},
      logError: jest.fn().mockResolvedValue(true),
    });

    return {
      service,
      save,
      remove,
      isAccountDeletionMarked,
      saveZplDebugFile,
    };
  }

  it('no sube el PDF si la cuenta ya estaba marcada al llegar a GCS', async () => {
    const { service, save, isAccountDeletionMarked } = buildUploadService([
      true,
    ]);
    service.jobs.set('job-1', {
      id: 'job-1',
      zplContent: '^XA^FDhola^FS^XZ',
      labelSize: LabelSize.FOUR_BY_SIX,
      outputFormat: OutputFormat.PDF,
      status: 'pending',
      progress: 0,
      createdAt: new Date(),
      userPlan: 'pro',
    });
    service.convertZplToPdf = jest.fn().mockResolvedValue(Buffer.from('pdf'));

    await service.processZplConversion(
      '^XA^FDhola^FS^XZ',
      '4x6',
      'job-1',
      OutputFormat.PDF,
      'uid-1',
      'pro',
    );

    expect(isAccountDeletionMarked).toHaveBeenCalledWith('uid-1');
    expect(save).not.toHaveBeenCalled();
  });

  it('retira el ZPL si la baja empieza mientras GCS termina la subida', async () => {
    const { service, save, remove, saveZplDebugFile } = buildUploadService([
      false,
      true,
    ]);

    await service.saveZplForDebug(
      '^XA^FDhola^FS^XZ',
      'job-1',
      'uid-1',
      'user@example.com',
      '4x6',
      1,
      OutputFormat.PDF,
    );

    expect(save).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    // No queda metadata apuntando a un objeto que la propia carrera retiró.
    expect(saveZplDebugFile).not.toHaveBeenCalled();
  });
});

/**
 * issue #101, riesgo 2: el batch no tiene `@IsEnum` (acepta string libre a
 * propósito para no romper el historial), así que un tamaño no reconocido
 * debe rechazarse explícitamente en vez de convertirse en 2x1 en silencio.
 */
describe('ZplService — validación de labelSize en el batch (issue #101)', () => {
  const SIMPLE_ZPL = '^XA^FO50,50^A0,30^FDtest^FS^XZ';

  function buildBatchService(saveErrorLog: jest.Mock) {
    const configService: any = { get: jest.fn(() => 'test-bucket') };
    const usersService: any = {
      getUserById: jest.fn().mockResolvedValue({
        id: 'uid-b',
        email: 'batch@ejemplo.com',
        plan: 'pro',
      }),
      getEffectivePlan: jest.fn().mockReturnValue('pro'),
      checkCanConvert: jest
        .fn()
        .mockResolvedValue({ allowed: true, userEmail: 'batch@ejemplo.com' }),
    };
    return new ZplService(
      configService,
      { saveErrorLog } as any,
      usersService,
      {} as any,
      {} as any,
    );
  }

  it('rechaza un tamaño no reconocido con INVALID_LABEL_SIZE en vez de convertirlo en 2x1', async () => {
    const saveErrorLog = jest
      .fn()
      .mockResolvedValue({ id: 'x', errorId: 'ERR-7' });
    const service = buildBatchService(saveErrorLog);

    await expect(
      service.startBatchConversion(
        'uid-b',
        [{ id: 'f1', fileName: 'a.zpl', content: SIMPLE_ZPL }],
        'tamano-inventado',
      ),
    ).rejects.toThrow();

    expect(saveErrorLog).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'INVALID_LABEL_SIZE',
        userId: 'uid-b',
        userEmail: 'batch@ejemplo.com',
      }),
    );
  });

  /**
   * Regresión (review de Codex, PR #104): `constructor` ya está en minúsculas,
   * así que un lookup ingenuo sobre el mapa de alias encuentra la propiedad
   * heredada de Object.prototype en vez de `undefined` y el gate lo deja pasar
   * como si fuera un tamaño válido. Cubre el camino completo, no solo el
   * helper del enum.
   */
  it('rechaza "constructor" en vez de dejarlo colar como propiedad heredada del mapa de alias', async () => {
    const saveErrorLog = jest
      .fn()
      .mockResolvedValue({ id: 'x', errorId: 'ERR-9' });
    const service = buildBatchService(saveErrorLog);

    await expect(
      service.startBatchConversion(
        'uid-b',
        [{ id: 'f1', fileName: 'a.zpl', content: SIMPLE_ZPL }],
        'constructor',
      ),
    ).rejects.toThrow();

    expect(saveErrorLog).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INVALID_LABEL_SIZE' }),
    );
  });

  it('acepta 50x80mm: pasa el gate de labelSize y llega hasta guardar el batch', async () => {
    const saveErrorLog = jest
      .fn()
      .mockResolvedValue({ id: 'x', errorId: 'ERR-8' });
    const configService: any = { get: jest.fn(() => 'test-bucket') };
    const usersService: any = {
      getUserById: jest.fn().mockResolvedValue({
        id: 'uid-b',
        email: 'batch@ejemplo.com',
        plan: 'pro',
      }),
      getEffectivePlan: jest.fn().mockReturnValue('pro'),
      checkCanConvert: jest
        .fn()
        .mockResolvedValue({ allowed: true, userEmail: 'batch@ejemplo.com' }),
    };
    // saveBatchJob corta el flujo justo después del gate de labelSize, sin
    // necesidad de simular processBatchFiles (que sigue en segundo plano sin
    // await) al completo.
    const saveBatchJob = jest.fn().mockRejectedValue(new Error('stop-here'));
    const service = new ZplService(
      configService,
      { saveErrorLog, saveBatchJob } as any,
      usersService,
      {} as any,
      {} as any,
    );

    await expect(
      service.startBatchConversion(
        'uid-b',
        [{ id: 'f1', fileName: 'a.zpl', content: SIMPLE_ZPL }],
        '50x80mm',
      ),
    ).rejects.toThrow();

    expect(saveBatchJob).toHaveBeenCalled();
    expect(saveErrorLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INVALID_LABEL_SIZE' }),
    );
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
    const saveErrorLog = jest
      .fn()
      .mockResolvedValue({ id: 'x', errorId: 'ERR-1' });
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
    const saveErrorLog = jest
      .fn()
      .mockRejectedValue(new Error('Firestore down'));
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

/**
 * Los rechazos de cuota/acceso deben registrarse con `userEmail`, no solo con
 * `userId`. El dashboard admin enlaza a la ficha del usuario vía
 * /admin/users?search=<email>, y esa búsqueda matchea por email o displayName
 * pero nunca por uid: sin el email el admin no puede saber quién agotó su cuota.
 */
describe('ZplService — userEmail en rechazos de cuota/acceso', () => {
  const SIMPLE_ZPL = '^XA^FO50,50^A0,30^FDtest^FS^XZ';

  function buildService(saveErrorLog: jest.Mock, checkCanConvert: jest.Mock) {
    const configService: any = { get: jest.fn(() => 'test-bucket') };
    return new ZplService(
      configService,
      { saveErrorLog } as any,
      {
        checkCanConvert,
        getUserById: jest.fn(),
        getEffectivePlan: jest.fn(),
      } as any,
      {} as any,
      {} as any,
    );
  }

  it('registra el email que devuelve checkCanConvert al rechazar por cuota mensual', async () => {
    const saveErrorLog = jest
      .fn()
      .mockResolvedValue({ id: 'x', errorId: 'ERR-1' });
    const checkCanConvert = jest.fn().mockResolvedValue({
      allowed: false,
      error: "You've reached your monthly limit",
      errorCode: 'MONTHLY_LIMIT_EXCEEDED',
      data: { current: 10, allowed: 10, resetsAt: '2026-07-02' },
      userEmail: 'usuario@ejemplo.com',
    });
    const service = buildService(saveErrorLog, checkCanConvert);

    await expect(
      service.startZplConversion(SIMPLE_ZPL, '4x6', 'es', 'uid-123'),
    ).rejects.toThrow();

    expect(saveErrorLog).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'MONTHLY_LIMIT_EXCEEDED',
        severity: 'warning',
        userId: 'uid-123',
        userEmail: 'usuario@ejemplo.com',
      }),
    );
  });

  it('no rompe el registro si el email no se pudo resolver', async () => {
    const saveErrorLog = jest
      .fn()
      .mockResolvedValue({ id: 'x', errorId: 'ERR-2' });
    const checkCanConvert = jest.fn().mockResolvedValue({
      allowed: false,
      error: 'User not found',
      errorCode: 'USER_NOT_FOUND',
      userEmail: null,
    });
    const service = buildService(saveErrorLog, checkCanConvert);

    await expect(
      service.startZplConversion(SIMPLE_ZPL, '4x6', 'es', 'uid-fantasma'),
    ).rejects.toThrow();

    // `null` se normaliza a undefined: Firestore rechaza los undefined pero
    // saveErrorLog ya los omite; lo importante es que el registro se guarde.
    expect(saveErrorLog).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'uid-fantasma', userEmail: undefined }),
    );
  });

  /**
   * Los rechazos que ocurren ANTES del checkCanConvert (plan sin batch, exceso
   * de archivos, archivo demasiado grande) también son eventos de acceso/cuota
   * y deben quedar registrados con el email del usuario.
   */
  describe('rechazos previos al gate de cuota', () => {
    function buildBatchService(
      saveErrorLog: jest.Mock,
      plan: string,
      email = 'batch@ejemplo.com',
    ) {
      const configService: any = { get: jest.fn(() => 'test-bucket') };
      const usersService: any = {
        getUserById: jest.fn().mockResolvedValue({ id: 'uid-b', email, plan }),
        getEffectivePlan: jest.fn().mockReturnValue(plan),
        checkCanConvert: jest
          .fn()
          .mockResolvedValue({ allowed: true, userEmail: email }),
      };
      return new ZplService(
        configService,
        { saveErrorLog } as any,
        usersService,
        {} as any,
        {} as any,
      );
    }

    it('registra BATCH_NOT_ALLOWED con el email cuando el plan no incluye batch', async () => {
      const saveErrorLog = jest
        .fn()
        .mockResolvedValue({ id: 'x', errorId: 'ERR-4' });
      const service = buildBatchService(saveErrorLog, 'free');

      await expect(
        service.startBatchConversion(
          'uid-b',
          [{ id: 'f1', fileName: 'a.zpl', content: SIMPLE_ZPL }],
          '4x6',
        ),
      ).rejects.toThrow();

      expect(saveErrorLog).toHaveBeenCalledWith(
        expect.objectContaining({
          // Fricción de acceso (upsell), no presión de cuota.
          type: 'ACCESS_DENIED',
          code: 'BATCH_NOT_ALLOWED',
          severity: 'warning',
          userId: 'uid-b',
          userEmail: 'batch@ejemplo.com',
        }),
      );
    });

    it('registra BATCH_LIMIT_EXCEEDED con el email al exceder los archivos por batch', async () => {
      const saveErrorLog = jest
        .fn()
        .mockResolvedValue({ id: 'x', errorId: 'ERR-5' });
      const service = buildBatchService(saveErrorLog, 'pro');
      // BATCH_LIMITS.pro permite 10 archivos; enviamos 11.
      const files = Array.from({ length: 11 }, (_, i) => ({
        id: `f${i}`,
        fileName: `a${i}.zpl`,
        content: SIMPLE_ZPL,
      }));

      await expect(
        service.startBatchConversion('uid-b', files, '4x6'),
      ).rejects.toThrow();

      expect(saveErrorLog).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'LIMIT_EXCEEDED',
          code: 'BATCH_LIMIT_EXCEEDED',
          userId: 'uid-b',
          userEmail: 'batch@ejemplo.com',
        }),
      );
    });

    it('registra USER_NOT_FOUND aunque no haya email que resolver', async () => {
      const saveErrorLog = jest
        .fn()
        .mockResolvedValue({ id: 'x', errorId: 'ERR-6' });
      const service = buildBatchService(saveErrorLog, 'pro');
      (service as any).usersService.getUserById = jest
        .fn()
        .mockResolvedValue(null);

      await expect(
        service.startBatchConversion(
          'uid-fantasma',
          [{ id: 'f1', fileName: 'a.zpl', content: SIMPLE_ZPL }],
          '4x6',
        ),
      ).rejects.toThrow();

      expect(saveErrorLog).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ACCESS_DENIED',
          code: 'USER_NOT_FOUND',
          userId: 'uid-fantasma',
          userEmail: undefined,
        }),
      );
    });
  });

  it('registra también el rechazo de un batch (antes no se guardaba nada)', async () => {
    const saveErrorLog = jest
      .fn()
      .mockResolvedValue({ id: 'x', errorId: 'ERR-3' });
    const checkCanConvert = jest.fn().mockResolvedValue({
      allowed: false,
      error: "You've reached your monthly limit",
      errorCode: 'MONTHLY_LIMIT_EXCEEDED',
      data: { current: 500, allowed: 500 },
      userEmail: 'pro@ejemplo.com',
    });
    const service = buildService(saveErrorLog, checkCanConvert);
    (service as any).usersService.getUserById = jest.fn().mockResolvedValue({
      id: 'uid-pro',
      email: 'pro@ejemplo.com',
      plan: 'pro',
    });
    (service as any).usersService.getEffectivePlan = jest
      .fn()
      .mockReturnValue('pro');

    await expect(
      service.startBatchConversion(
        'uid-pro',
        [{ id: 'f1', fileName: 'a.zpl', content: SIMPLE_ZPL }],
        '4x6',
      ),
    ).rejects.toThrow();

    expect(saveErrorLog).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'MONTHLY_LIMIT_EXCEEDED',
        severity: 'warning',
        userId: 'uid-pro',
        userEmail: 'pro@ejemplo.com',
      }),
    );
  });
});

/**
 * Cada archivo de un batch acaba como una fila propia en `conversion_history`,
 * indistinguible de una conversión individual desde el historial. Si el batch
 * no guarda su ZPL, esas filas quedan mudas: "reconvertir" devuelve 410 para
 * siempre y el listado, que solo mira la edad del registro, las anuncia como
 * reconvertibles durante los 15 días de retención.
 */
describe('ZplService — el batch deja el ZPL disponible para reconvertir', () => {
  function buildBatchService() {
    const saveZplForDebug = jest.fn().mockResolvedValue(undefined);
    const recordConversion = jest.fn().mockResolvedValue(undefined);
    const updateZplDebugResult = jest.fn().mockResolvedValue(undefined);

    const service = Object.create(ZplService.prototype) as any;
    Object.assign(service, {
      logger: {
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      },
      bucket: 'test-bucket',
      storage: {
        bucket: () => ({
          file: () => ({ save: jest.fn().mockResolvedValue(undefined) }),
        }),
      },
      firestoreService: {
        getBatchJob: jest.fn().mockResolvedValue({ userId: 'uid-pro' }),
        isAccountDeletionMarked: jest.fn().mockResolvedValue(false),
        updateZplDebugResult,
      },
      usersService: {
        getUserById: jest.fn().mockResolvedValue({
          id: 'uid-pro',
          plan: 'pro',
          email: 'pro@ejemplo.com',
        }),
        recordConversion,
      },
      // Ruido del bucle que estos tests no ejercitan.
      getLabelSize: jest.fn().mockReturnValue(LabelSize.FOUR_BY_SIX),
      countLabels: jest.fn().mockResolvedValue({ data: { totalLabels: 7 } }),
      convertZplToPdf: jest.fn().mockResolvedValue(Buffer.from('pdf')),
      updateBatchJobProgress: jest.fn().mockResolvedValue(undefined),
      finalizeBatch: jest.fn().mockResolvedValue(undefined),
      saveZplForDebug,
    });

    return { service, saveZplForDebug, recordConversion, updateZplDebugResult };
  }

  const archivo = { id: 'f1', content: '^XA^FDhola^FS^XZ', fileName: 'a.zpl' };
  const job = {
    jobId: 'job-batch-1',
    fileName: 'a.zpl',
    status: 'pending',
    progress: 0,
  };

  it('guarda el ZPL de cada archivo bajo el jobId con el que se registra en el historial', async () => {
    const { service, saveZplForDebug, recordConversion } = buildBatchService();

    await service.processBatchFiles('batch-1', [archivo], [job], '4x6', 'pdf');

    expect(saveZplForDebug).toHaveBeenCalledWith(
      archivo.content,
      'job-batch-1',
      'uid-pro',
      'pro@ejemplo.com',
      '4x6',
      7,
      'pdf',
    );
    // El mismo jobId en ambos lados: es lo que une la fila del historial con su ZPL.
    expect(recordConversion).toHaveBeenCalledWith(
      'uid-pro',
      'job-batch-1',
      7,
      '4x6',
      'completed',
      'pdf',
      undefined,
      undefined,
    );
  });

  it('marca el resultado del ZPL guardado en vez de dejarlo en pending', async () => {
    const { service, updateZplDebugResult } = buildBatchService();

    await service.processBatchFiles('batch-1', [archivo], [job], '4x6', 'pdf');

    expect(updateZplDebugResult).toHaveBeenCalledWith('job-batch-1', 'success');
  });

  it('espera a que el ZPL esté guardado antes de marcar su resultado', async () => {
    // updateZplDebugResult usa update() y se traga el fallo si el doc todavía no
    // existe; el set() posterior del guardado dejaría el registro en `pending`
    // para siempre. Con una subida más lenta que la conversión, el orden importa.
    const { service, updateZplDebugResult } = buildBatchService();
    let zplYaGuardado = false;
    service.saveZplForDebug = jest.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) =>
          setImmediate(() => {
            zplYaGuardado = true;
            resolve();
          }),
        ),
    );
    const observado: boolean[] = [];
    updateZplDebugResult.mockImplementation(() => {
      observado.push(zplYaGuardado);
      return Promise.resolve();
    });

    await service.processBatchFiles('batch-1', [archivo], [job], '4x6', 'pdf');

    expect(observado).toEqual([true]);
  });
});

/**
 * El render de la vista previa va contra el plan FREE de Labelary (1 req/s para
 * TODA la plataforma) y cada etiqueta única es una petición. El endpoint
 * público (issue #108) acota cuántas se renderizan, y lo que importa es que el
 * recorte ocurra ANTES de llamar a Labelary: recortar la respuesta no ahorraría
 * nada del techo compartido.
 */
describe('ZplService — etiquetas únicas y vista previa acotada', () => {
  const buildService = (): ZplService => {
    const configService: any = { get: jest.fn(() => 'test-bucket') };
    return new ZplService(configService, {} as any, {} as any, {}, {} as any);
  };

  const label = (texto: string, extra = '') =>
    `^XA\n^FO20,20^FD${texto}^FS${extra}\n^XZ`;

  describe('extractUniqueLabels', () => {
    it('agrupa etiquetas idénticas y suma las copias de ^PQ', () => {
      const service = buildService();

      const uniques = service.extractUniqueLabels(
        [
          label('A', '^PQ3'),
          label('B'),
          // Misma etiqueta que la primera salvo formato: sin saltos de línea
          // y con otro ^PQ. Debe fundirse con ella.
          '^XA^FO20,20^FDA^FS^PQ2^XZ',
        ].join('\n'),
      );

      expect(uniques).toHaveLength(2);
      expect(uniques[0].qty).toBe(5); // 3 + 2 copias
      expect(uniques[1].qty).toBe(1);
      expect(uniques[0].zpl).not.toContain('^PQ');
      expect(uniques[0].zpl).not.toContain('\n');
      expect(uniques[0].zpl.startsWith('^XA')).toBe(true);
      expect(uniques[0].zpl.endsWith('^XZ')).toBe(true);
    });

    it('respeta el orden de aparición', () => {
      const service = buildService();

      const uniques = service.extractUniqueLabels(
        [label('primera'), label('segunda'), label('tercera')].join('\n'),
      );

      expect(uniques.map((u) => u.zpl.includes('primera'))).toEqual([
        true,
        false,
        false,
      ]);
      expect(uniques[2].zpl).toContain('tercera');
    });

    it('lanza 400 si no hay ningún bloque ^XA…^XZ', () => {
      const service = buildService();

      expect(() => service.extractUniqueLabels('esto no es ZPL')).toThrow(
        HttpException,
      );
    });
  });

  describe('getLabelsPreview con maxUniqueLabels', () => {
    const buildServiceConLabelaryMockeado = () => {
      const service = buildService();
      const getSingleLabelaryPngImage = jest
        .fn()
        .mockResolvedValue(Buffer.from('png'));
      (service as any).getSingleLabelaryPngImage = getSingleLabelaryPngImage;
      return { service, getSingleLabelaryPngImage };
    };

    const zplDeCincoUnicas = [
      label('uno'),
      label('dos'),
      label('tres'),
      label('cuatro'),
      label('cinco'),
    ].join('\n');

    it('no manda a Labelary más etiquetas de las permitidas', async () => {
      const { service, getSingleLabelaryPngImage } =
        buildServiceConLabelaryMockeado();

      const previews = await service.getLabelsPreview(
        zplDeCincoUnicas,
        LabelSize.TWO_BY_ONE,
        { maxUniqueLabels: 2 },
      );

      expect(previews).toHaveLength(2);
      expect(getSingleLabelaryPngImage).toHaveBeenCalledTimes(2);
      expect(getSingleLabelaryPngImage.mock.calls[0][0]).toContain('uno');
      expect(getSingleLabelaryPngImage.mock.calls[1][0]).toContain('dos');
    });

    it('conserva las cantidades reales de las etiquetas que sí renderiza', async () => {
      const { service } = buildServiceConLabelaryMockeado();

      const previews = await service.getLabelsPreview(
        [label('uno', '^PQ10'), label('dos'), label('tres')].join('\n'),
        LabelSize.TWO_BY_ONE,
        { maxUniqueLabels: 2 },
      );

      expect(previews.map((p) => p.qty)).toEqual([10, 1]);
      expect(previews[0].img.startsWith('data:image/png;base64,')).toBe(true);
    });

    it('mil copias de la misma etiqueta siguen siendo una sola petición', async () => {
      const { service, getSingleLabelaryPngImage } =
        buildServiceConLabelaryMockeado();

      const previews = await service.getLabelsPreview(
        Array.from({ length: 1000 }, () => label('igual')).join('\n'),
        LabelSize.TWO_BY_ONE,
        { maxUniqueLabels: 2 },
      );

      expect(getSingleLabelaryPngImage).toHaveBeenCalledTimes(1);
      expect(previews).toEqual([expect.objectContaining({ qty: 1000 })]);
    });

    it('sin tope renderiza todas las etiquetas únicas (comportamiento de /zpl/preview)', async () => {
      const { service, getSingleLabelaryPngImage } =
        buildServiceConLabelaryMockeado();

      const previews = await service.getLabelsPreview(
        zplDeCincoUnicas,
        LabelSize.TWO_BY_ONE,
      );

      expect(previews).toHaveLength(5);
      expect(getSingleLabelaryPngImage).toHaveBeenCalledTimes(5);
    });
  });
});
