/**
 * Interfaces para el sistema de cola con prioridad de Labelary
 */

import { LabelSize } from '../enums/label-size.enum.js';

export type QueuePriority = 'high' | 'normal';
export type QueueItemStatus = 'queued' | 'processing' | 'completed' | 'failed';
export type UserPlan = 'free' | 'pro' | 'enterprise';

export interface QueueItem {
  id: string;
  jobId: string;
  userId: string;
  userPlan: UserPlan;
  priority: QueuePriority;
  zplBatch: string;
  labelSize: LabelSize;
  labelCount: number;
  createdAt: Date;
  attempts: number;
  lastAttemptAt?: Date;
  status: QueueItemStatus;
  resolve?: (value: Buffer) => void;
  reject?: (error: Error) => void;
}

export interface SlotAllocation {
  proEnterpriseSlots: number;
  freeSlots: number;
  activeProEnterprise: number;
  activeFree: number;
}

export interface QueuePositionResponse {
  jobId: string;
  status: QueueItemStatus | 'not_found';
  position: number | null;
  estimatedWaitSeconds: number;
  queueLength: {
    pro: number;
    free: number;
  };
}

export interface QueueStats {
  totalQueued: number;
  totalProcessing: number;
  proQueued: number;
  freeQueued: number;
  slotsActive: {
    proEnterprise: number;
    free: number;
  };
  slotsTotal: {
    proEnterprise: number;
    free: number;
  };
}

export const SLOT_CONFIG: SlotAllocation = {
  proEnterpriseSlots: 2,
  freeSlots: 1,
  activeProEnterprise: 0,
  activeFree: 0,
};

export const QUEUE_CONFIG = {
  minTimeBetweenCallsMs: 1000, // 1 segundo entre llamadas
  maxRetries: 3,
  baseDelayMs: 2000,
  maxDelayMs: 30000,
  estimatedSecondsPerJob: 2,
};
