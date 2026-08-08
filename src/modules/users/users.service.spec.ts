// Evitar la conexión real a Google Cloud Storage / Stripe al cargar el módulo.
jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: jest.fn() })),
}));
jest.mock('stripe', () => jest.fn());

import { UsersService, MAX_HISTORY_SCAN } from './users.service.js';
import {
  HistorySortBy,
  HistorySortOrder,
  HistoryStatus,
} from './dto/get-history-query.dto.js';
import { LabelSize } from '../zpl/enums/label-size.enum.js';
import { OutputFormat } from '../zpl/enums/output-format.enum.js';
import type { ConversionHistoryRecord } from '../../common/interfaces/conversion-history.interface.js';

/**
 * `getUserHistory` devolvía un array plano sin metadatos, así que el frontend
 * calculaba `totalPages` con `Math.ceil(data.length / limit)` y siempre le daba
 * 1: un usuario con 300 conversiones solo veía las 10 más recientes (issue #89).
 */
describe('UsersService — getUserHistory', () => {
  /** URL firmada con el formato real, para que `extractStorageInfo` la parsee. */
  function signedUrl(file: string): string {
    return `https://storage.googleapis.com/bucket-zpl/${file}?X-Goog-Algorithm=GOOG4-RSA-SHA256`;
  }

  function record(
    overrides: Partial<ConversionHistoryRecord> & { id: string },
  ): ConversionHistoryRecord {
    return {
      userId: 'uid-1',
      jobId: `job-${overrides.id}`,
      labelCount: 10,
      labelSize: LabelSize.FOUR_BY_SIX,
      status: 'completed',
      outputFormat: OutputFormat.PDF,
      fileUrl: signedUrl(`${overrides.id}.pdf`),
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      ...overrides,
    };
  }

  /**
   * UsersService tiene un constructor con muchas dependencias que estos tests no
   * ejercitan. Instanciamos por prototipo e inyectamos solo lo necesario.
   */
  function buildService(
    records: ConversionHistoryRecord[],
    user: Record<string, unknown> = { id: 'uid-1', plan: 'pro' },
  ) {
    const scanUserConversionHistory = jest.fn().mockResolvedValue(records);
    const generateSignedUrlForPath = jest
      .fn()
      .mockImplementation(async (path: string) => `signed://${path}`);

    const service: any = Object.create(UsersService.prototype);
    service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    service.historyScanCache = new Map();
    service.firestoreService = {
      getUserById: jest.fn().mockResolvedValue(user),
      scanUserConversionHistory,
    };
    service.storageService = { generateSignedUrlForPath };

    return { service, scanUserConversionHistory, generateSignedUrlForPath };
  }

  describe('paginación', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      record({
        id: `r${String(i).padStart(2, '0')}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      }),
    );

    it('devuelve totales reales aunque la página venga llena', async () => {
      const { service } = buildService(many);

      const result = await service.getUserHistory('uid-1', {
        page: 1,
        limit: 10,
      });

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(10);
      expect(result.pagination).toMatchObject({
        page: 1,
        limit: 10,
        total: 30,
        totalPages: 3,
      });
    });

    it('page=2 devuelve registros distintos a page=1', async () => {
      const { service } = buildService(many);

      const first = await service.getUserHistory('uid-1', {
        page: 1,
        limit: 10,
      });
      const second = await service.getUserHistory('uid-1', {
        page: 2,
        limit: 10,
      });

      const firstIds = first.data.map((r: { id: string }) => r.id);
      const secondIds = second.data.map((r: { id: string }) => r.id);

      expect(secondIds).toHaveLength(10);
      expect(firstIds).not.toEqual(secondIds);
      expect(firstIds.some((id: string) => secondIds.includes(id))).toBe(false);
    });

    it('totalPages es 1 cuando no hay resultados, no 0', async () => {
      const { service } = buildService([]);

      const result = await service.getUserHistory('uid-1', {});

      expect(result.pagination.total).toBe(0);
      expect(result.pagination.totalPages).toBe(1);
      expect(result.data).toEqual([]);
    });

    it('marca truncated cuando el usuario supera el tope de escaneo', async () => {
      const atCap = Array.from({ length: MAX_HISTORY_SCAN }, (_, i) =>
        record({ id: `t${i}` }),
      );
      const { service } = buildService(atCap);

      const result = await service.getUserHistory('uid-1', { limit: 10 });

      expect(result.pagination.truncated).toBe(true);
    });

    it('no marca truncated por debajo del tope', async () => {
      const { service } = buildService(many);

      const result = await service.getUserHistory('uid-1', {});

      expect(result.pagination.truncated).toBeUndefined();
    });
  });

  describe('orden', () => {
    it('sin parámetros devuelve las conversiones más recientes primero', async () => {
      const { service } = buildService([
        record({ id: 'a', createdAt: new Date('2026-01-03T00:00:00.000Z') }),
        record({ id: 'b', createdAt: new Date('2026-01-01T00:00:00.000Z') }),
        record({ id: 'c', createdAt: new Date('2026-01-02T00:00:00.000Z') }),
      ]);

      const result = await service.getUserHistory('uid-1', {});

      expect(result.data.map((r: { id: string }) => r.id)).toEqual([
        'a',
        'c',
        'b',
      ]);
    });

    it('ordena por labelCount ascendente', async () => {
      const { service } = buildService([
        record({ id: 'a', labelCount: 50 }),
        record({ id: 'b', labelCount: 5 }),
        record({ id: 'c', labelCount: 20 }),
      ]);

      const result = await service.getUserHistory('uid-1', {
        sortBy: HistorySortBy.LABEL_COUNT,
        sortOrder: HistorySortOrder.ASC,
      });

      expect(result.data.map((r: { id: string }) => r.id)).toEqual([
        'b',
        'c',
        'a',
      ]);
    });

    it('combina orden por labelCount con un filtro', async () => {
      const { service } = buildService([
        record({ id: 'a', labelCount: 50, status: 'failed' }),
        record({ id: 'b', labelCount: 5 }),
        record({ id: 'c', labelCount: 20 }),
      ]);

      const result = await service.getUserHistory('uid-1', {
        status: HistoryStatus.COMPLETED,
        sortBy: HistorySortBy.LABEL_COUNT,
        sortOrder: HistorySortOrder.DESC,
      });

      expect(result.data.map((r: { id: string }) => r.id)).toEqual(['c', 'b']);
    });

    it('desempata por fecha descendente con el mismo labelCount', async () => {
      const { service } = buildService([
        record({
          id: 'viejo',
          labelCount: 7,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        }),
        record({
          id: 'nuevo',
          labelCount: 7,
          createdAt: new Date('2026-01-05T00:00:00.000Z'),
        }),
      ]);

      const result = await service.getUserHistory('uid-1', {
        sortBy: HistorySortBy.LABEL_COUNT,
      });

      expect(result.data.map((r: { id: string }) => r.id)).toEqual([
        'nuevo',
        'viejo',
      ]);
    });
  });

  describe('filtros', () => {
    const mixed = [
      record({
        id: 'a',
        status: 'completed',
        outputFormat: OutputFormat.PDF,
        labelSize: LabelSize.FOUR_BY_SIX,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
      record({
        id: 'b',
        status: 'failed',
        outputFormat: OutputFormat.PNG,
        labelSize: LabelSize.TWO_BY_ONE,
        createdAt: new Date('2026-01-10T00:00:00.000Z'),
      }),
      record({
        id: 'c',
        status: 'completed',
        outputFormat: OutputFormat.PNG,
        labelSize: LabelSize.FOUR_BY_SIX,
        createdAt: new Date('2026-01-20T00:00:00.000Z'),
      }),
    ];

    it('filtra por status', async () => {
      const { service } = buildService(mixed);

      const result = await service.getUserHistory('uid-1', {
        status: HistoryStatus.FAILED,
      });

      expect(result.data.map((r: { id: string }) => r.id)).toEqual(['b']);
      expect(result.pagination.total).toBe(1);
    });

    it('combina outputFormat y labelSize', async () => {
      const { service } = buildService(mixed);

      const result = await service.getUserHistory('uid-1', {
        outputFormat: OutputFormat.PNG,
        labelSize: LabelSize.FOUR_BY_SIX,
      });

      expect(result.data.map((r: { id: string }) => r.id)).toEqual(['c']);
    });

    it('filtra por rango de fechas inclusivo en ambos extremos', async () => {
      const { service } = buildService(mixed);

      const result = await service.getUserHistory('uid-1', {
        dateFrom: '2026-01-10T00:00:00.000Z',
        dateTo: '2026-01-20T00:00:00.000Z',
      });

      expect(result.data.map((r: { id: string }) => r.id)).toEqual(['c', 'b']);
    });

    it('un dateTo sin hora incluye las conversiones de ese mismo día', async () => {
      const { service } = buildService([
        record({ id: 'a', createdAt: new Date('2026-01-20T18:30:00.000Z') }),
        record({ id: 'b', createdAt: new Date('2026-01-21T00:00:01.000Z') }),
      ]);

      const result = await service.getUserHistory('uid-1', {
        dateTo: '2026-01-20',
      });

      expect(result.data.map((r: { id: string }) => r.id)).toEqual(['a']);
    });

    it('un dateTo con hora se respeta al instante exacto', async () => {
      const { service } = buildService([
        record({ id: 'a', createdAt: new Date('2026-01-20T10:00:00.000Z') }),
        record({ id: 'b', createdAt: new Date('2026-01-20T18:30:00.000Z') }),
      ]);

      const result = await service.getUserHistory('uid-1', {
        dateTo: '2026-01-20T12:00:00.000Z',
      });

      expect(result.data.map((r: { id: string }) => r.id)).toEqual(['a']);
    });

    it('busca por prefijo de jobId sin distinguir mayúsculas', async () => {
      const { service } = buildService([
        record({ id: 'a', jobId: 'ABC-123' }),
        record({ id: 'b', jobId: 'abd-999' }),
        record({ id: 'c', jobId: 'zzz-abc' }),
      ]);

      const result = await service.getUserHistory('uid-1', { search: 'abc' });

      expect(result.data.map((r: { id: string }) => r.id)).toEqual(['a']);
    });

    it('total refleja los filtros, no el total absoluto', async () => {
      const { service } = buildService(mixed);

      const result = await service.getUserHistory('uid-1', {
        status: HistoryStatus.COMPLETED,
        limit: 1,
      });

      expect(result.pagination.total).toBe(2);
      expect(result.pagination.totalPages).toBe(2);
      expect(result.data).toHaveLength(1);
    });
  });

  describe('respuesta', () => {
    it('incluye el id del documento de Firestore en cada ítem', async () => {
      const { service } = buildService([record({ id: 'doc-abc' })]);

      const result = await service.getUserHistory('uid-1', {});

      expect(result.data[0].id).toBe('doc-abc');
      expect(result.data[0].jobId).toBe('job-doc-abc');
    });

    it('serializa createdAt como ISO 8601', async () => {
      const { service } = buildService([
        record({ id: 'a', createdAt: new Date('2026-01-02T03:04:05.000Z') }),
      ]);

      const result = await service.getUserHistory('uid-1', {});

      expect(result.data[0].createdAt).toBe('2026-01-02T03:04:05.000Z');
    });

    it('expone los valores presentes en el historial como facets', async () => {
      const { service } = buildService([
        record({
          id: 'a',
          labelSize: LabelSize.FOUR_BY_SIX,
          outputFormat: OutputFormat.PDF,
          status: 'completed',
        }),
        record({
          id: 'b',
          labelSize: LabelSize.TWO_BY_ONE,
          outputFormat: OutputFormat.PDF,
          status: 'failed',
        }),
      ]);

      const result = await service.getUserHistory('uid-1', {});

      expect(result.facets).toEqual({
        labelSizes: ['2x1', '4x6'],
        outputFormats: ['pdf'],
        statuses: ['completed', 'failed'],
      });
    });

    it('los facets describen todo el historial, no la página filtrada', async () => {
      const { service } = buildService([
        record({ id: 'a', status: 'completed' }),
        record({ id: 'b', status: 'failed' }),
      ]);

      const result = await service.getUserHistory('uid-1', {
        status: HistoryStatus.COMPLETED,
      });

      expect(result.data).toHaveLength(1);
      expect(result.facets.statuses).toEqual(['completed', 'failed']);
    });
  });

  describe('firma de URLs', () => {
    it('solo firma los registros de la página devuelta', async () => {
      const records = Array.from({ length: 30 }, (_, i) =>
        record({ id: `r${i}` }),
      );
      const { service, generateSignedUrlForPath } = buildService(records);

      const result = await service.getUserHistory('uid-1', { limit: 5 });

      expect(result.data).toHaveLength(5);
      expect(generateSignedUrlForPath).toHaveBeenCalledTimes(5);
    });

    it('no firma las conversiones fallidas', async () => {
      const { service, generateSignedUrlForPath } = buildService([
        record({ id: 'a', status: 'failed', fileUrl: null }),
        record({ id: 'b', status: 'completed' }),
      ]);

      await service.getUserHistory('uid-1', {});

      expect(generateSignedUrlForPath).toHaveBeenCalledTimes(1);
    });

    it('conserva la URL original si la firma falla', async () => {
      const { service, generateSignedUrlForPath } = buildService([
        record({ id: 'a' }),
      ]);
      generateSignedUrlForPath.mockRejectedValue(new Error('storage caído'));

      const result = await service.getUserHistory('uid-1', {});

      expect(result.data[0].fileUrl).toBe(signedUrl('a.pdf'));
    });
  });

  describe('control de acceso', () => {
    it('rechaza a los planes sin historial', async () => {
      const { service } = buildService([], { id: 'uid-1', plan: 'lite' });

      await expect(service.getUserHistory('uid-1', {})).rejects.toThrow(
        'History is only available for Pro, Pro Max and Enterprise plans',
      );
    });

    it('permite a un admin sin simulación aunque su plan sea free', async () => {
      const { service } = buildService([record({ id: 'a' })], {
        id: 'uid-1',
        plan: 'free',
        role: 'admin',
      });

      const result = await service.getUserHistory('uid-1', {});

      expect(result.data).toHaveLength(1);
    });
  });

  describe('caché del escaneo', () => {
    it('reutiliza el escaneo entre requests consecutivas del mismo usuario', async () => {
      const { service, scanUserConversionHistory } = buildService([
        record({ id: 'a' }),
      ]);

      await service.getUserHistory('uid-1', { page: 1 });
      await service.getUserHistory('uid-1', { page: 1, search: 'job' });

      expect(scanUserConversionHistory).toHaveBeenCalledTimes(1);
      expect(scanUserConversionHistory).toHaveBeenCalledWith(
        'uid-1',
        MAX_HISTORY_SCAN,
      );
    });

    it('vuelve a leer cuando la entrada ha caducado', async () => {
      const { service, scanUserConversionHistory } = buildService([
        record({ id: 'a' }),
      ]);

      await service.getUserHistory('uid-1', {});
      service.historyScanCache.get('uid-1').expiresAt = Date.now() - 1;
      await service.getUserHistory('uid-1', {});

      expect(scanUserConversionHistory).toHaveBeenCalledTimes(2);
    });

    it('se invalida al registrar una conversión nueva', async () => {
      const { service, scanUserConversionHistory } = buildService([
        record({ id: 'a' }),
      ]);

      await service.getUserHistory('uid-1', {});
      service.invalidateHistoryScanCache('uid-1');
      await service.getUserHistory('uid-1', {});

      expect(scanUserConversionHistory).toHaveBeenCalledTimes(2);
    });
  });
});
