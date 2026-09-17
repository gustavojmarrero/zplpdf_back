import { Injectable, Logger } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { WorkbookReadError } from './workbook-reader.port.js';
import type {
  TabularCell,
  TabularRow,
  TabularSheet,
  WorkbookReadOptions,
  WorkbookReaderPort,
} from './workbook-reader.port.js';
import { ZipFormatError, readZipInventory } from './zip-inspector.js';

/** Tope de expansión: cuánto puede ocupar el libro ya descomprimido. */
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
/** Entradas del ZIP. Un .xlsx normal tiene decenas, no cientos. */
const MAX_ZIP_ENTRIES = 512;

/**
 * Adaptador XLSX sobre exceljs 4.4.
 *
 * Tres decisiones que no son de estilo:
 *
 * 1. **El ZIP se inspecciona antes de abrirlo.** El tope de bytes de entrada no
 *    acota lo que ocupa descomprimido, así que se leen los tamaños declarados
 *    en el directorio central y se rechaza por encima del tope de expansión.
 *    Sin esto, un archivo de 5 MB puede convertirse en varios GB de memoria.
 * 2. **Las macros se detectan por nombre de entrada** (`vbaProject.bin`) en ese
 *    mismo directorio, no buscando a ciegas en el contenido.
 * 3. **Las fórmulas no se evalúan nunca.** exceljs tampoco las calcula —lee el
 *    resultado que venía cacheado en el archivo—, y ese resultado se descarta:
 *    la celda se marca `formula` y la fila se rechaza con diagnóstico. Un dato
 *    que depende de un cálculo ajeno no puede acabar impreso como si fuera
 *    contenido declarado.
 *
 * Se usa `xlsx.load` y no el lector por streaming: el streaming de exceljs 4.4
 * falla con `Cannot read properties of undefined (reading 'sheets')` en cuanto
 * el orden de las entradas del ZIP pone la hoja antes del libro, que es lo que
 * ocurre con cualquier archivo que traiga fórmulas. La cota de memoria la pone
 * la inspección del punto 1.
 *
 * El import es por defecto porque exceljs es CommonJS: bajo ESM sus
 * exportaciones con nombre llegan como `undefined`.
 */
@Injectable()
export class ExcelJsWorkbookReader implements WorkbookReaderPort {
  private readonly logger = new Logger(ExcelJsWorkbookReader.name);

  async read(
    buffer: Buffer,
    options: WorkbookReadOptions,
  ): Promise<TabularSheet> {
    this.assertSafeArchive(buffer);

    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(buffer as any);
    } catch {
      this.logger.warn('XLSX_UNREADABLE');
      throw new WorkbookReadError(
        'DATA_INVALID',
        'No se pudo leer el archivo XLSX',
      );
    }

    const worksheets = workbook.worksheets.slice(0, options.maxSheets);
    const available = worksheets.map((worksheet) => worksheet.name);
    const worksheet = this.selectWorksheet(worksheets, options.sheet);

    if (!worksheet) {
      throw new WorkbookReadError(
        'XLSX_SHEET_NOT_FOUND',
        'No se encontró la hoja indicada',
        { requested: options.sheet ?? null, available },
      );
    }

