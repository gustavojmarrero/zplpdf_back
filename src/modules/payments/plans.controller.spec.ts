import { Test } from '@nestjs/testing';
import { ServiceUnavailableException, ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import { PlansController } from './plans.controller.js';
import { PlanCatalogService } from './plan-catalog.service.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';
import { CustomThrottlerGuard } from '../../common/guards/custom-throttler.guard.js';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter.js';

/**
 * Contrato HTTP de la ruta pública de precios, montada como en producción:
 * junto a `PaymentsController` (mismo prefijo, guard de auth a nivel de clase),
 * con el throttler global y el `ValidationPipe`/`HttpExceptionFilter` reales.
 * La lógica de precios va mockeada; se prueba en plan-catalog.service.spec.ts.
 */
describe('PlansController — HTTP', () => {
  let app: INestApplication;
  let planCatalogService: { getPlans: jest.Mock };

  const RESPUESTA = {
    currency: 'MXN',
    plans: [
      {
        plan: 'pro',
        monthly: { priceId: 'price_pro_mxn', amount: 19900, display: '$199' },
        yearly: null,
      },
    ],
  };

  beforeEach(async () => {
    planCatalogService = {
      getPlans: jest.fn().mockResolvedValue(RESPUESTA),
    };

    const moduleRef = await Test.createTestingModule({
      // Límite 1 para que cualquier ruta sujeta al throttler global se note al
      // segundo intento.
      imports: [
        ThrottlerModule.forRoot([{ name: 'default', ttl: 60000, limit: 1 }]),
      ],
      controllers: [PaymentsController, PlansController],
      providers: [
        { provide: PlanCatalogService, useValue: planCatalogService },
        { provide: PaymentsService, useValue: {} },
        { provide: APP_GUARD, useClass: CustomThrottlerGuard },
      ],
    })
      // Visitante anónimo: cualquier ruta protegida debe rechazarlo.
      .overrideGuard(FirebaseAuthGuard)
      .useValue({ canActivate: () => false })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('responde sin autenticación, con cabecera de caché pública', async () => {
    const response = await request(app.getHttpServer())
      .get('/payments/plans')
      .query({ country: 'mx' })
      .expect(200);

    expect(response.body).toEqual(RESPUESTA);
    expect(response.headers['cache-control']).toBe(
      'public, max-age=300, stale-while-revalidate=3600',
    );
    expect(planCatalogService.getPlans).toHaveBeenCalledWith('MX');
  });

  it('trata un country vacío o ausente como sin país', async () => {
    await request(app.getHttpServer()).get('/payments/plans').expect(200);
    await request(app.getHttpServer())
      .get('/payments/plans?country=')
      .expect(200);

    expect(planCatalogService.getPlans).toHaveBeenNthCalledWith(1, undefined);
    expect(planCatalogService.getPlans).toHaveBeenNthCalledWith(2, undefined);
  });

  it('rechaza un country que no es de dos letras', async () => {
    await request(app.getHttpServer())
      .get('/payments/plans')
      .query({ country: 'MEX' })
      .expect(400);

    expect(planCatalogService.getPlans).not.toHaveBeenCalled();
  });

  it('el 503 no lleva la cabecera de caché pública', async () => {
    planCatalogService.getPlans.mockRejectedValue(
      new ServiceUnavailableException(
        'Plan prices are temporarily unavailable',
      ),
    );

    const response = await request(app.getHttpServer())
      .get('/payments/plans')
      .expect(503);

    expect(response.body.success).toBe(false);
    expect(response.headers['cache-control']).toBeUndefined();
  });

  it('queda fuera del throttler global y no abre las rutas protegidas del mismo prefijo', async () => {
    for (let i = 0; i < 3; i++) {
      await request(app.getHttpServer()).get('/payments/plans').expect(200);
    }

    await request(app.getHttpServer())
      .post('/payments/portal')
      .send({})
      .expect(403);
  });

  it('aparece en Swagger', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
    );

    expect(document.paths['/payments/plans']?.get).toBeDefined();
    expect(document.paths['/payments/create-checkout']?.post).toBeDefined();
  });
});
