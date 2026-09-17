import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
  UnprocessableEntityException,
} from '@nestjs/common';
import ExcelJS from 'exceljs';
import { validate as isUuid, version as uuidVersion } from 'uuid';
import archiver from 'archiver';
import { LabelTemplatesService } from './label-templates.service.js';
import { TemplateRunsService } from './template-runs.service.js';
import { InMemoryTemplateRepository } from './label-templates.in-memory-repository.js';
import { ExcelJsWorkbookReader } from './tabular/exceljs-workbook-reader.js';
import type { FeatureGatePort } from '../workflows/ports/feature-gate.port.js';
import { LabelEventPublisher } from '../workflows/label-event.publisher.js';
import { InMemoryLabelEventOutbox } from '../workflows/label-event.store.js';
import type {
  LabelEventRecorderPort,
  LabelServerEvent,
} from '../workflows/ports/label-event-recorder.port.js';
import type { UsersService } from '../users/users.service.js';
import type { ZplService } from '../zpl/zpl.service.js';
import type { CreateRunDto } from './dto/template-request.dto.js';

const ALICE = { uid: 'alice', email: 'alice@example.com' };
const BOB = { uid: 'bob', email: 'bob@example.com' };

class AllowAllFeatureGate implements FeatureGatePort {
  assertFeatureAvailable(): void {}
}

const TEMPLATE_DEF = {
  kind: 'product' as const,
  name: 'Producto',
  labelSize: '2x1',
  fields: [
    {
      key: 'sku',
      label: 'SKU',
      type: 'code' as const,
      required: true,
      maxLength: 32,
      charset: 'alnum_dash' as const,
    },
    {
      key: 'name',
      label: 'Nombre',
      type: 'text' as const,
      required: true,
      maxLength: 60,
    },
    {
      key: 'price',
      label: 'Precio',
      type: 'decimal' as const,
      required: false,
    },
  ],
  zplTemplate:
    '^XA^CI28^FO10,10^FD{{name}}^FS^FO10,40^FD{{sku}}^FS^FO10,70^FD{{price}}^FS^XZ',
};

const CSV = [
  'sku,name,price,quantity',
  '00751,Café Ñoño,12.50,3',
  'A-2,Caja normal,1.00,1',
  '',
].join('\n');

function buildHarness(
  options: { plan?: string; withXlsxReader?: boolean } = {},
) {
  const outbox = new InMemoryLabelEventOutbox();
  const repository = new InMemoryTemplateRepository(outbox);
  const events: LabelServerEvent[] = [];
  const recorder: LabelEventRecorderPort = {
    async recordServerEvent(event) {
      events.push(event);
      return { duplicate: false };
    },
  };

  const publisher = new LabelEventPublisher(recorder, outbox);
  const templates = new LabelTemplatesService(
    repository,
    new AllowAllFeatureGate(),
    publisher,
  );

  const usersService = {
    getUserById: async (uid: string) => ({ uid, plan: options.plan ?? 'pro' }),
    getEffectivePlan: () => options.plan ?? 'pro',
  } as unknown as UsersService;

  // Doble del puente duradero: devuelve `completed` y jobId === operationId.
  const runDurableConversion = jest.fn(
    async (input: {
      operationId: string;
      userId: string;
      zplContent: string;
      labelSize: string;
      outputFormat?: string;
      originalFilename?: string;
    }) => ({ jobId: input.operationId, status: 'completed' }),
  );
  const zplService = { runDurableConversion } as unknown as ZplService;

  const runs = new TemplateRunsService(
    repository,
    templates,
    usersService,
    zplService,
    options.withXlsxReader === false ? undefined : new ExcelJsWorkbookReader(),
  );

  return {
    repository,
    templates,
    runs,
    events,
    runDurableConversion,
    outbox,
    publisher,
    recorder,
  };
}

async function createTemplate(templates: LabelTemplatesService) {
  const created = await templates.createTemplate(ALICE, TEMPLATE_DEF);
  return created.template.id;
}

function csvRun(templateId: string, overrides: Partial<CreateRunDto> = {}) {
  return {
    templateId,
    format: 'csv' as const,
    content: CSV,
    mapping: {
      fields: { sku: 'sku', name: 'name', price: 'price' },
      quantityColumn: 'quantity',
    },
    ...overrides,
  } as CreateRunDto;
}

// ============== utilidades XLSX ==============

async function buildWorkbook(
  build: (worksheet: ExcelJS.Worksheet, workbook: ExcelJS.Workbook) => void,
): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Datos');
  build(worksheet, workbook);
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer).toString('base64');
}

function header(worksheet: ExcelJS.Worksheet) {
  worksheet.addRow(['sku', 'name', 'price', 'quantity']);
}

/** ZIP real (con directorio central) para probar los guardas del archivo. */
async function zipWith(
  files: { name: string; body: string }[],
): Promise<Buffer> {
  const archive = archiver('zip', { zlib: { level: 0 } });
  const chunks: Buffer[] = [];
  archive.on('data', (chunk: Buffer) => chunks.push(chunk));

  const done = new Promise<void>((resolve, reject) => {
    archive.on('end', () => resolve());
    archive.on('error', reject);
  });

  for (const file of files) {
    archive.append(file.body, { name: file.name });
  }
  await archive.finalize();
  await done;

  return Buffer.concat(chunks);
}

