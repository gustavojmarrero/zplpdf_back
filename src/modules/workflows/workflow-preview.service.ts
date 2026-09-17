import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ZplService } from '../zpl/zpl.service.js';
import { LabelSize } from '../zpl/enums/label-size.enum.js';
import { WORKFLOW_REPOSITORY } from './workflows.types.js';
import type { WorkflowRepositoryPort } from './workflows.types.js';
import { WorkflowsService } from './workflows.service.js';
import { asAccountDeletedResponse } from './label-event.outbox.js';

export const WORKFLOW_PREVIEW_LIMIT = 10;

@Injectable()
export class WorkflowPreviewService {
  constructor(
    @Inject(WORKFLOW_REPOSITORY)
    private readonly repository: WorkflowRepositoryPort,
    private readonly workflows: WorkflowsService,
    private readonly zpl: ZplService,
  ) {}

  async preview(
    accountId: string,
    workflowId: string,
    labelIds: string[],
  ): Promise<{
    schemaVersion: 1;
    items: { labelId: string; dataUrl: string }[];
  }> {
    await this.workflows.assertFeature(accountId);
    const workflow = await this.workflows.getOwnedWorkflow(
      accountId,
      workflowId,
    );
    this.workflows.assertSourceAlive(workflow);
    try {
      await this.repository.assertAccountActive(accountId);
    } catch (error) {
      throw asAccountDeletedResponse(error, 'ACCOUNT_DELETED') ?? error;
    }
    if (
      !Array.isArray(labelIds) ||
      labelIds.length < 1 ||
      labelIds.length > WORKFLOW_PREVIEW_LIMIT ||
      labelIds.some((id) => typeof id !== 'string' || !id) ||
      new Set(labelIds).size !== labelIds.length
    ) {
      throw new BadRequestException({
        error: 'WORKFLOW_PREVIEW_INVALID',
        message: 'Solicita entre 1 y 10 etiquetas distintas del lote',
      });
    }
    const labels = await this.repository.getLabels(accountId, workflowId);
    const byId = new Map(labels.map((label) => [label.labelId, label]));
    if (labelIds.some((id) => !byId.has(id)))
      throw new BadRequestException({
        error: 'WORKFLOW_PREVIEW_INVALID',
        message: 'La etiqueta no pertenece al lote',
      });
    const images = new Map<string, string>();
    const items: { labelId: string; dataUrl: string }[] = [];
    for (const labelId of labelIds) {
      const label = byId.get(labelId)!;
      // A per-group call keeps identity correct even when the converter drops
      // an individual failed preview; array positions are never guessed.
      let dataUrl = images.get(label.groupId);
      if (!dataUrl) {
        const result = await this.zpl.getLabelsPreview(
          label.zpl,
          workflow.labelSize as LabelSize,
          { maxUniqueLabels: 1 },
        );
        dataUrl = result[0]?.img;
        if (!dataUrl?.startsWith('data:image/png;base64,'))
          throw new ServiceUnavailableException({
            error: 'SERVICE_UNAVAILABLE',
            message: 'No se pudo generar la vista previa',
          });
        images.set(label.groupId, dataUrl);
      }
      items.push({ labelId, dataUrl });
    }
    return { schemaVersion: 1, items };
  }
}
