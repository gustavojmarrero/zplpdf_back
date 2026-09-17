import { WorkflowsModule } from '../workflows/workflows.module.js';
import { TemplateRegressionModule } from '../template-regression/template-regression.module.js';
import { FolderAutomationModule } from '../folder-automation/folder-automation.module.js';
import { DirectPrintModule } from '../direct-print/direct-print.module.js';
import { BillingReconciliationService } from './billing-reconciliation.service.js';
import { PublicApiModule } from '../public-api/public-api.module.js';
import { GrowthWorkersController } from './growth-workers.controller.js';
import { Module } from '@nestjs/common';
import { CacheModule } from '../cache/cache.module.js';
import { ProductObservabilityModule } from '../product-observability/product-observability.module.js';
import { BillingFactsService } from './billing-facts.service.js';
import { GrowthJobsService } from './growth-jobs.service.js';
import { GrowthJobsController } from './growth-jobs.controller.js';
import { GrowthSchedulerGuard } from '../../common/guards/growth-scheduler.guard.js';
import { AdminAuthGuard } from '../../common/guards/admin-auth.guard.js';
@Module({
  imports: [
    CacheModule,
    ProductObservabilityModule,
    PublicApiModule,
    FolderAutomationModule,
    DirectPrintModule,
    // Solo para drenar sus colas desde el planificador; este módulo no publica
    // ni altera sus datos.
    WorkflowsModule,
    TemplateRegressionModule,
  ],
  controllers: [GrowthJobsController, GrowthWorkersController],
  providers: [
    BillingFactsService,
    BillingReconciliationService,
    GrowthJobsService,
    GrowthSchedulerGuard,
    AdminAuthGuard,
  ],
  exports: [BillingFactsService, GrowthJobsService],
})
export class GrowthMetricsModule {}
