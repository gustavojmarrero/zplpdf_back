import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { WorkflowPreviewService } from './workflow-preview.service.js';
import { WorkflowsService } from './workflows.service.js';
import { InMemoryWorkflowRepository } from './workflows.in-memory-repository.js';
import type { ZplService } from '../zpl/zpl.service.js';
import type { WorkflowRecord, WorkflowLabelRecord } from './workflows.types.js';

async function setup() {
  const repository = new InMemoryWorkflowRepository();
  const workflow: WorkflowRecord = {
    id: 'workflow',
    accountId: 'alice',
    ownerId: 'alice',
    featureId: 'packing_workflow',
    featureVersion: '1',
    status: 'draft',
    labelSize: '4x6',
    outputFormat: 'pdf',
    version: 1,
    totalLabels: 3,
    totalCopies: 7,
    orderIds: ['a', 'b', 'c'],
    selectedIds: ['a'],
    sourceRefs: [],
    jobRefs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sourceExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const labels: WorkflowLabelRecord[] = ['a', 'b', 'c'].map(
    (labelId, index) => ({
      labelId,
      workflowId: workflow.id,
      accountId: 'alice',
      sequence: index,
      zpl: index < 2 ? '^XA^FDA^FS^XZ' : '^XA^FDC^FS^XZ',
      copies: index === 0 ? 5 : 1,
      contentHash: index < 2 ? 'a' : 'c',
      groupId: index < 2 ? 'a' : 'c',
      byteSize: 20,
      fields: {},
      serialized: false,
    }),
  );
  await repository.createWorkflow(workflow, labels);
  const gate = { assertFeatureAvailable: jest.fn() };
  const workflows = new WorkflowsService(
    repository,
    {} as never,
    gate,
    {} as never,
  );
  const getLabelsPreview = jest.fn(async (zpl: string) => [
    {
      img: `data:image/png;base64,${Buffer.from(zpl).toString('base64')}`,
      qty: 1,
    },
  ]);
  const service = new WorkflowPreviewService(repository, workflows, {
    getLabelsPreview,
  } as unknown as ZplService);
  return { repository, gate, service, getLabelsPreview };
}

describe('Workflow private PNG preview', () => {
  it('preserves requested identities/order and renders repeated groups once without multiplying copies', async () => {
    const h = await setup();
    const result = await h.service.preview('alice', 'workflow', [
      'c',
      'b',
      'a',
    ]);
    expect(result.schemaVersion).toBe(1);
    expect(result.items.map((item) => item.labelId)).toEqual(['c', 'b', 'a']);
    expect(result.items[1].dataUrl).toBe(result.items[2].dataUrl);
    expect(h.getLabelsPreview).toHaveBeenCalledTimes(2);
    expect(h.getLabelsPreview).toHaveBeenCalledWith('^XA^FDA^FS^XZ', '4x6', {
      maxUniqueLabels: 1,
    });
    expect(await h.repository.listExports('alice', 'workflow')).toEqual([]);
  });

  it.each([
    [[]],
    [Array.from({ length: 11 }, (_, i) => String(i))],
    [['a', 'a']],
    [['foreign']],
  ])('rejects invalid IDs before any rendering: %j', async (ids) => {
    const h = await setup();
    await expect(
      h.service.preview('alice', 'workflow', ids),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.getLabelsPreview).not.toHaveBeenCalled();
  });

  it('enforces ownership, feature access, tombstones and source expiry before rendering', async () => {
    const h = await setup();
    await expect(
      h.service.preview('bob', 'workflow', ['a']),
    ).rejects.toBeInstanceOf(NotFoundException);
    h.gate.assertFeatureAvailable.mockImplementationOnce(() => {
      throw new ForbiddenException();
    });
    await expect(
      h.service.preview('alice', 'workflow', ['a']),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await h.repository.updateWorkflow('alice', 'workflow', 1, () => ({
      sourceExpiresAt: new Date(0).toISOString(),
    }));
    await expect(
      h.service.preview('alice', 'workflow', ['a']),
    ).rejects.toBeInstanceOf(GoneException);
    const other = await setup();
    other.repository.markAccountDeleted('alice');
    await expect(
      other.service.preview('alice', 'workflow', ['a']),
    ).rejects.toBeInstanceOf(GoneException);
    expect(h.getLabelsPreview).not.toHaveBeenCalled();
    expect(other.getLabelsPreview).not.toHaveBeenCalled();
  });

  it('fails explicitly when the renderer drops an image instead of associating the next image with it', async () => {
    const h = await setup();
    h.getLabelsPreview.mockResolvedValueOnce([]);
    await expect(
      h.service.preview('alice', 'workflow', ['a', 'c']),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(h.getLabelsPreview).toHaveBeenCalledTimes(1);
  });
});