describe('TemplateRunsService — CSV', () => {
  it('valida sin convertir y devuelve previsualización y mapeo', async () => {
    const { templates, runs, runDurableConversion } = buildHarness();
    const templateId = await createTemplate(templates);

    const { run, mapping } = await runs.validateRun(ALICE, csvRun(templateId));

    expect(run.status).toBe('validated');
    expect(run.validRowCount).toBe(2);
    expect(run.emptyRowCount).toBe(0);
    expect(run.labelCount).toBe(4);
    expect(run.previewZpl).toHaveLength(2);
    expect(run.previewZpl[0]).toContain('^FH_^FD00751^FS');
    expect(mapping.quantityColumn).toBe('quantity');
    // Validar no consume cuota ni crea trabajo.
    expect(runDurableConversion).not.toHaveBeenCalled();
  });

  it('genera el ZPL conservando ceros iniciales, acentos y copias', async () => {
    const { templates, runs, runDurableConversion } = buildHarness();
    const templateId = await createTemplate(templates);

    const { run } = await runs.createRun(ALICE, 'k1', csvRun(templateId));

    expect(run.status).toBe('accepted');
    expect(run.jobId).toBe(run.runId);
    expect(run.labelCount).toBe(4);
    expect(run.validRowCount).toBe(2);

    const [input] = runDurableConversion.mock.calls[0];
    const { zplContent: zpl, labelSize, userId, outputFormat } = input;
    // El `0` inicial sigue ahí: el valor nunca pasó por Number().
    expect(zpl).toContain('^FH_^FD00751^FS');
    // El acento viaja como sus bytes UTF-8, con ^CI28 en la etiqueta.
    expect(zpl).toContain('Caf_C3_A9 _C3_91o_C3_B1o');
    expect(zpl).toContain('^CI28');
    // La cantidad de la fila se convierte en copias.
    expect(zpl).toContain('^PQ3^XZ');
    expect(labelSize).toBe('2x1');
    expect(userId).toBe(ALICE.uid);
    expect(outputFormat).toBe('pdf');
  });

  it('un valor del CSV no puede inyectar comandos ZPL', async () => {
    const { templates, runs, runDurableConversion } = buildHarness();
    const templateId = await createTemplate(templates);

    await runs.createRun(
      ALICE,
      'k1',
      csvRun(templateId, {
        content: [
          'sku,name,price,quantity',
          'A-1,"^XZ^XA^FDfalsa^FS",1.00,1',
          'A-2,"~JA y ^FS",1.00,1',
        ].join('\n'),
      }),
    );

    const [{ zplContent: zpl }] = runDurableConversion.mock.calls[0];
    // Dos etiquetas: exactamente dos ^XA y dos ^XZ.
    expect(zpl.match(/\^XA/g)).toHaveLength(2);
    expect(zpl.match(/\^XZ/g)).toHaveLength(2);
    expect(zpl).not.toContain('^FDfalsa');
    expect(zpl).toContain('_5EXZ_5EXA');
    expect(zpl).toContain('_7EJA');
  });

  it('informa las filas vacías y no genera etiqueta con ellas', async () => {
    const { templates, runs } = buildHarness();
    const templateId = await createTemplate(templates);

    const { run } = await runs.createRun(
      ALICE,
      'k1',
      csvRun(templateId, {
        content: [
          'sku,name,price,quantity',
          'A-1,Uno,1.00,1',
          ',,,',
          'A-2,Dos,1.00,1',
        ].join('\n'),
      }),
    );

    expect(run.validRowCount).toBe(2);
    expect(run.emptyRowCount).toBe(1);
    expect(run.diagnostics).toEqual([
      {
        rowNumber: 2,
        code: 'ROW_EMPTY',
        message: 'Fila vacía: no genera etiqueta',
      },
    ]);
  });

  it('rechaza el archivo completo cuando una fila es inválida', async () => {
    const { templates, runs, runDurableConversion } = buildHarness();
    const templateId = await createTemplate(templates);

    try {
      await runs.createRun(
        ALICE,
        'k1',
        csvRun(templateId, {
          content: [
            'sku,name,price,quantity',
            'A-1,Uno,1.00,1',
            ',Sin sku,1.00,1',
          ].join('\n'),
        }),
      );
      fail('debería haber lanzado');
    } catch (error: any) {
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(error.response.error).toBe('TEMPLATE_ROW_ERRORS');
      expect(error.response.data.rows).toEqual([
        {
          rowNumber: 2,
          column: 'sku',
          field: 'sku',
          code: 'ROW_REQUIRED_MISSING',
          message: 'El campo SKU es obligatorio',
        },
      ]);
    }
    // Nada se generó y no se consumió cuota.
    expect(runDurableConversion).not.toHaveBeenCalled();
  });

  it('con onInvalidRows=skip deja fuera la fila mala y la informa', async () => {
    const { templates, runs } = buildHarness();
    const templateId = await createTemplate(templates);

    const { run } = await runs.createRun(
      ALICE,
      'k1',
      csvRun(templateId, {
        onInvalidRows: 'skip',
        content: [
          'sku,name,price,quantity',
          'A-1,Uno,1.00,1',
          'A/2,Barra no admitida,1.00,1',
        ].join('\n'),
      }),
    );

    expect(run.validRowCount).toBe(1);
    expect(run.invalidRowCount).toBe(1);
    expect(run.diagnostics[0].code).toBe('ROW_CHARSET');
  });

  it('rechaza cantidades que no son un entero positivo', async () => {
    const { templates, runs } = buildHarness();
    const templateId = await createTemplate(templates);

    await expect(
      runs.createRun(
        ALICE,
        'k1',
        csvRun(templateId, {
          content: ['sku,name,price,quantity', 'A-1,Uno,1.00,0'].join('\n'),
        }),
      ),
    ).rejects.toMatchObject({
      response: {
        data: {
          rows: [expect.objectContaining({ code: 'ROW_INVALID_QUANTITY' })],
        },
      },
    });
  });

  it('rechaza un decimal ambiguo y acepta el separador declarado', async () => {
    const { templates, runs } = buildHarness();
    const templateId = await createTemplate(templates);

    // Con separador decimal "." un `1,234` puede ser millar o decimal.
    await expect(
      runs.createRun(
        ALICE,
        'k1',
        csvRun(templateId, {
          content: ['sku;name;price;quantity', 'A-1;Uno;1,234;1'].join('\n'),
          delimiter: ';',
        }),
      ),
    ).rejects.toMatchObject({
      response: {
        data: {
          rows: [expect.objectContaining({ code: 'ROW_AMBIGUOUS_NUMBER' })],
        },
      },
    });

    // Declarando la coma como separador decimal, el mismo valor es válido.
    const { run } = await runs.createRun(
      ALICE,
      'k2',
      csvRun(templateId, {
        content: ['sku;name;price;quantity', 'A-1;Uno;1,5;1'].join('\n'),
        delimiter: ';',
        decimalSeparator: ',',
      }),
    );
    expect(run.validRowCount).toBe(1);
  });

  it('rechaza un separador ambiguo en vez de adivinarlo', async () => {
    const { templates, runs } = buildHarness();
    const templateId = await createTemplate(templates);

    await expect(
      runs.createRun(
        ALICE,
        'k1',
        csvRun(templateId, { content: 'sku,name;price\nA-1,Uno;1\n' }),
      ),
    ).rejects.toMatchObject({
      response: { error: 'AMBIGUOUS_DELIMITER' },
    });
  });

  it('avisa de las columnas que faltan para los campos obligatorios', async () => {
    const { templates, runs } = buildHarness();
    const templateId = await createTemplate(templates);

    await expect(
      runs.createRun(
        ALICE,
        'k1',
        csvRun(templateId, {
          content: 'sku,price\nA-1,1.00\n',
          mapping: { fields: { sku: 'sku', name: 'name', price: 'price' } },
        }),
      ),
    ).rejects.toMatchObject({
      response: { error: 'COLUMN_MISSING', data: { fields: ['name'] } },
    });
  });

  it('guarda el mapeo y lo reutiliza con otro archivo', async () => {
    const { templates, runs, repository } = buildHarness();
    const templateId = await createTemplate(templates);

    await runs.createRun(
      ALICE,
      'k1',
      csvRun(templateId, {
        mapping: {
          fields: { sku: 'codigo', name: 'titulo', price: 'importe' },
          quantityColumn: 'piezas',
        },
        content: ['codigo,titulo,importe,piezas', '0010,Uno,1.00,2'].join('\n'),
      }),
    );

    const saved = await repository.getTemplate(ALICE.uid, templateId);
    expect(saved?.savedMapping?.fields.sku).toBe('codigo');

    // Segundo archivo con las mismas columnas y sin enviar mapeo.
    const { run } = await runs.createRun(ALICE, 'k2', {
      templateId,
      format: 'csv',
      content: ['codigo,titulo,importe,piezas', '0020,Dos,2.00,1'].join('\n'),
    } as CreateRunDto);

    expect(run.validRowCount).toBe(1);
    expect(run.labelCount).toBe(1);
  });
});

