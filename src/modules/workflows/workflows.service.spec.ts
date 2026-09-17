import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { validate as isUuid, version as uuidVersion } from 'uuid';
import { WorkflowsService } from './workflows.service.js';
import { WorkflowExportsService } from './workflow-exports.service.js';
import { InMemoryWorkflowRepository } from './workflows.in-memory-repository.js';
import { DeniedByDefaultFeatureGate } from './ports/feature-gate.port.js';
import { LabelEventPublisher } from './label-event.publisher.js';
import { InMemoryLabelEventOutbox } from './label-event.store.js';

/** Drena la cola con un consumidor nuevo, como haría la tarea programada. */
function buildDrain(
  outbox: InMemoryLabelEventOutbox,
  recorder: LabelEventRecorderPort,
) {
  return new LabelEventPublisher(recorder, outbox).retryPending();
}
import type { FeatureGatePort } from './ports/feature-gate.port.js';
import type {
  LabelEventRecorderPort,
  LabelServerEvent,
} from './ports/label-event-recorder.port.js';
import type { UsersService } from '../users/users.service.js';
import type { ZplService } from '../zpl/zpl.service.js';

const ALICE = { uid: 'alice', email: 'alice@example.com' };
const BOB = { uid: 'bob', email: 'bob@example.com' };

const ZPL_TWO_WITH_COPIES =
  '^XA^FO10,10^FDPEDIDO-001^FS^PQ3^XZ^XA^FO10,10^FDPEDIDO-002^FS^XZ';

class AllowAllFeatureGate implements FeatureGatePort {
  assertFeatureAvailable(): void {}
}

function buildHarness(options: { plan?: string } = {}) {
  const outbox = new InMemoryLabelEventOutbox();
  const repository = new InMemoryWorkflowRepository(outbox);
  const events: LabelServerEvent[] = [];

  const recorder: LabelEventRecorderPort = {
    async recordServerEvent(event) {
      events.push(event);
      return { duplicate: false };
    },
  };

  const usersService = {
    getUserById: async (uid: string) => ({ uid, plan: options.plan ?? 'pro' }),
    getEffectivePlan: () => options.plan ?? 'pro',
    getHistoryZpl: jest.fn(),
  } as unknown as UsersService;

  // Doble del puente duradero: devuelve `completed` y el jobId es el propio
  // operationId, igual que la implementación real.
  const runDurableConversion = jest.fn(
    async (input: {
      operationId: string;
      userId: string;
      zplContent: string;
      labelSize: string;
      outputFormat?: string;
      originalFilename?: string;
    }) => ({ jobId: input.operationId, status: 'completed' }),
  );
  const zplService = { runDurableConversion } as unknown as ZplService;

  const publisher = new LabelEventPublisher(recorder, outbox);
  const workflows = new WorkflowsService(
    repository,
    usersService,
    new AllowAllFeatureGate(),
    publisher,
  );
  const exportsService = new WorkflowExportsService(
    repository,
    workflows,
    zplService,
  );

  return {
    repository,
    workflows,
    exportsService,
    events,
    runDurableConversion,
    usersService,
    publisher,
    outbox,
    recorder,
  };
}

