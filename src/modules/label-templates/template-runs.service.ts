import { withOperationLease } from '../workflows/operation-lease.js';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  PayloadTooLargeException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { deterministicUuidV4 } from '../workflows/deterministic-uuid.js';
import { asAccountDeletedResponse } from '../workflows/label-event.outbox.js';
import { DEFAULT_PLAN_LIMITS } from '../../common/interfaces/user.interface.js';
import { ErrorCodes } from '../../common/constants/error-codes.js';
import { UsersService } from '../users/users.service.js';
import { ZplService } from '../zpl/zpl.service.js';
import { OutputFormat } from '../zpl/enums/output-format.enum.js';
import {
  DATA_TEMPLATES_FEATURE_ID,
  DATA_TEMPLATES_FEATURE_VERSION,
  TEMPLATE_LIMITS,
} from './label-templates.constants.js';
import { TemplateErrorCodes } from './template-error-codes.js';
import { LabelTemplatesService } from './label-templates.service.js';
import type { TemplateActor } from './label-templates.service.js';
import { TEMPLATE_REPOSITORY } from './label-templates.types.js';
import type {
  ColumnMapping,
  RowDiagnostic,
  TabularFormat,
  TemplateRepositoryPort,
  TemplateRunRecord,
  TemplateVersionRecord,
} from './label-templates.types.js';
import { assertNoInjection, renderTemplate } from './template-renderer.js';
import {
  inferDelimiter,
  isEmptyRecord,
  parseDelimitedText,
} from './tabular/csv.js';
import type { CsvDelimiter } from './tabular/csv.js';
import { MappingError, mapRows, resolveMapping } from './tabular/row-mapper.js';
import type { MappedRow } from './tabular/row-mapper.js';
import {
  WorkbookReadError,
  XLSX_WORKBOOK_READER,
} from './tabular/workbook-reader.port.js';
import type {
  TabularCell,
  WorkbookReaderPort,
} from './tabular/workbook-reader.port.js';
import type {
  CreateRunDto,
  ValidateRunDto,
} from './dto/template-request.dto.js';

/** Los valores de muestra se recortan: sirven para reconocer la columna. */
const SAMPLE_VALUE_LENGTH = 120;

function truncateSample(value: string): string {
  return value.length > SAMPLE_VALUE_LENGTH
    ? `${value.slice(0, SAMPLE_VALUE_LENGTH)}…`
    : value;
}

interface ParsedTable {
  header: string[];
  rows: { rowNumber: number; cells: TabularCell[] }[];
  emptyRowNumbers: number[];
  checksum: string;
  /** Solo en XLSX: hoja leída y hojas disponibles. */
  sheet?: string;
  availableSheets?: string[];
}

@Injectable()
export class TemplateRunsService {
  private readonly logger = new Logger(TemplateRunsService.name);

  constructor(
    @Inject(TEMPLATE_REPOSITORY)
    private readonly repository: TemplateRepositoryPort,
    private readonly templates: LabelTemplatesService,
    private readonly usersService: UsersService,
    private readonly zplService: ZplService,
    @Optional()
    @Inject(XLSX_WORKBOOK_READER)
    private readonly workbookReader?: WorkbookReaderPort,
  ) {}

  /**
   * `templateId` solo es opcional en la inspección, donde el archivo se mira
   * sin plantilla. Validar o ejecutar sin plantilla no significa nada.
   */
  private assertTemplateRequested(templateId?: string): void {
    if (!templateId) {
      throw new BadRequestException({
        error: ErrorCodes.INVALID_INPUT,
        message: 'Falta templateId',
      });
    }
  }

  // ============== lectura de datos ==============

