import { Module } from '@nestjs/common';
import { CacheModule } from '../cache/cache.module.js';
import { UsersModule } from '../users/users.module.js';
import { ZplModule } from '../zpl/zpl.module.js';
import { FEATURE_GATE } from '../workflows/ports/feature-gate.port.js';
import { LABEL_EVENT_RECORDER } from '../workflows/ports/label-event-recorder.port.js';
import { LabelEventPublisher } from '../workflows/label-event.publisher.js';
import { LabelEventOutboxProviders } from '../workflows/label-event.store.js';
import { ProductObservabilityModule } from '../product-observability/product-observability.module.js';
import { FeatureFlagsService } from '../product-observability/feature-flags.service.js';
import { ProductObservabilityService } from '../product-observability/product-observability.service.js';
import {
  LabelTemplatesController,
  TemplateRunsController,
} from './label-templates.controller.js';
import { LabelTemplatesService } from './label-templates.service.js';
import { TemplateRunsService } from './template-runs.service.js';
import {
  FirestoreTemplateRepository,
  TemplatesFirestoreProvider,
} from './label-templates.firestore-repository.js';
import { TEMPLATE_REPOSITORY } from './label-templates.types.js';
import { XLSX_WORKBOOK_READER } from './tabular/workbook-reader.port.js';
import { ExcelJsWorkbookReader } from './tabular/exceljs-workbook-reader.js';

/**
 * BE05 — plantillas y datos CSV/XLSX.
 *
 * Solo falta que el coordinador lo importe en `AppModule`: los adaptadores
 * reales se enlazan aquí (`FeatureFlagsService` para el flag `data_templates` y
 * `ProductObservabilityService` para los hechos canónicos).
 *
 * El lector de XLSX se registra aquí porque `exceljs` está instalado. Si un
 * despliegue lo retira, `POST /template-runs` con `format: 'xlsx'` devuelve
 * 422 FEATURE_UNSUPPORTED en vez de inventar una lectura.
 */
@Module({
  imports: [CacheModule, UsersModule, ZplModule, ProductObservabilityModule],
  controllers: [LabelTemplatesController, TemplateRunsController],
  providers: [
    TemplatesFirestoreProvider,
    { provide: TEMPLATE_REPOSITORY, useClass: FirestoreTemplateRepository },
    { provide: FEATURE_GATE, useExisting: FeatureFlagsService },
    { provide: LABEL_EVENT_RECORDER, useExisting: ProductObservabilityService },
    ...LabelEventOutboxProviders,
    LabelEventPublisher,
    { provide: XLSX_WORKBOOK_READER, useClass: ExcelJsWorkbookReader },
    LabelTemplatesService,
    TemplateRunsService,
  ],
  exports: [
    LabelTemplatesService,
    TemplateRunsService,
    // Exportado para que el despliegue pueda drenar la cola de hechos
    // (`retryPending`) desde una tarea con OIDC o un endpoint de administración.
    LabelEventPublisher,
    TEMPLATE_REPOSITORY,
  ],
})
export class LabelTemplatesModule {}
