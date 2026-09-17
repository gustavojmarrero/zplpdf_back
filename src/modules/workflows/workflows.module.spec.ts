import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { WorkflowsModule } from './workflows.module.js';
import { WorkflowsController } from './workflows.controller.js';
import { WorkflowsService } from './workflows.service.js';
import { WorkflowExportsService } from './workflow-exports.service.js';
import { WORKFLOW_REPOSITORY } from './workflows.types.js';
import { FEATURE_GATE } from './ports/feature-gate.port.js';
import { LabelEventPublisher } from './label-event.publisher.js';
import { LABEL_EVENT_OUTBOX } from './label-event.store.js';
import { LabelTemplatesModule } from '../label-templates/label-templates.module.js';
import { LabelTemplatesController } from '../label-templates/label-templates.controller.js';
import { TemplateRunsService } from '../label-templates/template-runs.service.js';
import { TEMPLATE_REPOSITORY } from '../label-templates/label-templates.types.js';
import { XLSX_WORKBOOK_READER } from '../label-templates/tabular/workbook-reader.port.js';
import { FirestoreService } from '../cache/firestore.service.js';
import { UsersService } from '../users/users.service.js';
import { ZplService } from '../zpl/zpl.service.js';
import { StorageService } from '../storage/storage.service.js';
import { FirebaseAdminService } from '../auth/firebase-admin.service.js';

/**
 * Comprobación de que los dos módulos se pueden instanciar: el coordinador los
 * va a importar en `AppModule` y un error de inyección solo aparecería al
 * arrancar. Se sustituyen los servicios que abrirían conexiones reales
 * (Firestore, Storage, Firebase Admin y el conversor), no la estructura del
 * módulo: lo que se verifica es el grafo de dependencias tal cual se declara.
 */
describe('WorkflowsModule y LabelTemplatesModule', () => {
  async function build() {
    return Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        WorkflowsModule,
        LabelTemplatesModule,
      ],
    })
      .overrideProvider(FirestoreService)
      .useValue({ getClient: () => ({}) })
      .overrideProvider(UsersService)
      .useValue({})
      .overrideProvider(ZplService)
      .useValue({})
      .overrideProvider(StorageService)
      .useValue({})
      .overrideProvider(FirebaseAdminService)
      .useValue({})
      .compile();
  }

  it('resuelve controladores, servicios y puertos de BE04', async () => {
    const moduleRef = await build();

    expect(moduleRef.get(WorkflowsController)).toBeDefined();
    expect(moduleRef.get(WorkflowsService)).toBeDefined();
    expect(moduleRef.get(WorkflowExportsService)).toBeDefined();
    expect(moduleRef.get(WORKFLOW_REPOSITORY)).toBeDefined();
    expect(moduleRef.get(FEATURE_GATE)).toBeDefined();
    // La cola de salida y su publicador se resuelven: sin ellos, la transición
    // de negocio no tendría dónde escribir el hecho.
    expect(moduleRef.get(LABEL_EVENT_OUTBOX)).toBeDefined();
    expect(moduleRef.get(LabelEventPublisher)).toBeDefined();

    await moduleRef.close();
  });

  it('resuelve controladores, servicios y el lector XLSX de BE05', async () => {
    const moduleRef = await build();

    expect(moduleRef.get(LabelTemplatesController)).toBeDefined();
    expect(moduleRef.get(TemplateRunsService)).toBeDefined();
    expect(moduleRef.get(TEMPLATE_REPOSITORY)).toBeDefined();
    expect(moduleRef.get(XLSX_WORKBOOK_READER)).toBeDefined();
    expect(moduleRef.get(LABEL_EVENT_OUTBOX)).toBeDefined();
    // `retryPending` es el punto que el despliegue conecta a su tarea con OIDC.
    expect(typeof moduleRef.get(LabelEventPublisher).retryPending).toBe(
      'function',
    );

    await moduleRef.close();
  });
});
