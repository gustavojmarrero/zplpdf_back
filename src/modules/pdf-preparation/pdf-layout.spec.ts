import { PDFDocument, PDFName, degrees } from 'pdf-lib';
import { randomBytes } from 'node:crypto';
import { preparePdf, PdfRecipe, runPdfWorker } from './pdf-layout.js';
const recipe: PdfRecipe = {
  selections: [{ page: 0, rotation: 0 }],
  paper: '4x6',
  columns: 1,
  rows: 1,
  marginPt: 0,
  gapPt: 0,
  scale: 'actual',
};
async function source(width = 288, height = 432, rotation = 0) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([width, height]);
  page.drawText('SYNTHETIC LABEL 001', { x: 10, y: 20 });
  page.setRotation(degrees(rotation));
  return Buffer.from(await pdf.save());
}
describe('physical PDF layout', () => {
  it('preserves 4x6 dimensions in points and produces loadable vector output', async () => {
    const result = await preparePdf(await source(), recipe);
    const pdf = await PDFDocument.load(result.buffer);
    expect(pdf.getPage(0).getSize()).toEqual({ width: 288, height: 432 });
    expect(result.labelCount).toBe(1);
  });
  it('imposes multiple selected pages in order on A4 sheets', async () => {
    const result = await preparePdf(await source(), {
      ...recipe,
      paper: 'a4',
      rows: 2,
      columns: 2,
      scale: 'fit',
      selections: Array.from({ length: 5 }, () => ({ page: 0, rotation: 0 })),
    });
    expect(result.pageCount).toBe(2);
    expect(result.labelCount).toBe(5);
  });
  it('respects a rotated source page and explicit crop', async () => {
    const result = await preparePdf(await source(432, 288, 90), recipe);
    expect(result.pageCount).toBe(1);
    await expect(
      preparePdf(await source(), {
        ...recipe,
        selections: [
          {
            page: 0,
            rotation: 90,
            crop: { x: 0, y: 0, width: 100, height: 200 },
          },
        ],
      }),
    ).resolves.toMatchObject({ pageCount: 1 });
  });
  it('rejects clipped actual-size layouts, invalid crops and invalid files', async () => {
    await expect(preparePdf(await source(600, 800), recipe)).rejects.toThrow(
      'PDF_ACTUAL_SIZE_DOES_NOT_FIT',
    );
    await expect(
      preparePdf(await source(), {
        ...recipe,
        selections: [
          {
            page: 0,
            rotation: 0,
            crop: { x: 0, y: 0, width: 900, height: 900 },
          },
        ],
      }),
    ).rejects.toThrow('PDF_CROP_OUTSIDE_PAGE');
    await expect(preparePdf(Buffer.from('not pdf'), recipe)).rejects.toThrow(
      'PDF_INVALID',
    );
  });
  it('rejects incomplete crop objects and prototype-like paper names as client errors', async () => {
    const bytes = await source();
    await expect(
      preparePdf(bytes, { ...recipe, paper: 'toString' as any }),
    ).rejects.toThrow('PDF_RECIPE_INVALID');
    await expect(
      preparePdf(bytes, {
        ...recipe,
        selections: [{ page: 0, rotation: 0, crop: {} as any }],
      }),
    ).rejects.toThrow('PDF_CROP_OUTSIDE_PAGE');
  });
  it('keeps blank inputs blank and reuses repeated vector pages within a bounded file', async () => {
    const blank = await PDFDocument.create();
    blank.addPage([288, 432]);
    expect(
      await preparePdf(Buffer.from(await blank.save()), recipe),
    ).toMatchObject({ pageCount: 1, labelCount: 1 });
    const repeated = await preparePdf(await source(), {
      ...recipe,
      paper: 'a4',
      columns: 2,
      rows: 2,
      scale: 'fit',
      selections: Array.from({ length: 100 }, () => ({ page: 0, rotation: 0 })),
    });
    expect(repeated.pageCount).toBe(25);
    expect(repeated.buffer.length).toBeLessThan(100000);
  });
});

describe('PDF parser isolation', () => {
  it('enforces both input and serialized output byte budgets', async () => {
    await expect(
      preparePdf(Buffer.alloc(20 * 1024 * 1024 + 1), recipe),
    ).rejects.toThrow('PDF_MAX_20_MB');
    const document = await PDFDocument.create();
    const page = document.addPage([288, 432]);
    // Incompressible synthetic content exercises the serialized-output boundary.
    page.node.set(
      PDFName.of('Contents'),
      document.context.register(
        document.context.stream(randomBytes(11 * 1024 * 1024)),
      ),
    );
    const bytes = Buffer.from(await document.save());
    expect(bytes.length).toBeLessThan(20 * 1024 * 1024);
    await expect(preparePdf(bytes, recipe)).rejects.toThrow(
      'PDF_OUTPUT_MAX_20_MB',
    );
  });
  it('terminates at the deadline and releases capacity for the next PDF', async () => {
    const bytes = await source();
    await expect(runPdfWorker(bytes, recipe, 1)).rejects.toThrow(
      'PDF_PROCESSING_TIMEOUT',
    );
    await expect(preparePdf(bytes, recipe)).resolves.toMatchObject({
      pageCount: 1,
    });
  });
  it('bounds concurrent isolates without retaining an unbounded input queue', async () => {
    const bytes = await source();
    const running = Promise.allSettled([
      runPdfWorker(bytes, recipe, 1),
      runPdfWorker(bytes, recipe, 1),
    ]);
    await expect(preparePdf(bytes, recipe)).rejects.toThrow(
      'PDF_PREPARATION_BUSY',
    );
    await running;
    await expect(preparePdf(bytes, recipe)).resolves.toMatchObject({
      pageCount: 1,
    });
  });
  it('parses and lays out outside the request thread', async () => {
    const bytes = await source();
    const parser = jest
      .spyOn(PDFDocument, 'load')
      .mockImplementation(async () => {
        throw new Error('REQUEST_THREAD_PARSER_CALLED');
      });
    try {
      await expect(preparePdf(bytes, recipe)).resolves.toMatchObject({
        pageCount: 1,
      });
      expect(parser).not.toHaveBeenCalled();
    } finally {
      parser.mockRestore();
    }
  });
});

describe('PDF crop resource reuse', () => {
  it('embeds one source stream across many different crops instead of multiplying its decompressed contents', async () => {
    const { PDFName, PDFRawStream } = await import('pdf-lib');
    const result = await preparePdf(await source(), {
      ...recipe,
      selections: Array.from({ length: 24 }, (_, x) => ({
        page: 0,
        rotation: 0,
        crop: { x, y: 0, width: 100, height: 200 },
      })),
    });
    const pdf = await PDFDocument.load(result.buffer);
    const forms = pdf.context
      .enumerateIndirectObjects()
      .filter(
        ([, object]) =>
          object instanceof PDFRawStream &&
          object.dict.get(PDFName.of('Subtype')) === PDFName.of('Form'),
      );
    expect(result.labelCount).toBe(24);
    expect(forms).toHaveLength(1);
  });
});
