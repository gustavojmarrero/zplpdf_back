import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { createHash } from 'node:crypto';
import { FirestoreService } from '../cache/firestore.service.js';
import { FeatureFlagsService } from '../product-observability/feature-flags.service.js';
import { PdfPreparationService } from '../pdf-preparation/pdf-preparation.service.js';
import { FirestoreTemplateRepository } from '../label-templates/label-templates.firestore-repository.js';
import { TemplateRunsService } from '../label-templates/template-runs.service.js';
import { ZplService } from '../zpl/zpl.service.js';

function strict(value: any, keys: string[]) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    throw new BadRequestException('DRIVE_RECIPE_INVALID');
}
export function driveRecipeLimits(recipe: any) {
  if (recipe?.kind === 'pdf')
    return { maxBytes: 20 * 1024 * 1024, mimes: ['application/pdf'] };
  if (recipe?.kind === 'template')
    return recipe.format === 'xlsx'
      ? {
          maxBytes: 5 * 1024 * 1024,
          mimes: [
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          ],
        }
      : {
          maxBytes: 5 * 1024 * 1024,
          mimes: ['text/csv', 'text/plain', 'application/csv'],
        };
  return {
    maxBytes: 1024 * 1024,
    mimes: ['text/plain', 'application/octet-stream'],
  };
}
@Injectable()
export class DriveRecipeAdapter {
  constructor(
    private readonly store: FirestoreService,
    private readonly flags: FeatureFlagsService,
    private readonly pdf: PdfPreparationService,
    private readonly tables: TemplateRunsService,
    private readonly zpl: ZplService,
  ) {}
  async resolve(accountId: string, input: any) {
    const value = input ?? { kind: 'zpl' };
    if (value.kind === 'zpl') {
      strict(value, ['kind']);
      return {
        recipe: { kind: 'zpl' },
        snapshot: { kind: 'zpl' },
        fingerprint: 'zpl-v1',
      };
    }
    let recipe: any, snapshot: any;
    if (value.kind === 'pdf') {
      strict(value, ['kind', 'presetId', 'presetVersion']);
      if (
        !isUUID(value.presetId, '4') ||
        !Number.isInteger(value.presetVersion) ||
        value.presetVersion < 1 ||
        value.presetVersion > 200
      )
        throw new BadRequestException('DRIVE_PRESET_INVALID');
      await this.flags.assertFeatureAvailable(accountId, 'pdf_preparation');
      const db = this.store.getClient();
      const [preset, version] = await Promise.all([
        db.doc(`pdf_output_presets/${value.presetId}`).get(),
        db
          .doc(
            `pdf_output_preset_versions/${value.presetId}_${value.presetVersion}`,
          )
          .get(),
      ]);
      if (
        !preset.exists ||
        preset.get('accountId') !== accountId ||
        preset.get('status') !== 'active' ||
        !version.exists ||
        version.get('accountId') !== accountId
      )
        throw new NotFoundException('PDF_PRESET_NOT_FOUND');
      recipe = {
        kind: 'pdf',
        presetId: value.presetId,
        presetVersion: value.presetVersion,
      };
      snapshot = { ...recipe, layout: version.get('recipe') };
    } else if (value.kind === 'template') {
      strict(value, [
        'kind',
        'templateId',
        'templateVersion',
        'format',
        'mapping',
        'delimiter',
        'decimalSeparator',
        'hasHeader',
        'sheet',
      ]);
      if (
        !isUUID(value.templateId, '4') ||
        !Number.isInteger(value.templateVersion) ||
        value.templateVersion < 1 ||
        !['csv', 'xlsx'].includes(value.format) ||
        (value.delimiter !== undefined &&
          ![',', ';', '\t'].includes(value.delimiter)) ||
        (value.decimalSeparator !== undefined &&
          !['.', ','].includes(value.decimalSeparator)) ||
        (value.hasHeader !== undefined &&
          typeof value.hasHeader !== 'boolean') ||
        (value.sheet !== undefined &&
          !(
            typeof value.sheet === 'string' &&
            value.sheet.length > 0 &&
            value.sheet.length <= 120
          ) &&
          !(
            Number.isInteger(value.sheet) &&
            value.sheet >= 0 &&
            value.sheet < 20
          ))
      )
        throw new BadRequestException('DRIVE_TEMPLATE_RECIPE_INVALID');
      strict(value.mapping, ['fields', 'quantityColumn']);
      const fields = value.mapping.fields;
      if (
        !fields ||
        typeof fields !== 'object' ||
        Array.isArray(fields) ||
        Object.keys(fields).length > 32 ||
        Object.entries(fields).some(
          ([k, v]) =>
            !/^[a-z][a-z0-9_]{0,39}$/.test(k) ||
            typeof v !== 'string' ||
            !v.trim() ||
            v.length > 120,
        ) ||
        (value.mapping.quantityColumn !== undefined &&
          (typeof value.mapping.quantityColumn !== 'string' ||
            !value.mapping.quantityColumn.trim() ||
            value.mapping.quantityColumn.length > 120))
      )
        throw new BadRequestException('DRIVE_MAPPING_INVALID');
      await this.flags.assertFeatureAvailable(accountId, 'data_templates');
      const repository = new FirestoreTemplateRepository(
        this.store.getClient(),
      );
      const [template, version] = await Promise.all([
        repository.getTemplate(accountId, value.templateId),
        repository.getVersion(
          accountId,
          value.templateId,
          value.templateVersion,
        ),
      ]);
      if (!template || template.status !== 'active' || !version)
        throw new NotFoundException('Template version unavailable');
      if (
        Object.keys(fields).some(
          (k) => !version.fields.some((f) => f.key === k),
        ) ||
        version.fields.some((f) => f.required && !fields[f.key])
      )
        throw new BadRequestException('DRIVE_MAPPING_INVALID');
      recipe = {
        kind: 'template',
        templateId: value.templateId,
        templateVersion: value.templateVersion,
        format: value.format,
        mapping: {
          fields: Object.fromEntries(
            Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)),
          ),
          ...(value.mapping.quantityColumn === undefined
            ? {}
            : { quantityColumn: value.mapping.quantityColumn }),
        },
        decimalSeparator: value.decimalSeparator ?? '.',
        hasHeader: value.hasHeader ?? true,
        ...(value.delimiter === undefined
          ? {}
          : { delimiter: value.delimiter }),
        ...(value.sheet === undefined ? {} : { sheet: value.sheet }),
      };
      snapshot = { ...recipe, version };
    } else throw new BadRequestException('DRIVE_RECIPE_KIND_INVALID');
    return {
      recipe,
      snapshot,
      fingerprint: createHash('sha256')
        .update(JSON.stringify(snapshot))
        .digest('hex'),
    };
  }
  async convert(
    accountId: string,
    operationId: string,
    source: Buffer,
    snapshot: any,
  ) {
    if (snapshot.kind === 'pdf')
      return this.pdf.export(
        accountId,
        operationId,
        source,
        snapshot.layout,
        'folder',
      );
    if (snapshot.kind === 'template') {
      const { kind: _kind, version, ...options } = snapshot;
      const rendered = await this.tables.materializeFileSnapshot(
        accountId,
        version,
        {
          ...options,
          content: source.toString(
            snapshot.format === 'xlsx' ? 'base64' : 'utf8',
          ),
        },
      );
      return this.zpl.runDurableConversion({
        operationId,
        userId: accountId,
        zplContent: rendered.zplContent,
        labelSize: rendered.labelSize,
      });
    }
    throw new BadRequestException('DRIVE_RECIPE_KIND_INVALID');
  }
}