describe('WorkflowsService — creación', () => {
  it('crea el lote preservando orden, copias y grupos', async () => {
    const { workflows } = buildHarness();
    const workflow = await workflows.createWorkflow(ALICE, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });

    expect(workflow.version).toBe(1);
    expect(workflow.totalLabels).toBe(2);
    expect(workflow.totalCopies).toBe(4);
    expect(workflow.labels).toHaveLength(2);
    expect(workflow.labels[0].copies).toBe(3);
    expect(workflow.labels[0].order).toBe(1);
    expect(workflow.labels.every((label) => label.selected)).toBe(true);
    expect(workflow.sourceExpiresAt > workflow.createdAt).toBe(true);
  });

  it('rechaza ZPL sin etiquetas y tamaños desconocidos', async () => {
    const { workflows } = buildHarness();

    await expect(
      workflows.createWorkflow(ALICE, { zplContent: 'nada', labelSize: '4x6' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      workflows.createWorkflow(ALICE, {
        zplContent: ZPL_TWO_WITH_COPIES,
        labelSize: '9x9',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('exige exactamente un origen', async () => {
    const { workflows } = buildHarness();

    await expect(
      workflows.createWorkflow(ALICE, { labelSize: '4x6' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      workflows.createWorkflow(ALICE, {
        zplContent: ZPL_TWO_WITH_COPIES,
        historyId: 'h1',
        labelSize: '4x6',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('aplica el tope del plan sobre las copias, que es lo que cuenta el conversor', async () => {
    // Free admite 75 etiquetas por PDF; 80 copias de una sola etiqueta ya lo pasan.
    const { workflows } = buildHarness({ plan: 'free' });

    await expect(
      workflows.createWorkflow(ALICE, {
        zplContent: '^XA^FDUNA^FS^PQ80^XZ',
        labelSize: '4x6',
      }),
    ).rejects.toMatchObject({
      response: {
        error: 'WORKFLOW_LABEL_LIMIT_EXCEEDED',
        data: { limit: 75, actual: 80, scope: 'plan' },
      },
    });
  });

  it('el gate por defecto deniega: el flag está apagado hasta que se enlaza', async () => {
    const repository = new InMemoryWorkflowRepository();
    const workflows = new WorkflowsService(
      repository,
      { getUserById: async () => ({}), getEffectivePlan: () => 'pro' } as any,
      new DeniedByDefaultFeatureGate(),
      new LabelEventPublisher(),
    );

    await expect(
      workflows.createWorkflow(ALICE, {
        zplContent: ZPL_TWO_WITH_COPIES,
        labelSize: '4x6',
      }),
    ).rejects.toMatchObject({
      response: { error: 'FEATURE_NOT_AVAILABLE' },
    });
  });
});

describe('WorkflowsService — aislamiento entre cuentas', () => {
  it('otra cuenta no puede leer, reordenar, cotejar ni exportar el lote', async () => {
    const { workflows, exportsService } = buildHarness();
    const workflow = await workflows.createWorkflow(ALICE, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });

    await expect(
      workflows.getWorkflow(BOB.uid, workflow.id),
    ).rejects.toBeInstanceOf(NotFoundException);

    await expect(
      workflows.updateOrder(BOB.uid, workflow.id, 1, [
        workflow.labels[1].labelId,
        workflow.labels[0].labelId,
      ]),
    ).rejects.toMatchObject({ response: { error: 'WORKFLOW_NOT_FOUND' } });

    await expect(
      workflows.updateSelection(BOB.uid, workflow.id, 1, {
        mode: 'replace',
        labelIds: [workflow.labels[0].labelId],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    await expect(
      exportsService.createExport(BOB, workflow.id, 'k-bob', {
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    await expect(
      workflows.reconcile(BOB, workflow.id, {
        expectedVersion: 1,
        format: 'pedido_id_guia_v1',
        csvContent: 'pedido_id,guia\nPEDIDO-001,X1\n',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    // El lote de Alice sigue intacto y visible para ella.
    const untouched = await workflows.getWorkflow(ALICE.uid, workflow.id);
    expect(untouched.version).toBe(1);
  });

  it('el listado solo devuelve los lotes de la cuenta', async () => {
    const { workflows } = buildHarness();
    await workflows.createWorkflow(ALICE, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });
    await workflows.createWorkflow(BOB, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });

    const alice = await workflows.listWorkflows(ALICE.uid, {});
    expect(alice.items).toHaveLength(1);
    expect(alice.items[0].accountId).toBe(ALICE.uid);
  });
});

describe('WorkflowsService — orden y CAS', () => {
  it('reordena con la versión vigente y conserva las copias', async () => {
    const { workflows } = buildHarness();
    const created = await workflows.createWorkflow(ALICE, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });
    const [first, second] = created.labels;

    const updated = await workflows.updateOrder(ALICE.uid, created.id, 1, [
      second.labelId,
      first.labelId,
    ]);

    expect(updated.version).toBe(2);
    expect(updated.labels.map((label) => label.labelId)).toEqual([
      second.labelId,
      first.labelId,
    ]);
    // El id y la posición original no se mueven; las copias tampoco.
    expect(updated.labels[1].sequence).toBe(1);
    expect(updated.labels[1].copies).toBe(3);
    expect(updated.totalCopies).toBe(4);
  });

  it('una versión desfasada devuelve conflicto en vez de sobrescribir', async () => {
    const { workflows } = buildHarness();
    const created = await workflows.createWorkflow(ALICE, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });
    const [first, second] = created.labels;

    await workflows.updateOrder(ALICE.uid, created.id, 1, [
      second.labelId,
      first.labelId,
    ]);

    // Segunda pestaña que aún cree estar en la versión 1.
    await expect(
      workflows.updateOrder(ALICE.uid, created.id, 1, [
        first.labelId,
        second.labelId,
      ]),
    ).rejects.toMatchObject({
      response: {
        error: 'WORKFLOW_VERSION_CONFLICT',
        data: { expectedVersion: 1, currentVersion: 2 },
      },
    });

    const current = await workflows.getWorkflow(ALICE.uid, created.id);
    expect(current.labels[0].labelId).toBe(second.labelId);
  });

  it('exige una permutación completa: no admite altas, bajas ni repeticiones', async () => {
    const { workflows } = buildHarness();
    const created = await workflows.createWorkflow(ALICE, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });
    const [first] = created.labels;

    await expect(
      workflows.updateOrder(ALICE.uid, created.id, 1, [first.labelId]),
    ).rejects.toMatchObject({
      response: { error: 'WORKFLOW_ORDER_MISMATCH' },
    });

    await expect(
      workflows.updateOrder(ALICE.uid, created.id, 1, [
        first.labelId,
        first.labelId,
      ]),
    ).rejects.toMatchObject({
      response: { error: 'WORKFLOW_ORDER_MISMATCH', data: { duplicated: 1 } },
    });
  });

  it('selecciona por grupo de copias y nunca deja la selección vacía', async () => {
    const { workflows } = buildHarness();
    const created = await workflows.createWorkflow(ALICE, {
      zplContent: `${ZPL_TWO_WITH_COPIES}^XA^FO10,10^FDPEDIDO-001^FS^XZ`,
      labelSize: '4x6',
    });

    const groupId = created.labels[0].groupId;
    const selected = await workflows.updateSelection(ALICE.uid, created.id, 1, {
      mode: 'replace',
      groupIds: [groupId],
    });

    // El grupo cubre las dos apariciones del mismo contenido.
    expect(selected.selectedCount).toBe(2);
    expect(
      selected.labels.filter((label) => label.selected).map((l) => l.groupId),
    ).toEqual([groupId, groupId]);

    await expect(
      workflows.updateSelection(ALICE.uid, created.id, 2, {
        mode: 'deselect',
        groupIds: [groupId],
      }),
    ).rejects.toMatchObject({
      response: { error: 'WORKFLOW_SELECTION_EMPTY' },
    });
  });
});

describe('WorkflowExportsService — idempotencia y cuota', () => {
  it('repetir la misma clave con la misma intención devuelve la misma operación y no vuelve a convertir', async () => {
    const { workflows, exportsService, runDurableConversion, events } =
      buildHarness();
    const created = await workflows.createWorkflow(ALICE, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });

    const first = await exportsService.createExport(ALICE, created.id, 'k1', {
      expectedVersion: 1,
    });
    const retry = await exportsService.createExport(ALICE, created.id, 'k1', {
      expectedVersion: 1,
    });

    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.export.idempotent).toBe(true);
    expect(retry.export.jobId).toBe(first.export.jobId);
    // La cuota la consume el conversor, y solo se le llamó una vez.
    expect(runDurableConversion).toHaveBeenCalledTimes(1);
    // Y el evento canónico tampoco se duplica.
    expect(
      events.filter((event) => event.eventName === 'packing_export_succeeded'),
    ).toHaveLength(1);
  });

  it('el ZPL exportado lleva las copias ^PQ y el recuento las incluye', async () => {
    const { workflows, exportsService, runDurableConversion } = buildHarness();
    const created = await workflows.createWorkflow(ALICE, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });

    const result = await exportsService.createExport(ALICE, created.id, 'k1', {
      expectedVersion: 1,
    });

    const [input] = runDurableConversion.mock.calls[0];
    expect(input.zplContent).toContain('^PQ3^XZ');
    expect(input.labelSize).toBe('4x6');
    expect(input.userId).toBe(ALICE.uid);
    // El operationId del puente ES el exportId: la conversión es idempotente
    // por sí misma, no solo por la reserva.
    expect(input.operationId).toBe(result.export.exportId);
    expect(result.export.labelCount).toBe(4);
    expect(result.export.uniqueLabelCount).toBe(2);
  });

  it('exporta en el orden y con la selección vigentes', async () => {
    const { workflows, exportsService, runDurableConversion } = buildHarness();
    const created = await workflows.createWorkflow(ALICE, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });
    const [first, second] = created.labels;

    await workflows.updateOrder(ALICE.uid, created.id, 1, [
      second.labelId,
      first.labelId,
    ]);
    await workflows.updateSelection(ALICE.uid, created.id, 2, {
      mode: 'replace',
      labelIds: [second.labelId],
    });

    const result = await exportsService.createExport(ALICE, created.id, 'k1', {
      expectedVersion: 3,
    });

    const [input] = runDurableConversion.mock.calls[0];
    expect(input.zplContent).toContain('PEDIDO-002');
    expect(input.zplContent).not.toContain('PEDIDO-001');
    expect(result.export.labelCount).toBe(1);
  });

  it('la misma clave con otra intención da conflicto', async () => {
    const { workflows, exportsService } = buildHarness();
    const created = await workflows.createWorkflow(ALICE, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });

    await exportsService.createExport(ALICE, created.id, 'k1', {
      expectedVersion: 1,
    });

    await expect(
      exportsService.createExport(ALICE, created.id, 'k1', {
        expectedVersion: 1,
        outputFormat: 'png',
      }),
    ).rejects.toMatchObject({
      response: { error: 'IDEMPOTENCY_KEY_REUSED' },
    });
  });

  it('la misma clave en otra cuenta es otra operación y no se cruza', async () => {
    const { workflows, exportsService, runDurableConversion } = buildHarness();
    const aliceWorkflow = await workflows.createWorkflow(ALICE, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });
    const bobWorkflow = await workflows.createWorkflow(BOB, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });

    const alice = await exportsService.createExport(
      ALICE,
      aliceWorkflow.id,
      'shared-key',
      { expectedVersion: 1 },
    );
    const bob = await exportsService.createExport(
      BOB,
      bobWorkflow.id,
      'shared-key',
      { expectedVersion: 1 },
    );

    expect(alice.export.exportId).not.toBe(bob.export.exportId);
    expect(runDurableConversion).toHaveBeenCalledTimes(2);
  });

  it('exige Idempotency-Key', async () => {
    const { workflows, exportsService } = buildHarness();
    const created = await workflows.createWorkflow(ALICE, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });

    await expect(
      exportsService.createExport(ALICE, created.id, '  ', {
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({
      response: { error: 'IDEMPOTENCY_KEY_REQUIRED' },
    });
  });

  it('un fallo de cuota libera la reserva y deja reintentar con la misma clave', async () => {
    const { workflows, exportsService, runDurableConversion } = buildHarness();
    const created = await workflows.createWorkflow(ALICE, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });

    runDurableConversion.mockRejectedValueOnce(
      new ForbiddenException({
        error: 'MONTHLY_LIMIT_EXCEEDED',
        message: 'sin cuota',
      }),
    );

    await expect(
      exportsService.createExport(ALICE, created.id, 'k1', {
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const retry = await exportsService.createExport(ALICE, created.id, 'k1', {
      expectedVersion: 1,
    });
    expect(retry.created).toBe(true);
    expect(retry.export.jobId).toBeDefined();
    expect(runDurableConversion).toHaveBeenCalledTimes(2);
  });

  it('una versión desfasada no exporta y no consume cuota', async () => {
    const { workflows, exportsService, runDurableConversion } = buildHarness();
    const created = await workflows.createWorkflow(ALICE, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });
    const [first, second] = created.labels;
    await workflows.updateOrder(ALICE.uid, created.id, 1, [
      second.labelId,
      first.labelId,
    ]);

    await expect(
      exportsService.createExport(ALICE, created.id, 'k1', {
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({
      response: { error: 'WORKFLOW_VERSION_CONFLICT' },
    });
    expect(runDurableConversion).not.toHaveBeenCalled();
  });

  it('la reimpresión queda ligada al trabajo original', async () => {
    const { workflows, exportsService, events } = buildHarness();
    const created = await workflows.createWorkflow(ALICE, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });

    const first = await exportsService.createExport(ALICE, created.id, 'k1', {
      expectedVersion: 1,
    });
    const reexport = await exportsService.createExport(
      ALICE,
      created.id,
      'k2',
      {
        expectedVersion: 2,
        reexportOf: first.export.exportId,
      },
    );

    expect(reexport.export.reexportOf).toBe(first.export.exportId);
    expect(
      events
        .map((event) => event.eventName)
        .filter((name) => name.includes('export')),
    ).toEqual(['packing_export_succeeded', 'packing_reexport_succeeded']);

    const workflow = await workflows.getWorkflow(ALICE.uid, created.id);
    expect(workflow.jobRefs).toHaveLength(2);
    expect(workflow.jobRefs[1].reexportOf).toBe(first.export.exportId);
    expect(workflow.status).toBe('ready');
  });

  it('rechaza una reimpresión que apunta a una exportación de otro lote', async () => {
    const { workflows, exportsService } = buildHarness();
    const a = await workflows.createWorkflow(ALICE, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });
    const b = await workflows.createWorkflow(ALICE, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });
    const first = await exportsService.createExport(ALICE, a.id, 'k1', {
      expectedVersion: 1,
    });

    await expect(
      exportsService.createExport(ALICE, b.id, 'k2', {
        expectedVersion: 1,
        reexportOf: first.export.exportId,
      }),
    ).rejects.toMatchObject({ response: { error: 'EXPORT_NOT_FOUND' } });
  });

  it('no exporta un lote archivado', async () => {
    const { workflows, exportsService } = buildHarness();
    const created = await workflows.createWorkflow(ALICE, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });
    await workflows.archiveWorkflow(ALICE.uid, created.id, 1);

    await expect(
      exportsService.createExport(ALICE, created.id, 'k1', {
        expectedVersion: 2,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('WorkflowsService — copias por etiqueta', () => {
  const SERIALIZED_ZPL =
    '^XA^FO10,10^FDCAJA^FS^SNSERIE00000001,1,Y^FS^XZ^XA^FDNORMAL^FS^XZ';

  it('marca las etiquetas serializadas al crear el lote', async () => {
    const { workflows } = buildHarness();
    const created = await workflows.createWorkflow(ALICE, {
      zplContent: SERIALIZED_ZPL,
      labelSize: '4x6',
    });

    expect(created.labels[0].serialized).toBe(true);
    expect(created.labels[1].serialized).toBe(false);
  });

  it('fija las copias y recalcula el total sin perder el valor de ^PQ', async () => {
    const { workflows } = buildHarness();
    const created = await workflows.createWorkflow(ALICE, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });
    const [first, second] = created.labels;

    const updated = await workflows.updateCopies(ALICE.uid, created.id, 1, [
      { labelId: first.labelId, copies: 7 },
      { labelId: second.labelId, copies: 2 },
    ]);

    expect(updated.version).toBe(2);
    expect(updated.labels[0].copies).toBe(7);
    expect(updated.labels[0].originalCopies).toBe(3);
    expect(updated.labels[0].copiesOverridden).toBe(true);
    expect(updated.totalCopies).toBe(9);
    expect(updated.selectedCopies).toBe(9);
  });

  it('volver al valor de ^PQ retira el override', async () => {
    const { workflows } = buildHarness();
    const created = await workflows.createWorkflow(ALICE, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });
    const [first] = created.labels;

    await workflows.updateCopies(ALICE.uid, created.id, 1, [
      { labelId: first.labelId, copies: 7 },
    ]);
    const restored = await workflows.updateCopies(ALICE.uid, created.id, 2, [
      { labelId: first.labelId, copies: 3 },
    ]);

    expect(restored.labels[0].copies).toBe(3);
    expect(restored.labels[0].copiesOverridden).toBe(false);
    expect(restored.totalCopies).toBe(4);
  });

  it('rechaza cambiar las copias de una etiqueta serializada', async () => {
    const { workflows } = buildHarness();
    const created = await workflows.createWorkflow(ALICE, {
      zplContent: SERIALIZED_ZPL,
      labelSize: '4x6',
    });
    const serialized = created.labels.find((label) => label.serialized);

    await expect(
      workflows.updateCopies(ALICE.uid, created.id, 1, [
        { labelId: serialized.labelId, copies: 4 },
      ]),
    ).rejects.toMatchObject({
      response: {
        error: 'WORKFLOW_SERIALIZED_LABEL',
        data: { labelIds: [serialized.labelId] },
      },
    });
  });

  it('rechaza copias fuera de rango y etiquetas ajenas al lote', async () => {
    const { workflows } = buildHarness();
    const created = await workflows.createWorkflow(ALICE, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });
    const [first] = created.labels;

    await expect(
      workflows.updateCopies(ALICE.uid, created.id, 1, [
        { labelId: first.labelId, copies: 0 },
      ]),
    ).rejects.toMatchObject({
      response: { error: 'WORKFLOW_COPIES_LIMIT_EXCEEDED' },
    });

    await expect(
      workflows.updateCopies(ALICE.uid, created.id, 1, [
        { labelId: 'lbl_ajena', copies: 2 },
      ]),
    ).rejects.toMatchObject({
      response: { error: 'WORKFLOW_ORDER_MISMATCH' },
    });
  });

  it('no deja que el override pase el tope del plan', async () => {
    const { workflows } = buildHarness({ plan: 'free' });
    const created = await workflows.createWorkflow(ALICE, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });
    const [first] = created.labels;

    await expect(
      workflows.updateCopies(ALICE.uid, created.id, 1, [
        { labelId: first.labelId, copies: 100 },
      ]),
    ).rejects.toMatchObject({
      response: {
        error: 'WORKFLOW_LABEL_LIMIT_EXCEEDED',
        data: { limit: 75, scope: 'plan' },
      },
    });
  });

  it('otra cuenta no puede cambiar las copias y el CAS sigue vigente', async () => {
    const { workflows } = buildHarness();
    const created = await workflows.createWorkflow(ALICE, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });
    const [first] = created.labels;

    await expect(
      workflows.updateCopies(BOB.uid, created.id, 1, [
        { labelId: first.labelId, copies: 2 },
      ]),
    ).rejects.toMatchObject({ response: { error: 'WORKFLOW_NOT_FOUND' } });

    await workflows.updateCopies(ALICE.uid, created.id, 1, [
      { labelId: first.labelId, copies: 5 },
    ]);
    await expect(
      workflows.updateCopies(ALICE.uid, created.id, 1, [
        { labelId: first.labelId, copies: 6 },
      ]),
    ).rejects.toMatchObject({
      response: { error: 'WORKFLOW_VERSION_CONFLICT' },
    });
  });

  it('la exportación imprime las copias fijadas, no las de ^PQ', async () => {
    const { workflows, exportsService, runDurableConversion } = buildHarness();
    const created = await workflows.createWorkflow(ALICE, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });
    const [first] = created.labels;

    await workflows.updateCopies(ALICE.uid, created.id, 1, [
      { labelId: first.labelId, copies: 6 },
    ]);
    const result = await exportsService.createExport(ALICE, created.id, 'k1', {
      expectedVersion: 2,
    });

    const [input] = runDurableConversion.mock.calls[0];
    expect(input.zplContent).toContain('^PQ6^XZ');
    expect(input.zplContent).not.toContain('^PQ3^XZ');
    expect(result.export.labelCount).toBe(7);
  });
});

describe('WorkflowsService — borrado', () => {
  it('borra el lote y conserva marcadas sus exportaciones', async () => {
    const { workflows, exportsService, repository } = buildHarness();
    const created = await workflows.createWorkflow(ALICE, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });
    const exported = await exportsService.createExport(
      ALICE,
      created.id,
      'k1',
      {
        expectedVersion: 1,
      },
    );

    await workflows.deleteWorkflow(ALICE.uid, created.id);

    await expect(
      workflows.getWorkflow(ALICE.uid, created.id),
    ).rejects.toBeInstanceOf(NotFoundException);

    const record = await repository.getExport(
      ALICE.uid,
      exported.export.exportId,
    );
    expect(record?.workflowDeleted).toBe(true);
    expect(record?.jobId).toBe(exported.export.jobId);
  });
});

describe('WorkflowExportsService — identificadores y eventos', () => {
  it('exportId es un UUIDv4 estable y es el operationId del puente', async () => {
    const { workflows, exportsService, runDurableConversion, events } =
      buildHarness();
    const created = await workflows.createWorkflow(ALICE, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });

    // El id del lote también es UUIDv4: el registro canónico valida su formato.
    expect(isUuid(created.id)).toBe(true);
    expect(uuidVersion(created.id)).toBe(4);

    const first = await exportsService.createExport(ALICE, created.id, 'k1', {
      expectedVersion: 1,
    });
    const retry = await exportsService.createExport(ALICE, created.id, 'k1', {
      expectedVersion: 1,
    });

    expect(isUuid(first.export.exportId)).toBe(true);
    expect(uuidVersion(first.export.exportId)).toBe(4);
    expect(retry.export.exportId).toBe(first.export.exportId);
    expect(first.export.jobId).toBe(first.export.exportId);

    const [input] = runDurableConversion.mock.calls[0];
    expect(input.operationId).toBe(first.export.exportId);

    const succeeded = events.filter(
      (event) => event.eventName === 'packing_export_succeeded',
    );
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0].operationId).toBe(first.export.exportId);
    expect(succeeded[0].workflowId).toBe(created.id);
    expect(succeeded[0].jobId).toBe(first.export.exportId);
    expect(succeeded[0].source).toBe('api');
    expect(isUuid(succeeded[0].eventId)).toBe(true);
  });

  it('el cotejo emite un operationId UUIDv4', async () => {
    const { workflows, events } = buildHarness();
    const created = await workflows.createWorkflow(ALICE, {
      zplContent: '^XA^FDPED-001^FS^XZ',
      labelSize: '4x6',
    });

    const { workflow } = await workflows.reconcile(ALICE, created.id, {
      expectedVersion: 1,
      format: 'pedido_id_guia_v1',
      csvContent: 'pedido_id,guia\nPED-001,GU1\n',
    });

    const event = events.find(
      (item) => item.eventName === 'packing_reconcile_completed',
    );
    expect(isUuid(event.operationId)).toBe(true);
    expect(event.operationId).toBe(workflow.reconcile.reconcileId);
    expect(event.source).toBe('api');
  });
});

describe('BE04 — el hecho se confirma con la transición (outbox atómico)', () => {
  it('exportar escribe la exportación y su hecho a la vez', async () => {
    const { workflows, exportsService, outbox, events } = buildHarness();
    const created = await workflows.createWorkflow(ALICE, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });

    const result = await exportsService.createExport(ALICE, created.id, 'k1', {
      expectedVersion: 1,
    });

    // Entregado en el acto: la cola queda vacía.
    expect(outbox.all()).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0].operationId).toBe(result.export.exportId);
  });

  it('si la confirmación falla, no queda ni exportación aceptada ni hecho', async () => {
    const { workflows, exportsService, repository, outbox, events } =
      buildHarness();
    const created = await workflows.createWorkflow(ALICE, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });

    // Caída justo en la transacción que pasa la exportación a `accepted`.
    repository.failNextCommit(new Error('caída en la transacción'));

    await expect(
      exportsService.createExport(ALICE, created.id, 'k1', {
        expectedVersion: 1,
      }),
    ).rejects.toThrow('caída en la transacción');

    // Ni hecho suelto ni exportación aceptada: los dos viajaban juntos.
    expect(outbox.all()).toEqual([]);
    expect(events).toEqual([]);
    const stored = await repository.getExport(
      ALICE.uid,
      created.labels &&
        (await repository.listExports(ALICE.uid, created.id))[0]?.exportId,
    );
    expect(stored?.status).not.toBe('accepted');
  });

  it('el reintento tras esa caída sí produce exportación y hecho, una sola vez', async () => {
    const { workflows, exportsService, repository, events, outbox } =
      buildHarness();
    const created = await workflows.createWorkflow(ALICE, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });

    repository.failNextCommit();
    await expect(
      exportsService.createExport(ALICE, created.id, 'k1', {
        expectedVersion: 1,
      }),
    ).rejects.toThrow();

    const retry = await exportsService.createExport(ALICE, created.id, 'k1', {
      expectedVersion: 1,
    });

    expect(retry.export.status).toBe('accepted');
    expect(events).toHaveLength(1);
    expect(events[0].operationId).toBe(retry.export.exportId);
    expect(outbox.all()).toEqual([]);
  });

  it('si el proceso muere tras confirmar, el hecho sobrevive y el drenado lo entrega', async () => {
    const { workflows, exportsService, outbox, events, recorder } =
      buildHarness();
    const created = await workflows.createWorkflow(ALICE, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });

    // Morir después de confirmar = la entrega inmediata nunca llega a ocurrir.
    const spy = jest
      .spyOn(recorder, 'recordServerEvent')
      .mockRejectedValueOnce(new Error('proceso caído'));

    const result = await exportsService.createExport(ALICE, created.id, 'k1', {
      expectedVersion: 1,
    });

    // La exportación está aceptada y el hecho sigue en la cola, no perdido.
    expect(result.export.status).toBe('accepted');
    const [pending] = outbox.all();
    expect(pending.operationId).toBe(result.export.exportId);
    expect(pending.accountId).toBe(ALICE.uid);
    expect(events).toEqual([]);

    spy.mockRestore();
    jest.useFakeTimers().setSystemTime(Date.now() + 10 * 60_000);
    try {
      expect(await buildDrain(outbox, recorder)).toMatchObject({
        delivered: 1,
      });
    } finally {
      jest.useRealTimers();
    }

    expect(events).toHaveLength(1);
    expect(events[0].eventId).toBe(pending.id);
    expect(outbox.all()).toEqual([]);
  });

  it('el cotejo escribe su diagnóstico y su hecho juntos', async () => {
    const { workflows, repository, outbox, events } = buildHarness();
    const created = await workflows.createWorkflow(ALICE, {
      zplContent: '^XA^FDPED-001^FS^XZ',
      labelSize: '4x6',
    });

    repository.failNextCommit();
    await expect(
      workflows.reconcile(ALICE, created.id, {
        expectedVersion: 1,
        format: 'pedido_id_guia_v1',
        csvContent: 'pedido_id,guia\nPED-001,GU1\n',
      }),
    ).rejects.toThrow();

    // Ni cotejo guardado ni hecho.
    expect(
      (await workflows.getWorkflow(ALICE.uid, created.id)).reconcile,
    ).toBeUndefined();
    expect(outbox.all()).toEqual([]);
    expect(events).toEqual([]);

    const ok = await workflows.reconcile(ALICE, created.id, {
      expectedVersion: 1,
      format: 'pedido_id_guia_v1',
      csvContent: 'pedido_id,guia\nPED-001,GU1\n',
    });

    expect(ok.workflow.reconcile.counts.matched).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0].eventName).toBe('packing_reconcile_completed');
  });
});

