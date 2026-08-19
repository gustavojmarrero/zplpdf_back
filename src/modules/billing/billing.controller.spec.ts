import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter.js';

/**
 * Verifica el contrato HTTP del módulo de facturación: que los query params
 * llegan al servicio con el nombre y tipo correctos, y que lo que el cliente
 * recibe de verdad —después del `HttpExceptionFilter` global— conserva lo que
 * el servicio puso en `data`.
 *
 * El servicio va mockeado a propósito: su lógica (validación del cursor,
 * anidado de cfdiError) se prueba en billing.service.spec.ts. Lo que aquí
 * puede romperse es el cableado del controller y el filtro.
 */
describe('BillingController — HTTP', () => {
  const UID = 'uid-propietario';

  let app: INestApplication;
  let billingService: {
    getInvoices: jest.Mock;
    retryCfdi: jest.Mock;
  };

  beforeEach(async () => {
    billingService = {
      getInvoices: jest
        .fn()
        .mockResolvedValue({ invoices: [], hasMore: false }),
      retryCfdi: jest.fn().mockResolvedValue({
        status: 'stamped',
        uuid: 'UUID-1',
        pdfUrl: null,
        xmlUrl: null,
        stampedAt: null,
        error: null,
      }),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [BillingController],
      providers: [{ provide: BillingService, useValue: billingService }],
    })
      .overrideGuard(FirebaseAuthGuard)
      .useValue({
        canActivate: (context) => {
          context.switchToHttp().getRequest().user = { uid: UID };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /billing/invoices', () => {
    it('usa el default de limit=10 y no manda starting_after si no llega', async () => {
      await request(app.getHttpServer()).get('/billing/invoices').expect(200);

      expect(billingService.getInvoices).toHaveBeenCalledWith(
        UID,
        10,
        undefined,
      );
    });

    it('pasa limit y starting_after tal cual llegan en el query', async () => {
      await request(app.getHttpServer())
        .get('/billing/invoices')
        .query({ limit: '5', starting_after: 'in_abc' })
        .expect(200);

      expect(billingService.getInvoices).toHaveBeenCalledWith(UID, 5, 'in_abc');
    });

    it('propaga el 403 cuando el cursor no pertenece al usuario', async () => {
      const { ForbiddenException } = await import('@nestjs/common');
      billingService.getInvoices.mockRejectedValue(
        new ForbiddenException('Invoice cursor does not belong to this user'),
      );

      const response = await request(app.getHttpServer())
        .get('/billing/invoices')
        .query({ starting_after: 'in_ajena' })
        .expect(403);

      expect(response.body.success).toBe(false);
    });
  });

  describe('POST /billing/invoices/:invoiceId/cfdi/retry', () => {
    /**
     * Este es el test central del issue #97: reproduce, vía HTTP real
     * (supertest) y el `HttpExceptionFilter` real (no un doble), los tres
     * rechazos de `retryCfdi` y comprueba que `data.cfdiError.code` llega
     * intacto al cliente. Es la capa que un test que solo mire
     * `error.getResponse()` en el servicio no puede cubrir.
     */
    it.each([
      ['400 — cobro no efectivo', 400, 'BadRequestException'],
      ['400 — perfil fiscal incompleto', 400, 'BadRequestException'],
      ['422 — rechazo del PAC', 422, 'UnprocessableEntityException'],
    ])(
      '%s: propaga cfdiError dentro de data',
      async (_label, status, exceptionName) => {
        const nestCommon = await import('@nestjs/common');
        const ExceptionCtor = nestCommon[exceptionName] as new (
          body: unknown,
        ) => Error;

        billingService.retryCfdi.mockRejectedValue(
          new ExceptionCtor({
            error: 'INVALID_INPUT',
            message: 'detalle interno',
            data: {
              cfdiError: { code: 'rfc_not_found', message: 'RFC no inscrito' },
            },
          }),
        );

        const response = await request(app.getHttpServer())
          .post('/billing/invoices/in_123/cfdi/retry')
          .expect(status);

        expect(response.body.success).toBe(false);
        expect(response.body.data).toEqual({
          cfdiError: { code: 'rfc_not_found', message: 'RFC no inscrito' },
        });
      },
    );

    it('responde con el cfdi cuando el timbrado funciona', async () => {
      // Nest responde 201 por defecto en @Post sin @HttpCode explícito.
      const response = await request(app.getHttpServer())
        .post('/billing/invoices/in_123/cfdi/retry')
        .expect(201);

      expect(billingService.retryCfdi).toHaveBeenCalledWith(UID, 'in_123');
      expect(response.body).toEqual({
        success: true,
        cfdi: {
          status: 'stamped',
          uuid: 'UUID-1',
          pdfUrl: null,
          xmlUrl: null,
          stampedAt: null,
          error: null,
        },
      });
    });
  });
});
