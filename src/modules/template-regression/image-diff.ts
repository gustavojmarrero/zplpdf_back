import sharp from 'sharp';
import { BadRequestException } from '@nestjs/common';
export interface DiffMask {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface DiffOptions {
  masks?: DiffMask[];
  channelTolerance?: number;
  maxChangedRatio?: number;
}
/** Pixel comparison over decoded images with explicit excluded regions; no physical-print claims. */
export async function compareLabelImages(
  baseline: Buffer,
  candidate: Buffer,
  options: DiffOptions = {},
) {
  const tolerance = options.channelTolerance ?? 8;
  const allowed = options.maxChangedRatio ?? 0.005;
  if (
    !Number.isInteger(tolerance) ||
    tolerance < 0 ||
    tolerance > 64 ||
    !Number.isFinite(allowed) ||
    allowed < 0 ||
    allowed > 0.1
  )
    throw new BadRequestException('INVALID_DIFF_THRESHOLD');
  const decode = (input: Buffer) =>
    sharp(input, { limitInputPixels: 16_000_000 })
      .flatten({ background: '#ffffff' })
      .toColourspace('srgb')
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  let a: Awaited<ReturnType<typeof decode>>,
    b: Awaited<ReturnType<typeof decode>>;
  try {
    [a, b] = await Promise.all([decode(baseline), decode(candidate)]);
  } catch {
    throw new BadRequestException('INVALID_REGRESSION_IMAGE');
  }
  if (a.info.width !== b.info.width || a.info.height !== b.info.height)
    return {
      status: 'dimensions_changed',
      passed: false,
      width: a.info.width,
      height: a.info.height,
      candidateWidth: b.info.width,
      candidateHeight: b.info.height,
      comparedPixels: null,
      changedPixels: null,
      changedRatio: null,
      diffPng: null,
    };
  const masks = options.masks ?? [];
  if (
    !Array.isArray(masks) ||
    masks.length > 20 ||
    masks.some(
      (m) =>
        !m ||
        ![m.x, m.y, m.width, m.height].every(Number.isInteger) ||
        m.x < 0 ||
        m.y < 0 ||
        m.width <= 0 ||
        m.height <= 0 ||
        m.x + m.width > a.info.width ||
        m.y + m.height > a.info.height,
    )
  )
    throw new BadRequestException('INVALID_DIFF_MASK');
  const width = a.info.width,
    height = a.info.height;
  const diff = Buffer.alloc(width * height * 3, 255);
  let comparedPixels = 0,
    changedPixels = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      if (
        masks.some(
          (m) =>
            x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height,
        )
      ) {
        diff[offset] = 210;
        diff[offset + 1] = 210;
        diff[offset + 2] = 210;
        continue;
      }
      comparedPixels++;
      if (
        [0, 1, 2].some(
          (c) => Math.abs(a.data[offset + c] - b.data[offset + c]) > tolerance,
        )
      ) {
        changedPixels++;
        diff[offset] = 220;
        diff[offset + 1] = 30;
        diff[offset + 2] = 45;
      }
    }
  if (!comparedPixels)
    throw new BadRequestException('DIFF_MASK_EXCLUDES_EVERY_PIXEL');
  const changedRatio = changedPixels / comparedPixels;
  return {
    status: 'compared',
    passed: changedRatio <= allowed,
    width,
    height,
    candidateWidth: width,
    candidateHeight: height,
    comparedPixels,
    changedPixels,
    changedRatio,
    diffPng: await sharp(diff, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer(),
  };
}
