import request from 'supertest';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module.js';
import { FirestoreService } from './modules/cache/firestore.service.js';
import { FirebaseAdminService } from './modules/auth/firebase-admin.service.js';
import { ZplService } from './modules/zpl/zpl.service.js';
import { GrowthJobsService } from './modules/growth-metrics/growth-jobs.service.js';
import { PdfPreparationService } from './modules/pdf-preparation/pdf-preparation.service.js';
import { ApiJobsService } from './modules/public-api/api-jobs.service.js';
import { TemplateRegressionService } from './modules/template-regression/template-regression.service.js';
import { LabelTemplatesService } from './modules/label-templates/label-templates.service.js';
import { FolderAutomationService } from './modules/folder-automation/folder-automation.service.js';
import { DirectPrintService } from './modules/direct-print/direct-print.service.js';
import { WorkflowsService } from './modules/workflows/workflows.service.js';

describe('application module wiring', () => {
  it('resolves integrated growth domains without contacting providers', async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue(new ConfigService({ NODE_ENV: 'test' }))
      .overrideProvider('GOOGLE_AUTH_OPTIONS')
      .useValue({ projectId: 'demo-zpl-growth' })
      .overrideProvider(FirestoreService)
      .useValue({ getClient: () => ({}) })
      .overrideProvider(FirebaseAdminService)
      .useValue({ verifyToken: jest.fn() })
      .overrideProvider(ZplService)
      .useValue({ runDurableConversion: jest.fn() })
      .compile();
    expect(module.get(GrowthJobsService)).toBeDefined();
    expect(module.get(PdfPreparationService)).toBeDefined();
    expect(module.get(ApiJobsService)).toBeDefined();
    expect(module.get(WorkflowsService)).toBeDefined();
    expect(module.get(TemplateRegressionService)).toBeDefined();
    expect(module.get(LabelTemplatesService)).toBeDefined();
    expect(module.get(FolderAutomationService)).toBeDefined();
    expect(module.get(DirectPrintService)).toBeDefined();
    const app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    try {
      for (const path of [
        '/api/users/me/features',
        '/api/users/me/api-jobs',
        '/api/template-regression/fixtures',
        '/api/admin/observability/quality',
        '/api/admin/growth/snapshot',
        '/api/admin/growth/incidents?queue=label_events',
        '/api/pdf-preparation/presets',
      ])
        await request(app.getHttpServer()).get(path).expect(401);
      for (const path of [
        '/api/product-events/web',
        '/api/feedback/invitations/claim',
        '/api/pdf-preparation/internal/recover',
        '/api/zpl/internal/recover-durable',
        '/api/cron/growth/quality',
        '/api/internal/growth/api-jobs',
        '/api/internal/growth/drive-revoke',
        '/api/internal/growth/label-events',
        '/api/internal/growth/template-regression',
        '/api/v1/test',
        '/api/admin/growth/incidents/label_events/00000000-0000-4000-8000-000000000000/retry',
      ])
        await request(app.getHttpServer()).post(path).send({}).expect(401);
    } finally {
      await app.close();
    }
  });
});