  private decodeContent(dto: ValidateRunDto): Buffer {
    const buffer =
      dto.format === 'xlsx'
        ? Buffer.from(dto.content, 'base64')
        : Buffer.from(dto.content, 'utf8');

    if (buffer.length === 0) {
      throw new BadRequestException({
        error: TemplateErrorCodes.DATA_EMPTY,
        message: 'El archivo de datos está vacío',
      });
    }
    if (buffer.length > TEMPLATE_LIMITS.maxDataBytes) {
      throw new PayloadTooLargeException({
        error: TemplateErrorCodes.DATA_TOO_LARGE,
        message: 'El archivo de datos supera el tamaño admitido',
        data: {
          maxBytes: TEMPLATE_LIMITS.maxDataBytes,
          byteSize: buffer.length,
        },
      });
    }

    return buffer;
  }

  private parseCsv(
    text: string,
    dto: ValidateRunDto,
    checksum: string,
  ): ParsedTable {
    const delimiter: CsvDelimiter | null =
      (dto.delimiter as CsvDelimiter) ?? inferDelimiter(text);

    if (!delimiter) {
      throw new BadRequestException({
        error: TemplateErrorCodes.AMBIGUOUS_DELIMITER,
        message: 'No se puede determinar el separador; indícalo explícitamente',
        data: { candidates: [',', ';', '\\t'] },
      });
    }

    const { records } = parseDelimitedText(text, delimiter);
    if (records.length === 0) {
      throw new BadRequestException({
        error: TemplateErrorCodes.DATA_EMPTY,
        message: 'El archivo no tiene contenido',
      });
    }

    const hasHeader = dto.hasHeader !== false;
    const columnCount = Math.max(
      ...records.map((record) => record.values.length),
    );

    if (columnCount > TEMPLATE_LIMITS.maxDataColumns) {
      throw new PayloadTooLargeException({
        error: TemplateErrorCodes.DATA_TOO_LARGE,
        message: 'El archivo tiene más columnas de las admitidas',
        data: { maxColumns: TEMPLATE_LIMITS.maxDataColumns, columnCount },
      });
    }

    // Sin cabecera se nombran las columnas col1..colN: el mapeo siempre se
    // expresa por nombre de columna, nunca por posición implícita.
    const header = hasHeader
      ? records[0].values.map((value) => value.trim())
      : Array.from({ length: columnCount }, (_, index) => `col${index + 1}`);

    const dataRecords = hasHeader ? records.slice(1) : records;

    if (dataRecords.length > TEMPLATE_LIMITS.maxDataRows) {
      throw new PayloadTooLargeException({
        error: TemplateErrorCodes.DATA_TOO_LARGE,
        message: 'El archivo tiene más filas de las admitidas',
        data: {
          maxRows: TEMPLATE_LIMITS.maxDataRows,
          rows: dataRecords.length,
        },
      });
    }

    const rows = dataRecords.map((record, index) => ({
      rowNumber: index + 1,
      // En CSV cada celda llega como TEXTO: un `007` sigue siendo `007` porque
      // en ningún punto pasa por Number().
      cells: record.values.map<TabularCell>((value) =>
        isEmptyRecord({ ...record, values: [value] })
          ? { text: '', kind: 'empty' }
          : { text: value, kind: 'string' },
      ),
    }));

    return { header, rows, emptyRowNumbers: [], checksum };
  }

