import {
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ErrorCodes } from '../../common/constants/error-codes.js';
import {
  isKnownLabelSize,
  normalizeLabelSize,
} from '../zpl/enums/label-size.enum.js';
import { FEATURE_GATE } from '../workflows/ports/feature-gate.port.js';
import type { FeatureGatePort } from '../workflows/ports/feature-gate.port.js';
import { LabelEventPublisher } from '../workflows/label-event.publisher.js';
import { AccountDeletedError } from '../workflows/label-event.outbox.js';
import type { OutboxEventRecord } from '../workflows/label-event.outbox.js';
import type { LabelServerEvent } from '../workflows/ports/label-event-recorder.port.js';
import {
  DATA_TEMPLATES_FEATURE_ID,
  DATA_TEMPLATES_FEATURE_VERSION,
  TEMPLATE_LIMITS,
} from './label-templates.constants.js';
import { TemplateErrorCodes } from './template-error-codes.js';
import { plainColumnMapping } from './column-mapping.js';
import { BUILTIN_TEMPLATES } from './builtin-templates.js';
import { deterministicUuidV4 } from '../workflows/deterministic-uuid.js';
import { mapRows } from './tabular/row-mapper.js';
import type { TabularCell } from './tabular/workbook-reader.port.js';
import {
  assertNoInjection,
  renderTemplate,
  templateChecksum,
  validateFields,
  validateZplTemplate,
} from './template-renderer.js';
import {
  TEMPLATE_REPOSITORY,
  TemplateMissingError,
  TemplateVersionConflictError,
} from './label-templates.types.js';
import type {
  LabelTemplateRecord,
  TemplateField,
  TemplateRepositoryPort,
  TemplateVersionRecord,
} from './label-templates.types.js';
import type {
  CreateTemplateDto,
  CreateVersionDto,
  UpdateTemplateDto,
} from './dto/template-request.dto.js';

export interface TemplateActor {
  uid: string;
  email?: string;
}

@Injectable()
export class LabelTemplatesService {
  private readonly logger = new Logger(LabelTemplatesService.name);

  constructor(
    @Inject(TEMPLATE_REPOSITORY)
    private readonly repository: TemplateRepositoryPort,
    @Inject(FEATURE_GATE) private readonly featureGate: FeatureGatePort,
    private readonly events: LabelEventPublisher,
  ) {}

  async assertFeature(accountId: string): Promise<void> {
    await this.featureGate.assertFeatureAvailable(
      accountId,
      DATA_TEMPLATES_FEATURE_ID,
    );
  }

  /**
   * Construye el hecho canónico que la transacción de negocio va a escribir con
   * ella. No entrega nada: solo fija `eventId` y `occurredAt`.
   */
  prepareEvent(
    event: Omit<LabelServerEvent, 'eventId' | 'schemaVersion' | 'occurredAt'>,
  ): OutboxEventRecord {
    return this.events.prepare(event);
  }

  /** Intenta entregar un hecho ya confirmado. Nunca lanza. */
  async deliverEvent(record: OutboxEventRecord): Promise<void> {
    await this.events.deliverAfterCommit(record);
  }

  listBuiltins() {
    return { items: Object.values(BUILTIN_TEMPLATES) };
  }

  translateRepositoryError(error: unknown): never {
    if (error instanceof AccountDeletedError) {
      throw new GoneException({
        error: TemplateErrorCodes.ACCOUNT_DELETED,
        message: 'La cuenta ya no existe',
      });
    }
    if (error instanceof TemplateVersionConflictError) {
      throw new ConflictException({
        error: TemplateErrorCodes.TEMPLATE_VERSION_CONFLICT,
        message:
          'La plantilla cambió desde la última lectura; vuelve a cargarla antes de reintentar',
        data: {
          expectedVersion: error.expectedVersion,
          currentVersion: error.currentVersion,
        },
      });
    }
    if (error instanceof TemplateMissingError) {
      throw new NotFoundException({
        error: TemplateErrorCodes.TEMPLATE_NOT_FOUND,
        message: 'Plantilla no encontrada',
      });
    }
    throw error as Error;
  }

