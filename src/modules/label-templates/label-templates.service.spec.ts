import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { LabelTemplatesService } from './label-templates.service.js';
import { InMemoryTemplateRepository } from './label-templates.in-memory-repository.js';
import { DeniedByDefaultFeatureGate } from '../workflows/ports/feature-gate.port.js';
import { LabelEventPublisher } from '../workflows/label-event.publisher.js';
import { InMemoryLabelEventOutbox } from '../workflows/label-event.store.js';
import type { FeatureGatePort } from '../workflows/ports/feature-gate.port.js';
import type {
  LabelEventRecorderPort,
  LabelServerEvent,
} from '../workflows/ports/label-event-recorder.port.js';

const ALICE = { uid: 'alice', email: 'alice@example.com' };
const BOB = { uid: 'bob', email: 'bob@example.com' };

class AllowAllFeatureGate implements FeatureGatePort {
  assertFeatureAvailable(): void {}
}

function buildTemplateHarness() {
  const outbox = new InMemoryLabelEventOutbox();
  const repository = new InMemoryTemplateRepository(outbox);
  const events: LabelServerEvent[] = [];
  const recorder: LabelEventRecorderPort = {
    async recordServerEvent(event) {
      events.push(event);
      return { duplicate: false };
    },
  };
  const service = new LabelTemplatesService(
    repository,
    new AllowAllFeatureGate(),
    new LabelEventPublisher(recorder, outbox),
  );

  return { repository, service, events, outbox };
}

const CUSTOM = {
  kind: 'product' as const,
  name: 'Mía',
  labelSize: '2x1',
  fields: [{ key: 'sku', label: 'SKU', type: 'code' as const, required: true }],
  zplTemplate: '^XA^CI28^FO10,10^FD{{sku}}^FS^XZ',
};

