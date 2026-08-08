// Evitar la conexión real a Google Cloud Storage / Stripe al cargar el módulo.
jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: jest.fn() })),
}));
jest.mock('stripe', () => jest.fn());

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ForbiddenException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { UsersService, MAX_HISTORY_SCAN } from './users.service.js';
import { ZPL_RETENTION_DAYS } from '../../common/interfaces/conversion-history.interface.js';
import {
  GetHistoryQueryDto,
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
    service.historyCacheGeneration = 0;
    service.firestoreService = {
      getUserById: jest.fn().mockResolvedValue(user),
      scanUserConversionHistory,
      // Todos los registros tienen su ZPL guardado hoy salvo que un test diga
      // lo contrario; `canReconvert` se prueba aparte.
      getSavedZplDatesByJobId: jest
        .fn()
        .mockImplementation(
          async (jobIds: string[]) =>
            new Map(jobIds.map((jobId) => [jobId, new Date()])),
        ),
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
      // El servicio pide un documento de más; devolverlo significa que sobran.
      const overCap = Array.from({ length: MAX_HISTORY_SCAN + 1 }, (_, i) =>
        record({ id: `t${i}` }),
      );
      const { service } = buildService(overCap);

      const result = await service.getUserHistory('uid-1', { limit: 10 });

      expect(result.pagination.truncated).toBe(true);
      // El registro sobrante es solo la señal: no debe contarse como resultado.
      expect(result.pagination.total).toBe(MAX_HISTORY_SCAN);
    });

    it('no marca truncated con exactamente el tope de conversiones', async () => {
      const atCap = Array.from({ length: MAX_HISTORY_SCAN }, (_, i) =>
        record({ id: `t${i}` }),
      );
      const { service } = buildService(atCap);

      const result = await service.getUserHistory('uid-1', { limit: 10 });

      expect(result.pagination.truncated).toBeUndefined();
      expect(result.pagination.total).toBe(MAX_HISTORY_SCAN);
    });

    it('no marca truncated por debajo del tope', async () => {
      const { service } = buildService(many);

      const result = await service.getUserHistory('uid-1', {});

      expect(result.pagination.truncated).toBeUndefined();
    });

    it('pide un documento más que el tope, para detectar el corte', async () => {
      const { service, scanUserConversionHistory } = buildService([]);

      await service.getUserHistory('uid-1', {});

      expect(scanUserConversionHistory).toHaveBeenCalledWith(
        'uid-1',
        MAX_HISTORY_SCAN + 1,
      );
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

    it('filtra por un labelSize fuera del enum, como los que guarda el batch', async () => {
      // `BatchConvertDto.labelSize` es un string libre: el historial contiene
      // valores como `large` que los facets exponen y el filtro debe aceptar.
      const { service } = buildService([
        record({ id: 'a', labelSize: 'large' }),
        record({ id: 'b', labelSize: LabelSize.FOUR_BY_SIX }),
      ]);

      const result = await service.getUserHistory('uid-1', {
        labelSize: 'large',
      });

      expect(result.data.map((r: { id: string }) => r.id)).toEqual(['a']);
      expect(result.facets.labelSizes).toEqual(['4x6', 'large']);
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

    it('interpreta en UTC las fechas-hora sin offset', async () => {
      // `@IsDateString()` acepta `2026-01-20T12:00:00`; sin forzar UTC el corte
      // se movería con la zona del proceso (GMT-6 en local, UTC en Cloud Run).
      const { service } = buildService([
        record({ id: 'a', createdAt: new Date('2026-01-20T11:00:00.000Z') }),
        record({ id: 'b', createdAt: new Date('2026-01-20T13:00:00.000Z') }),
      ]);

      const result = await service.getUserHistory('uid-1', {
        dateTo: '2026-01-20T12:00:00',
      });

      expect(result.data.map((r: { id: string }) => r.id)).toEqual(['a']);
    });

    it('respeta un offset explícito distinto de UTC', async () => {
      const { service } = buildService([
        record({ id: 'a', createdAt: new Date('2026-01-20T17:00:00.000Z') }),
        record({ id: 'b', createdAt: new Date('2026-01-20T19:00:00.000Z') }),
      ]);

      // 12:00 en GMT-6 son las 18:00 UTC.
      const result = await service.getUserHistory('uid-1', {
        dateTo: '2026-01-20T12:00:00-06:00',
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

    it('no cachea un escaneo invalidado mientras estaba en vuelo', async () => {
      // Si `recordConversion` invalida durante el await, cachear el resultado
      // ocultaría la conversión recién guardada durante todo el TTL.
      const { service, scanUserConversionHistory } = buildService([
        record({ id: 'viejo' }),
      ]);
      scanUserConversionHistory.mockImplementationOnce(async () => {
        service.invalidateHistoryScanCache('uid-1');
        return [record({ id: 'viejo' })];
      });

      await service.getUserHistory('uid-1', {});

      expect(service.historyScanCache.has('uid-1')).toBe(false);

      // La siguiente request vuelve a leer y ve la conversión nueva.
      scanUserConversionHistory.mockResolvedValue([
        record({ id: 'nuevo' }),
        record({ id: 'viejo' }),
      ]);
      const result = await service.getUserHistory('uid-1', {});

      expect(result.data.map((r: { id: string }) => r.id)).toContain('nuevo');
      expect(scanUserConversionHistory).toHaveBeenCalledTimes(2);
    });
  });
});

/**
 * La validación del query es lo que separa un 400 con mensaje claro de un 500 o,
 * peor, de una respuesta con metadatos incoherentes.
 */
describe('GetHistoryQueryDto', () => {
  /** Reproduce lo que hace el ValidationPipe global (`transform: true`). */
  async function validateQuery(query: Record<string, string>) {
    const dto = plainToInstance(GetHistoryQueryDto, query, {
      enableImplicitConversion: false,
    });
    const errors = await validate(dto);
    return {
      dto,
      failed: errors.map((e) => e.property),
    };
  }

  it('acepta un query vacío y aplica los defaults', async () => {
    const { dto, failed } = await validateQuery({});

    expect(failed).toEqual([]);
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(25);
    expect(dto.sortBy).toBe(HistorySortBy.CREATED_AT);
    expect(dto.sortOrder).toBe(HistorySortOrder.DESC);
  });

  it('rechaza un limit fraccionario', async () => {
    // `Array.slice` truncaría el índice mientras `totalPages` conservaría el
    // divisor decimal: páginas de tamaño variable y metadatos incoherentes.
    const { failed } = await validateQuery({ limit: '2.5' });

    expect(failed).toContain('limit');
  });

  it('rechaza una page fraccionaria', async () => {
    const { failed } = await validateQuery({ page: '1.5' });

    expect(failed).toContain('page');
  });

  it('rechaza un limit por encima de 100', async () => {
    const { failed } = await validateQuery({ limit: '101' });

    expect(failed).toContain('limit');
  });

  it('rechaza page y limit por debajo de 1', async () => {
    expect((await validateQuery({ page: '0' })).failed).toContain('page');
    expect((await validateQuery({ limit: '0' })).failed).toContain('limit');
  });

  it('rechaza enums desconocidos', async () => {
    expect((await validateQuery({ status: 'pending' })).failed).toContain(
      'status',
    );
    expect((await validateQuery({ outputFormat: 'gif' })).failed).toContain(
      'outputFormat',
    );
    expect((await validateQuery({ sortBy: 'fileUrl' })).failed).toContain(
      'sortBy',
    );
  });

  it('rechaza fechas que no son ISO 8601', async () => {
    expect((await validateQuery({ dateFrom: '20-01-2026' })).failed).toContain(
      'dateFrom',
    );
    expect((await validateQuery({ dateFrom: '2026-13-45' })).failed).toContain(
      'dateFrom',
    );
  });

  it('rechaza fechas de calendario inexistentes', async () => {
    expect((await validateQuery({ dateFrom: '2026-02-30' })).failed).toContain(
      'dateFrom',
    );
    expect((await validateQuery({ dateTo: '2026-04-31' })).failed).toContain(
      'dateTo',
    );
  });

  it('rechaza el separador espacio, que Date.parse resuelve en zona local', async () => {
    const { failed } = await validateQuery({ dateFrom: '2026-01-20 12:00:00' });

    expect(failed).toContain('dateFrom');
  });

  it('rechaza el formato básico sin guiones, que Date.parse no entiende', async () => {
    // `20260120T120000Z` pasaría `@IsDateString()` pero da NaN al parsear: el
    // límite quedaría ignorado en silencio en vez de devolver un 400.
    expect(Number.isNaN(Date.parse('20260120T120000Z'))).toBe(true);

    const { failed } = await validateQuery({ dateTo: '20260120T120000Z' });

    expect(failed).toContain('dateTo');
  });

  it('acepta las formas de fecha que el frontend puede enviar', async () => {
    const validas = [
      '2026-01-20',
      '2026-01-20T12:00',
      '2026-01-20T12:00:00',
      '2026-01-20T12:00:00Z',
      '2026-01-20T12:00:00.999Z',
      '2026-01-20T12:00:00-06:00',
    ];

    for (const dateFrom of validas) {
      const { failed } = await validateQuery({ dateFrom });
      expect({ dateFrom, failed }).toEqual({ dateFrom, failed: [] });
      // Nada que pase la validación puede quedar sin parsear.
      expect(Number.isNaN(Date.parse(dateFrom))).toBe(false);
    }
  });

  it('acepta un labelSize fuera del enum', async () => {
    // Lo contrario rechazaría con 400 el valor que `facets.labelSizes` ofrece.
    const { failed } = await validateQuery({ labelSize: 'large' });

    expect(failed).toEqual([]);
  });

  it('acepta un query completo y válido', async () => {
    const { failed } = await validateQuery({
      page: '2',
      limit: '50',
      search: 'job-abc',
      status: 'completed',
      outputFormat: 'pdf',
      labelSize: '4x6',
      dateFrom: '2026-01-01',
      dateTo: '2026-01-31T23:59:59.999Z',
      sortBy: 'labelCount',
      sortOrder: 'asc',
    });

    expect(failed).toEqual([]);
  });
});

/**
 * Acciones del historial: borrar una fila y recuperar el ZPL original para
 * reconvertir.
 *
 * Dos riesgos concretos guían estos tests:
 *
 *  1. El id de `conversion_history` viaja en la URL. Sin comprobación de
 *     ownership, cualquier usuario con plan de pago leería el ZPL de otro —
 *     que es su dato de negocio (SKUs, direcciones, lotes).
 *  2. El contador mensual no puede depender del historial. Si borrar filas
 *     descontara PDFs, la cuota se reiniciaría vaciando la tabla.
 */
describe('UsersService — acciones sobre el historial', () => {
  const UID = 'uid-propietario';
  const OTRO_UID = 'uid-ajeno';
  const HISTORY_ID = 'hist-1';

  const diasAtras = (dias: number) =>
    new Date(Date.now() - dias * 24 * 60 * 60 * 1000);

  function registroDeHistorial(overrides: Record<string, unknown> = {}) {
    return {
      id: HISTORY_ID,
      userId: UID,
      jobId: 'job-1',
      labelCount: 3,
      labelSize: '4x6',
      status: 'completed',
      outputFormat: 'pdf',
      createdAt: new Date(),
      ...overrides,
    };
  }

  function buildService(overrides: {
    user?: Record<string, unknown> | null;
    record?: Record<string, unknown> | null;
    debugFile?: Record<string, unknown> | null;
    zplContent?: string | null;
    history?: Record<string, unknown>[];
    zplsGuardados?: Map<string, Date | null> | Error;
  }) {
    const firestoreService = {
      getUserById: jest
        .fn()
        .mockResolvedValue(
          overrides.user === undefined
            ? { id: UID, plan: 'pro', role: 'user' }
            : overrides.user,
        ),
      getConversionHistoryById: jest
        .fn()
        .mockResolvedValue(
          overrides.record === undefined
            ? registroDeHistorial()
            : overrides.record,
        ),
      deleteConversionHistory: jest.fn().mockResolvedValue(undefined),
      getZplDebugFileByJobId: jest
        .fn()
        .mockResolvedValue(
          overrides.debugFile === undefined
            ? { userId: UID, storagePath: 'debug-zpl/uid/2026-08-08/job-1.zpl' }
            : overrides.debugFile,
        ),
      scanUserConversionHistory: jest
        .fn()
        .mockResolvedValue(overrides.history ?? []),
      getSavedZplDatesByJobId: jest
        .fn()
        .mockImplementation((jobIds: string[]) => {
          if (overrides.zplsGuardados instanceof Error) {
            return Promise.reject(overrides.zplsGuardados);
          }
          // Por defecto, todos los jobs tienen su ZPL guardado hoy mismo.
          return Promise.resolve(
            overrides.zplsGuardados ??
              new Map(jobIds.map((jobId) => [jobId, new Date()])),
          );
        }),
      // Si algún camino intentara tocar la cuota, el test lo vería aquí.
      incrementUsage: jest.fn(),
      updateUsage: jest.fn(),
      resetUsage: jest.fn(),
    };

    const storageService = {
      readTextFile: jest
        .fn()
        .mockResolvedValue(
          overrides.zplContent === undefined
            ? '^XA^FDhola^FS^XZ'
            : overrides.zplContent,
        ),
      generateSignedUrlForPath: jest
        .fn()
        .mockResolvedValue('https://signed.example/file.pdf'),
    };

    const service = Object.create(UsersService.prototype) as any;
    Object.assign(service, {
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      historyScanCache: new Map(),
      historyCacheGeneration: 0,
      firestoreService,
      storageService,
    });

    return { service, firestoreService, storageService };
  }

  describe('deleteHistoryEntry', () => {
    it('borra el registro y devuelve el id', async () => {
      const { service, firestoreService } = buildService({});

      await expect(
        service.deleteHistoryEntry(UID, HISTORY_ID),
      ).resolves.toEqual({ id: HISTORY_ID, deleted: true });
      expect(firestoreService.deleteConversionHistory).toHaveBeenCalledWith(
        HISTORY_ID,
      );
    });

    it('no toca el uso mensual al borrar', async () => {
      // Si el borrado descontara PDFs del período, bastaría con vaciar el
      // historial para reiniciar la cuota del mes.
      const { service, firestoreService } = buildService({});

      await service.deleteHistoryEntry(UID, HISTORY_ID);

      expect(firestoreService.incrementUsage).not.toHaveBeenCalled();
      expect(firestoreService.updateUsage).not.toHaveBeenCalled();
      expect(firestoreService.resetUsage).not.toHaveBeenCalled();
    });

    it('invalida la caché del listado para que la fila no reaparezca', async () => {
      // El listado sirve de una caché de 60s: sin invalidarla, el usuario borra
      // una fila, la tabla se recarga y la fila sigue ahí.
      const { service } = buildService({
        history: [registroDeHistorial()],
      });
      await service.getUserHistory(UID, {});
      expect(service.historyScanCache.has(UID)).toBe(true);

      await service.deleteHistoryEntry(UID, HISTORY_ID);

      expect(service.historyScanCache.has(UID)).toBe(false);
    });

    it('responde 404 —no 403— ante un registro de otro usuario, y no lo borra', async () => {
      // Un 403 confirmaría que el id existe; el id va en la URL y es adivinable.
      const { service, firestoreService } = buildService({
        record: registroDeHistorial({ userId: OTRO_UID }),
      });

      await expect(
        service.deleteHistoryEntry(UID, HISTORY_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(firestoreService.deleteConversionHistory).not.toHaveBeenCalled();
    });

    it('responde 404 cuando el registro no existe', async () => {
      const { service } = buildService({ record: null });

      await expect(
        service.deleteHistoryEntry(UID, HISTORY_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rechaza a los planes sin historial antes de leer nada', async () => {
      const { service, firestoreService } = buildService({
        user: { id: UID, plan: 'lite', role: 'user' },
      });

      await expect(
        service.deleteHistoryEntry(UID, HISTORY_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(firestoreService.getConversionHistoryById).not.toHaveBeenCalled();
      expect(firestoreService.deleteConversionHistory).not.toHaveBeenCalled();
    });
  });

  describe('getHistoryZpl', () => {
    it('devuelve el ZPL con el tamaño y el formato del registro', async () => {
      const { service, storageService } = buildService({});

      await expect(service.getHistoryZpl(UID, HISTORY_ID)).resolves.toEqual({
        zplContent: '^XA^FDhola^FS^XZ',
        labelSize: '4x6',
        outputFormat: 'pdf',
      });
      expect(storageService.readTextFile).toHaveBeenCalledWith(
        'debug-zpl/uid/2026-08-08/job-1.zpl',
      );
    });

    it('responde 404 ante un registro de otro usuario, sin leer el ZPL', async () => {
      const { service, storageService, firestoreService } = buildService({
        record: registroDeHistorial({ userId: OTRO_UID }),
      });

      await expect(
        service.getHistoryZpl(UID, HISTORY_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(firestoreService.getZplDebugFileByJobId).not.toHaveBeenCalled();
      expect(storageService.readTextFile).not.toHaveBeenCalled();
    });

    it('responde 410 —no 500— cuando el archivo ya salió del bucket', async () => {
      // El lifecycle de `debug-zpl/` borra en GCS pero deja el doc de
      // `zpl_debug_files`: la ausencia solo se ve al leer el objeto.
      const { service } = buildService({ zplContent: null });

      await expect(
        service.getHistoryZpl(UID, HISTORY_ID),
      ).rejects.toBeInstanceOf(GoneException);
    });

    it('responde 410 cuando nunca se guardó el ZPL del job', async () => {
      // saveZplForDebug es fire-and-forget: puede haber fallado.
      const { service } = buildService({ debugFile: null });

      await expect(
        service.getHistoryZpl(UID, HISTORY_ID),
      ).rejects.toBeInstanceOf(GoneException);
    });

    it('rechaza a los planes sin historial', async () => {
      const { service } = buildService({
        user: { id: UID, plan: 'free', role: 'user' },
      });

      await expect(
        service.getHistoryZpl(UID, HISTORY_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('getUserHistory — flag canReconvert', () => {
    it('marca reconvertible lo que sigue dentro de la ventana de retención', async () => {
      const { service } = buildService({
        history: [registroDeHistorial({ createdAt: diasAtras(1) })],
      });

      const { data } = await service.getUserHistory(UID, {});

      expect(data[0].canReconvert).toBe(true);
    });

    it('marca no reconvertible lo que ya la superó', async () => {
      // El frontend deshabilita el botón con esto en vez de descubrirlo con un 410.
      const { service } = buildService({
        history: [
          registroDeHistorial({ createdAt: diasAtras(ZPL_RETENTION_DAYS + 1) }),
        ],
        zplsGuardados: new Map([['job-1', diasAtras(ZPL_RETENTION_DAYS + 1)]]),
      });

      const { data } = await service.getUserHistory(UID, {});

      expect(data[0].canReconvert).toBe(false);
    });

    it('cuenta la ventana desde que se guardó el ZPL, no desde la fila del historial', async () => {
      // El objeto se sube al empezar la conversión y la fila nace al terminarla:
      // en el borde de la ventana, fecharlo por el historial promete de más.
      const { service } = buildService({
        history: [
          registroDeHistorial({
            createdAt: diasAtras(ZPL_RETENTION_DAYS - 0.5),
          }),
        ],
        zplsGuardados: new Map([
          ['job-1', diasAtras(ZPL_RETENTION_DAYS + 0.5)],
        ]),
      });

      const { data } = await service.getUserHistory(UID, {});

      expect(data[0].canReconvert).toBe(false);
    });

    it('recurre a la fecha del historial si el doc de metadata no la trae', async () => {
      const { service } = buildService({
        history: [registroDeHistorial({ createdAt: diasAtras(1) })],
        zplsGuardados: new Map([['job-1', null]]),
      });

      const { data } = await service.getUserHistory(UID, {});

      expect(data[0].canReconvert).toBe(true);
    });

    it('no promete reconvertir una fila cuyo ZPL nunca se guardó', async () => {
      // Las filas que el flujo batch creó antes de que guardara el ZPL son
      // recientes pero irrecuperables: por edad saldrían como reconvertibles y
      // el botón devolvería 410 al pulsarlo.
      const { service } = buildService({
        history: [registroDeHistorial({ createdAt: diasAtras(1) })],
        zplsGuardados: new Map<string, Date | null>(),
      });

      const { data } = await service.getUserHistory(UID, {});

      expect(data[0].canReconvert).toBe(false);
    });

    it('degrada a no reconvertible si la consulta de ZPLs falla', async () => {
      // Un botón de más deshabilitado es preferible a prometer un 410, y a que
      // el listado entero reviente por un flag.
      const { service } = buildService({
        history: [registroDeHistorial({ createdAt: diasAtras(1) })],
        zplsGuardados: new Error('firestore caído'),
      });

      const { data } = await service.getUserHistory(UID, {});

      expect(data[0].canReconvert).toBe(false);
    });

    it('solo consulta los ZPLs de la página, no los del escaneo entero', async () => {
      // El escaneo llega hasta MAX_HISTORY_SCAN registros; resolver el flag para
      // todos costaría cientos de lecturas por request.
      const { service, firestoreService } = buildService({
        history: Array.from({ length: 40 }, (_, i) =>
          registroDeHistorial({ id: `hist-${i}`, jobId: `job-${i}` }),
        ),
      });

      await service.getUserHistory(UID, { limit: 10 });

      expect(firestoreService.getSavedZplDatesByJobId).toHaveBeenCalledWith(
        expect.arrayContaining(['job-0']),
      );
      expect(
        firestoreService.getSavedZplDatesByJobId.mock.calls[0][0],
      ).toHaveLength(10);
    });
  });
});
