export interface ConversionHistory {
  userId: string;
  jobId: string;
  labelCount: number;
  labelSize: string;
  status: 'completed' | 'failed';
  outputFormat: 'pdf' | 'png' | 'jpeg';
  fileUrl?: string;
  createdAt: Date;
}