  private async parseXlsx(
    buffer: Buffer,
    dto: ValidateRunDto,
    checksum: string,
  ): Promise<ParsedTable> {
    if (!this.workbookReader) {
      // Sin lector registrado NO se improvisa una lectura: se rechaza.
      throw new UnprocessableEntityException({
        error: TemplateErrorCodes.FEATURE_UNSUPPORTED,
        message:
          'Este despliegue no tiene lector de XLSX habilitado; sube los datos como CSV',
        data: { feature: 'xlsx' },
      });
    }

    let sheet;
    try {
      sheet = await this.workbookReader.read(buffer, {
        sheet: dto.sheet,
        maxRows: TEMPLATE_LIMITS.maxDataRows,
        maxColumns: TEMPLATE_LIMITS.maxDataColumns,
        maxCellBytes: TEMPLATE_LIMITS.maxCellBytes,
        maxSheets: TEMPLATE_LIMITS.maxSheets,
      });
    } catch (error) {
      if (error instanceof WorkbookReadError) {
        const body = {
          error: error.code,
          message: error.message,
          data: error.data,
        };
        if (error.code === 'DATA_TOO_LARGE') {
          throw new PayloadTooLargeException(body);
        }
        if (error.code === 'XLSX_MACROS_NOT_ALLOWED') {
          throw new UnprocessableEntityException(body);
        }
        if (error.code === 'XLSX_SHEET_NOT_FOUND') {
          throw new NotFoundException(body);
        }
        throw new BadRequestException(body);
      }
      throw error;
    }

    if (sheet.rows.length === 0) {
      throw new BadRequestException({
        error: TemplateErrorCodes.DATA_EMPTY,
        message: 'La hoja no tiene contenido',
      });
    }

    const hasHeader = dto.hasHeader !== false;
    const headerRow = hasHeader ? sheet.rows[0] : undefined;
    const dataRows = hasHeader ? sheet.rows.slice(1) : sheet.rows;

    const columnCount = Math.max(
      ...sheet.rows.map((row) => row.cells.length),
      0,
    );

    const header = headerRow
      ? headerRow.cells.map((cell) => cell.text.trim())
      : Array.from({ length: columnCount }, (_, index) => `col${index + 1}`);

    // Las filas de datos se numeran 1..N; la cabecera es la fila 1 de la hoja.
    const offset = hasHeader ? 1 : 0;
    const rows = dataRows.map((row) => ({
      rowNumber: row.sheetRow - offset,
      cells: row.cells,
    }));

    const emptyRowNumbers = sheet.skippedEmptySheetRows
      .map((sheetRow) => sheetRow - offset)
      .filter((rowNumber) => rowNumber > 0);

    return {
      header,
      rows,
      emptyRowNumbers,
      checksum,
      sheet: sheet.name,
      availableSheets: sheet.availableSheets,
    };
  }

  private async parseTable(dto: ValidateRunDto): Promise<ParsedTable> {
    const buffer = this.decodeContent(dto);
    const checksum = createHash('sha256').update(buffer).digest('hex');

    return dto.format === 'xlsx'
      ? this.parseXlsx(buffer, dto, checksum)
      : this.parseCsv(buffer.toString('utf8'), dto, checksum);
  }

  // ============== validación ==============

  private buildPreview(
    version: TemplateVersionRecord,
    rows: MappedRow[],
    previewRows: number,
  ): string[] {
    return rows
      .slice(0, previewRows)
      .map((row) =>
        renderTemplate(version.zplTemplate, row.values, row.copies),
      );
  }

