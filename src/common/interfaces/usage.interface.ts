export interface Usage {
  odId: string;
  userId: string;
  periodStart: Date;
  periodEnd: Date;
  pdfCount: number;
  reservedPdfCount?: number;
  labelCount: number;
}
