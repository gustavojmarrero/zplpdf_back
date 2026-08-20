// Evitar la conexión real a Google Cloud Storage / Stripe al cargar el módulo.
jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: jest.fn() })),
}));
jest.mock('stripe', () => jest.fn());

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import sharp from 'sharp';
import {
  UsersService,
  MAX_HISTORY_SCAN,
  MAX_PROFILE_PHOTO_BYTES,
  MAX_PROFILE_PHOTO_PIXELS,
  MAX_RECONVERTIBLE_ZPL_SIZE_BYTES,
  PROFILE_PHOTO_SIZE_PX,
} from './users.service.js';
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
            new Map(
              jobIds.map((jobId) => [
                jobId,
                { createdAt: new Date(), fileSize: null },
              ]),
            ),
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

    /**
     * issue #94: antes era prefix-match, así que un jobId copiado a medias (el
     * tramo final de una URL de descarga, por ejemplo) no encontraba nada. 'c'
     * TERMINA en "abc" — con prefijo se quedaba fuera; con subcadena, no.
     */
    it('busca por subcadena de jobId, no solo por prefijo, sin distinguir mayúsculas', async () => {
      const { service } = buildService([
        record({ id: 'a', jobId: 'ABC-123' }),
        record({ id: 'b', jobId: 'abd-999' }),
        record({ id: 'c', jobId: 'zzz-abc' }),
      ]);

      const result = await service.getUserHistory('uid-1', { search: 'abc' });

      expect(result.data.map((r: { id: string }) => r.id)).toEqual(['a', 'c']);
    });

    /**
     * issue #94: `search` vuelve a ser multi-campo — labelSize y outputFormat
     * ya tenían filtros dedicados, pero el cuadro de búsqueda único debe seguir
     * cubriéndolos sin que el usuario tenga que saber en qué desplegable vive
     * cada cosa.
     */
    it('busca también por labelSize y por outputFormat', async () => {
      const { service } = buildService([
        record({
          id: 'a',
          labelSize: LabelSize.FOUR_BY_SIX,
          outputFormat: OutputFormat.PDF,
        }),
        record({
          id: 'b',
          labelSize: LabelSize.TWO_BY_ONE,
          outputFormat: OutputFormat.PNG,
        }),
      ]);

      const porLabelSize = await service.getUserHistory('uid-1', {
        search: '4x6',
      });
      expect(porLabelSize.data.map((r: { id: string }) => r.id)).toEqual(['a']);

      const porOutputFormat = await service.getUserHistory('uid-1', {
        search: 'png',
      });
      expect(porOutputFormat.data.map((r: { id: string }) => r.id)).toEqual([
        'b',
      ]);
    });

    /**
     * issue #94: labelCount entra en el barrido solo cuando el término es
     * numérico, para que "50" encuentre tanto un jobId que lo contenga como
     * una fila con 50 o 150 etiquetas.
     */
    it('busca por labelCount cuando el término es numérico', async () => {
      const { service } = buildService([
        record({ id: 'a', labelCount: 50, jobId: 'job-a' }),
        record({ id: 'b', labelCount: 150, jobId: 'job-b' }),
        record({ id: 'c', labelCount: 7, jobId: 'job-c' }),
      ]);

      const result = await service.getUserHistory('uid-1', { search: '50' });

      expect(result.data.map((r: { id: string }) => r.id)).toEqual(['a', 'b']);
    });

    it('un término que no aparece en ningún campo cubierto no devuelve nada', async () => {
      const { service } = buildService(mixed);

      const result = await service.getUserHistory('uid-1', {
        search: 'no-existe-en-nada',
      });

      expect(result.data).toHaveLength(0);
      expect(result.pagination.total).toBe(0);
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
    zplsGuardados?:
      | Map<string, { createdAt: Date | null; fileSize: number | null }>
      | Error;
    preserveLastActivityAtError?: Error;
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
      preserveLastActivityAt: overrides.preserveLastActivityAtError
        ? jest.fn().mockRejectedValue(overrides.preserveLastActivityAtError)
        : jest.fn().mockResolvedValue(undefined),
      getZplDebugFileByJobId: jest.fn().mockResolvedValue(
        overrides.debugFile === undefined
          ? {
              userId: UID,
              storagePath: 'debug-zpl/uid/2026-08-08/job-1.zpl',
              createdAt: new Date(),
            }
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
              new Map(
                jobIds.map((jobId) => [
                  jobId,
                  { createdAt: new Date(), fileSize: null },
                ]),
              ),
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

    it('preserva la actividad del registro antes de borrarlo y no bloquea el borrado si falla', async () => {
      const createdAt = diasAtras(1);
      const { service, firestoreService } = buildService({
        user: {
          id: UID,
          plan: 'pro',
          role: 'user',
          lastActivityAt: diasAtras(30),
        },
        record: registroDeHistorial({ createdAt }),
      });

      await service.deleteHistoryEntry(UID, HISTORY_ID);

      expect(firestoreService.preserveLastActivityAt).toHaveBeenCalledWith(
        UID,
        createdAt,
      );
      expect(
        firestoreService.preserveLastActivityAt.mock.invocationCallOrder[0],
      ).toBeLessThan(
        firestoreService.deleteConversionHistory.mock.invocationCallOrder[0],
      );

      const fallo = buildService({
        preserveLastActivityAtError: new Error('Firestore no disponible'),
      });

      await expect(
        fallo.service.deleteHistoryEntry(UID, HISTORY_ID),
      ).resolves.toEqual({ id: HISTORY_ID, deleted: true });
      expect(fallo.firestoreService.deleteConversionHistory).toHaveBeenCalled();
      expect(fallo.service.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to preserve lastActivityAt'),
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

    it('normaliza el tamaño del batch al valor que acepta POST /zpl/convert', async () => {
      // El batch guarda el tamaño como llegó (`large`), pero ConvertZplDto lo
      // valida con @IsEnum(LabelSize): devolverlo crudo haría que reconvertir
      // fallara con un 400 usando el tamaño con el que ya funcionó.
      const { service } = buildService({
        record: registroDeHistorial({ labelSize: 'large' }),
      });

      const { labelSize } = await service.getHistoryZpl(UID, HISTORY_ID);

      expect(labelSize).toBe('4x6');
    });

    it('devuelve 2x1 para un tamaño desconocido, que es con el que se convirtió', async () => {
      const { service } = buildService({
        record: registroDeHistorial({ labelSize: '4x4' }),
      });

      const { labelSize } = await service.getHistoryZpl(UID, HISTORY_ID);

      expect(labelSize).toBe('2x1');
    });

    it('normaliza el alias jpg al valor JPEG que acepta la reconversión', async () => {
      const { service } = buildService({
        record: registroDeHistorial({ outputFormat: 'jpg' }),
      });

      const { outputFormat } = await service.getHistoryZpl(UID, HISTORY_ID);

      expect(outputFormat).toBe('jpeg');
    });

    it('devuelve JPEG para PDF porque el batch lo procesó como imagen', async () => {
      // `processBatchFiles` compara con `pdf` antes de elegir la rama de
      // imagen; `PDF` cae en JPEG aunque parezca un alias natural de PDF.
      const { service } = buildService({
        record: registroDeHistorial({ outputFormat: 'PDF' }),
      });

      const { outputFormat } = await service.getHistoryZpl(UID, HISTORY_ID);

      expect(outputFormat).toBe('jpeg');
    });

    it('devuelve JPEG para un formato desconocido, igual que el batch', async () => {
      const { service } = buildService({
        record: registroDeHistorial({ outputFormat: 'webp' }),
      });

      const { outputFormat } = await service.getHistoryZpl(UID, HISTORY_ID);

      expect(outputFormat).toBe('jpeg');
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

    it('responde 410 sin leer GCS cuando el ZPL ya superó la retención', async () => {
      // El lifecycle puede tardar en borrar el objeto; su existencia física no
      // debe ampliar el plazo que el endpoint promete al usuario.
      const { service, storageService } = buildService({
        debugFile: {
          userId: UID,
          storagePath: 'debug-zpl/uid/2026-08-08/job-1.zpl',
          createdAt: diasAtras(ZPL_RETENTION_DAYS + 1),
        },
      });

      await expect(
        service.getHistoryZpl(UID, HISTORY_ID),
      ).rejects.toBeInstanceOf(GoneException);
      expect(storageService.readTextFile).not.toHaveBeenCalled();
    });

    it('usa la fecha reciente del historial cuando la metadata no trae createdAt', async () => {
      const { service, storageService } = buildService({
        record: registroDeHistorial({ createdAt: diasAtras(1) }),
        debugFile: {
          userId: UID,
          storagePath: 'debug-zpl/uid/2026-08-08/job-1.zpl',
        },
      });

      await expect(service.getHistoryZpl(UID, HISTORY_ID)).resolves.toEqual({
        zplContent: '^XA^FDhola^FS^XZ',
        labelSize: '4x6',
        outputFormat: 'pdf',
      });
      expect(storageService.readTextFile).toHaveBeenCalledWith(
        'debug-zpl/uid/2026-08-08/job-1.zpl',
      );
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
        zplsGuardados: new Map([
          [
            'job-1',
            {
              createdAt: diasAtras(ZPL_RETENTION_DAYS + 1),
              fileSize: null,
            },
          ],
        ]),
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
          [
            'job-1',
            {
              createdAt: diasAtras(ZPL_RETENTION_DAYS + 0.5),
              fileSize: null,
            },
          ],
        ]),
      });

      const { data } = await service.getUserHistory(UID, {});

      expect(data[0].canReconvert).toBe(false);
    });

    it('recurre a la fecha del historial si el doc de metadata no la trae', async () => {
      const { service } = buildService({
        history: [registroDeHistorial({ createdAt: diasAtras(1) })],
        zplsGuardados: new Map([
          ['job-1', { createdAt: null, fileSize: null }],
        ]),
      });

      const { data } = await service.getUserHistory(UID, {});

      expect(data[0].canReconvert).toBe(true);
    });

    it('no promete reconvertir un ZPL cuyo tamaño conocido supera el tope del body', async () => {
      const { service } = buildService({
        history: [registroDeHistorial({ createdAt: diasAtras(1) })],
        zplsGuardados: new Map([
          [
            'job-1',
            {
              createdAt: diasAtras(1),
              fileSize: MAX_RECONVERTIBLE_ZPL_SIZE_BYTES + 1,
            },
          ],
        ]),
      });

      const { data } = await service.getUserHistory(UID, {});

      expect(data[0].canReconvert).toBe(false);
    });

    it('permite reconvertir un ZPL cuyo tamaño conocido queda bajo el tope', async () => {
      const { service } = buildService({
        history: [registroDeHistorial({ createdAt: diasAtras(1) })],
        zplsGuardados: new Map([
          [
            'job-1',
            {
              createdAt: diasAtras(1),
              fileSize: MAX_RECONVERTIBLE_ZPL_SIZE_BYTES - 1,
            },
          ],
        ]),
      });

      const { data } = await service.getUserHistory(UID, {});

      expect(data[0].canReconvert).toBe(true);
    });

    it('no bloquea la reconversión cuando la metadata antigua no trae tamaño', async () => {
      const { service } = buildService({
        history: [registroDeHistorial({ createdAt: diasAtras(1) })],
        zplsGuardados: new Map([
          ['job-1', { createdAt: diasAtras(1), fileSize: null }],
        ]),
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
        zplsGuardados: new Map<
          string,
          { createdAt: Date | null; fileSize: number | null }
        >(),
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
      //
      // Cada registro lleva su propia fecha, decreciente: con la fecha por
      // defecto los 40 `new Date()` caen en el mismo milisegundo casi siempre,
      // pero si el bucle cruza uno el orden cambia y con él la página.
      const { service, firestoreService } = buildService({
        history: Array.from({ length: 40 }, (_, i) =>
          registroDeHistorial({
            id: `hist-${i}`,
            jobId: `job-${i}`,
            createdAt: new Date(Date.now() - i * 60_000),
          }),
        ),
      });

      await service.getUserHistory(UID, { limit: 10 });

      // Los diez más recientes, en orden: nada del resto del escaneo.
      expect(firestoreService.getSavedZplDatesByJobId).toHaveBeenCalledWith(
        Array.from({ length: 10 }, (_, i) => `job-${i}`),
      );
    });
  });
});

/**
 * La foto de perfil no podía guardarse en ningún sitio (issue #106): Firebase
 * Storage está deshabilitado en el proyecto, así que el avatar vive en el bucket
 * público de GCS. Lo que estos tests protegen es que la imagen se valide por su
 * contenido, que salga normalizada y que la URL llegue TAMBIÉN a Firebase Auth:
 * sin eso el claim `picture` del token sigue sirviendo la foto de Google.
 */
describe('UsersService — foto de perfil', () => {
  const UID = 'uid-foto';
  const PUBLIC_URL = `https://storage.googleapis.com/zplpdf-public-assets/users/${UID}/avatar.webp`;

  function buildService(user: Record<string, unknown> | null = { id: UID }) {
    const firestoreService = {
      getUserById: jest.fn().mockResolvedValue(user),
      updateUser: jest.fn().mockResolvedValue(undefined),
    };
    const firebaseAdminService = {
      updateUser: jest.fn().mockResolvedValue({}),
      getUser: jest.fn().mockResolvedValue({ emailVerified: true }),
    };
    const storageService = {
      readPublicFile: jest.fn().mockResolvedValue(null),
      savePublicFile: jest
        .fn()
        .mockResolvedValue({ url: PUBLIC_URL, generation: '17' }),
      deletePublicFile: jest.fn().mockResolvedValue(undefined),
    };

    const service: any = Object.create(UsersService.prototype);
    service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    service.firestoreService = firestoreService;
    service.firebaseAdminService = firebaseAdminService;
    service.storageService = storageService;
    service.profilePhotoOperations = new Map<string, Promise<void>>();

    return { service, firestoreService, firebaseAdminService, storageService };
  }

  function promesaControlada(): {
    promise: Promise<void>;
    resolve: () => void;
  } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });

    return { promise, resolve };
  }

  async function imagen(
    formato: 'png' | 'jpeg' | 'webp' | 'gif',
    width = 800,
    height = 400,
  ): Promise<Buffer> {
    const base = sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 10, g: 120, b: 200 },
      },
    });

    return formato === 'gif'
      ? base.gif().toBuffer()
      : base.toFormat(formato).toBuffer();
  }

  function upload(buffer: Buffer): Express.Multer.File {
    return {
      buffer,
      size: buffer.length,
      mimetype: 'image/png',
      originalname: 'avatar.png',
    } as Express.Multer.File;
  }

  function crc32(buffer: Buffer): number {
    let crc = 0xffffffff;

    for (const byte of buffer) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }

    return (crc ^ 0xffffffff) >>> 0;
  }

  async function pngWithDeclaredDimensions(
    width: number,
    height: number,
  ): Promise<Buffer> {
    // Partimos de un PNG real de 1x1 y cambiamos solo su IHDR. `metadata()` lee
    // las dimensiones declaradas sin decodificar el IDAT, de modo que podemos
    // probar una cabecera de 42 MP con apenas unos bytes y sin agotar el runner.
    const png = await imagen('png', 1, 1);
    png.writeUInt32BE(width, 16);
    png.writeUInt32BE(height, 20);
    png.writeUInt32BE(crc32(png.subarray(12, 29)), 29);

    return png;
  }

  describe('validación', () => {
    it('rechaza la petición sin archivo con NO_FILES', async () => {
      const { service } = buildService();

      await expect(service.uploadProfilePhoto(UID, undefined)).rejects.toThrow(
        BadRequestException,
      );
      await expect(
        service.uploadProfilePhoto(UID, undefined),
      ).rejects.toMatchObject({
        response: { error: 'NO_FILES' },
      });
    });

    it('rechaza por peso con IMAGE_TOO_LARGE y no toca Storage', async () => {
      const { service, storageService } = buildService();
      const grande = upload(Buffer.alloc(MAX_PROFILE_PHOTO_BYTES + 1));

      await expect(
        service.uploadProfilePhoto(UID, grande),
      ).rejects.toMatchObject({
        status: 413,
        response: { error: 'IMAGE_TOO_LARGE' },
      });
      expect(storageService.savePublicFile).not.toHaveBeenCalled();
    });

    it('rechaza un formato no admitido con UNSUPPORTED_IMAGE_TYPE', async () => {
      // GIF: sharp sabe leerlo, así que llega hasta la lista de formatos. Es el
      // caso que distingue "no es una imagen" de "es una imagen que no sirve".
      const { service, storageService } = buildService();

      await expect(
        service.uploadProfilePhoto(UID, upload(await imagen('gif'))),
      ).rejects.toMatchObject({
        status: 400,
        response: { error: 'UNSUPPORTED_IMAGE_TYPE' },
      });
      expect(storageService.savePublicFile).not.toHaveBeenCalled();
    });

    it('rechaza con IMAGE_TOO_LARGE una imagen de dimensiones desorbitadas', () => {
      // El tope de 2 MB no acota el trabajo de decodificar: un PNG muy
      // comprimido cabe de sobra declarando decenas de miles de píxeles por
      // lado, y descomprimirlo cuesta gigabytes. Se mide antes de decodificar,
      // así que la prueba va sobre las dimensiones y no sobre un archivo real
      // de 40 MP, que no cabría en la memoria del runner.
      const { service } = buildService();

      expect(() =>
        service.assertWithinPixelBudget('png', 30_000, 30_000),
      ).toThrow(PayloadTooLargeException);
      try {
        service.assertWithinPixelBudget('png', 30_000, 30_000);
      } catch (error: any) {
        expect(error.response).toMatchObject({
          error: 'IMAGE_TOO_LARGE',
          data: { maxPixels: MAX_PROFILE_PHOTO_PIXELS, pixels: 900_000_000 },
        });
      }
    });

    it('rechaza por el camino real de upload una cabecera de más de 40 MP', async () => {
      const { service, storageService } = buildService();
      const width = 7000;
      const height = 6000;
      const png = await pngWithDeclaredDimensions(width, height);

      expect(png.length).toBeLessThan(1024);
      await expect(
        service.uploadProfilePhoto(UID, upload(png)),
      ).rejects.toMatchObject({
        status: 413,
        response: {
          error: 'IMAGE_TOO_LARGE',
          data: {
            maxPixels: MAX_PROFILE_PHOTO_PIXELS,
            pixels: width * height,
            width,
            height,
          },
        },
      });
      expect(storageService.savePublicFile).not.toHaveBeenCalled();
    });

    it('deja pasar una foto de cámara normal', () => {
      // 24 MP (6000x4000) es una réflex cualquiera: el tope está para las bombas
      // de descompresión, no para las fotos de los usuarios.
      const { service } = buildService();

      expect(() =>
        service.assertWithinPixelBudget('jpeg', 6000, 4000),
      ).not.toThrow();
    });

    it('trata como formato inválido lo que no declara dimensiones', () => {
      const { service } = buildService();

      expect(() =>
        service.assertWithinPixelBudget('png', undefined, 10),
      ).toThrow(BadRequestException);
    });

    it('rechaza como 400 una imagen cuya cabecera es válida pero el cuerpo no', async () => {
      // Un PNG truncado pasa el examen de `metadata()` y revienta al decodificar.
      // Sigue siendo entrada inválida: como 500 diríamos que el fallo es nuestro
      // y el frontend se quedaría sin código que traducir.
      const { service, storageService } = buildService();
      const png = await imagen('png');

      await expect(
        service.uploadProfilePhoto(UID, upload(png.subarray(0, 120))),
      ).rejects.toMatchObject({
        status: 400,
        response: { error: 'UNSUPPORTED_IMAGE_TYPE' },
      });
      expect(storageService.savePublicFile).not.toHaveBeenCalled();
    });

    it('rechaza un archivo que no es una imagen', async () => {
      const { service } = buildService();

      await expect(
        service.uploadProfilePhoto(UID, upload(Buffer.from('no soy una foto'))),
      ).rejects.toMatchObject({
        response: { error: 'UNSUPPORTED_IMAGE_TYPE' },
      });
    });

    it.each(['png', 'jpeg', 'webp'] as const)('acepta %s', async (formato) => {
      const { service, storageService } = buildService();

      await service.uploadProfilePhoto(UID, upload(await imagen(formato)));

      expect(storageService.savePublicFile).toHaveBeenCalledTimes(1);
    });

    it('responde USER_NOT_FOUND si el perfil no existe', async () => {
      const { service, storageService } = buildService(null);

      await expect(
        service.uploadProfilePhoto(UID, upload(await imagen('png'))),
      ).rejects.toMatchObject({
        status: 404,
        response: { error: 'USER_NOT_FOUND' },
      });
      expect(storageService.savePublicFile).not.toHaveBeenCalled();
    });
  });

  describe('normalización y guardado', () => {
    it('recorta a cuadrado y reescala a 256 px en WebP', async () => {
      const { service, storageService } = buildService();

      await service.uploadProfilePhoto(
        UID,
        upload(await imagen('png', 800, 400)),
      );

      const [path, buffer, contentType] =
        storageService.savePublicFile.mock.calls[0];
      expect(path).toBe(`users/${UID}/avatar.webp`);
      expect(contentType).toBe('image/webp');

      const meta = await sharp(buffer).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.width).toBe(PROFILE_PHOTO_SIZE_PX);
      expect(meta.height).toBe(PROFILE_PHOTO_SIZE_PX);
      // El original pesa lo suyo; servirlo tal cual para pintarlo en 64 px es
      // justo lo que el endpoint evita.
      expect(buffer.length).toBeLessThan(MAX_PROFILE_PHOTO_BYTES);
    });

    it('guarda siempre en la misma ruta para no dejar huérfanos', async () => {
      const { service, storageService } = buildService();

      await service.uploadProfilePhoto(UID, upload(await imagen('png')));
      await service.uploadProfilePhoto(UID, upload(await imagen('jpeg')));

      const rutas = storageService.savePublicFile.mock.calls.map(
        ([path]: [string]) => path,
      );
      expect(new Set(rutas).size).toBe(1);
    });

    it('devuelve la URL con versión y la escribe en Firestore y en Firebase Auth', async () => {
      const { service, firestoreService, firebaseAdminService } =
        buildService();

      const { photoURL } = await service.uploadProfilePhoto(
        UID,
        upload(await imagen('png')),
      );

      expect(photoURL).toMatch(new RegExp(`^${PUBLIC_URL}\\?v=\\d+$`));
      // Los dos destinos con la MISMA url: si Auth se queda con otra, el claim
      // `picture` del token y el perfil muestran fotos distintas.
      expect(firebaseAdminService.updateUser).toHaveBeenCalledWith(UID, {
        photoURL,
      });
      expect(firestoreService.updateUser).toHaveBeenCalledWith(UID, {
        photoURL,
      });
    });

    it('no escribe en Firestore si Firebase Auth falla', async () => {
      // Al revés dejaría el perfil apuntando a una foto que el token ignora, que
      // es exactamente la incoherencia que este endpoint viene a cerrar.
      const { service, firestoreService, firebaseAdminService } =
        buildService();
      firebaseAdminService.updateUser.mockRejectedValue(
        new Error('auth caído'),
      );

      await expect(
        service.uploadProfilePhoto(UID, upload(await imagen('png'))),
      ).rejects.toThrow('auth caído');
      expect(firestoreService.updateUser).not.toHaveBeenCalled();
    });

    it('devuelve Firebase Auth a su foto anterior si Firestore falla', async () => {
      // Firestore es lo que lee `GET /users/me`: sin revertir, el token pintaría
      // la foto nueva y el perfil la vieja, y ese desajuste no se corrige solo.
      const { service, firestoreService, firebaseAdminService } =
        buildService();
      firebaseAdminService.getUser.mockResolvedValue({
        emailVerified: true,
        photoURL: 'https://lh3.googleusercontent.com/foto-de-google',
      });
      firestoreService.updateUser.mockRejectedValue(
        new Error('firestore caído'),
      );

      await expect(
        service.uploadProfilePhoto(UID, upload(await imagen('png'))),
      ).rejects.toThrow('firestore caído');

      expect(firebaseAdminService.updateUser).toHaveBeenLastCalledWith(UID, {
        photoURL: 'https://lh3.googleusercontent.com/foto-de-google',
      });
    });

    it('devuelve los bytes anteriores si el perfil no llega a confirmarse', async () => {
      // La ruta es fija, así que la subida ya pisó la foto vieja: revertir solo
      // la URL dejaría al usuario con la imagen nueva pese al error.
      const { service, firestoreService, storageService } = buildService();
      const anterior = Buffer.from('foto-anterior');
      storageService.readPublicFile.mockResolvedValue(anterior);
      firestoreService.updateUser.mockRejectedValue(
        new Error('firestore caído'),
      );

      await expect(
        service.uploadProfilePhoto(UID, upload(await imagen('png'))),
      ).rejects.toThrow('firestore caído');

      expect(storageService.savePublicFile).toHaveBeenLastCalledWith(
        `users/${UID}/avatar.webp`,
        anterior,
        'image/webp',
        // Condicionada a la generación que escribió esta subida: si otra ya
        // confirmó una foto más nueva, no se pisa.
        { ifGenerationMatch: '17' },
      );
    });

    it('borra el objeto si falla y el usuario no tenía foto antes', async () => {
      const { service, firestoreService, storageService } = buildService();
      storageService.readPublicFile.mockResolvedValue(null);
      firestoreService.updateUser.mockRejectedValue(
        new Error('firestore caído'),
      );

      await expect(
        service.uploadProfilePhoto(UID, upload(await imagen('png'))),
      ).rejects.toThrow('firestore caído');

      expect(storageService.deletePublicFile).toHaveBeenCalledWith(
        `users/${UID}/avatar.webp`,
        { ifGenerationMatch: '17' },
      );
    });

    it('no pisa la foto que otra subida ya confirmó', async () => {
      // El 412 de GCS es la señal de que la generación cambió: la compensación
      // llega tarde y lo correcto es no tocar nada.
      const { service, firestoreService, storageService } = buildService();
      storageService.readPublicFile.mockResolvedValue(Buffer.from('anterior'));
      firestoreService.updateUser.mockRejectedValue(
        new Error('firestore caído'),
      );
      storageService.savePublicFile
        .mockResolvedValueOnce({ url: PUBLIC_URL, generation: '17' })
        .mockRejectedValueOnce(
          Object.assign(new Error('generation mismatch'), { code: 412 }),
        );

      await expect(
        service.uploadProfilePhoto(UID, upload(await imagen('png'))),
      ).rejects.toThrow('firestore caído');
    });

    it('propaga el error original aunque la restauración falle', async () => {
      const { service, firestoreService, storageService } = buildService();
      storageService.readPublicFile.mockResolvedValue(Buffer.from('anterior'));
      firestoreService.updateUser.mockRejectedValue(
        new Error('firestore caído'),
      );
      storageService.savePublicFile
        .mockResolvedValueOnce({ url: PUBLIC_URL, generation: '17' })
        .mockRejectedValueOnce(new Error('gcs caído'));

      await expect(
        service.uploadProfilePhoto(UID, upload(await imagen('png'))),
      ).rejects.toThrow('firestore caído');
    });

    it('no revierte a un valor inventado si no pudo leer la foto anterior', async () => {
      // Revertir a `null` sin saber qué había borraría de Auth la foto del
      // proveedor de acceso de quien nunca subió ninguna.
      const { service, firestoreService, firebaseAdminService } =
        buildService();
      firebaseAdminService.getUser.mockRejectedValue(new Error('auth caído'));
      firestoreService.updateUser.mockRejectedValue(
        new Error('firestore caído'),
      );

      await expect(
        service.uploadProfilePhoto(UID, upload(await imagen('png'))),
      ).rejects.toThrow('firestore caído');

      // Solo la escritura de la foto nueva: ninguna reversión a ciegas.
      expect(firebaseAdminService.updateUser).toHaveBeenCalledTimes(1);
    });
  });

  describe('coordinación para que objeto y perfil no se contradigan', () => {
    it('no deja que una subida publique la imagen escrita por la otra', async () => {
      // La primera queda detenida después de guardar sus bytes. Sin una sección
      // crítica compartida, la segunda pisaría el objeto antes de que la primera
      // publicara su URL, dejando esa URL asociada a los bytes equivocados.
      const { service, firestoreService, storageService } = buildService();
      const primeraPublicando = promesaControlada();
      const liberarPrimera = promesaControlada();
      const segundaNormalizada = promesaControlada();

      service.normalizeProfilePhoto = jest
        .fn()
        .mockResolvedValueOnce(Buffer.from('normalizada-1'))
        .mockImplementationOnce(async () => {
          segundaNormalizada.resolve();
          return Buffer.from('normalizada-2');
        });
      firestoreService.updateUser.mockImplementationOnce(async () => {
        primeraPublicando.resolve();
        await liberarPrimera.promise;
      });
      storageService.savePublicFile
        .mockResolvedValueOnce({ url: PUBLIC_URL, generation: '17' })
        .mockResolvedValueOnce({ url: PUBLIC_URL, generation: '18' });

      const primera = service.uploadProfilePhoto(
        UID,
        upload(Buffer.from('original-1')),
      );
      await primeraPublicando.promise;

      const segunda = service.uploadProfilePhoto(
        UID,
        upload(Buffer.from('original-2')),
      );
      await segundaNormalizada.promise;
      await Promise.resolve();

      expect(storageService.savePublicFile).toHaveBeenCalledTimes(1);

      liberarPrimera.resolve();
      await Promise.all([primera, segunda]);

      expect(storageService.savePublicFile).toHaveBeenCalledTimes(2);
      expect(
        firestoreService.updateUser.mock.invocationCallOrder[0],
      ).toBeLessThan(storageService.savePublicFile.mock.invocationCallOrder[1]);
      expect(service.profilePhotoOperations.size).toBe(0);
    });

    it('no borra la generación que una subida simultánea acaba de publicar', async () => {
      // El borrado queda detenido después de limpiar el perfil. Sin compartir la
      // misma cola, una subida podría guardar y publicar su foto en ese hueco y
      // el DELETE borraría después justo el objeto que el perfil nuevo referencia.
      const { service, firestoreService, storageService } = buildService();
      const borradoEnStorage = promesaControlada();
      const liberarBorrado = promesaControlada();
      const subidaNormalizada = promesaControlada();

      storageService.deletePublicFile.mockImplementationOnce(async () => {
        borradoEnStorage.resolve();
        await liberarBorrado.promise;
      });
      service.normalizeProfilePhoto = jest.fn(async () => {
        subidaNormalizada.resolve();
        return Buffer.from('normalizada-nueva');
      });

      const borrado = service.deleteProfilePhoto(UID);
      await borradoEnStorage.promise;

      const subida = service.uploadProfilePhoto(
        UID,
        upload(Buffer.from('original-nuevo')),
      );
      await subidaNormalizada.promise;
      await Promise.resolve();

      expect(storageService.savePublicFile).not.toHaveBeenCalled();

      liberarBorrado.resolve();
      await Promise.all([borrado, subida]);

      expect(
        storageService.deletePublicFile.mock.invocationCallOrder[0],
      ).toBeLessThan(storageService.savePublicFile.mock.invocationCallOrder[0]);
      expect(firestoreService.updateUser).toHaveBeenLastCalledWith(UID, {
        photoURL: expect.stringMatching(new RegExp(`^${PUBLIC_URL}\\?v=\\d+$`)),
      });
      expect(service.profilePhotoOperations.size).toBe(0);
    });
  });

  describe('borrado', () => {
    it('borra el objeto y deja photoURL a null en los dos sitios', async () => {
      const {
        service,
        firestoreService,
        firebaseAdminService,
        storageService,
      } = buildService();

      await service.deleteProfilePhoto(UID);

      expect(storageService.deletePublicFile).toHaveBeenCalledWith(
        `users/${UID}/avatar.webp`,
      );
      expect(firebaseAdminService.updateUser).toHaveBeenCalledWith(UID, {
        photoURL: null,
      });
      expect(firestoreService.updateUser).toHaveBeenCalledWith(UID, {
        photoURL: null,
      });
    });

    it('limpia el perfil antes de borrar el objeto', async () => {
      // Borrar el archivo es el único paso irreversible: hacerlo primero dejaría
      // —si luego falla una escritura— un perfil apuntando a un 404.
      const { service, firestoreService, storageService } = buildService();

      await service.deleteProfilePhoto(UID);

      expect(
        firestoreService.updateUser.mock.invocationCallOrder[0],
      ).toBeLessThan(
        storageService.deletePublicFile.mock.invocationCallOrder[0],
      );
    });

    it('no borra el objeto si el perfil no llegó a limpiarse', async () => {
      const { service, firestoreService, storageService } = buildService();
      firestoreService.updateUser.mockRejectedValue(
        new Error('firestore caído'),
      );

      await expect(service.deleteProfilePhoto(UID)).rejects.toThrow(
        'firestore caído',
      );
      expect(storageService.deletePublicFile).not.toHaveBeenCalled();
    });

    it('responde USER_NOT_FOUND si el perfil no existe', async () => {
      const { service, storageService } = buildService(null);

      await expect(service.deleteProfilePhoto(UID)).rejects.toMatchObject({
        status: 404,
        response: { error: 'USER_NOT_FOUND' },
      });
      expect(storageService.deletePublicFile).not.toHaveBeenCalled();
    });
  });

  describe('resolveProfilePhotoURL', () => {
    it('prefiere la foto subida sobre la del proveedor', () => {
      const { service } = buildService();

      expect(
        service.resolveProfilePhotoURL({ photoURL: 'propia' }, 'google'),
      ).toBe('propia');
    });

    it('cae en la del proveedor si el usuario nunca subió ninguna', () => {
      const { service } = buildService();

      expect(service.resolveProfilePhotoURL({}, 'google')).toBe('google');
    });

    it('no resucita la de Google cuando el usuario borró la suya', () => {
      // `null` es "la quitó a propósito": devolver la de Google haría que el
      // DELETE pareciera no haber hecho nada.
      const { service } = buildService();

      expect(
        service.resolveProfilePhotoURL({ photoURL: null }, 'google'),
      ).toBeUndefined();
    });
  });
});