  /**
   * Inspección de un archivo antes de mapear nada.
   *
   * El asistente de datos necesita saber qué columnas trae el archivo, de qué
   * tipo llegan las celdas y qué hojas tiene el libro **antes** de pedirle al
   * operador que asigne columnas. Sin esto, el frontend tendría que adivinar la
   * forma del archivo o mandarlo a validar contra un mapeo que aún no existe.
   *
   * No convierte, no consume cuota y no guarda el archivo: solo devuelve su
   * forma y unas pocas filas de muestra. Los valores de muestra son datos
   * operativos del propio usuario (no salen hacia analítica) y se recortan a
   * 120 caracteres.
   */
  async inspectTable(
    actor: TemplateActor,
    dto: ValidateRunDto,
  ): Promise<{
    format: TabularFormat;
    sheet?: string;
    availableSheets?: string[];
    rowCount: number;
    emptyRowCount: number;
    columns: {
      index: number;
      name: string;
      kinds: string[];
      nonEmptyCount: number;
      sampleValues: string[];
    }[];
    sampleRows: { rowNumber: number; values: string[] }[];
    suggestedMapping?: ColumnMapping;
  }> {
    await this.templates.assertFeature(actor.uid);

    const table = await this.parseTable(dto);
    const sampleSize = Math.min(
      dto.previewRows ?? TEMPLATE_LIMITS.defaultPreviewRows,
      TEMPLATE_LIMITS.maxPreviewRows,
    );
    const sample = table.rows.slice(0, sampleSize);

    const columns = table.header.map((name, index) => {
      const cells = table.rows.map((row) => row.cells[index]);
      const nonEmpty = cells.filter(
        (cell) => cell && cell.kind !== 'empty' && cell.text.trim() !== '',
      );
      return {
        index,
        name,
        // Los tipos que realmente traen las celdas: `number` en una columna de
        // identificadores es la señal de que hay ceros iniciales perdidos.
        kinds: [...new Set(cells.map((cell) => cell?.kind ?? 'empty'))],
        nonEmptyCount: nonEmpty.length,
        sampleValues: nonEmpty
          .slice(0, sampleSize)
          .map((cell) => truncateSample(cell.text)),
      };
    });

    // Si se indica plantilla, se propone el mapeo con las mismas reglas del
    // flujo de ejecución (coincidencia exacta de nombre, nunca por parecido).
    let suggestedMapping: ColumnMapping | undefined;
    if (dto.templateId) {
      const { template, version } = await this.templates.resolveVersion(
        actor.uid,
        dto.templateId,
        dto.templateVersion,
      );
      suggestedMapping = resolveMapping(
        version.fields,
        table.header,
        (dto.mapping as ColumnMapping) ?? template.savedMapping,
      );
    }

    return {
      format: dto.format,
      sheet: table.sheet,
      availableSheets: table.availableSheets,
      rowCount: table.rows.length + table.emptyRowNumbers.length,
      emptyRowCount: table.emptyRowNumbers.length,
      columns,
      sampleRows: sample.map((row) => ({
        rowNumber: row.rowNumber,
        values: row.cells.map((cell) => truncateSample(cell?.text ?? '')),
      })),
      suggestedMapping,
    };
  }

  /** Server-only materialization port for a pinned Drive recipe; no conversion or events. */
  async materializeFileSnapshot(
    accountId: string,
    version: TemplateVersionRecord,
    dto: ValidateRunDto,
  ): Promise<{ zplContent: string; labelSize: string; labelCount: number }> {
    await this.templates.assertFeature(accountId);
    try {
      await this.repository.assertAccountActive(accountId);
    } catch (error) {
      throw (
        asAccountDeletedResponse(error, TemplateErrorCodes.ACCOUNT_DELETED) ??
        error
      );
    }
    if (version.ownerId !== accountId || version.accountId !== accountId) {
      throw new NotFoundException({
        error: TemplateErrorCodes.TEMPLATE_NOT_FOUND,
        message: 'Plantilla no encontrada',
      });
    }
    const table = await this.parseTable(dto);
    const mapping = this.resolveMappingOrThrow(dto, undefined, {
      fields: version.fields,
      header: table.header,
    });
    const mapped = this.mapOrThrow({
      fields: version.fields,
      mapping,
      table,
      decimalSeparator: dto.decimalSeparator ?? '.',
    });
    if (mapped.invalidRowCount > 0) {
      throw new UnprocessableEntityException({
        error: TemplateErrorCodes.TEMPLATE_ROW_ERRORS,
        message: 'Hay filas que no se pueden interpretar',
        data: {
          invalidRowCount: mapped.invalidRowCount,
          rows: mapped.diagnostics,
        },
      });
    }
    if (mapped.rows.length === 0) {
      throw new UnprocessableEntityException({
        error: TemplateErrorCodes.TEMPLATE_RUN_EMPTY,
        message: 'No hay ninguna fila válida que generar',
        data: { rows: mapped.diagnostics },
      });
    }
    const labelCount = mapped.rows.reduce((sum, row) => sum + row.copies, 0);
    await this.assertLabelCountAllowed(accountId, labelCount);
    for (const row of mapped.rows) assertNoInjection(row.values);
    return {
      zplContent: mapped.rows
        .map((row) =>
          renderTemplate(version.zplTemplate, row.values, row.copies),
        )
        .join('\n'),
      labelSize: version.labelSize,
      labelCount,
    };
  }