  async getOwnedTemplate(
    accountId: string,
    templateId: string,
  ): Promise<LabelTemplateRecord> {
    const template = await this.repository.getTemplate(accountId, templateId);
    if (!template) {
      // Mismo error para "no existe" y "no es tuya".
      throw new NotFoundException({
        error: TemplateErrorCodes.TEMPLATE_NOT_FOUND,
        message: 'Plantilla no encontrada',
      });
    }
    return template;
  }

  /**
   * Resuelve la versión con la que se va a ejecutar. Si el cliente no indica
   * ninguna se usa la vigente, pero la ejecución guarda el número: modificar la
   * plantilla después no cambia lo que ya se generó.
   */
  async resolveVersion(
    accountId: string,
    templateId: string,
    versionNumber?: number,
  ): Promise<{
    template: LabelTemplateRecord;
    version: TemplateVersionRecord;
  }> {
    const template = await this.getOwnedTemplate(accountId, templateId);
    const target = versionNumber ?? template.currentVersion;
    const version = await this.repository.getVersion(
      accountId,
      templateId,
      target,
    );

    if (!version) {
      throw new NotFoundException({
        error: TemplateErrorCodes.TEMPLATE_VERSION_NOT_FOUND,
        message: `La plantilla no tiene la versión ${target}`,
        data: { requested: target, currentVersion: template.currentVersion },
      });
    }

    return { template, version };
  }

  private assertValidDefinition(
    labelSize: string,
    fields: TemplateField[],
    zplTemplate: string,
  ): void {
    if (!isKnownLabelSize(labelSize)) {
      throw new BadRequestException({
        error: ErrorCodes.INVALID_LABEL_SIZE,
        message: `Tamaño de etiqueta no reconocido: ${labelSize}`,
      });
    }

    const fieldReasons = validateFields(fields);
    if (fieldReasons.length > 0) {
      throw new UnprocessableEntityException({
        error: TemplateErrorCodes.TEMPLATE_FIELDS_INVALID,
        message: 'Los campos de la plantilla no son válidos',
        data: { reasons: fieldReasons },
      });
    }

    const { reasons } = validateZplTemplate(zplTemplate, fields);
    if (reasons.length > 0) {
      throw new UnprocessableEntityException({
        error: TemplateErrorCodes.TEMPLATE_ZPL_INVALID,
        message: 'El ZPL de la plantilla no es válido',
        data: { reasons },
      });
    }
  }

