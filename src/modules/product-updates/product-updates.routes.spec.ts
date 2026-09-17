import request from 'supertest';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { FirestoreService } from '../cache/firestore.service.js';
import { FirebaseAdminService } from '../auth/firebase-admin.service.js';
import { ProductUpdatesModule } from './product-updates.module.js';
import { ProductUpdatesService } from './product-updates.service.js';

describe('product updates routes', () => {
  it('requires a verified Firebase token on both routes', async () => {
    const verifyToken = jest.fn(async () => {
      throw new Error('invalid token');
    });
    const module = await Test.createTestingModule({
      imports: [ProductUpdatesModule],
    })
      .overrideProvider(ConfigService)
      .useValue(new ConfigService({ NODE_ENV: 'test' }))
      .overrideProvider('GOOGLE_AUTH_OPTIONS')
      .useValue({ projectId: 'demo-zpl-growth' })
      .overrideProvider(FirestoreService)
      .useValue({
        getClient: () => ({}),
        isAccountDeletionMarked: jest.fn(async () => false),
        getUserById: jest.fn(async () => null),
      })
      .overrideProvider(FirebaseAdminService)
      .useValue({ verifyToken })
      .compile();
    expect(module.get(ProductUpdatesService)).toBeDefined();
    const app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    const progressPath =
      '/api/users/me/product-updates/growth-2026-09/1/progress';
    try {
      // 401 y no 404: la ruta existe y el guard es quien la rechaza.
      await request(app.getHttpServer())
        .get('/api/users/me/product-updates')
        .expect(401);
      await request(app.getHttpServer())
        .patch(progressPath)
        .send({})
        .expect(401);
      await request(app.getHttpServer())
        .get('/api/users/me/product-updates')
        .set('Authorization', 'Bearer forged')
        .expect(401);
      await request(app.getHttpServer())
        .patch(progressPath)
        .set('Authorization', 'Bearer forged')
        .send({
          eventId: '00000000-0000-4000-8000-000000000001',
          expectedRevision: 0,
          action: 'start',
        })
        .expect(401);
      expect(verifyToken).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
});