/**
 * Sin persistencia, los interruptores de la pantalla de ajustes serían
 * decorativos: el frontend no los pinta hasta que estos dos métodos existen
 * (issue #99).
 */
describe('UsersService — preferencias de notificación', () => {
  function buildService(user: Record<string, unknown> | null) {
    const updateUser = jest.fn().mockResolvedValue(undefined);
    const service: any = Object.create(UsersService.prototype);
    service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    service.firestoreService = {
      getUserById: jest.fn().mockResolvedValue(user),
      updateUser,
    };
    return { service, updateUser };
  }

  it('devuelve todo activado para una cuenta que nunca tocó sus preferencias', async () => {
    const { service } = buildService({ id: 'uid-1' });

    await expect(service.getNotificationPreferences('uid-1')).resolves.toEqual({
      product: true,
      billing: true,
      usageReminders: true,
    });
  });

  it('completa las claves que falten en el documento guardado', async () => {
    const { service } = buildService({
      id: 'uid-1',
      notificationPreferences: { product: false },
    });

    await expect(service.getNotificationPreferences('uid-1')).resolves.toEqual({
      product: false,
      billing: true,
      usageReminders: true,
    });
  });

  it('fusiona la actualización parcial sin tocar los interruptores ausentes', async () => {
    const { service, updateUser } = buildService({
      id: 'uid-1',
      notificationPreferences: { product: false, billing: true },
    });

    const result = await service.updateNotificationPreferences('uid-1', {
      usageReminders: false,
    });

    expect(result).toEqual({
      product: false,
      billing: true,
      usageReminders: false,
    });
    // Se persisten siempre las tres claves resueltas.
    expect(updateUser).toHaveBeenCalledWith('uid-1', {
      notificationPreferences: {
        product: false,
        billing: true,
        usageReminders: false,
      },
    });
  });

  it('una clave presente con valor undefined no revierte la preferencia guardada', async () => {
    const { service } = buildService({
      id: 'uid-1',
      notificationPreferences: { product: false },
    });

    const result = await service.updateNotificationPreferences('uid-1', {
      product: undefined,
      billing: false,
    });

    expect(result.product).toBe(false);
    expect(result.billing).toBe(false);
  });

  it('rechaza a un usuario que no existe', async () => {
    const { service } = buildService(null);

    await expect(
      service.getNotificationPreferences('uid-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.updateNotificationPreferences('uid-1', { product: false }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
