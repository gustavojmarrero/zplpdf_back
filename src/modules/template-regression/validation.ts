import { BadRequestException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { LabelSize } from '../zpl/enums/label-size.enum.js';
import { MAX_INPUT_BYTES } from './template-regression.types.js';
import type { DiffSettings } from './template-regression.types.js';

export function objectKeys(
  value: unknown,
  keys: string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    throw new BadRequestException('INVALID_REQUEST');
}
export function uuid(value: unknown) {
  if (typeof value !== 'string' || !isUUID(value, '4'))
    throw new BadRequestException('INVALID_OPERATION_ID');
}
export function version(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new BadRequestException('INVALID_VERSION');
}
export function approvalNote(value: unknown) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > 500 ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)
  )
    throw new BadRequestException('INVALID_APPROVAL_NOTE');
  return value.trim();
}
export function validateLabel(
  zpl: unknown,
  size: unknown,
): asserts zpl is string {
  if (!Object.values(LabelSize).includes(size as LabelSize))
    throw new BadRequestException('INVALID_LABEL_SIZE');
  if (
    typeof zpl !== 'string' ||
    Buffer.byteLength(zpl, 'utf8') > MAX_INPUT_BYTES ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(zpl)
  )
    throw new BadRequestException('INVALID_ZPL');
  // Reject format recall/download and delimiter-changing commands. Only literal
  // ^XA..^XZ with one field/graphic and quantity one can reach the renderer.
  const drawable = zpl.replace(/\^FX[\s\S]*?\^FS/g, '');
  const hasText = [...drawable.matchAll(/\^FD([^\^]*)\^FS/g)].some(
    (match) => match[1].trim().length > 0,
  );
  const hasGraphic =
    /\^G(?:B|C|D|E)(?:[1-9]\d*|0,[1-9]\d*)[^\^]*\^FS|\^GF[A-Z],[1-9]\d*,[^\^]+\^FS/.test(
      drawable,
    );
  if (
    !/^\s*\^XA[\s\S]*\^XZ\s*$/.test(zpl) ||
    (zpl.match(/\^XA/g) ?? []).length !== 1 ||
    (zpl.match(/\^XZ/g) ?? []).length !== 1 ||
    /~|\^(?:CC|CT|CD|DF|XF|FN|SN|SF|J[A-Z]|HV|HW|HY|ID|IS|IL|IM|XG)/i.test(
      zpl,
    ) ||
    /\^[a-z]/.test(zpl) ||
    (!hasText && !hasGraphic)
  )
    throw new BadRequestException('EXACTLY_ONE_LITERAL_LABEL_REQUIRED');
  const quantities = [...zpl.matchAll(/\^PQ([^\^]*)/g)];
  if (
    quantities.length > 1 ||
    quantities.some((m) => !/^1(?:,0(?:,1(?:,N)?)?)?\s*$/.test(m[1]))
  )
    throw new BadRequestException('EXACTLY_ONE_LABEL_REQUIRED');
}
export function settings(input: unknown): DiffSettings {
  const value = input ?? {};
  objectKeys(value, ['masks', 'channelTolerance', 'maxChangedRatio']);
  const result = {
    masks: [],
    channelTolerance: 8,
    maxChangedRatio: 0.005,
    ...value,
  } as DiffSettings;
  if (
    !Number.isInteger(result.channelTolerance) ||
    result.channelTolerance < 0 ||
    result.channelTolerance > 64 ||
    !Number.isFinite(result.maxChangedRatio) ||
    result.maxChangedRatio < 0 ||
    result.maxChangedRatio > 0.1
  )
    throw new BadRequestException('INVALID_DIFF_THRESHOLD');
  if (!Array.isArray(result.masks) || result.masks.length > 20)
    throw new BadRequestException('INVALID_DIFF_MASK');
  for (const mask of result.masks) {
    objectKeys(mask, ['x', 'y', 'width', 'height']);
    if (
      ![mask.x, mask.y, mask.width, mask.height].every(Number.isSafeInteger) ||
      mask.x < 0 ||
      mask.y < 0 ||
      mask.width <= 0 ||
      mask.height <= 0
    )
      throw new BadRequestException('INVALID_DIFF_MASK');
  }
  return {
    ...result,
    masks: result.masks.map(({ x, y, width, height }) => ({
      x,
      y,
      width,
      height,
    })),
  };
}
export function validateMaskBounds(
  options: DiffSettings,
  width: number,
  height: number,
) {
  if (
    options.masks.some((m) => m.x + m.width > width || m.y + m.height > height)
  )
    throw new BadRequestException('INVALID_DIFF_MASK');
  // Conservative summed area also bounds overlapping masks and keeps work O(20).
  if (
    options.masks.reduce((sum, m) => sum + m.width * m.height, 0) >
    width * height * 0.25
  )
    throw new BadRequestException('DIFF_MASK_AREA_EXCEEDED');
}