describe('LabelTemplatesService', () => {
  it('crea una plantilla a partir de una de las iniciales, con su versión 1', async () => {
    const { service, events } = buildTemplateHarness();

    const { template, version } = await service.createTemplate(ALICE, {
      fromBuiltin: 'product',
    });

    expect(template.kind).toBe('product');
    expect(template.currentVersion).toBe(1);
    expect(template.version).toBe(1);
    expect(template.status).toBe('active');
    expect(version.versionNumber).toBe(1);
    expect(version.zplTemplate).toContain('{{sku}}');
    expect(version.checksum).toHaveLength(64);
    // Guardar una plantilla no es activación, pero sí es un hecho del servidor.
    expect(events.map((event) => event.eventName)).toEqual(['template_saved']);
  });

  it('ofrece las tres plantillas iniciales', async () => {
    const { service } = buildTemplateHarness();
    const { items } = service.listBuiltins();
    expect(items.map((item) => item.kind).sort()).toEqual([
      'location',
      'lot',
      'product',
    ]);
  });

  it('rechaza una plantilla propia con ZPL o campos inválidos', async () => {
    const { service } = buildTemplateHarness();

    await expect(
      service.createTemplate(ALICE, {
        ...CUSTOM,
        zplTemplate: '^XA^FO{{sku}},10^FS^XZ',
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    await expect(
      service.createTemplate(ALICE, {
        ...CUSTOM,
        fields: [{ key: 'X', label: 'x', type: 'code', required: true }],
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('exige fromBuiltin o la definición completa', async () => {
    const { service } = buildTemplateHarness();
    await expect(
      service.createTemplate(ALICE, { name: 'sin nada' }),
    ).rejects.toMatchObject({ response: { error: 'INVALID_INPUT' } });
  });

  it('el gate por defecto deniega mientras el flag está apagado', async () => {
    const service = new LabelTemplatesService(
      new InMemoryTemplateRepository(),
      new DeniedByDefaultFeatureGate(),
      new LabelEventPublisher(),
    );

    await expect(
      service.createTemplate(ALICE, { fromBuiltin: 'lot' }),
    ).rejects.toMatchObject({
      response: {
        error: 'FEATURE_NOT_AVAILABLE',
        data: { featureId: 'data_templates' },
      },
    });
  });

  it('una versión nueva no altera la anterior', async () => {
    const { service, repository } = buildTemplateHarness();
    const created = await service.createTemplate(ALICE, CUSTOM);

    const { template, version } = await service.addVersion(
      ALICE,
      created.template.id,
      {
        expectedVersion: 1,
        fields: [
          { key: 'sku', label: 'SKU', type: 'code', required: true },
          { key: 'lote', label: 'Lote', type: 'code', required: false },
        ],
        zplTemplate: '^XA^CI28^FD{{sku}}^FS^FD{{lote}}^FS^XZ',
      },
    );

    expect(version.versionNumber).toBe(2);
    expect(template.currentVersion).toBe(2);

    // La versión 1 sigue existiendo exactamente como se creó.
    const first = await repository.getVersion(
      ALICE.uid,
      created.template.id,
      1,
    );
    expect(first?.zplTemplate).toBe(CUSTOM.zplTemplate);
    expect(first?.fields).toHaveLength(1);
    expect(first?.checksum).toBe(created.version.checksum);
  });

  it('el CAS de la metadata devuelve conflicto en vez de sobrescribir', async () => {
    const { service } = buildTemplateHarness();
    const created = await service.createTemplate(ALICE, CUSTOM);

    await service.updateTemplate(ALICE.uid, created.template.id, {
      expectedVersion: 1,
      name: 'Renombrada',
    });

    await expect(
      service.updateTemplate(ALICE.uid, created.template.id, {
        expectedVersion: 1,
        name: 'Otra',
      }),
    ).rejects.toMatchObject({
      response: {
        error: 'TEMPLATE_VERSION_CONFLICT',
        data: { expectedVersion: 1, currentVersion: 2 },
      },
    });

    await expect(
      service.addVersion(ALICE, created.template.id, {
        expectedVersion: 1,
        fields: CUSTOM.fields,
        zplTemplate: CUSTOM.zplTemplate,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('otra cuenta no puede leer ni modificar la plantilla', async () => {
    const { service } = buildTemplateHarness();
    const created = await service.createTemplate(ALICE, CUSTOM);
    const id = created.template.id;

    await expect(service.getTemplate(BOB.uid, id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.updateTemplate(BOB.uid, id, { expectedVersion: 1, name: 'x' }),
    ).rejects.toMatchObject({ response: { error: 'TEMPLATE_NOT_FOUND' } });
    await expect(
      service.addVersion(BOB, id, {
        expectedVersion: 1,
        fields: CUSTOM.fields,
        zplTemplate: CUSTOM.zplTemplate,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.archiveTemplate(BOB.uid, id, 1),
    ).rejects.toBeInstanceOf(NotFoundException);

    // Intacta para su dueña.
    const { template } = await service.getTemplate(ALICE.uid, id);
    expect(template.version).toBe(1);
    expect((await service.listTemplates(BOB.uid)).items).toEqual([]);
  });

  it('archiva sin borrar versiones y no admite versiones nuevas después', async () => {
    const { service } = buildTemplateHarness();
    const created = await service.createTemplate(ALICE, CUSTOM);

    const archived = await service.archiveTemplate(
      ALICE.uid,
      created.template.id,
      1,
    );
    expect(archived.status).toBe('archived');

    const { versions } = await service.getTemplate(
      ALICE.uid,
      created.template.id,
    );
    expect(versions).toHaveLength(1);

    await expect(
      service.addVersion(ALICE, created.template.id, {
        expectedVersion: 2,
        fields: CUSTOM.fields,
        zplTemplate: CUSTOM.zplTemplate,
      }),
    ).rejects.toMatchObject({ response: { error: 'TEMPLATE_ARCHIVED' } });
  });

  it('resolveVersion usa la vigente y falla con una versión inexistente', async () => {
    const { service } = buildTemplateHarness();
    const created = await service.createTemplate(ALICE, CUSTOM);

    const current = await service.resolveVersion(
      ALICE.uid,
      created.template.id,
    );
    expect(current.version.versionNumber).toBe(1);

    await expect(
      service.resolveVersion(ALICE.uid, created.template.id, 9),
    ).rejects.toMatchObject({
      response: { error: 'TEMPLATE_VERSION_NOT_FOUND' },
    });
  });
});
