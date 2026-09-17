import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { FirestoreService } from '../cache/firestore.service.js';
import { FirestoreTemplateRepository } from '../label-templates/label-templates.firestore-repository.js';
import { mapRows } from '../label-templates/tabular/row-mapper.js';
import {
  assertNoInjection,
  renderTemplate,
  validateZplTemplate,
} from '../label-templates/template-renderer.js';
import { TEMPLATE_LIMITS } from '../label-templates/label-templates.constants.js';

/** Composes the template domain's public repository, validator and renderer. */
@Injectable()
export class ApiTemplateAdapter {
  constructor(private readonly store: FirestoreService) {}
  async renderRows(
    accountId: string,
    templateId: string,
    versionNumber: number,
    rows: Record<string, string | number>[],
  ) {
    const repository = new FirestoreTemplateRepository(this.store.getClient());
    const [template, version] = await Promise.all([
      repository.getTemplate(accountId, templateId),
      repository.getVersion(accountId, templateId, versionNumber),
    ]);
    if (!template || template.status !== 'active' || !version)
      throw new NotFoundException('Template version unavailable');
    const header = version.fields.map((field) => field.key);
    if (
      rows.some((row) => Object.keys(row).some((key) => !header.includes(key)))
    )
      throw new BadRequestException('Unknown template field');
    const mapped = mapRows({
      fields: version.fields,
      mapping: { fields: Object.fromEntries(header.map((key) => [key, key])) },
      header,
      rows: rows.map((row, i) => ({
        rowNumber: i + 1,
        cells: header.map((key) =>
          row[key] === undefined
            ? { kind: 'empty' as const, text: '' }
            : typeof row[key] === 'number'
              ? {
                  kind: 'number' as const,
                  text: String(row[key]),
                  numeric: row[key] as number,
                }
              : { kind: 'string' as const, text: row[key] as string },
        ),
      })),
      decimalSeparator: '.',
    });
    if (
      mapped.invalidRowCount ||
      mapped.emptyRowCount ||
      mapped.rows.length !== rows.length ||
      rows.length > TEMPLATE_LIMITS.maxLabelsPerRun ||
      validateZplTemplate(version.zplTemplate, version.fields).reasons.length
    )
      throw new BadRequestException('Invalid template rows');
    const zplContent = mapped.rows
      .map((row) => {
        assertNoInjection(row.values);
        return renderTemplate(version.zplTemplate, row.values, 1);
      })
      .join('\n');
    if (Buffer.byteLength(zplContent) > 512 * 1024)
      throw new BadRequestException('Rendered template too large');
    return {
      zplContent,
      labelSize: version.labelSize,
      labelCount: mapped.rows.length,
    };
  }
}