    return {
      ...this.readSheet(worksheet, options),
      availableSheets: available,
    };
  }

  private assertSafeArchive(buffer: Buffer): void {
    if (
      buffer.length < 4 ||
      buffer.subarray(0, 2).toString('latin1') !== 'PK'
    ) {
      throw new WorkbookReadError(
        'DATA_INVALID',
        'El archivo no es un XLSX válido',
      );
    }

    let inventory;
    try {
      inventory = readZipInventory(buffer, MAX_ZIP_ENTRIES);
    } catch (error) {
      if (error instanceof ZipFormatError) {
        throw new WorkbookReadError('DATA_INVALID', error.message);
      }
      throw error;
    }

    if (
      inventory.entries.some((entry) => entry.name.endsWith('vbaProject.bin'))
    ) {
      throw new WorkbookReadError(
        'XLSX_MACROS_NOT_ALLOWED',
        'El libro contiene macros; súbelo como .xlsx sin macros',
      );
    }

    if (inventory.hasUnknownSizes) {
      throw new WorkbookReadError(
        'DATA_INVALID',
        'El archivo declara tamaños en formato ZIP64; vuelve a guardarlo como .xlsx',
      );
    }

    if (inventory.totalUncompressedSize > MAX_UNCOMPRESSED_BYTES) {
      throw new WorkbookReadError(
        'DATA_TOO_LARGE',
        'El archivo ocupa demasiado al descomprimirse',
        {
          maxUncompressedBytes: MAX_UNCOMPRESSED_BYTES,
          uncompressedBytes: inventory.totalUncompressedSize,
        },
      );
    }
  }

  private selectWorksheet(
    worksheets: ExcelJS.Worksheet[],
    requested: string | number | undefined,
  ): ExcelJS.Worksheet | undefined {
    if (requested === undefined || requested === null) return worksheets[0];
    if (typeof requested === 'number') return worksheets[requested - 1];
    return worksheets.find((worksheet) => worksheet.name === requested);
  }

  private readSheet(
    worksheet: ExcelJS.Worksheet,
    options: WorkbookReadOptions,
  ): TabularSheet {
    const rows: TabularRow[] = [];
    const skippedEmptySheetRows: number[] = [];
    let previousSheetRow = 0;

    worksheet.eachRow({ includeEmpty: false }, (row) => {
      if (rows.length > options.maxRows) {
        throw new WorkbookReadError(
          'DATA_TOO_LARGE',
          'El archivo tiene más filas de las admitidas',
          { maxRows: options.maxRows },
        );
      }

      const cells: TabularCell[] = [];
      let lastColumn = 0;

      row.eachCell({ includeEmpty: true }, (cell, column) => {
        if (column > options.maxColumns) return;
        lastColumn = Math.max(lastColumn, column);
        cells[column - 1] = this.toCell(
          cell,
          options.maxCellBytes,
          worksheet.name,
          row.number,
          column,
        );
      });

      for (let index = 0; index < lastColumn; index += 1) {
        if (!cells[index]) cells[index] = { text: '', kind: 'empty' };
      }

      // exceljs no emite las filas completamente vacías: el hueco en la
      // numeración es la única señal de que existían.
      for (let gap = previousSheetRow + 1; gap < row.number; gap += 1) {
        skippedEmptySheetRows.push(gap);
      }
      previousSheetRow = row.number;

      rows.push({ sheetRow: row.number, cells: cells.slice(0, lastColumn) });
    });

    return {
      name: worksheet.name,
      rows,
      skippedEmptySheetRows,
      availableSheets: [worksheet.name],
    };
  }

  private toCell(
    cell: ExcelJS.Cell,
    maxCellBytes: number,
    sheetName: string,
    rowNumber: number,
    column: number,
  ): TabularCell {
    const { ValueType } = ExcelJS;

    switch (cell.type) {
      case ValueType.Formula:
        // El resultado cacheado se descarta a propósito.
        return { text: '', kind: 'formula' };

      case ValueType.Error:
        return { text: '', kind: 'error' };

      case ValueType.Null:
      case ValueType.Merge:
        return { text: '', kind: 'empty' };

      case ValueType.Number: {
        const numeric = cell.value as number;
        return { text: String(numeric), kind: 'number', numeric };
      }

      case ValueType.Boolean:
        return { text: cell.value ? 'true' : 'false', kind: 'boolean' };

      case ValueType.Date: {
        const value = cell.value as Date;
        return {
          text: value.toISOString().slice(0, 10),
          kind: 'date',
          iso: value.toISOString(),
        };
      }

      default: {
        const text = String(cell.text ?? '');
        if (Buffer.byteLength(text, 'utf8') > maxCellBytes) {
          throw new WorkbookReadError(
            'DATA_TOO_LARGE',
            `Una celda supera ${maxCellBytes} bytes`,
            { sheet: sheetName, row: rowNumber, column },
          );
        }
        return { text, kind: text === '' ? 'empty' : 'string' };
      }
    }
  }
}