describe('TemplateRunsService — idempotencia, cuota y propiedad', () => {
  it('repetir la misma clave con la misma intención no vuelve a convertir', async () => {
    const { templates, runs, runDurableConversion, events } = buildHarness();
    const templateId = await createTemplate(templates);

    const first = await runs.createRun(ALICE, 'k1', csvRun(templateId));
    const retry = await runs.createRun(ALICE, 'k1', csvRun(templateId));

    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.run.idempotent).toBe(true);
    expect(retry.run.jobId).toBe(first.run.jobId);
    expect(runDurableConversion).toHaveBeenCalledTimes(1);
    expect(
      events.filter((event) => event.eventName === 'template_run_succeeded'),
    ).toHaveLength(1);
  });

  it('la misma clave con otros datos da conflicto', async () => {
    const { templates, runs } = buildHarness();
    const templateId = await createTemplate(templates);

    await runs.createRun(ALICE, 'k1', csvRun(templateId));

    await expect(
      runs.createRun(
        ALICE,
        'k1',
        csvRun(templateId, {
          content: ['sku,name,price,quantity', 'B-9,Otro,1.00,1'].join('\n'),
        }),
      ),
    ).rejects.toMatchObject({ response: { error: 'IDEMPOTENCY_KEY_REUSED' } });
  });

  it('exige Idempotency-Key', async () => {
    const { templates, runs } = buildHarness();
    const templateId = await createTemplate(templates);

    await expect(
      runs.createRun(ALICE, '   ', csvRun(templateId)),
    ).rejects.toMatchObject({
      response: { error: 'IDEMPOTENCY_KEY_REQUIRED' },
    });
  });

  it('un fallo de cuota libera la reserva y deja reintentar', async () => {
    const { templates, runs, runDurableConversion } = buildHarness();
    const templateId = await createTemplate(templates);

    runDurableConversion.mockRejectedValueOnce(
      new ForbiddenException({
        error: 'MONTHLY_LIMIT_EXCEEDED',
        message: 'sin cuota',
      }),
    );

    await expect(
      runs.createRun(ALICE, 'k1', csvRun(templateId)),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const retry = await runs.createRun(ALICE, 'k1', csvRun(templateId));
    expect(retry.created).toBe(true);
    expect(runDurableConversion).toHaveBeenCalledTimes(2);
  });

  it('aplica el tope del plan contando copias', async () => {
    const { templates, runs, runDurableConversion } = buildHarness({
      plan: 'free',
    });
    const templateId = await createTemplate(templates);

    await expect(
      runs.createRun(
        ALICE,
        'k1',
        csvRun(templateId, {
          content: ['sku,name,price,quantity', 'A-1,Uno,1.00,80'].join('\n'),
        }),
      ),
    ).rejects.toMatchObject({
      response: {
        error: 'TEMPLATE_LABEL_LIMIT_EXCEEDED',
        data: { limit: 75, actual: 80, scope: 'plan' },
      },
    });
    expect(runDurableConversion).not.toHaveBeenCalled();
  });

  it('otra cuenta no puede ejecutar ni leer la plantilla ajena', async () => {
    const { templates, runs } = buildHarness();
    const templateId = await createTemplate(templates);

    await expect(
      runs.createRun(BOB, 'k-bob', csvRun(templateId)),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      runs.validateRun(BOB, csvRun(templateId)),
    ).rejects.toBeInstanceOf(NotFoundException);

    const mine = await runs.createRun(ALICE, 'k1', csvRun(templateId));
    await expect(runs.getRun(BOB.uid, mine.run.runId)).rejects.toMatchObject({
      response: { error: 'TEMPLATE_RUN_NOT_FOUND' },
    });
    expect((await runs.listRuns(BOB.uid)).items).toEqual([]);
  });

  it('una ejecución queda anclada a su versión: cambiar la plantilla no la altera', async () => {
    const { templates, runs, runDurableConversion } = buildHarness();
    const templateId = await createTemplate(templates);

    const first = await runs.createRun(ALICE, 'k1', csvRun(templateId));
    expect(first.run.templateVersion).toBe(1);

    await templates.addVersion(ALICE, templateId, {
      expectedVersion: 2,
      fields: TEMPLATE_DEF.fields,
      zplTemplate:
        '^XA^CI28^FO0,0^FD{{sku}}^FS^FD{{name}}^FS^FD{{price}}^FS^XZ',
    });

    // La ejecución guardada sigue diciendo versión 1.
    const stored = await runs.getRun(ALICE.uid, first.run.runId);
    expect(stored.templateVersion).toBe(1);

    // Y pedir explícitamente la versión 1 usa su ZPL original.
    await runs.createRun(
      ALICE,
      'k2',
      csvRun(templateId, { templateVersion: 1 }),
    );
    const [{ zplContent: zplV1 }] = runDurableConversion.mock.calls[1];
    expect(zplV1).toContain('^FO10,10');

    await runs.createRun(ALICE, 'k3', csvRun(templateId));
    const [{ zplContent: zplV2 }] = runDurableConversion.mock.calls[2];
    expect(zplV2).toContain('^FO0,0');
  });

  it('no ejecuta una plantilla archivada', async () => {
    const { templates, runs } = buildHarness();
    const templateId = await createTemplate(templates);
    const { template } = await templates.getTemplate(ALICE.uid, templateId);
    await templates.archiveTemplate(ALICE.uid, templateId, template.version);

    await expect(
      runs.createRun(ALICE, 'k1', csvRun(templateId)),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('TemplateRunsService — XLSX', () => {
  it('lee una hoja conservando el texto con ceros iniciales', async () => {
    const { templates, runs, runDurableConversion } = buildHarness();
    const templateId = await createTemplate(templates);

    const content = await buildWorkbook((worksheet) => {
      header(worksheet);
      const row = worksheet.addRow(['00751', 'Café Ñoño', 12.5, 3]);
      // Columna formateada como texto: el cero inicial sobrevive.
      row.getCell(1).numFmt = '@';
    });

    const { run } = await runs.createRun(ALICE, 'k1', {
      templateId,
      format: 'xlsx',
      content,
    } as CreateRunDto);

    expect(run.validRowCount).toBe(1);
    expect(run.labelCount).toBe(3);
    const [{ zplContent: zpl }] = runDurableConversion.mock.calls[0];
    expect(zpl).toContain('^FH_^FD00751^FS');
    expect(zpl).toContain('^PQ3^XZ');
  });

  it('rechaza una celda con fórmula sin evaluarla', async () => {
    const { templates, runs, runDurableConversion } = buildHarness();
    const templateId = await createTemplate(templates);

    const content = await buildWorkbook((worksheet) => {
      header(worksheet);
      const row = worksheet.addRow(['A-1', 'Uno', 1, 1]);
      row.getCell(3).value = { formula: 'C1+1', result: 999 } as any;
    });

    try {
      await runs.createRun(ALICE, 'k1', {
        templateId,
        format: 'xlsx',
        content,
      } as CreateRunDto);
      fail('debería haber lanzado');
    } catch (error: any) {
      expect(error.response.error).toBe('TEMPLATE_ROW_ERRORS');
      expect(error.response.data.rows[0]).toMatchObject({
        rowNumber: 1,
        code: 'ROW_FORMULA_NOT_ALLOWED',
      });
      // El resultado cacheado (999) no aparece en ninguna parte.
      expect(JSON.stringify(error.response)).not.toContain('999');
    }
    expect(runDurableConversion).not.toHaveBeenCalled();
  });

  it('rechaza una cantidad que viene de una fórmula', async () => {
    const { templates, runs } = buildHarness();
    const templateId = await createTemplate(templates);

    const content = await buildWorkbook((worksheet) => {
      header(worksheet);
      const row = worksheet.addRow(['A-1', 'Uno', 1, 1]);
      row.getCell(4).value = { formula: 'D1*2', result: 4 } as any;
    });

    await expect(
      runs.createRun(ALICE, 'k1', {
        templateId,
        format: 'xlsx',
        content,
      } as CreateRunDto),
    ).rejects.toMatchObject({
      response: {
        data: {
          rows: [expect.objectContaining({ code: 'ROW_FORMULA_NOT_ALLOWED' })],
        },
      },
    });
  });

  it('rechaza un identificador que llega como número, por ambiguo', async () => {
    const { templates, runs } = buildHarness();
    const templateId = await createTemplate(templates);

    const content = await buildWorkbook((worksheet) => {
      header(worksheet);
      // 751 numérico: si el original era 00751, los ceros ya se perdieron.
      worksheet.addRow([751, 'Uno', 1, 1]);
    });

    await expect(
      runs.createRun(ALICE, 'k1', {
        templateId,
        format: 'xlsx',
        content,
      } as CreateRunDto),
    ).rejects.toMatchObject({
      response: {
        data: {
          rows: [
            expect.objectContaining({ code: 'ROW_AMBIGUOUS_LEADING_ZERO' }),
          ],
        },
      },
    });
  });

  it('informa las filas que la hoja se salta por vacías', async () => {
    const { templates, runs } = buildHarness();
    const templateId = await createTemplate(templates);

    const content = await buildWorkbook((worksheet) => {
      header(worksheet);
      worksheet.addRow(['A-1', 'Uno', 1, 1]);
      worksheet.addRow([]);
      worksheet.addRow(['A-2', 'Dos', 1, 1]);
    });

    const { run } = await runs.createRun(ALICE, 'k1', {
      templateId,
      format: 'xlsx',
      content,
    } as CreateRunDto);

    expect(run.validRowCount).toBe(2);
    expect(run.emptyRowCount).toBe(1);
    expect(run.diagnostics).toEqual([
      {
        rowNumber: 2,
        code: 'ROW_EMPTY',
        message: 'Fila vacía: no genera etiqueta',
      },
    ]);
  });

  it('rechaza un libro con macros', async () => {
    const { templates, runs } = buildHarness();
    const templateId = await createTemplate(templates);

    // ZIP real con una entrada `xl/vbaProject.bin`: el rechazo se decide leyendo
    // los nombres del directorio central, antes de abrir el libro.
    const withMacros = await zipWith([
      { name: '[Content_Types].xml', body: '<Types/>' },
      { name: 'xl/vbaProject.bin', body: 'binario' },
    ]);

    await expect(
      runs.createRun(ALICE, 'k1', {
        templateId,
        format: 'xlsx',
        content: withMacros.toString('base64'),
      } as CreateRunDto),
    ).rejects.toMatchObject({
      response: { error: 'XLSX_MACROS_NOT_ALLOWED' },
    });
  });

  it('rechaza algo que no es un XLSX', async () => {
    const { templates, runs } = buildHarness();
    const templateId = await createTemplate(templates);

    await expect(
      runs.createRun(ALICE, 'k1', {
        templateId,
        format: 'xlsx',
        content: Buffer.from('no soy un zip', 'utf8').toString('base64'),
      } as CreateRunDto),
    ).rejects.toMatchObject({ response: { error: 'DATA_INVALID' } });
  });

  it('avisa cuando la hoja pedida no existe, diciendo las que hay', async () => {
    const { templates, runs } = buildHarness();
    const templateId = await createTemplate(templates);

    const content = await buildWorkbook((worksheet) => {
      header(worksheet);
      worksheet.addRow(['A-1', 'Uno', 1, 1]);
    });

    await expect(
      runs.createRun(ALICE, 'k1', {
        templateId,
        format: 'xlsx',
        content,
        sheet: 'NoExiste',
      } as CreateRunDto),
    ).rejects.toMatchObject({
      response: {
        error: 'XLSX_SHEET_NOT_FOUND',
        data: { available: ['Datos'] },
      },
    });
  });

  it('sin lector registrado rechaza la función en vez de inventar la lectura', async () => {
    const { templates, runs, runDurableConversion } = buildHarness({
      withXlsxReader: false,
    });
    const templateId = await createTemplate(templates);

    const content = await buildWorkbook((worksheet) => {
      header(worksheet);
      worksheet.addRow(['A-1', 'Uno', 1, 1]);
    });

    await expect(
      runs.createRun(ALICE, 'k1', {
        templateId,
        format: 'xlsx',
        content,
      } as CreateRunDto),
    ).rejects.toMatchObject({
      response: {
        error: 'FEATURE_UNSUPPORTED',
        data: { feature: 'xlsx' },
      },
    });
    expect(runDurableConversion).not.toHaveBeenCalled();
  });

  it('rechaza un archivo por encima del tamaño admitido', async () => {
    const { templates, runs } = buildHarness();
    const templateId = await createTemplate(templates);

    await expect(
      runs.createRun(ALICE, 'k1', {
        templateId,
        format: 'csv',
        content: 'x'.repeat(6 * 1024 * 1024),
      } as CreateRunDto),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
  });
});

describe('TemplateRunsService — inspección y previsualización', () => {
  it('describe columnas, tipos reales y filas de muestra de un CSV', async () => {
    const { templates, runs, runDurableConversion } = buildHarness();
    const templateId = await createTemplate(templates);

    const result = await runs.inspectTable(ALICE, {
      templateId,
      format: 'csv',
      content: CSV,
    } as CreateRunDto);

    expect(result.format).toBe('csv');
    expect(result.rowCount).toBe(2);
    expect(result.columns.map((column) => column.name)).toEqual([
      'sku',
      'name',
      'price',
      'quantity',
    ]);
    // En CSV todo llega como texto: por eso el `0` inicial sobrevive.
    expect(result.columns[0].kinds).toEqual(['string']);
    expect(result.columns[0].sampleValues).toEqual(['00751', 'A-2']);
    expect(result.sampleRows[0]).toEqual({
      rowNumber: 1,
      values: ['00751', 'Café Ñoño', '12.50', '3'],
    });
    // Con plantilla propone el mapeo por coincidencia exacta de nombre.
    expect(result.suggestedMapping?.fields).toMatchObject({
      sku: 'sku',
      name: 'name',
      price: 'price',
    });
    expect(result.suggestedMapping?.quantityColumn).toBe('quantity');
    expect(runDurableConversion).not.toHaveBeenCalled();
  });

  it('inspecciona sin plantilla y no propone mapeo', async () => {
    const { runs } = buildHarness();

    const result = await runs.inspectTable(ALICE, {
      format: 'csv',
      content: CSV,
    } as CreateRunDto);

    expect(result.columns).toHaveLength(4);
    expect(result.suggestedMapping).toBeUndefined();
  });

  it('delata una columna de identificadores que llega como número en XLSX', async () => {
    const { runs } = buildHarness();

    const content = await buildWorkbook((worksheet) => {
      header(worksheet);
      worksheet.addRow([751, 'Uno', 1, 1]);
      const row = worksheet.addRow(['00752', 'Dos', 2, 1]);
      row.getCell(1).numFmt = '@';
    });

    const result = await runs.inspectTable(ALICE, {
      format: 'xlsx',
      content,
    } as CreateRunDto);

    expect(result.sheet).toBe('Datos');
    expect(result.availableSheets).toEqual(['Datos']);
    // La mezcla number/string es exactamente la señal que el asistente necesita.
    expect(result.columns[0].kinds.sort()).toEqual(['number', 'string']);
  });

  it('validate devuelve los valores literales ya validados de las primeras filas', async () => {
    const { templates, runs } = buildHarness();
    const templateId = await createTemplate(templates);

    const { run } = await runs.validateRun(ALICE, csvRun(templateId));

    expect(run.previewFields).toEqual([
      {
        rowNumber: 1,
        copies: 3,
        values: { sku: '00751', name: 'Café Ñoño', price: '12.50' },
      },
      {
        rowNumber: 2,
        copies: 1,
        values: { sku: 'A-2', name: 'Caja normal', price: '1.00' },
      },
    ]);
  });

  it('exige plantilla para validar y para ejecutar', async () => {
    const { runs } = buildHarness();

    await expect(
      runs.validateRun(ALICE, { format: 'csv', content: CSV } as CreateRunDto),
    ).rejects.toMatchObject({ response: { error: 'INVALID_INPUT' } });

    await expect(
      runs.createRun(ALICE, 'k1', {
        format: 'csv',
        content: CSV,
      } as CreateRunDto),
    ).rejects.toMatchObject({ response: { error: 'INVALID_INPUT' } });
  });

  it('la inspección respeta la propiedad de la plantilla', async () => {
    const { templates, runs } = buildHarness();
    const templateId = await createTemplate(templates);

    await expect(
      runs.inspectTable(BOB, {
        templateId,
        format: 'csv',
        content: CSV,
      } as CreateRunDto),
    ).rejects.toMatchObject({ response: { error: 'TEMPLATE_NOT_FOUND' } });
  });
});

describe('LabelTemplatesService.renderRows', () => {
  it('renderiza filas JSON con la misma validación y escapado', async () => {
    const { templates } = buildHarness();
    const templateId = await createTemplate(templates);

    const result = await templates.renderRows(
      ALICE.uid,
      templateId,
      undefined,
      [
        {
          values: { sku: '00751', name: 'Café Ñoño', price: '12.50' },
          copies: 3,
        },
        { values: { sku: 'A-2', name: '^XZ^XA', price: '1.00' } },
      ],
    );

    expect(result.labelSize).toBe('2x1');
    expect(result.templateVersion).toBe(1);
    expect(result.labelCount).toBe(4);
    expect(result.zplContent).toContain('^FH_^FD00751^FS');
    expect(result.zplContent).toContain('^PQ3^XZ');
    // El valor con comandos no parte la etiqueta.
    expect(result.zplContent.match(/\^XA/g)).toHaveLength(2);
    expect(result.zplContent).toContain('_5EXZ_5EXA');
  });

  it('devuelve diagnóstico por fila y no renderiza nada', async () => {
    const { templates } = buildHarness();
    const templateId = await createTemplate(templates);

    await expect(
      templates.renderRows(ALICE.uid, templateId, undefined, [
        { values: { sku: 'A-1', name: 'Uno', price: '1.00' } },
        { values: { sku: 'A/2', name: 'Dos', price: '1.00' } },
      ]),
    ).rejects.toMatchObject({
      response: {
        error: 'TEMPLATE_ROW_ERRORS',
        data: {
          rows: [
            expect.objectContaining({
              rowNumber: 2,
              field: 'sku',
              code: 'ROW_CHARSET',
            }),
          ],
        },
      },
    });
  });

  it('rechaza copias inválidas y filas vacías', async () => {
    const { templates } = buildHarness();
    const templateId = await createTemplate(templates);

    await expect(
      templates.renderRows(ALICE.uid, templateId, undefined, [
        { values: { sku: 'A-1', name: 'Uno', price: '1.00' }, copies: 0 },
      ]),
    ).rejects.toMatchObject({
      response: {
        data: {
          rows: [expect.objectContaining({ code: 'ROW_INVALID_QUANTITY' })],
        },
      },
    });

    await expect(
      templates.renderRows(ALICE.uid, templateId, undefined, []),
    ).rejects.toMatchObject({ response: { error: 'TEMPLATE_RUN_EMPTY' } });
  });

  it('usa el ZPL exacto de la versión pedida', async () => {
    const { templates } = buildHarness();
    const templateId = await createTemplate(templates);

    await templates.addVersion(ALICE, templateId, {
      expectedVersion: 1,
      fields: TEMPLATE_DEF.fields,
      zplTemplate:
        '^XA^CI28^FO0,0^FD{{sku}}^FS^FD{{name}}^FS^FD{{price}}^FS^XZ',
    });

    const v1 = await templates.renderRows(ALICE.uid, templateId, 1, [
      { values: { sku: 'A-1', name: 'Uno', price: '1.00' } },
    ]);
    const current = await templates.renderRows(
      ALICE.uid,
      templateId,
      undefined,
      [{ values: { sku: 'A-1', name: 'Uno', price: '1.00' } }],
    );

    expect(v1.zplContent).toContain('^FO10,10');
    expect(current.zplContent).toContain('^FO0,0');
    expect(current.templateVersion).toBe(2);
  });

  it('respeta la propiedad y el archivado', async () => {
    const { templates } = buildHarness();
    const templateId = await createTemplate(templates);

    await expect(
      templates.renderRows(BOB.uid, templateId, undefined, [
        { values: { sku: 'A-1', name: 'Uno', price: '1.00' } },
      ]),
    ).rejects.toMatchObject({ response: { error: 'TEMPLATE_NOT_FOUND' } });

    const { template } = await templates.getTemplate(ALICE.uid, templateId);
    await templates.archiveTemplate(ALICE.uid, templateId, template.version);

    await expect(
      templates.renderRows(ALICE.uid, templateId, undefined, [
        { values: { sku: 'A-1', name: 'Uno', price: '1.00' } },
      ]),
    ).rejects.toMatchObject({ response: { error: 'TEMPLATE_ARCHIVED' } });
  });
});

describe('TemplateRunsService — identificadores y eventos', () => {
  it('runId y operationId son el mismo UUIDv4, estable entre reintentos', async () => {
    const { templates, runs, runDurableConversion, events } = buildHarness();
    const templateId = await createTemplate(templates);

    const first = await runs.createRun(ALICE, 'k1', csvRun(templateId));
    const retry = await runs.createRun(ALICE, 'k1', csvRun(templateId));

    expect(isUuid(first.run.runId)).toBe(true);
    expect(uuidVersion(first.run.runId)).toBe(4);
    expect(retry.run.runId).toBe(first.run.runId);

    const [input] = runDurableConversion.mock.calls[0];
    expect(input.operationId).toBe(first.run.runId);
    expect(first.run.jobId).toBe(first.run.runId);

    const succeeded = events.filter(
      (event) => event.eventName === 'template_run_succeeded',
    );
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0].operationId).toBe(first.run.runId);
    expect(succeeded[0].source).toBe('api');
    expect(isUuid(succeeded[0].eventId)).toBe(true);
  });

  it('template_saved lleva un operationId UUIDv4 estable por versión', async () => {
    const { templates, events } = buildHarness();
    const templateId = await createTemplate(templates);

    await templates.addVersion(ALICE, templateId, {
      expectedVersion: 1,
      fields: TEMPLATE_DEF.fields,
      zplTemplate: '^XA^CI28^FD{{sku}}^FS^FD{{name}}^FS^FD{{price}}^FS^XZ',
    });

    const saved = events.filter(
      (event) => event.eventName === 'template_saved',
    );
    expect(saved).toHaveLength(2);
    for (const event of saved) {
      expect(isUuid(event.operationId)).toBe(true);
      expect(uuidVersion(event.operationId)).toBe(4);
      expect(event.source).toBe('api');
    }
    expect(saved[0].operationId).not.toBe(saved[1].operationId);
    // Estable: el mismo par plantilla/versión da siempre el mismo id.
    expect(saved[1].operationId).toBe(
      LabelTemplatesService.versionOperationId(templateId, 2),
    );
  });
});

describe('BE05 — el hecho se confirma con la transición (outbox atómico)', () => {
  it('ejecutar escribe la ejecución y su hecho a la vez', async () => {
    const { templates, runs, outbox, events } = buildHarness();
    const templateId = await createTemplate(templates);

    const { run } = await runs.createRun(ALICE, 'k1', csvRun(templateId));

    expect(run.status).toBe('accepted');
    expect(outbox.all()).toEqual([]);
    expect(
      events.filter((event) => event.eventName === 'template_run_succeeded'),
    ).toHaveLength(1);
  });

  it('si la confirmación falla, no hay ejecución aceptada ni hecho', async () => {
    const { templates, runs, repository, outbox, events } = buildHarness();
    const templateId = await createTemplate(templates);
    const before = events.length;

    repository.failNextCommit(new Error('caída en la transacción'));

    await expect(
      runs.createRun(ALICE, 'k1', csvRun(templateId)),
    ).rejects.toThrow('caída en la transacción');

    expect(outbox.all()).toEqual([]);
    expect(events).toHaveLength(before);
    // La ejecución queda marcada como fallida y reintentable, nunca aceptada.
    const stored = (await runs.listRuns(ALICE.uid)).items;
    expect(stored.map((item) => item.status)).toEqual(['failed']);
  });

  it('el reintento tras la caída produce ejecución y hecho, una sola vez', async () => {
    const { templates, runs, repository, events, outbox } = buildHarness();
    const templateId = await createTemplate(templates);
    const before = events.length;

    repository.failNextCommit();
    await expect(
      runs.createRun(ALICE, 'k1', csvRun(templateId)),
    ).rejects.toThrow();

    const retry = await runs.createRun(ALICE, 'k1', csvRun(templateId));

    expect(retry.run.status).toBe('accepted');
    const succeeded = events
      .slice(before)
      .filter((event) => event.eventName === 'template_run_succeeded');
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0].operationId).toBe(retry.run.runId);
    expect(outbox.all()).toEqual([]);
  });

  it('si el proceso muere tras confirmar, el hecho sobrevive y el drenado lo entrega', async () => {
    const { templates, runs, outbox, events, publisher, recorder } =
      buildHarness();
    const templateId = await createTemplate(templates);
    const before = events.length;

    const spy = jest
      .spyOn(recorder, 'recordServerEvent')
      .mockRejectedValueOnce(new Error('proceso caído'));

    const { run } = await runs.createRun(ALICE, 'k1', csvRun(templateId));
    spy.mockRestore();

    expect(run.status).toBe('accepted');
    const [pending] = outbox.all();
    expect(pending.operationId).toBe(run.runId);
    expect(pending.accountId).toBe(ALICE.uid);
    expect(events.slice(before)).toEqual([]);

    jest.useFakeTimers().setSystemTime(Date.now() + 10 * 60_000);
    try {
      expect(await publisher.retryPending()).toMatchObject({ delivered: 1 });
    } finally {
      jest.useRealTimers();
    }

    expect(events.slice(before)).toHaveLength(1);
    expect(events[before].eventId).toBe(pending.id);
    expect(outbox.all()).toEqual([]);
  });

  it('guardar plantilla y versión escribe su hecho en la misma transacción', async () => {
    const { templates, repository, outbox, events } = buildHarness();

    repository.failNextCommit();
    await expect(
      templates.createTemplate(ALICE, TEMPLATE_DEF),
    ).rejects.toThrow();
    expect(outbox.all()).toEqual([]);
    expect(events).toEqual([]);

    const created = await templates.createTemplate(ALICE, TEMPLATE_DEF);
    expect(events).toHaveLength(1);
    expect(events[0].eventName).toBe('template_saved');

    repository.failNextCommit();
    await expect(
      templates.addVersion(ALICE, created.template.id, {
        expectedVersion: 1,
        fields: TEMPLATE_DEF.fields,
        zplTemplate: TEMPLATE_DEF.zplTemplate,
      }),
    ).rejects.toThrow();

    // Ni versión nueva ni hecho.
    const { versions } = await templates.getTemplate(
      ALICE.uid,
      created.template.id,
    );
    expect(versions).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(outbox.all()).toEqual([]);
  });
});

describe('BE05 — cuenta borrada (lápida)', () => {
  it('no admite guardar plantilla ni ejecutar, y no deja hechos', async () => {
    const { templates, runs, repository, outbox, events } = buildHarness();
    const templateId = await createTemplate(templates);
    const before = events.length;

    repository.markAccountDeleted(ALICE.uid);

    await expect(
      runs.createRun(ALICE, 'k1', csvRun(templateId)),
    ).rejects.toMatchObject({ response: { error: 'ACCOUNT_DELETED' } });

    await expect(
      templates.createTemplate(ALICE, TEMPLATE_DEF),
    ).rejects.toMatchObject({ response: { error: 'ACCOUNT_DELETED' } });

    await expect(
      templates.addVersion(ALICE, templateId, {
        expectedVersion: 1,
        fields: TEMPLATE_DEF.fields,
        zplTemplate: TEMPLATE_DEF.zplTemplate,
      }),
    ).rejects.toMatchObject({ response: { error: 'ACCOUNT_DELETED' } });

    expect(outbox.all()).toEqual([]);
    expect(events).toHaveLength(before);
  });
});

describe('Template run pinned recovery', () => {
  it('keeps the original version, saved mapping and filename after template edits', async () => {
    const { templates, repository, runs, runDurableConversion, events } =
      buildHarness();
    const templateId = await createTemplate(templates);
    const dto = csvRun(templateId, { mapping: undefined });
    repository.failNextCommit();
    await expect(runs.createRun(ALICE, 'pinned-run', dto)).rejects.toThrow();
    await templates.addVersion(ALICE, templateId, {
      expectedVersion: 1,
      fields: TEMPLATE_DEF.fields,
      zplTemplate: TEMPLATE_DEF.zplTemplate.replace('^FO10,10', '^FO20,20'),
      labelSize: '4x6',
    });
    await repository.updateTemplate(ALICE.uid, templateId, 2, () => ({
      name: 'Changed',
      savedMapping: { fields: { name: 'sku', sku: 'name' } },
    }));
    const retry = await runs.createRun(ALICE, 'pinned-run', dto);
    expect(retry.run.status).toBe('accepted');
    expect(retry.run.templateVersion).toBe(1);
    expect(runDurableConversion.mock.calls[1][0]).toEqual(
      runDurableConversion.mock.calls[0][0],
    );
    expect(
      events.filter((event) => event.eventName === 'template_run_succeeded'),
    ).toHaveLength(1);
    expect(retry.run).not.toHaveProperty('leaseToken');
    expect(retry.run).not.toHaveProperty('completionEvent');
    expect(await runs.getRun(ALICE.uid, retry.run.runId)).not.toHaveProperty(
      'resolvedMapping',
    );
  });

  it('keeps accepted success when post-acceptance mapping persistence fails', async () => {
    const { templates, runs, runDurableConversion, events } = buildHarness();
    const templateId = await createTemplate(templates);
    jest
      .spyOn(templates, 'rememberMapping')
      .mockRejectedValue(new Error('unavailable'));
    const first = await runs.createRun(
      ALICE,
      'mapping-failure',
      csvRun(templateId),
    );
    const retry = await runs.createRun(
      ALICE,
      'mapping-failure',
      csvRun(templateId),
    );
    expect(first.run.status).toBe('accepted');
    expect(retry.run.status).toBe('accepted');
    expect(runDurableConversion).toHaveBeenCalledTimes(1);
    expect(
      events.filter((event) => event.eventName === 'template_run_succeeded'),
    ).toHaveLength(1);
  });
});

describe('Drive server snapshot materialization', () => {
  it('uses the supplied immutable version and existing parser without runs, conversion or success events', async () => {
    const { templates, repository, runs, runDurableConversion, events } =
      buildHarness();
    const templateId = await createTemplate(templates);
    const version = (await repository.getVersion(ALICE.uid, templateId, 1))!;
    const result = await runs.materializeFileSnapshot(
      ALICE.uid,
      version,
      csvRun(templateId),
    );
    expect(result.labelCount).toBe(4);
    expect(result.labelSize).toBe('2x1');
    expect(result.zplContent).toContain('^XA');
    expect(await repository.listRuns(ALICE.uid)).toEqual([]);
    expect(runDurableConversion).not.toHaveBeenCalled();
    expect(
      events.filter((event) => event.eventName === 'template_run_succeeded'),
    ).toEqual([]);
  });

  it('supports XLSX through the same workbook reader', async () => {
    const { templates, repository, runs } = buildHarness();
    const templateId = await createTemplate(templates);
    const version = (await repository.getVersion(ALICE.uid, templateId, 1))!;
    const content = await buildWorkbook((sheet) => {
      sheet.addRow(['sku', 'name', 'price', 'quantity']);
      sheet.addRow(['001', 'Producto', '1.50', 2]);
    });
    const result = await runs.materializeFileSnapshot(
      ALICE.uid,
      version,
      csvRun(templateId, { format: 'xlsx', content }),
    );
    expect(result.labelCount).toBe(2);
    expect(result.zplContent).toContain('001');
  });

  it('rejects foreign owners, tombstones, invalid data and excessive counts before any conversion', async () => {
    const { templates, repository, runs, runDurableConversion } =
      buildHarness();
    const templateId = await createTemplate(templates);
    const version = (await repository.getVersion(ALICE.uid, templateId, 1))!;
    await expect(
      runs.materializeFileSnapshot(BOB.uid, version, csvRun(templateId)),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      runs.materializeFileSnapshot(
        ALICE.uid,
        version,
        csvRun(templateId, {
          content: 'sku,name,price,quantity\n,Missing,1,1',
        }),
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(
      runs.materializeFileSnapshot(
        ALICE.uid,
        version,
        csvRun(templateId, {
          content: 'sku,name,price,quantity\n001,Product,1,999999',
        }),
      ),
    ).rejects.toThrow();
    repository.markAccountDeleted(ALICE.uid);
    await expect(
      runs.materializeFileSnapshot(ALICE.uid, version, csvRun(templateId)),
    ).rejects.toMatchObject({ status: 410 });
    expect(runDurableConversion).not.toHaveBeenCalled();
  });
});

describe('Template service late workers', () => {
  it.each(['complete', 'fail'])(
    'returns the winning acceptance after a late worker tries to %s',
    async (late) => {
      jest.useFakeTimers();
      try {
        const h = buildHarness();
        const templateId = await createTemplate(h.templates);
        let started!: () => void;
        const entered = new Promise<void>((resolve) => {
          started = resolve;
        });
        let finish!: (value: { jobId: string; status: string }) => void;
        let fail!: (error: Error) => void;
        h.runDurableConversion.mockImplementationOnce(() => {
          started();
          return new Promise((resolve, reject) => {
            finish = resolve;
            fail = reject;
          });
        });
        const first = h.runs.createRun(ALICE, 'race', csvRun(templateId));
        await entered;
        jest.setSystemTime(new Date(Date.now() + 13 * 60_000));
        const second = await h.runs.createRun(
          ALICE,
          'race',
          csvRun(templateId),
        );
        const accepted = await h.repository.getRun(ALICE.uid, second.run.runId);
        if (late === 'complete')
          finish({ jobId: second.run.runId, status: 'completed' });
        else fail(new Error('late converter failure'));
        const stale = await first;
        expect(stale.run.status).toBe('accepted');
        expect(stale.created).toBe(false);
        expect(await h.repository.getRun(ALICE.uid, second.run.runId)).toEqual(
          accepted,
        );
        expect(
          h.events.filter(
            (event) => event.eventName === 'template_run_succeeded',
          ),
        ).toHaveLength(1);
        expect(h.outbox.all()).toEqual([]);
      } finally {
        jest.useRealTimers();
      }
    },
  );
});
