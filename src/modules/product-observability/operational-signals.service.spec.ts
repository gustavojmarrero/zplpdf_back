import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom, throwError } from 'rxjs';
import {
  classifyOperationalError,
  OperationalSignalsInterceptor,
  OperationalSignalsService,
  signalFeature,
} from './operational-signals.service.js';

describe('operational friction signals', () => {
  it('classifies only known quota codes and strips free text', () => {
    expect(
      classifyOperationalError(
        new ForbiddenException('MONTHLY_LIMIT_EXCEEDED'),
      ),
    ).toEqual({
      kind: 'quota_rejected',
      code: 'MONTHLY_LIMIT_EXCEEDED',
      statusCode: 403,
    });
    expect(
      classifyOperationalError(
        new BadRequestException('customer@example.com ^XA token=secret'),
      ),
    ).toEqual({
      kind: 'http_error',
      code: 'REQUEST_REJECTED',
      statusCode: 400,
    });
    expect(
      classifyOperationalError(new Error('private provider response')),
    ).toEqual({ kind: 'http_error', code: 'SERVER_FAILURE', statusCode: 500 });
  });
  it('maps known feature routes without retaining identifiers or query parameters', () => {
    expect(signalFeature('/api/workflows/private/exports')).toBe(
      'packing_workflow',
    );
    expect(signalFeature('/api/v1/jobs')).toBe('self_service_api');
    expect(signalFeature('/api/print/jobs')).toBe('direct_print');
    expect(signalFeature('/api/auth/private')).toBeNull();
  });
  it('preserves the exact business error after recording a private safe row', async () => {
    const rows: any[] = [];
    const tx = {
      get: async (ref: string) => ({ exists: ref.startsWith('users/') }),
      create: (_ref: any, row: any) => rows.push(row),
    };
    const db = {
      doc: (path: string) => path,
      runTransaction: async (fn) => fn(tx),
    };
    const service = new OperationalSignalsService(
      { getClient: () => db } as any,
      { account: async () => ({ isSynthetic: true }) } as any,
      new ConfigService({ NODE_ENV: 'test' }),
    );
    const interceptor = new OperationalSignalsInterceptor(service);
    const context = {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({
          path: '/api/v1/jobs',
          apiPrincipal: { accountId: 'synthetic' },
        }),
      }),
    };
    const error = new ForbiddenException('MONTHLY_LIMIT_EXCEEDED');
    await expect(
      firstValueFrom(
        interceptor.intercept(context as any, {
          handle: () => throwError(() => error),
        }),
      ),
    ).rejects.toBe(error);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      accountId: 'synthetic',
      featureId: 'self_service_api',
      isSynthetic: true,
      environment: 'test',
      kind: 'quota_rejected',
    });
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        'accountId',
        'code',
        'environment',
        'expiresAt',
        'featureId',
        'id',
        'isSynthetic',
        'kind',
        'occurredAt',
        'statusCode',
      ].sort(),
    );
  });
  it('does not recreate records after account deletion and tolerates storage failure', async () => {
    const create = jest.fn();
    const db = {
      doc: (path: string) => path,
      runTransaction: async (fn) =>
        fn({ get: async () => ({ exists: true }), create }),
    };
    const service = new OperationalSignalsService(
      { getClient: () => db } as any,
      { account: async () => ({ isSynthetic: false }) } as any,
      new ConfigService(),
    );
    await service.record('gone', 'pdf_preparation', new Error('private'));
    expect(create).not.toHaveBeenCalled();
    db.runTransaction = async () => {
      throw new Error('sensitive');
    };
    await expect(
      service.record('gone', 'pdf_preparation', new Error('private')),
    ).resolves.toBeUndefined();
  });
});
