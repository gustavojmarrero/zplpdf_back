import {
  BadRequestException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PdfRecipe } from './pdf-layout.types.js';
export type { PdfRecipe, PdfSelection } from './pdf-layout.types.js';

export const PDF_WORKER_LIMITS = Object.freeze({
  deadlineMs: 30000,
  maxOldGenerationSizeMb: 128,
  maxYoungGenerationSizeMb: 16,
  maxConcurrent: 2,
  maxBytes: 20 * 1024 * 1024,
});
let activeWorkers = 0;
const safeCodes = new Set([
  'PDF_MAX_20_MB',
  'PDF_INVALID',
  'PDF_RECIPE_INVALID',
  'PDF_CORRUPT_OR_ENCRYPTED',
  'PDF_MAX_500_PAGES',
  'PDF_LAYOUT_HAS_NO_SPACE',
  'PDF_PAGE_OR_ROTATION_INVALID',
  'PDF_CROP_OUTSIDE_PAGE',
  'PDF_SOURCE_ROTATION_UNSUPPORTED',
  'PDF_ACTUAL_SIZE_DOES_NOT_FIT',
  'PDF_OUTPUT_MAX_20_MB',
]);
const workerProgram = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  try {
    const { preparePdfInWorker } = await import(workerData.engineUrl);
    const result = await preparePdfInWorker(Buffer.from(workerData.input), workerData.recipe);
    const bytes = Uint8Array.from(result.buffer);
    parentPort.postMessage({ ok: true, result: { ...result, buffer: bytes } }, [bytes.buffer]);
  } catch (error) {
    parentPort.postMessage({ ok: false, code: error?.message, status: error?.getStatus?.() });
  }
})();
`;
export interface PreparedPdf {
  buffer: Buffer;
  pageCount: number;
  labelCount: number;
  paperWidthPt: number;
  paperHeightPt: number;
}
/** Internal deadline override is for isolation tests; callers use the fixed budget. */
export async function runPdfWorker(
  input: Buffer,
  recipe: PdfRecipe,
  deadlineMs: number = PDF_WORKER_LIMITS.deadlineMs,
): Promise<PreparedPdf> {
  if (input.length > PDF_WORKER_LIMITS.maxBytes)
    throw new PayloadTooLargeException('PDF_MAX_20_MB');
  if (activeWorkers >= PDF_WORKER_LIMITS.maxConcurrent)
    throw new ServiceUnavailableException('PDF_PREPARATION_BUSY');
  activeWorkers++;
  let worker: Worker;
  let timer: NodeJS.Timeout;
  try {
    // Nest's existing **/*.js asset rule copies the same engine used by tests.
    // App scripts and the Docker WORKDIR run from the project root.
    const engineUrl = pathToFileURL(
      resolve(
        process.cwd(),
        process.env.NODE_ENV === 'test' ? 'src' : 'dist',
        'modules/pdf-preparation/pdf-layout.engine.js',
      ),
    ).href;
    const bytes = Uint8Array.from(input);
    worker = new Worker(workerProgram, {
      eval: true,
      // The bootstrap is CommonJS; do not inherit --input-type or debugger flags.
      execArgv: [],
      workerData: { engineUrl, input: bytes, recipe },
      transferList: [bytes.buffer],
      resourceLimits: {
        maxOldGenerationSizeMb: PDF_WORKER_LIMITS.maxOldGenerationSizeMb,
        maxYoungGenerationSizeMb: PDF_WORKER_LIMITS.maxYoungGenerationSizeMb,
        stackSizeMb: 4,
      },
      // PDF parser diagnostics can contain source-derived values: never forward them.
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    return await new Promise<PreparedPdf>((accept, reject) => {
      timer = setTimeout(
        () => reject(new BadRequestException('PDF_PROCESSING_TIMEOUT')),
        deadlineMs,
      );
      worker.once('error', () =>
        reject(new BadRequestException('PDF_PROCESSING_LIMIT')),
      );
      worker.once('exit', () =>
        reject(new BadRequestException('PDF_PROCESSING_LIMIT')),
      );
      worker.once('message', (message) => {
        if (!message.ok) {
          const code = safeCodes.has(message.code)
            ? message.code
            : 'PDF_CORRUPT_OR_ENCRYPTED';
          reject(
            message.status === 413
              ? new PayloadTooLargeException(code)
              : new BadRequestException(code),
          );
          return;
        }
        if (message.result.buffer.byteLength > PDF_WORKER_LIMITS.maxBytes) {
          reject(new PayloadTooLargeException('PDF_OUTPUT_MAX_20_MB'));
          return;
        }
        accept({
          ...message.result,
          buffer: Buffer.from(message.result.buffer),
        });
      });
    });
  } finally {
    clearTimeout(timer);
    // Do not admit another input until the old isolate has actually stopped.
    try {
      if (worker) await worker.terminate();
    } finally {
      activeWorkers--;
    }
  }
}
/** Parsing, decompression, embedding and serialization all stay in the isolate. */
export function preparePdf(
  input: Buffer,
  recipe: PdfRecipe,
): Promise<PreparedPdf> {
  return runPdfWorker(input, recipe);
}
