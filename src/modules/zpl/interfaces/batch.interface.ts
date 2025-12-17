export type BatchStatus = 'processing' | 'completed' | 'partial' | 'failed';
export type BatchFileStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface BatchFileJob {
  jobId: string;
  fileId: string;
  fileName: string;
  status: BatchFileStatus;
  progress: number;
  error?: string;
  tempStoragePath?: string;
}

export interface BatchJob {
  id: string;
  userId: string;
  status: BatchStatus;
  totalFiles: number;
  completedFiles: number;
  failedFiles: number;
  outputFormat: 'pdf' | 'png' | 'jpeg';
  labelSize: string;
  jobs: BatchFileJob[];
  downloadUrl?: string;
  zipFilename?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface BatchLimits {
  batchAllowed: boolean;
  maxFilesPerBatch: number;
  maxFileSizeBytes: number;
}

export const BATCH_LIMITS: Record<string, BatchLimits> = {
  free: {
    batchAllowed: false,
    maxFilesPerBatch: 0,
    maxFileSizeBytes: 0,
  },
  pro: {
    batchAllowed: true,
    maxFilesPerBatch: 10,
    maxFileSizeBytes: 5 * 1024 * 1024, // 5MB
  },
  enterprise: {
    batchAllowed: true,
    maxFilesPerBatch: 50,
    maxFileSizeBytes: 10 * 1024 * 1024, // 10MB
  },
};