  async createTemplate(
    actor: TemplateActor,
    dto: CreateTemplateDto,
  ): Promise<{
    template: LabelTemplateRecord;
    version: TemplateVersionRecord;
  }> {
    await this.assertFeature(actor.uid);

    const builtin = dto.fromBuiltin
      ? BUILTIN_TEMPLATES[dto.fromBuiltin]
      : undefined;

    if (
      !builtin &&
      (!dto.kind || !dto.labelSize || !dto.fields || !dto.zplTemplate)
    ) {
      throw new BadRequestException({
        error: ErrorCodes.INVALID_INPUT,
        message:
          'Indica fromBuiltin, o bien kind, labelSize, fields y zplTemplate',
      });
    }

    const kind = builtin?.kind ?? dto.kind;
    const labelSize = builtin?.labelSize ?? dto.labelSize;
    const fields = (builtin?.fields ?? dto.fields) as TemplateField[];
    const zplTemplate = builtin?.zplTemplate ?? dto.zplTemplate;

    this.assertValidDefinition(labelSize, fields, zplTemplate);

    const count = await this.repository.countTemplates(actor.uid);
    if (count >= TEMPLATE_LIMITS.maxTemplatesPerAccount) {
      throw new ConflictException({
        error: TemplateErrorCodes.TEMPLATE_LIMIT_EXCEEDED,
        message: 'La cuenta alcanzó el número de plantillas admitido',
        data: { limit: TEMPLATE_LIMITS.maxTemplatesPerAccount, actual: count },
      });
    }

    const templateId = `tpl_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const now = new Date().toISOString();
    const normalizedSize = normalizeLabelSize(labelSize);

    const version: TemplateVersionRecord = {
      id: `${templateId}:1`,
      templateId,
      accountId: actor.uid,
      ownerId: actor.uid,
      versionNumber: 1,
      labelSize: normalizedSize,
      fields,
      zplTemplate: zplTemplate.trim(),
      checksum: templateChecksum(normalizedSize, fields, zplTemplate.trim()),
      createdAt: now,
    };

    const template: LabelTemplateRecord = {
      id: templateId,
      accountId: actor.uid,
      ownerId: actor.uid,
      kind,
      name: dto.name ?? builtin?.name ?? 'Plantilla',
      status: 'active',
      currentVersion: 1,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    // `template_saved` NO es activación: guardar una plantilla no prueba que se
    // haya generado una sola etiqueta con ella. Va en la misma transacción que
    // la plantilla, así que no puede existir una sin el hecho.
    const outbox = this.prepareEvent({
      eventName: 'template_saved',
      accountId: actor.uid,
      featureId: DATA_TEMPLATES_FEATURE_ID,
      featureVersion: DATA_TEMPLATES_FEATURE_VERSION,
      operationId: LabelTemplatesService.versionOperationId(templateId, 1),
      source: 'api',
    });

    try {
      await this.repository.createTemplate(template, version, outbox);
    } catch (error) {
      this.translateRepositoryError(error);
    }
    await this.deliverEvent(outbox);

    return { template, version };
  }

  async listTemplates(accountId: string) {
    const items = await this.repository.listTemplates(accountId);
    return { items };
  }

  async getTemplate(accountId: string, templateId: string) {
    const template = await this.getOwnedTemplate(accountId, templateId);
    const versions = await this.repository.listVersions(accountId, templateId);
    return { template, versions };
  }

  async addVersion(
    actor: TemplateActor,
    templateId: string,
    dto: CreateVersionDto,
  ) {
    await this.assertFeature(actor.uid);
    const template = await this.getOwnedTemplate(actor.uid, templateId);

    if (template.status === 'archived') {
      throw new ConflictException({
        error: TemplateErrorCodes.TEMPLATE_ARCHIVED,
        message: 'La plantilla está archivada; no admite versiones nuevas',
      });
    }

    const versions = await this.repository.listVersions(actor.uid, templateId);
    if (versions.length >= TEMPLATE_LIMITS.maxVersionsPerTemplate) {
      throw new ConflictException({
        error: TemplateErrorCodes.TEMPLATE_VERSION_LIMIT_EXCEEDED,
        message: 'La plantilla alcanzó el número de versiones admitido',
        data: {
          limit: TEMPLATE_LIMITS.maxVersionsPerTemplate,
          actual: versions.length,
        },
      });
    }

    const current = versions.find(
      (version) => version.versionNumber === template.currentVersion,
    );
    const labelSize = dto.labelSize ?? current?.labelSize ?? '4x6';
    const fields = dto.fields as TemplateField[];

    this.assertValidDefinition(labelSize, fields, dto.zplTemplate);

    const normalizedSize = normalizeLabelSize(labelSize);
    const now = new Date().toISOString();

    // El número de la versión nueva es determinista: la vigente más una. Por eso
    // el hecho se puede construir antes de abrir la transacción, que es lo que
    // permite escribirlo dentro de ella.
    const nextVersionNumber = template.currentVersion + 1;
    const outbox = this.prepareEvent({
      eventName: 'template_saved',
      accountId: actor.uid,
      featureId: DATA_TEMPLATES_FEATURE_ID,
      featureVersion: DATA_TEMPLATES_FEATURE_VERSION,
      operationId: LabelTemplatesService.versionOperationId(
        templateId,
        nextVersionNumber,
      ),
      source: 'api',
    });

    try {
      const result = await this.repository.addVersion(
        actor.uid,
        templateId,
        dto.expectedVersion,
        (currentVersionNumber) => ({
          id: `${templateId}:${currentVersionNumber + 1}`,
          templateId,
          accountId: actor.uid,
          ownerId: actor.uid,
          versionNumber: currentVersionNumber + 1,
          labelSize: normalizedSize,
          fields,
          zplTemplate: dto.zplTemplate.trim(),
          checksum: templateChecksum(
            normalizedSize,
            fields,
            dto.zplTemplate.trim(),
          ),
          createdAt: now,
        }),
        outbox,
      );

      await this.deliverEvent(outbox);
      return result;
    } catch (error) {
      this.translateRepositoryError(error);
    }
  }

  async updateTemplate(
    accountId: string,
    templateId: string,
    dto: UpdateTemplateDto,
  ): Promise<LabelTemplateRecord> {
    await this.getOwnedTemplate(accountId, templateId);

    try {
      // Nombre, mapeo guardado y estado. Los campos y el ZPL no se editan aquí:
      // eso siempre es una versión nueva.
      return await this.repository.updateTemplate(
        accountId,
        templateId,
        dto.expectedVersion,
        () => ({
          name: dto.name,
          savedMapping: dto.savedMapping
            ? plainColumnMapping(dto.savedMapping)
            : dto.savedMapping,
          status: dto.status,
        }),
      );
    } catch (error) {
      this.translateRepositoryError(error);
    }
  }

  /** Guarda el mapeo para que el siguiente archivo lo reutilice. */
  async rememberMapping(
    accountId: string,
    templateId: string,
    mapping: LabelTemplateRecord['savedMapping'],
  ): Promise<void> {
    const template = await this.repository.getTemplate(accountId, templateId);
    if (!template) return;
    try {
      await this.repository.updateTemplate(
        accountId,
        templateId,
        template.version,
        () => ({
          savedMapping: mapping ? plainColumnMapping(mapping) : mapping,
        }),
      );
    } catch (error: any) {
      // Esto sí se puede tragar, y es la única cosa que se traga en todo el
      // módulo: el mapeo guardado es una comodidad que el operador puede volver
      // a elegir en la siguiente subida, no un hecho. Fallar aquí invalidaría
      // una ejecución ya convertida y ya cobrada. Los hechos canónicos no
      // pasan por este camino: van en la transacción de negocio.
      this.logger.warn(
        `No se pudo guardar el mapeo de ${templateId}: ${error?.message}`,
      );
    }
  }

  /**
   * Identidad de la operación «versión guardada», estable y en formato UUIDv4
   * como exige el registro de eventos. Se deriva de la plantilla y del número
   * de versión, así que reintentar no produce un segundo hecho.
   */
  static versionOperationId(templateId: string, versionNumber: number): string {
    return deterministicUuidV4(
      `label-template-version:${templateId}:${versionNumber}`,
    );
  }

  /**
   * Renderiza filas ya estructuradas contra una versión de plantilla.
   *
   * Es el punto de entrada para quien trae los datos en JSON en vez de en un
   * archivo (BE06). Reutiliza la misma validación por campo y el mismo
   * escapado que el flujo de CSV/XLSX —no hay una segunda implementación—, así
   * que un valor con comandos ZPL tampoco puede inyectar nada por esta vía.
   *
   * No convierte ni consume cuota: devuelve el ZPL para que quien llama lo pase
   * al puente de conversión con su propio `operationId`.
   */
  async renderRows(
    accountId: string,
    templateId: string,
    versionNumber: number | undefined,
    rows: { values: Record<string, string>; copies?: number }[],
  ): Promise<{
    zplContent: string;
    labelSize: string;
    labelCount: number;
    templateId: string;
    templateVersion: number;
  }> {
    const { template, version } = await this.resolveVersion(
      accountId,
      templateId,
      versionNumber,
    );

    if (template.status === 'archived') {
      throw new ConflictException({
        error: TemplateErrorCodes.TEMPLATE_ARCHIVED,
        message: 'La plantilla está archivada; no admite ejecuciones nuevas',
      });
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      throw new UnprocessableEntityException({
        error: TemplateErrorCodes.TEMPLATE_RUN_EMPTY,
        message: 'No hay filas que generar',
      });
    }
    if (rows.length > TEMPLATE_LIMITS.maxDataRows) {
      throw new UnprocessableEntityException({
        error: TemplateErrorCodes.DATA_TOO_LARGE,
        message: 'Demasiadas filas',
        data: { maxRows: TEMPLATE_LIMITS.maxDataRows, rows: rows.length },
      });
    }

    // Se reaprovecha `mapRows` construyendo una tabla sintética: las claves de
    // campo hacen de cabecera y la cantidad viaja en una columna reservada. Así
    // los tipos, los conjuntos de caracteres, las fechas ISO y los ceros
    // iniciales se validan exactamente igual que con un archivo.
    const QUANTITY_COLUMN = '__copies';
    const header = [
      ...version.fields.map((field) => field.key),
      QUANTITY_COLUMN,
    ];
    const mapped = mapRows({
      fields: version.fields,
      mapping: {
        fields: Object.fromEntries(
          version.fields.map((field) => [field.key, field.key]),
        ),
        quantityColumn: QUANTITY_COLUMN,
      },
      header,
      rows: rows.map((row, index) => ({
        rowNumber: index + 1,
        cells: [
          ...version.fields.map<TabularCell>((field) => {
            const value = row.values?.[field.key];
            return value === undefined || value === null || value === ''
              ? { text: '', kind: 'empty' }
              : { text: String(value), kind: 'string' };
          }),
          row.copies === undefined
            ? { text: '', kind: 'empty' }
            : { text: String(row.copies), kind: 'string' },
        ],
      })),
      decimalSeparator: '.',
    });

    if (mapped.invalidRowCount > 0 || mapped.rows.length !== rows.length) {
      throw new UnprocessableEntityException({
        error: TemplateErrorCodes.TEMPLATE_ROW_ERRORS,
        message: 'Hay filas que no se pueden interpretar',
        data: {
          invalidRowCount: mapped.invalidRowCount,
          rows: mapped.diagnostics,
        },
      });
    }

    const labelCount = mapped.rows.reduce((sum, row) => sum + row.copies, 0);
    if (labelCount > TEMPLATE_LIMITS.maxLabelsPerRun) {
      throw new UnprocessableEntityException({
        error: TemplateErrorCodes.TEMPLATE_LABEL_LIMIT_EXCEEDED,
        message: 'Demasiadas etiquetas para una sola ejecución',
        data: {
          limit: TEMPLATE_LIMITS.maxLabelsPerRun,
          actual: labelCount,
          scope: 'absolute',
        },
      });
    }

    for (const row of mapped.rows) {
      assertNoInjection(row.values);
    }

    return {
      zplContent: mapped.rows
        .map((row) =>
          renderTemplate(version.zplTemplate, row.values, row.copies),
        )
        .join('\n'),
      labelSize: version.labelSize,
      labelCount,
      templateId: template.id,
      templateVersion: version.versionNumber,
    };
  }

  async archiveTemplate(
    accountId: string,
    templateId: string,
    expectedVersion: number,
  ): Promise<LabelTemplateRecord> {
    await this.getOwnedTemplate(accountId, templateId);
    try {
      // Se archiva, no se borra: las versiones son la explicación de lo que ya
      // se imprimió.
      return await this.repository.updateTemplate(
        accountId,
        templateId,
        expectedVersion,
        () => ({ status: 'archived' as const }),
      );
    } catch (error) {
      this.translateRepositoryError(error);
    }
  }
}
