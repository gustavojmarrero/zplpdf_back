import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import {
  PDFDocument,
  PageSizes,
  degrees,
  pushGraphicsState,
  popGraphicsState,
  rectangle,
  clip,
  endPath,
} from 'pdf-lib';
/** @typedef {import('./pdf-layout.types.js').PdfRecipe} PdfRecipe */
/** @type {Record<PdfRecipe['paper'], readonly [number, number]>} */
const PAPER = {
  '4x6': [288, 432],
  a4: PageSizes.A4,
  letter: PageSizes.Letter,
};
/** Places vector pages into physical point dimensions; no fixed printer DPI or rasterization. */
/** @param {Buffer} input @param {PdfRecipe} recipe */
export async function preparePdfInWorker(input, recipe) {
  if (input.length > 20 * 1024 * 1024)
    throw new PayloadTooLargeException('PDF_MAX_20_MB');
  if (!input.subarray(0, 1024).includes(Buffer.from('%PDF-')))
    throw new BadRequestException('PDF_INVALID');
  if (
    !recipe ||
    !['4x6', 'a4', 'letter'].includes(recipe.paper) ||
    !Array.isArray(recipe.selections) ||
    recipe.selections.length < 1 ||
    recipe.selections.length > 500 ||
    ![recipe.columns, recipe.rows].every(
      (n) => Number.isInteger(n) && n >= 1 && n <= 4,
    ) ||
    ![recipe.marginPt, recipe.gapPt].every(
      (n) => Number.isFinite(n) && n >= 0 && n <= 72,
    ) ||
    !['fit', 'actual'].includes(recipe.scale)
  )
    throw new BadRequestException('PDF_RECIPE_INVALID');
  /** @type {PDFDocument} */
  let source;
  try {
    source = await PDFDocument.load(input, {
      ignoreEncryption: false,
      updateMetadata: false,
      throwOnInvalidObject: true,
    });
  } catch {
    throw new BadRequestException('PDF_CORRUPT_OR_ENCRYPTED');
  }
  if (source.getPageCount() > 500)
    throw new BadRequestException('PDF_MAX_500_PAGES');
  const [width, height] = PAPER[recipe.paper];
  const cellWidth =
    (width - 2 * recipe.marginPt - (recipe.columns - 1) * recipe.gapPt) /
    recipe.columns;
  const cellHeight =
    (height - 2 * recipe.marginPt - (recipe.rows - 1) * recipe.gapPt) /
    recipe.rows;
  if (cellWidth <= 0 || cellHeight <= 0)
    throw new BadRequestException('PDF_LAYOUT_HAS_NO_SPACE');
  const output = await PDFDocument.create();
  const uniquePages = [
    ...new Set(
      recipe.selections.map((selection) => {
        if (
          !selection ||
          !Number.isInteger(selection.page) ||
          selection.page < 0 ||
          selection.page >= source.getPageCount()
        )
          throw new BadRequestException('PDF_PAGE_OR_ROTATION_INVALID');
        return selection.page;
      }),
    ),
  ];
  // Copy shared fonts/images once even when selecting the same page repeatedly.
  const copied = await output.copyPages(source, uniquePages);
  const copiedByIndex = new Map(
    uniquePages.map((index, i) => [index, copied[i]]),
  );
  const embeddedByPage = new Map();
  const perSheet = recipe.columns * recipe.rows;
  for (let i = 0; i < recipe.selections.length; i++) {
    const selection = recipe.selections[i];
    if (
      !selection ||
      typeof selection !== 'object' ||
      !Number.isInteger(selection.page) ||
      selection.page < 0 ||
      selection.page >= source.getPageCount() ||
      ![0, 90, 180, 270].includes(selection.rotation)
    )
      throw new BadRequestException('PDF_PAGE_OR_ROTATION_INVALID');
    const page = source.getPage(selection.page);
    const media = page.getMediaBox();
    // Crop coordinates refer to source content, independent of the viewer rotation.
    const crop = selection.crop ?? {
      x: media.x,
      y: media.y,
      width: media.width,
      height: media.height,
    };
    if (
      ![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) ||
      crop.width <= 0 ||
      crop.height <= 0 ||
      crop.x < media.x ||
      crop.y < media.y ||
      crop.x + crop.width > media.x + media.width ||
      crop.y + crop.height > media.y + media.height
    )
      throw new BadRequestException('PDF_CROP_OUTSIDE_PAGE');
    const rotation =
      (((page.getRotation().angle + selection.rotation) % 360) + 360) % 360;
    if (![0, 90, 180, 270].includes(rotation))
      throw new BadRequestException('PDF_SOURCE_ROTATION_UNSUPPORTED');
    const rotated = rotation === 90 || rotation === 270;
    const naturalWidth = rotated ? crop.height : crop.width;
    const naturalHeight = rotated ? crop.width : crop.height;
    const scale =
      recipe.scale === 'actual'
        ? 1
        : Math.min(cellWidth / naturalWidth, cellHeight / naturalHeight);
    if (
      naturalWidth * scale > cellWidth + 0.001 ||
      naturalHeight * scale > cellHeight + 0.001
    )
      throw new BadRequestException('PDF_ACTUAL_SIZE_DOES_NOT_FIT');
    if (i % perSheet === 0) output.addPage([width, height]);
    if (!page.node.Contents()) continue; // A valid blank input remains blank.
    let embedded = embeddedByPage.get(selection.page);
    if (!embedded) {
      embedded = await output.embedPage(copiedByIndex.get(selection.page), {
        left: media.x,
        bottom: media.y,
        right: media.x + media.width,
        top: media.y + media.height,
      });
      embeddedByPage.set(selection.page, embedded);
    }
    const column = i % recipe.columns;
    const row = Math.floor((i % perSheet) / recipe.columns);
    let x =
      recipe.marginPt +
      column * (cellWidth + recipe.gapPt) +
      (cellWidth - naturalWidth * scale) / 2;
    let y =
      height -
      recipe.marginPt -
      (row + 1) * cellHeight -
      row * recipe.gapPt +
      (cellHeight - naturalHeight * scale) / 2;
    const target = output.getPage(output.getPageCount() - 1);
    // Clip in output coordinates; all crops share one decoded source XObject.
    target.pushOperators(
      pushGraphicsState(),
      rectangle(x, y, naturalWidth * scale, naturalHeight * scale),
      clip(),
      endPath(),
    );
    // PDF /Rotate is clockwise, whereas drawPage rotates counterclockwise.
    if (rotation === 90) y += crop.width * scale;
    if (rotation === 180) {
      x += crop.width * scale;
      y += crop.height * scale;
    }
    if (rotation === 270) x += crop.height * scale;
    const radians = (-rotation * Math.PI) / 180;
    const dx = (crop.x - media.x) * scale;
    const dy = (crop.y - media.y) * scale;
    x -= dx * Math.cos(radians) - dy * Math.sin(radians);
    y -= dx * Math.sin(radians) + dy * Math.cos(radians);
    target.drawPage(embedded, {
      x,
      y,
      xScale: scale,
      yScale: scale,
      rotate: degrees(-rotation),
    });
    target.pushOperators(popGraphicsState());
  }
  output.setProducer('ZPLPDF');
  const buffer = Buffer.from(await output.save());
  if (buffer.length > 20 * 1024 * 1024)
    throw new PayloadTooLargeException('PDF_OUTPUT_MAX_20_MB');
  return {
    buffer,
    pageCount: output.getPageCount(),
    labelCount: recipe.selections.length,
    paperWidthPt: width,
    paperHeightPt: height,
  };
}