  async validateRun(actor: TemplateActor, dto: ValidateRunDto) {
    await this.templates.assertFeature(actor.uid);
    this.assertTemplateRequested(dto.templateId);
    const { template, version } = await this.templates.resolveVersion(
      actor.uid,
      dto.templateId,
      dto.templateVersion,
    );

    const table = await this.parseTable(dto);
    const mapping = this.resolveMappingOrThrow(dto, template.savedMapping, {
      fields: version.fields,
      header: table.header,
    });

    const mapped = this.mapOrThrow({
      fields: version.fields,
      mapping,
      table,
      decimalSeparator: dto.decimalSeparator ?? '.',
    });

    const labelCount = mapped.rows.reduce((sum, row) => sum + row.copies, 0);
    const previewRows = Math.min(
      dto.previewRows ?? TEMPLATE_LIMITS.defaultPreviewRows,
      TEMPLATE_LIMITS.maxPreviewRows,
    );

    return {
      run: {
        runId: null,
        templateId: template.id,
        templateVersion: version.versionNumber,
        status: 'validated' as const,
        format: dto.format,
        labelSize: version.labelSize,
        outputFormat: 'pdf' as const,
        rowCount: table.rows.length + mapped.emptyRowCount,
        validRowCount: mapped.rows.length,
        emptyRowCount: mapped.emptyRowCount,
        invalidRowCount: mapped.invalidRowCount,
        labelCount,
        diagnostics: mapped.diagnostics,
        sourceChecksum: table.checksum,
        previewZpl: this.buildPreview(version, mapped.rows, previewRows),
        // Valores literales ya validados, para que el asistente muestre lo que
        // se va a imprimir en vez de solo el ZPL. Son datos operativos del
        // usuario: no salen hacia analítica ni se guardan con la ejecución.
        previewFields: mapped.rows.slice(0, previewRows).map((row) => ({
          rowNumber: row.rowNumber,
          copies: row.copies,
          values: row.values,
        })),
      },
      mapping,
      sheet: table.sheet,
      availableSheets: table.availableSheets,
    };
  }

  private resolveMappingOrThrow(
    dto: ValidateRunDto,
    savedMapping: ColumnMapping | undefined,
    input: { fields: TemplateVersionRecord['fields']; header: string[] },
  ): ColumnMapping {
    // Prioridad: el mapeo enviado, el guardado en la plantilla y, si no hay
    // ninguno, coincidencia exacta por nombre de columna.
    const provided = (dto.mapping as ColumnMapping) ?? savedMapping;
    return resolveMapping(input.fields, input.header, provided);
  }

  private mapOrThrow(input: {
    fields: TemplateVersionRecord['fields'];
    mapping: ColumnMapping;
    table: ParsedTable;
    decimalSeparator: '.' | ',';
  }) {
    try {
      return mapRows({
        fields: input.fields,
        mapping: input.mapping,
        header: input.table.header,
        rows: input.table.rows,
        decimalSeparator: input.decimalSeparator,
        emptyRowNumbers: input.table.emptyRowNumbers,
      });
    } catch (error) {
      if (error instanceof MappingError) {
        throw new UnprocessableEntityException({
          error: error.code,
          message: error.message,
          data: error.data,
        });
      }
      throw error;
    }
  }

  // ============== ejecución ==============

