import { BadRequestException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { LabelSize } from '../zpl/enums/label-size.enum.js';
import type { ApiJobInput } from './public-api.types.js';
import { hash } from './public-api.crypto.js';
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function operationUuid(...parts: string[]) {
  const chars = hash(...parts)
    .slice(0, 32)
    .split('');
  chars[12] = '4';
  chars[16] = '8';
  const raw = chars.join('');
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}
export function validateJob(input: unknown): ApiJobInput {
  const v = input as ApiJobInput;
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).some(
      (k) =>
        ![
          'zplContent',
          'templateId',
          'templateVersion',
          'rows',
          'labelSize',
          'callbackId',
          'testMode',
        ].includes(k),
    ) ||
    !Object.values(LabelSize).includes(v.labelSize as LabelSize) ||
    Buffer.byteLength(JSON.stringify(v)) > 512 * 1024
  )
    throw new BadRequestException('Invalid job');
  if (v.testMode !== undefined && typeof v.testMode !== 'boolean')
    throw new BadRequestException('Invalid test mode');
  if (v.callbackId !== undefined && !isUUID(v.callbackId, '4'))
    throw new BadRequestException('Invalid callback');
  if (v.zplContent !== undefined) {
    if (
      typeof v.zplContent !== 'string' ||
      !v.zplContent.trim() ||
      v.templateId !== undefined ||
      v.templateVersion !== undefined ||
      v.rows !== undefined
    )
      throw new BadRequestException('Choose one job source');
  } else {
    if (
      !isUUID(v.templateId, '4') ||
      !Number.isSafeInteger(v.templateVersion) ||
      v.templateVersion < 1 ||
      !Array.isArray(v.rows) ||
      v.rows.length < 1 ||
      v.rows.length > 1000 ||
      v.rows.some(
        (row) =>
          !row ||
          typeof row !== 'object' ||
          Array.isArray(row) ||
          Object.keys(row).length > 100 ||
          Object.entries(row).some(
            ([k, value]) =>
              !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(k) ||
              !['string', 'number'].includes(typeof value) ||
              (typeof value === 'number' && !Number.isFinite(value)),
          ),
      )
    )
      throw new BadRequestException('Invalid template rows');
  }
  return v;
}
