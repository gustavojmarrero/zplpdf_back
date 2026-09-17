export interface PdfSelection {
  page: number;
  /** PDF points, bottom-left origin, in the unrotated media box. */
  crop?: { x: number; y: number; width: number; height: number };
  rotation: 0 | 90 | 180 | 270;
}
export interface PdfRecipe {
  selections: PdfSelection[];
  paper: '4x6' | 'a4' | 'letter';
  columns: number;
  rows: number;
  marginPt: number;
  gapPt: number;
  scale: 'fit' | 'actual';
}
