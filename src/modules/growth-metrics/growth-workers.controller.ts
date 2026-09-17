import { LabelEventPublisher } from '../workflows/label-event.publisher.js';
import { TemplateRegressionService } from '../template-regression/template-regression.service.js';
import { FolderAutomationService } from '../folder-automation/folder-automation.service.js';
import { DirectPrintService } from '../direct-print/direct-print.service.js';
import { Controller, Post, UseGuards } from '@nestjs/common';
import { GrowthSchedulerGuard } from '../../common/guards/growth-scheduler.guard.js';
import { ApiJobsService } from '../public-api/api-jobs.service.js';
import { ApiCallbacksService } from '../public-api/api-callbacks.service.js';
@Controller('internal/growth')
@UseGuards(GrowthSchedulerGuard)
export class GrowthWorkersController {
  constructor(
    private readonly jobs: ApiJobsService,
    private readonly callbacks: ApiCallbacksService,
    private readonly folders: FolderAutomationService,
    private readonly print: DirectPrintService,
    private readonly labelEvents: LabelEventPublisher,
    private readonly regression: TemplateRegressionService,
  ) {}

  /**
   * Drena la cola de hechos de BE04/BE05.
   *
   * Vive aquí y no en `workflows` porque el guard del planificador ya protege
   * esta ruta: el módulo de etiquetas expone `retryPending` y no programa nada
   * por su cuenta. Un hecho que agota sus intentos queda como `dead` y **no** se
   * borra; el drenado no lo revive ni lo elimina.
   */
  @Post('label-events') labelEventBacklog() {
    return this.labelEvents.retryPending(20);
  }

  /** Recuperación interna de BE10. Sin endpoints públicos. */
  @Post('template-regression') templateRegression() {
    return this.regression.recover();
  }
  @Post('drive-scan') scan() {
    return this.folders.scanDue(20);
  }
  @Post('drive-runs') folderRuns() {
    return this.folders.processDue(20);
  }
  @Post('drive-revoke') revokeDrive() {
    return this.folders.revokePending(20);
  }
  @Post('print-jobs') printJobs() {
    return this.print.dispatchJobs(20);
  }
  @Post('api-jobs') jobsDue() {
    return this.jobs.processDueJobs(10);
  }
  @Post('callbacks') callbacksDue() {
    return this.callbacks.dispatchCallbacks(20);
  }
}