describe('BE04 — cuenta borrada (lápida)', () => {
  it('no admite crear, exportar ni cotejar, y no deja hechos', async () => {
    const { workflows, exportsService, repository, outbox, events } =
      buildHarness();
    const created = await workflows.createWorkflow(ALICE, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });

    // La baja ocurre entre la lectura y la escritura.
    repository.markAccountDeleted(ALICE.uid);

    await expect(
      exportsService.createExport(ALICE, created.id, 'k1', {
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ response: { error: 'ACCOUNT_DELETED' } });

    await expect(
      workflows.reconcile(ALICE, created.id, {
        expectedVersion: 1,
        format: 'pedido_id_guia_v1',
        csvContent: 'pedido_id,guia\nPEDIDO-001,GU1\n',
      }),
    ).rejects.toMatchObject({ response: { error: 'ACCOUNT_DELETED' } });

    await expect(
      workflows.createWorkflow(ALICE, {
        zplContent: ZPL_TWO_WITH_COPIES,
        labelSize: '4x6',
      }),
    ).rejects.toMatchObject({ response: { error: 'ACCOUNT_DELETED' } });

    expect(outbox.all()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('otra cuenta sigue funcionando con normalidad', async () => {
    const { workflows, repository, events } = buildHarness();
    repository.markAccountDeleted(ALICE.uid);

    const bobWorkflow = await workflows.createWorkflow(BOB, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });

    expect(bobWorkflow.version).toBe(1);
    expect(events).toEqual([]);
  });
});

describe('Workflow export recovery with pinned input', () => {
  it('retries the same converter UUID and payload after workflow edits', async () => {
    const {
      workflows,
      repository,
      exportsService,
      runDurableConversion,
      events,
    } = buildHarness();
    const workflow = await workflows.createWorkflow(ALICE, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
      name: 'Original',
    });
    repository.failNextCommit();
    await expect(
      exportsService.createExport(ALICE, workflow.id, 'pinned', {
        expectedVersion: 1,
      }),
    ).rejects.toThrow();
    await repository.updateWorkflow(ALICE.uid, workflow.id, 1, () => ({
      name: 'Changed',
      labelSize: '2x1',
      outputFormat: 'png',
      selectedIds: [],
      orderIds: [...workflow.labels.map((label) => label.labelId)].reverse(),
    }));
    const retried = await exportsService.createExport(
      ALICE,
      workflow.id,
      'pinned',
      { expectedVersion: 1 },
    );
    expect(retried.export.status).toBe('accepted');
    expect(runDurableConversion.mock.calls[1][0]).toEqual(
      runDurableConversion.mock.calls[0][0],
    );
    expect(events).toHaveLength(1);
  });

  it('keeps accepted success when appendJobRef fails and does not convert or emit again', async () => {
    const {
      workflows,
      repository,
      exportsService,
      runDurableConversion,
      events,
    } = buildHarness();
    const workflow = await workflows.createWorkflow(ALICE, {
      zplContent: ZPL_TWO_WITH_COPIES,
      labelSize: '4x6',
    });
    jest
      .spyOn(repository, 'appendJobRef')
      .mockRejectedValue(new Error('write unavailable'));
    const first = await exportsService.createExport(
      ALICE,
      workflow.id,
      'append-failure',
      { expectedVersion: 1 },
    );
    const retry = await exportsService.createExport(
      ALICE,
      workflow.id,
      'append-failure',
      { expectedVersion: 1 },
    );
    expect(first.export.status).toBe('accepted');
    expect(retry.export.status).toBe('accepted');
    expect(retry.created).toBe(false);
    expect(runDurableConversion).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
  });
});

describe('Workflow service late workers', () => {
  it.each(['complete', 'fail'])(
    'returns the winning acceptance after a late worker tries to %s',
    async (late) => {
      jest.useFakeTimers();
      try {
        const h = buildHarness();
        const workflow = await h.workflows.createWorkflow(ALICE, {
          zplContent: ZPL_TWO_WITH_COPIES,
          labelSize: '4x6',
        });
        let started!: () => void;
        const entered = new Promise<void>((resolve) => {
          started = resolve;
        });
        let finish!: (value: { jobId: string; status: string }) => void;
        let fail!: (error: Error) => void;
        h.runDurableConversion.mockImplementationOnce(() => {
          started();
          return new Promise((resolve, reject) => {
            finish = resolve;
            fail = reject;
          });
        });
        const first = h.exportsService.createExport(
          ALICE,
          workflow.id,
          'race',
          { expectedVersion: 1 },
        );
        await entered;
        // Simulate a suspended process: its renewal timer never ran.
        jest.setSystemTime(new Date(Date.now() + 13 * 60_000));
        const second = await h.exportsService.createExport(
          ALICE,
          workflow.id,
          'race',
          { expectedVersion: 1 },
        );
        const accepted = await h.repository.getExport(
          ALICE.uid,
          second.export.exportId,
        );
        if (late === 'complete')
          finish({ jobId: second.export.exportId, status: 'completed' });
        else fail(new Error('late converter failure'));
        const stale = await first;
        expect(stale.export.status).toBe('accepted');
        expect(stale.created).toBe(false);
        expect(
          await h.repository.getExport(ALICE.uid, second.export.exportId),
        ).toEqual(accepted);
        expect(h.events).toHaveLength(1);
        expect(h.outbox.all()).toEqual([]);
      } finally {
        jest.useRealTimers();
      }
    },
  );
});
