import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface.js';
import { LabelSize } from '../zpl/enums/label-size.enum.js';
export const createKeySchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['scopes'],
  properties: {
    scopes: {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      uniqueItems: true,
      items: { type: 'string', enum: ['jobs:read', 'jobs:write'] },
    },
  },
};
export const createCallbackSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['url'],
  properties: {
    url: {
      type: 'string',
      format: 'uri',
      maxLength: 2048,
      description:
        'HTTPS on port 443; public destinations only; no credentials, query or fragment',
    },
  },
};
export const createJobSchema: SchemaObject = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['zplContent', 'labelSize'],
      properties: {
        zplContent: { type: 'string', minLength: 1 },
        labelSize: { type: 'string', enum: Object.values(LabelSize) },
        callbackId: { type: 'string', format: 'uuid' },
        testMode: {
          type: 'boolean',
          default: false,
          description:
            'Real conversion using normal quota; excluded from commercial adoption metrics',
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['templateId', 'templateVersion', 'rows', 'labelSize'],
      properties: {
        templateId: { type: 'string', format: 'uuid' },
        templateVersion: { type: 'integer', minimum: 1 },
        rows: {
          type: 'array',
          minItems: 1,
          maxItems: 1000,
          items: {
            type: 'object',
            additionalProperties: {
              oneOf: [{ type: 'string' }, { type: 'number' }],
            },
          },
        },
        labelSize: { type: 'string', enum: Object.values(LabelSize) },
        callbackId: { type: 'string', format: 'uuid' },
        testMode: {
          type: 'boolean',
          default: false,
          description:
            'Real conversion using normal quota; excluded from commercial adoption metrics',
        },
      },
    },
  ],
};
