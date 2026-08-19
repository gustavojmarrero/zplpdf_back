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
