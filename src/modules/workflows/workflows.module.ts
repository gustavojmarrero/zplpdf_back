import { WorkflowPreviewService } from './workflow-preview.service.js';
import { Module } from '@nestjs/common';
import { CacheModule } from '../cache/cache.module.js';
import { UsersModule } from '../users/users.module.js';
import { ZplModule } from '../zpl/zpl.module.js';
import { WorkflowsController } from './workflows.controller.js';
import { WorkflowsService } from './workflows.service.js';
import { WorkflowExportsService } from './workflow-exports.service.js';
import {
  FirestoreWorkflowRepository,
  WorkflowsFirestoreProvider,
} from './workflows.firestore-repository.js';
import { WORKFLOW_REPOSITORY } from './workflows.types.js';
import { FEATURE_GATE } from './ports/feature-gate.port.js';
import { LABEL_EVENT_RECORDER } from './ports/label-event-recorder.port.js';
import { LabelEventPublisher } from './label-event.publisher.js';
import { LabelEventOutboxProviders } from './label-event.store.js';
import { ProductObservabilityModule } from '../product-observability/product-observability.module.js';
import { FeatureFlagsService } from '../product-observability/feature-flags.service.js';
import { ProductObservabilityService } from '../product-observability/product-observability.service.js';

/**
 * BE04 — lotes listos para empacar.
 *
 * Solo falta que el coordinador lo importe en `AppModule`: los adaptadores
 * reales se enlazan aquí. `FEATURE_GATE` es `FeatureFlagsService`, así que el
 * flag `packing_workflow` decide el acceso y está apagado hasta que la
 * configuración del servidor lo encienda; `LABEL_EVENT_RECORDER` es
 * `ProductObservabilityService`, así que los hechos canónicos se registran de
 * verdad y no se pierden por un puerto sin enlazar.
 */
@Module({
  // AuthModule es @Global: FirebaseAuthGuard ya está disponible sin importarlo.
  imports: [CacheModule, UsersModule, ZplModule, ProductObservabilityModule],
  controllers: [WorkflowsController],
  providers: [
    WorkflowsFirestoreProvider,
    { provide: WORKFLOW_REPOSITORY, useClass: FirestoreWorkflowRepository },
    { provide: FEATURE_GATE, useExisting: FeatureFlagsService },
    { provide: LABEL_EVENT_RECORDER, useExisting: ProductObservabilityService },
    ...LabelEventOutboxProviders,
    LabelEventPublisher,
    WorkflowsService,
    WorkflowExportsService,
    WorkflowPreviewService,
  ],
  exports: [
    WorkflowsService,
    WorkflowExportsService,
    WorkflowPreviewService,
    // Exportado para que el despliegue pueda drenar la cola de hechos
    // (`retryPending`) desde una tarea con OIDC o un endpoint de administración.
    LabelEventPublisher,
    WORKFLOW_REPOSITORY,
  ],
})
export class WorkflowsModule {}
