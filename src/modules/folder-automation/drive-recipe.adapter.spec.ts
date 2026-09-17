import { randomUUID } from 'node:crypto';
import {
  DriveRecipeAdapter,
  driveRecipeLimits,
} from './drive-recipe.adapter.js';
import { MemoryDb } from './testing/memory-db.js';
function fixture() {
  const db = new MemoryDb();
  const store = {
    getClient: () => ({
      doc: (path: string) => db.ref(path),
      collection: db.collection.bind(db),
    }),
  };
  const flags = {
    assertFeatureAvailable: jest
      .fn()
      .mockResolvedValue({ featureVersion: '1' }),
  };
  const pdf = { export: jest.fn().mockResolvedValue({ status: 'completed' }) };
  const tables = {
    materializeFileSnapshot: jest.fn().mockResolvedValue({
      zplContent: '^XA^FD001^FS^XZ',
      labelSize: '4x6',
      labelCount: 1,
    }),
  };
  const zpl = {
    runDurableConversion: jest.fn().mockResolvedValue({ status: 'completed' }),
  };
  return {
    db,
    flags,
    pdf,
    tables,
    zpl,
    service: new DriveRecipeAdapter(
      store as any,
      flags as any,
      pdf as any,
      tables as any,
      zpl as any,
    ),
  };
}
describe('versioned Drive recipes', () => {
  it('preserves the selected PDF version and passes the same operation ID into quota boundary', async () => {
    const h = fixture(),
      id = randomUUID(),
      op = randomUUID();
    const layout = {
      paper: '4x6',
      columns: 1,
      rows: 1,
      selections: [{ page: 0, rotation: 0 }],
    };
    h.db.rows.set(`pdf_output_presets/${id}`, {
      accountId: 'owner',
      status: 'active',
    });
    h.db.rows.set(`pdf_output_preset_versions/${id}_1`, {
      accountId: 'owner',
      recipe: layout,
    });
    const resolved = await h.service.resolve('owner', {
      kind: 'pdf',
      presetId: id,
      presetVersion: 1,
    });
    h.db.rows.set(`pdf_output_presets/${id}`, {
      accountId: 'owner',
      status: 'archived',
    });
    await h.service.convert(
      'owner',
      op,
      Buffer.from('%PDF-'),
      resolved.snapshot,
    );
    expect(h.pdf.export).toHaveBeenCalledWith(
      'owner',
      op,
      Buffer.from('%PDF-'),
      layout,
      'folder',
    );
    expect(resolved.recipe).not.toHaveProperty('layout');
    await expect(h.service.resolve('owner', resolved.recipe)).rejects.toThrow(
      'PDF_PRESET_NOT_FOUND',
    );
    await expect(h.service.resolve('foreign', resolved.recipe)).rejects.toThrow(
      'PDF_PRESET_NOT_FOUND',
    );
  });
  it('pins the owned template and mapping without creating a second template run', async () => {
    const h = fixture(),
      id = randomUUID(),
      op = randomUUID();
    const version = {
      ownerId: 'owner',
      accountId: 'owner',
      templateId: id,
      versionNumber: 1,
      labelSize: '4x6',
      fields: [{ key: 'sku', required: true }],
      zplTemplate: '^XA^FD{{sku}}^FS^XZ',
    };
    h.db.rows.set(`label_templates/${id}`, {
      ownerId: 'owner',
      status: 'active',
    });
    h.db.rows.set(`label_template_versions/${id}:1`, version);
    const resolved = await h.service.resolve('owner', {
      kind: 'template',
      templateId: id,
      templateVersion: 1,
      format: 'xlsx',
      mapping: { fields: { sku: 'SKU' }, quantityColumn: 'Quantity' },
    });
    await h.service.convert(
      'owner',
      op,
      Buffer.from('synthetic xlsx'),
      resolved.snapshot,
    );
    expect(h.tables.materializeFileSnapshot).toHaveBeenCalledWith(
      'owner',
      version,
      expect.objectContaining({
        format: 'xlsx',
        content: Buffer.from('synthetic xlsx').toString('base64'),
        mapping: { fields: { sku: 'SKU' }, quantityColumn: 'Quantity' },
      }),
    );
    expect(h.zpl.runDurableConversion).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: op,
        userId: 'owner',
        labelSize: '4x6',
      }),
    );
    expect(resolved.recipe).not.toHaveProperty('version');
    await expect(
      h.service.resolve('owner', {
        ...resolved.recipe,
        mapping: { fields: { unknown: 'X' } },
      }),
    ).rejects.toThrow('DRIVE_MAPPING_INVALID');
    await expect(h.service.resolve('foreign', resolved.recipe)).rejects.toThrow(
      'Template version unavailable',
    );
  });
  it('rejects client snapshots and invalid recipe fields; bounds input according to format', async () => {
    const h = fixture();
    await expect(
      h.service.resolve('owner', { kind: 'pdf', snapshot: {} }),
    ).rejects.toThrow('DRIVE_RECIPE_INVALID');
    await expect(
      h.service.resolve('owner', { kind: 'zpl', source: 'http://internal' }),
    ).rejects.toThrow('DRIVE_RECIPE_INVALID');
    await expect(
      h.service.resolve('owner', { kind: 'unknown' }),
    ).rejects.toThrow('DRIVE_RECIPE_KIND_INVALID');
    expect(driveRecipeLimits({ kind: 'pdf' }).maxBytes).toBe(20 * 1024 * 1024);
    expect(
      driveRecipeLimits({ kind: 'template', format: 'xlsx' }).mimes,
    ).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(driveRecipeLimits(undefined).maxBytes).toBe(1024 * 1024);
  });
});