  private intentHash(input: {
    templateId: string;
    templateVersion: number;
    labelSize: string;
    outputFormat: string;
    sourceChecksum: string;
    rows: MappedRow[];
  }): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          templateId: input.templateId,
          templateVersion: input.templateVersion,
          labelSize: input.labelSize,
          outputFormat: input.outputFormat,
          sourceChecksum: input.sourceChecksum,
          rows: input.rows.map((row) => [row.values, row.copies]),
        }),
        'utf8',
      )
      .digest('hex');
  }

  /**
   * Identidad de la operación: cuenta + clave, en formato UUIDv4 porque es
   * también el `operationId` del puente de conversión y del registro de
   * eventos. Determinista para que un reintento no genere otra conversión.
   */
  private runIdFor(accountId: string, idempotencyKey: string): string {
    return deterministicUuidV4(
      `label-template-run:${accountId}:${idempotencyKey}`,
    );
  }

  async createRun(
    actor: TemplateActor,
    idempotencyKey: string,
    dto: CreateRunDto,
  ): Promise<{
    run: TemplateRunRecord & { idempotent: boolean };
    created: boolean;
  }> {
    await this.templates.assertFeature(actor.uid);

    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      throw new BadRequestException({
        error: TemplateErrorCodes.IDEMPOTENCY_KEY_REQUIRED,
        message: 'Falta la cabecera Idempotency-Key',
      });
    }
    if (idempotencyKey.length > 200) {
      throw new BadRequestException({
        error: TemplateErrorCodes.IDEMPOTENCY_KEY_REQUIRED,
        message: 'La cabecera Idempotency-Key es demasiado larga',
        data: { maxLength: 200 },
      });
    }

    this.assertTemplateRequested(dto.templateId);
    const runId = this.runIdFor(actor.uid, idempotencyKey);
    const prior = await this.repository.getRun(actor.uid, runId);
    if (prior && prior.status !== 'accepted' && !prior.requestHash) {
      throw new ConflictException({
        error: 'OPERATION_REPLAY_CONTEXT_MISSING',
        message:
          'La reserva antigua no conserva el contexto necesario para reintentar con seguridad',
      });
    }
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          templateId: dto.templateId,
          templateVersion: dto.templateVersion ?? null,
          content: dto.content,
          format: dto.format,
          outputFormat: dto.outputFormat ?? 'pdf',
          delimiter: dto.delimiter ?? null,
          hasHeader: dto.hasHeader !== false,
          sheet: dto.sheet ?? null,
          decimalSeparator: dto.decimalSeparator ?? '.',
          onInvalidRows: dto.onInvalidRows ?? 'reject',
          mapping: dto.mapping
            ? Object.fromEntries(
                Object.entries(dto.mapping).sort(([a], [b]) =>
                  a.localeCompare(b),
                ),
              )
            : null,
        }),
      )
      .digest('hex');
    if (prior?.requestHash && prior.requestHash !== requestHash) {
      throw new ConflictException({
        error: TemplateErrorCodes.IDEMPOTENCY_KEY_REUSED,
        message: 'Esa Idempotency-Key ya se usó para otra ejecución distinta',
        data: { runId },
      });
    }
    const { template, version } = await this.templates.resolveVersion(
      actor.uid,
      dto.templateId,
      prior?.requestHash ? prior.templateVersion : dto.templateVersion,
    );

    if (template.status === 'archived' && !prior?.requestHash) {
      throw new ConflictException({
        error: TemplateErrorCodes.TEMPLATE_ARCHIVED,
        message: 'La plantilla está archivada; no admite ejecuciones nuevas',
      });
    }

    const table = await this.parseTable(dto);
    const mapping =
      prior?.resolvedMapping ??
      this.resolveMappingOrThrow(dto, template.savedMapping, {
        fields: version.fields,
        header: table.header,
      });
    const mapped = this.mapOrThrow({
      fields: version.fields,
      mapping,
      table,
      decimalSeparator: dto.decimalSeparator ?? '.',
    });

    const onInvalidRows = dto.onInvalidRows ?? 'reject';
    if (onInvalidRows === 'reject' && mapped.invalidRowCount > 0) {
      // Nada se genera y no se consume cuota: el diagnóstico va por fila.
      throw new UnprocessableEntityException({
        error: TemplateErrorCodes.TEMPLATE_ROW_ERRORS,
        message: 'Hay filas que no se pueden interpretar',
        data: {
          invalidRowCount: mapped.invalidRowCount,
          rows: mapped.diagnostics,
        },
      });
    }

    if (mapped.rows.length === 0) {
      throw new UnprocessableEntityException({
        error: TemplateErrorCodes.TEMPLATE_RUN_EMPTY,
        message: 'No hay ninguna fila válida que generar',
        data: { rows: mapped.diagnostics },
      });
    }

    const labelCount = mapped.rows.reduce((sum, row) => sum + row.copies, 0);
    await this.assertLabelCountAllowed(actor.uid, labelCount);

    const outputFormat = dto.outputFormat ?? 'pdf';
    const intentHash = this.intentHash({
      templateId: template.id,
      templateVersion: version.versionNumber,
      labelSize: version.labelSize,
      outputFormat,
      sourceChecksum: table.checksum,
      rows: mapped.rows,
    });
    const now = new Date();

    const diagnostics: RowDiagnostic[] = mapped.diagnostics;
    const candidate: TemplateRunRecord = {
      runId,
      accountId: actor.uid,
      ownerId: actor.uid,
      templateId: template.id,
      templateVersion: version.versionNumber,
      status: 'pending',
      format: dto.format,
      labelSize: version.labelSize,
      outputFormat,
      idempotencyKey,
      intentHash,
      rowCount: table.rows.length + mapped.emptyRowCount,
      validRowCount: mapped.rows.length,
      emptyRowCount: mapped.emptyRowCount,
      invalidRowCount: mapped.invalidRowCount,
      labelCount,
      diagnostics,
      sourceChecksum: table.checksum,
      requestHash,
      resolvedMapping: mapping,
      originalFilename: prior?.originalFilename ?? `${template.name}.zpl`,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    let reservation;
    try {
      reservation = await this.repository.reserveRun(candidate, now);
    } catch (error) {
      // La reserva queda fuera del `try` que libera la ejecución: su lápida se
      // traduce aquí para no salir como 500.
      const gone = asAccountDeletedResponse(
        error,
        TemplateErrorCodes.ACCOUNT_DELETED,
      );
      throw gone ?? error;
    }

    if (reservation.outcome === 'existing') {
      return {
        run: { ...this.publicRecord(reservation.record), idempotent: true },
        created: false,
      };
    }
    if (reservation.outcome === 'in_progress') {
      throw new ConflictException({
        error: TemplateErrorCodes.RUN_IN_PROGRESS,
        message: 'La misma ejecución está en curso',
        data: { runId },
      });
    }
    if (reservation.outcome === 'key_reused') {
      throw new ConflictException({
        error: TemplateErrorCodes.IDEMPOTENCY_KEY_REUSED,
        message: 'Esa Idempotency-Key ya se usó para otra ejecución distinta',
        data: { runId },
      });
    }

    try {
      const startedAt = Date.now();

      // Cada valor se escapa con ^FH antes de entrar en el campo; la
      // comprobación posterior es la red que impide que una regresión del
      // escapado llegue a la impresora.
      for (const row of mapped.rows) {
        assertNoInjection(row.values);
      }

      const zplContent = mapped.rows
        .map((row) =>
          renderTemplate(version.zplTemplate, row.values, row.copies),
        )
        .join('\n');

      // Puente duradero del conversor: espera a que termine, reserva la cuota
      // de forma atómica y es idempotente por `operationId`, que aquí es el
      // propio `runId`. No hay segundo renderizador ni segundo contador.
      const conversion = await withOperationLease(
        () => this.repository.renewRun(runId, reservation.record.leaseToken!),
        () =>
          this.zplService.runDurableConversion({
            operationId: runId,
            userId: actor.uid,
            zplContent,
            labelSize: version.labelSize,
            outputFormat: outputFormat as OutputFormat,
            originalFilename:
              reservation.record.originalFilename ?? `${template.name}.zpl`,
          }),
      );

      // El hecho es cierto en cuanto la conversión terminó, y se escribe en la
      // misma transacción que pasa la ejecución a `accepted`.
      const outbox = this.templates.prepareEvent({
        eventName: 'template_run_succeeded',
        accountId: actor.uid,
        featureId: DATA_TEMPLATES_FEATURE_ID,
        featureVersion: DATA_TEMPLATES_FEATURE_VERSION,
        operationId: runId,
        source: 'api',
        jobId: conversion.jobId,
        labelCount,
        durationMs: Date.now() - startedAt,
      });

      const record = await this.repository.completeRun(
        runId,
        reservation.record.leaseToken!,
        { jobId: conversion.jobId },
        outbox,
      );

      const created = record.completionEvent?.id === outbox.id;
      if (created && dto.saveMapping !== false) {
        await this.templates
          .rememberMapping(actor.uid, template.id, mapping)
          .catch((error) =>
            this.logger.warn(`No se pudo guardar el mapeo: ${error?.message}`),
          );
      }

      await this.templates
        .deliverEvent(record.completionEvent)
        .catch((error) =>
          this.logger.warn(
            `El evento queda pendiente de entrega: ${error?.message}`,
          ),
        );

      return {
        run: { ...this.publicRecord(record), idempotent: !created },
        created,
      };
    } catch (error: any) {
      const gone = asAccountDeletedResponse(
        error,
        TemplateErrorCodes.ACCOUNT_DELETED,
      );
      if (gone) {
        await this.repository
          .failRun(
            runId,
            reservation.record.leaseToken!,
            TemplateErrorCodes.ACCOUNT_DELETED,
          )
          .catch(() => undefined);
        throw gone;
      }
      const errorCode =
        error?.response?.error ??
        error?.getResponse?.()?.error ??
        'SERVER_ERROR';
      const settled = await this.repository
        .failRun(runId, reservation.record.leaseToken!, String(errorCode))
        .catch((failure) =>
          this.logger.error(
            `No se pudo marcar la ejecución ${runId} como fallida: ${failure?.message}`,
          ),
        );
      if (settled && settled.status === 'accepted')
        return {
          run: { ...this.publicRecord(settled), idempotent: true },
          created: false,
        };
      throw error;
    }
  }

  private publicRecord(record: TemplateRunRecord): TemplateRunRecord {
    const result = { ...record };
    delete result.leaseToken;
    delete result.expiresAt;
    delete result.attempts;
    delete result.completionEvent;
    delete result.requestHash;
    delete result.resolvedMapping;
    delete result.originalFilename;
    return result;
  }

  private async assertLabelCountAllowed(
    userId: string,
    labelCount: number,
  ): Promise<void> {
    if (labelCount > TEMPLATE_LIMITS.maxLabelsPerRun) {
      throw new ForbiddenException({
        error: TemplateErrorCodes.TEMPLATE_LABEL_LIMIT_EXCEEDED,
        message: 'La ejecución supera el número de etiquetas admitido',
        data: {
          limit: TEMPLATE_LIMITS.maxLabelsPerRun,
          actual: labelCount,
          scope: 'absolute',
        },
      });
    }

    const user = await this.usersService.getUserById(userId);
    if (!user) {
      throw new NotFoundException({
        error: ErrorCodes.USER_NOT_FOUND,
        message: 'Usuario no encontrado',
      });
    }

    const plan = this.usersService.getEffectivePlan(user);
    const limit = DEFAULT_PLAN_LIMITS[plan].maxLabelsPerPdf;

    // El conversor lo vuelve a comprobar al aceptar el trabajo: el rechazo es
    // doble, nunca al revés.
    if (labelCount > limit) {
      throw new ForbiddenException({
        error: TemplateErrorCodes.TEMPLATE_LABEL_LIMIT_EXCEEDED,
        message:
          'La ejecución supera el número de etiquetas que admite el plan',
        data: { limit, actual: labelCount, scope: 'plan' },
      });
    }
  }

  async getRun(accountId: string, runId: string): Promise<TemplateRunRecord> {
    const record = await this.repository.getRun(accountId, runId);
    if (!record) {
      throw new NotFoundException({
        error: TemplateErrorCodes.TEMPLATE_RUN_NOT_FOUND,
        message: 'Ejecución no encontrada',
      });
    }
    return this.publicRecord(record);
  }

  async listRuns(accountId: string, templateId?: string) {
    if (templateId) {
      await this.templates.getOwnedTemplate(accountId, templateId);
    }
    const items = await this.repository.listRuns(accountId, templateId);
    return {
      items: items
        .filter((item) => item.status !== 'pending')
        .map((item) => this.publicRecord(item)),
    };
  }
}
