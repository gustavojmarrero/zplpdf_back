jest.mock('axios');

import axios from 'axios';
import { LabelaryQueueService } from './labelary-queue.service.js';
import { LabelSize } from '../enums/label-size.enum.js';

const mockedAxios = axios as jest.Mocked<typeof axios>;

/**
 * issue #101 (50x80mm, Phomemo M110): el id de `LabelSize` que circula por la
 * app (`50x80mm`) no es lo que entiende la URL de Labelary. Antes el enum SE
 * INTERPOLABA tal cual porque id y dimensión eran la misma cosa; con la
 * opción B dejan de serlo. Este spec fija que la llamada HTTP real sale con
 * la dimensión traducida, no con el id — es la regresión más directa si
 * alguien revierte alguno de los dos puntos de interpolación.
 */
describe('LabelaryQueueService — traducción de LabelSize a dimensiones de Labelary', () => {
  function buildService(): LabelaryQueueService {
    const labelaryAnalyticsService: any = {
      trackSuccess: jest.fn().mockResolvedValue(undefined),
      trackRateLimit: jest.fn().mockResolvedValue(undefined),
      trackError: jest.fn().mockResolvedValue(undefined),
    };
    return new LabelaryQueueService(labelaryAnalyticsService);
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('enqueuePngDirect (preview)', () => {
    it('usa la dimensión decimal para 50x80mm, no el id legible', async () => {
      mockedAxios.post.mockResolvedValue({ data: Buffer.from('png') });
      const service = buildService();

      await service.enqueuePngDirect('^XA^XZ', LabelSize.FIFTY_BY_EIGHTY_MM);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        'http://api.labelary.com/v1/printers/8dpmm/labels/1.9705x3.1528/0/',
        expect.anything(),
        expect.anything(),
      );
    });

    it('sigue mandando la dimensión de los tamaños de catálogo original sin cambios', async () => {
      mockedAxios.post.mockResolvedValue({ data: Buffer.from('png') });
      const service = buildService();

      await service.enqueuePngDirect('^XA^XZ', LabelSize.FOUR_BY_SIX);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        'http://api.labelary.com/v1/printers/8dpmm/labels/4x6/0/',
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('enqueue (conversión PDF)', () => {
    it('usa la dimensión decimal para 50x80mm, no el id legible', async () => {
      mockedAxios.post.mockResolvedValue({ data: Buffer.from('pdf') });
      const service = buildService();

      await service.enqueue(
        'job-1',
        'user-1',
        'free',
        '^XA^XZ',
        LabelSize.FIFTY_BY_EIGHTY_MM,
        1,
      );

      expect(mockedAxios.post).toHaveBeenCalledWith(
        'http://api.labelary.com/v1/printers/8dpmm/labels/1.9705x3.1528',
        expect.anything(),
        expect.anything(),
      );
    });
  });
});

/**
 * El plan free de Labelary admite 1 req/s para TODA la plataforma. Antes,
 * `waitForRateLimit` leía `lastCallTime` y solo lo actualizaba DESPUÉS de
 * dormir: varias previews concurrentes calculaban la misma espera, despertaban
 * juntas y salían de golpe. Con el endpoint público (issue #108) esas ráfagas
 * las puede provocar cualquier visitante.
 */
describe('LabelaryQueueService — el rate limit global serializa las llamadas concurrentes', () => {
  function buildService(): LabelaryQueueService {
    const labelaryAnalyticsService: any = {
      trackSuccess: jest.fn().mockResolvedValue(undefined),
      trackRateLimit: jest.fn().mockResolvedValue(undefined),
      trackError: jest.fn().mockResolvedValue(undefined),
    };
    return new LabelaryQueueService(labelaryAnalyticsService);
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reparte en el tiempo tres peticiones lanzadas a la vez', async () => {
    mockedAxios.post.mockResolvedValue({ data: Buffer.from('png') });
    const service = buildService();
    const momentos: number[] = [];
    mockedAxios.post.mockImplementation(async () => {
      momentos.push(Date.now());
      return { data: Buffer.from('png') } as any;
    });

    await Promise.all([
      service.enqueuePngDirect('^XA^FDuno^XZ', LabelSize.TWO_BY_ONE),
      service.enqueuePngDirect('^XA^FDdos^XZ', LabelSize.TWO_BY_ONE),
      service.enqueuePngDirect('^XA^FDtres^XZ', LabelSize.TWO_BY_ONE),
    ]);

    expect(momentos).toHaveLength(3);
    momentos.sort((a, b) => a - b);
    // Margen de 50 ms para el jitter del scheduler de timers.
    expect(momentos[1] - momentos[0]).toBeGreaterThanOrEqual(950);
    expect(momentos[2] - momentos[1]).toBeGreaterThanOrEqual(950);
  }, 15000);

  it('un turno que falla no rompe la cadena para los siguientes', async () => {
    const service = buildService();
    mockedAxios.post
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ data: Buffer.from('png') } as any);

    await expect(
      service.enqueuePngDirect('^XA^XZ', LabelSize.TWO_BY_ONE),
    ).rejects.toThrow();
    await expect(
      service.enqueuePngDirect('^XA^XZ', LabelSize.TWO_BY_ONE),
    ).resolves.toBeInstanceOf(Buffer);
  }, 15000);
});
