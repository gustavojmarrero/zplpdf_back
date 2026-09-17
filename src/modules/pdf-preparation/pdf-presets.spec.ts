import { randomUUID } from 'node:crypto';
import { Timestamp } from '@google-cloud/firestore';
import { PdfPresetsService } from './pdf-presets.service.js';
import { MemoryDb } from '../folder-automation/testing/memory-db.js';
const recipe = {
  paper: '4x6',
  columns: 1,
  rows: 1,
  marginPt: 0,
  gapPt: 0,
  scale: 'actual',
  selections: [{ page: 0, rotation: 0 }],
};
function fixture() {
  const db = new MemoryDb();
  db.rows.set('users/owner', {});
  return {
    db,
    service: new PdfPresetsService(
      { getClient: () => db } as any,
      {
        assertFeatureAvailable: async () => ({ featureVersion: '1' }),
      } as any,
    ),
  };
}
describe('persistent preset limits and replay', () => {
  it('serializes the 50th slot and archive releases it only once', async () => {
    const { db, service } = fixture();
    db.rows.set('pdf_preset_limits/owner', {
      accountId: 'owner',
      activeCount: 49,
    });
    const results = await Promise.allSettled(
      [0, 1].map(() =>
        service.create('owner', {
          id: randomUUID(),
          name: 'Synthetic',
          recipe,
        }),
      ),
    );
    const winner = results.find(
      (r) => r.status === 'fulfilled',
    ) as PromiseFulfilledResult<any>;
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(db.rows.get('pdf_preset_limits/owner').activeCount).toBe(50);
    await service.archive('owner', winner.value.preset.id, {
      expectedVersion: 1,
    });
    await service.archive('owner', winner.value.preset.id, {
      expectedVersion: 1,
    });
    expect(db.rows.get('pdf_preset_limits/owner').activeCount).toBe(49);
    await service.create('owner', {
      id: randomUUID(),
      name: 'Replacement',
      recipe,
    });
    expect(db.rows.get('pdf_preset_limits/owner').activeCount).toBe(50);
  });
  it('keeps creation and update replays immutable after archive and caps versions at 200', async () => {
    const { db, service } = fixture(),
      id = randomUUID();
    const input = { id, name: 'Original', recipe };
    await service.create('owner', input);
    const next = { expectedVersion: 1, name: 'Second', recipe };
    await service.update('owner', id, next);
    await service.archive('owner', id, { expectedVersion: 2 });
    expect((await service.create('owner', input)).preset.version).toBe(1);
    expect((await service.update('owner', id, next)).preset.version).toBe(2);
    await expect(
      service.update('owner', id, { ...next, expectedVersion: 2 }),
    ).rejects.toThrow('PDF_PRESET_VERSION_CONFLICT');
    const versions = await service.versions('owner', id);
    expect(versions.versions.map((v) => [v.version, v.status])).toEqual([
      [2, 'active'],
      [1, 'active'],
    ]);
    db.rows.get(`pdf_output_presets/${id}`).status = 'active';
    db.rows.get(`pdf_output_presets/${id}`).version = 199;
    expect(
      (await service.update('owner', id, { ...next, expectedVersion: 199 }))
        .preset.version,
    ).toBe(200);
    await expect(
      service.update('owner', id, { ...next, expectedVersion: 200 }),
    ).rejects.toThrow('PDF_PRESET_VERSION_INVALID');
  });
  it('survives expired source operations without retaining source metadata', async () => {
    const { db, service } = fixture(),
      id = randomUUID();
    db.rows.set('durable_operations/source', {
      userId: 'owner',
      expiresAt: Timestamp.fromMillis(0),
    });
    await service.create('owner', { id, name: 'Persistent', recipe });
    db.rows.delete('durable_operations/source');
    expect((await service.list('owner')).presets).toHaveLength(1);
    const row = db.rows.get(`pdf_output_presets/${id}`);
    expect(row).not.toHaveProperty('expiresAt');
    expect(row).not.toHaveProperty('sourcePath');
    await expect(
      service.create('foreign', { id, name: 'Persistent', recipe }),
    ).rejects.toThrow();
    db.rows.set('deleted_accounts/owner', {});
    await expect(
      service.create('owner', { id, name: 'Persistent', recipe }),
    ).rejects.toThrow('Account unavailable');
    await expect(
      service.update('owner', id, { expectedVersion: 1, name: 'New', recipe }),
    ).rejects.toThrow('Account unavailable');
    await expect(
      service.archive('owner', id, { expectedVersion: 1 }),
    ).rejects.toThrow('Account unavailable');
  });
});

describe('preset and source crop validation agree', () => {
  it('persists valid negative media-box coordinates and revalidates them against a different source', async () => {
    const { PDFDocument } = await import('pdf-lib');
    const { preparePdf } = await import('./pdf-layout.js');
    const { service } = fixture();
    const document = await PDFDocument.create();
    const page = document.addPage([288, 432]);
    page.setMediaBox(-100, -100, 288, 432);
    const cropped = {
      ...recipe,
      selections: [
        {
          page: 0,
          rotation: 0,
          crop: { x: -50, y: -50, width: 100, height: 200 },
        },
      ],
    };
    await expect(
      preparePdf(Buffer.from(await document.save()), cropped as any),
    ).resolves.toMatchObject({ pageCount: 1 });
    const saved = await service.create('owner', {
      id: randomUUID(),
      name: 'Negative media origin',
      recipe: cropped,
    });
    expect(saved.preset.recipe).toEqual(cropped);
    page.setMediaBox(0, 0, 288, 432);
    await expect(
      preparePdf(Buffer.from(await document.save()), saved.preset.recipe),
    ).rejects.toThrow('PDF_CROP_OUTSIDE_PAGE');
  });
});
