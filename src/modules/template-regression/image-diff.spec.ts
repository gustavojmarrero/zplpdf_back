import sharp from 'sharp';
import { compareLabelImages } from './image-diff.js';
async function fixture(changed = false, width = 10) {
  const bytes = Buffer.alloc(width * 10 * 3, 255);
  if (changed) {
    bytes[0] = 0;
    bytes[1] = 0;
    bytes[2] = 0;
  }
  return sharp(bytes, { raw: { width, height: 10, channels: 3 } })
    .png()
    .toBuffer();
}
describe('synthetic label regression diff', () => {
  it('normalizes grayscale and RGB channels before computing differences', async () => {
    const rgb = await fixture(true);
    const grayscale = await sharp(rgb).greyscale().png().toBuffer();
    expect(
      await compareLabelImages(grayscale, rgb, {
        channelTolerance: 0,
        maxChangedRatio: 0,
      }),
    ).toMatchObject({ passed: true, changedPixels: 0, comparedPixels: 100 });
  });
  it('decodes images before comparing and reports a changed pixel', async () => {
    const result = await compareLabelImages(
      await fixture(),
      await fixture(true),
      { maxChangedRatio: 0 },
    );
    expect(result).toMatchObject({
      passed: false,
      changedPixels: 1,
      comparedPixels: 100,
      changedRatio: 0.01,
    });
    expect(await sharp(result.diffPng).metadata()).toMatchObject({
      width: 10,
      height: 10,
      format: 'png',
    });
  });
  it('applies explicit masks without treating excluded pixels as matched', async () => {
    expect(
      await compareLabelImages(await fixture(), await fixture(true), {
        masks: [{ x: 0, y: 0, width: 1, height: 1 }],
      }),
    ).toMatchObject({ passed: true, comparedPixels: 99, changedPixels: 0 });
    await expect(
      compareLabelImages(await fixture(), await fixture(), {
        masks: [{ x: 0, y: 0, width: 10, height: 10 }],
      }),
    ).rejects.toThrow('DIFF_MASK_EXCLUDES_EVERY_PIXEL');
  });
  it('reports dimension changes and rejects invalid masks', async () => {
    expect(
      await compareLabelImages(await fixture(), await fixture(false, 12)),
    ).toMatchObject({
      passed: false,
      status: 'dimensions_changed',
      changedRatio: null,
    });
    await expect(
      compareLabelImages(await fixture(), await fixture(), {
        masks: [{ x: 10, y: 0, width: 1, height: 1 }],
      }),
    ).rejects.toThrow('INVALID_DIFF_MASK');
  });
});
