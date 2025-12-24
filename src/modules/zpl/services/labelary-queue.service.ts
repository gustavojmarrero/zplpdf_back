import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import {
  QueueItem,
  QueueItemStatus,
  QueuePriority,
  QueuePositionResponse,
  QueueStats,
  UserPlan,
  SLOT_CONFIG,
  QUEUE_CONFIG,
} from '../interfaces/queue.interface.js';
import { LabelaryAnalyticsService } from './labelary-analytics.service.js';
import { LabelSize } from '../enums/label-size.enum.js';
import { v4 as uuidv4 } from 'uuid';

interface PendingRequest {
  item: QueueItem;
  resolve: (value: Buffer) => void;
  reject: (error: Error) => void;
}

@Injectable()
export class LabelaryQueueService {
  private readonly logger = new Logger(LabelaryQueueService.name);

  // Colas separadas por prioridad
  private highPriorityQueue: PendingRequest[] = [];
  private normalPriorityQueue: PendingRequest[] = [];

  // Items en procesamiento
  private processing: Map<string, QueueItem> = new Map();

  // Configuración de slots
  private slots = {
    proEnterpriseSlots: SLOT_CONFIG.proEnterpriseSlots,
    freeSlots: SLOT_CONFIG.freeSlots,
    activeProEnterprise: 0,
    activeFree: 0,
  };

  // Rate limiting global
  private lastCallTime = 0;
  private isProcessing = false;

  constructor(
    private readonly labelaryAnalyticsService: LabelaryAnalyticsService,
  ) {
    this.logger.log(
      `LabelaryQueueService inicializado: ${this.slots.proEnterpriseSlots} slots Pro, ${this.slots.freeSlots} slots Free`,
    );
  }

  /**
   * Encola una solicitud a Labelary y retorna una promesa
   */
  async enqueue(
    jobId: string,
    userId: string,
    userPlan: UserPlan,
    zplBatch: string,
    labelSize: LabelSize,
    labelCount: number,
  ): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const priority: QueuePriority = userPlan === 'free' ? 'normal' : 'high';

      const item: QueueItem = {
        id: uuidv4(),
        jobId,
        userId,
        userPlan,
        priority,
        zplBatch,
        labelSize,
        labelCount,
        createdAt: new Date(),
        attempts: 0,
        status: 'queued',
      };

      const pendingRequest: PendingRequest = { item, resolve, reject };

      // Agregar a la cola correspondiente
      if (priority === 'high') {
        this.highPriorityQueue.push(pendingRequest);
        this.logger.debug(
          `Job ${jobId} encolado en cola Pro/Enterprise (pos: ${this.highPriorityQueue.length})`,
        );
      } else {
        this.normalPriorityQueue.push(pendingRequest);
        this.logger.debug(
          `Job ${jobId} encolado en cola Free (pos: ${this.normalPriorityQueue.length})`,
        );
      }

      // Disparar procesamiento
      this.processQueue();
    });
  }

  /**
   * Procesa la cola respetando slots reservados
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    try {
      while (this.hasAvailableSlots() && this.hasItemsInQueue()) {
        const request = this.getNextRequest();

        if (!request) {
          break;
        }

        // Marcar slot como ocupado
        this.occupySlot(request.item);

        // Procesar en background (no await aquí para permitir concurrencia)
        this.processItem(request).catch((error) => {
          this.logger.error(`Error processing item: ${error.message}`);
        });

        // Rate limit: esperar entre despachos
        await this.waitForRateLimit();
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Verifica si hay slots disponibles para algún tipo
   */
  private hasAvailableSlots(): boolean {
    const canProcessHigh =
      this.slots.activeProEnterprise < this.slots.proEnterpriseSlots;
    const canProcessNormal = this.slots.activeFree < this.slots.freeSlots;
    return canProcessHigh || canProcessNormal;
  }

  /**
   * Verifica si hay items en las colas
   */
  private hasItemsInQueue(): boolean {
    return (
      this.highPriorityQueue.length > 0 || this.normalPriorityQueue.length > 0
    );
  }

  /**
   * Obtiene el siguiente request a procesar respetando slots
   */
  private getNextRequest(): PendingRequest | null {
    const canProcessHigh =
      this.slots.activeProEnterprise < this.slots.proEnterpriseSlots;
    const canProcessNormal = this.slots.activeFree < this.slots.freeSlots;

    // Primero intentar Pro/Enterprise si hay slot y hay items
    if (canProcessHigh && this.highPriorityQueue.length > 0) {
      return this.highPriorityQueue.shift()!;
    }

    // Luego intentar Free si hay slot y hay items
    if (canProcessNormal && this.normalPriorityQueue.length > 0) {
      return this.normalPriorityQueue.shift()!;
    }

    return null;
  }

  /**
   * Marca un slot como ocupado
   */
  private occupySlot(item: QueueItem): void {
    item.status = 'processing';
    this.processing.set(item.id, item);

    if (item.priority === 'high') {
      this.slots.activeProEnterprise++;
    } else {
      this.slots.activeFree++;
    }

    this.logger.debug(
      `Slot ocupado: Pro=${this.slots.activeProEnterprise}/${this.slots.proEnterpriseSlots}, Free=${this.slots.activeFree}/${this.slots.freeSlots}`,
    );
  }

  /**
   * Libera un slot
   */
  private releaseSlot(item: QueueItem): void {
    this.processing.delete(item.id);

    if (item.priority === 'high') {
      this.slots.activeProEnterprise = Math.max(
        0,
        this.slots.activeProEnterprise - 1,
      );
    } else {
      this.slots.activeFree = Math.max(0, this.slots.activeFree - 1);
    }

    this.logger.debug(
      `Slot liberado: Pro=${this.slots.activeProEnterprise}/${this.slots.proEnterpriseSlots}, Free=${this.slots.activeFree}/${this.slots.freeSlots}`,
    );
  }

  /**
   * Espera para respetar el rate limit global
   */
  private async waitForRateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastCall = now - this.lastCallTime;
    const waitTime = QUEUE_CONFIG.minTimeBetweenCallsMs - timeSinceLastCall;

    if (waitTime > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    this.lastCallTime = Date.now();
  }

  /**
   * Calcula delay con backoff exponencial + jitter
   */
  private calculateBackoff(attempt: number): number {
    const exponentialDelay =
      QUEUE_CONFIG.baseDelayMs * Math.pow(2, attempt - 1);
    const jitter = Math.random() * 1000; // 0-1000ms de jitter
    return Math.min(exponentialDelay + jitter, QUEUE_CONFIG.maxDelayMs);
  }

  /**
   * Procesa un item individual con reintentos
   */
  private async processItem(request: PendingRequest): Promise<void> {
    const { item, resolve, reject } = request;
    const startTime = Date.now();

    try {
      item.attempts++;
      item.lastAttemptAt = new Date();

      const result = await this.callLabelaryInternal(item);

      // Trackear éxito
      const responseTime = Date.now() - startTime;
      await this.labelaryAnalyticsService.trackSuccess(
        responseTime,
        item.labelCount,
      );

      // Liberar slot y resolver promesa
      item.status = 'completed';
      this.releaseSlot(item);
      resolve(result);

      // Continuar procesando cola
      this.processQueue();
    } catch (error: any) {
      const responseTime = Date.now() - startTime;

      if (error.response?.status === 429) {
        // Rate limit - trackear y reintentar
        await this.labelaryAnalyticsService.trackRateLimit(responseTime);

        if (item.attempts < QUEUE_CONFIG.maxRetries) {
          const delay = this.calculateBackoff(item.attempts);
          this.logger.warn(
            `Rate limit en job ${item.jobId}, reintento ${item.attempts}/${QUEUE_CONFIG.maxRetries} en ${Math.round(delay)}ms`,
          );

          // Liberar slot temporalmente
          this.releaseSlot(item);
          item.status = 'queued';

          // Re-encolar después del delay
          setTimeout(() => {
            if (item.priority === 'high') {
              this.highPriorityQueue.unshift(request); // Al frente
            } else {
              this.normalPriorityQueue.unshift(request); // Al frente
            }
            this.processQueue();
          }, delay);

          return; // No rechazar aún
        }
      }

      // Error final o error no-429
      await this.labelaryAnalyticsService.trackError(responseTime, error.message);
      item.status = 'failed';
      this.releaseSlot(item);
      reject(error);

      // Continuar procesando cola
      this.processQueue();
    }
  }

  /**
   * Llamada HTTP a Labelary API
   */
  private async callLabelaryInternal(item: QueueItem): Promise<Buffer> {
    const url = `http://api.labelary.com/v1/printers/8dpmm/labels/${item.labelSize}`;

    const response = await axios.post(url, item.zplBatch, {
      headers: {
        Accept: 'application/pdf',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      responseType: 'arraybuffer',
      timeout: 60000, // 60 segundos timeout
    });

    return Buffer.from(response.data);
  }

  /**
   * Obtiene la posición en cola de un job
   */
  getQueuePosition(jobId: string): QueuePositionResponse {
    // Buscar en processing
    for (const item of this.processing.values()) {
      if (item.jobId === jobId) {
        return {
          jobId,
          status: 'processing',
          position: null,
          estimatedWaitSeconds: 0,
          queueLength: {
            pro: this.highPriorityQueue.length,
            free: this.normalPriorityQueue.length,
          },
        };
      }
    }

    // Buscar en cola high priority
    const highIndex = this.highPriorityQueue.findIndex(
      (r) => r.item.jobId === jobId,
    );
    if (highIndex !== -1) {
      return {
        jobId,
        status: 'queued',
        position: highIndex + 1,
        estimatedWaitSeconds:
          (highIndex + 1) * QUEUE_CONFIG.estimatedSecondsPerJob,
        queueLength: {
          pro: this.highPriorityQueue.length,
          free: this.normalPriorityQueue.length,
        },
      };
    }

    // Buscar en cola normal priority
    const normalIndex = this.normalPriorityQueue.findIndex(
      (r) => r.item.jobId === jobId,
    );
    if (normalIndex !== -1) {
      return {
        jobId,
        status: 'queued',
        position: normalIndex + 1,
        estimatedWaitSeconds:
          (normalIndex + 1) * QUEUE_CONFIG.estimatedSecondsPerJob,
        queueLength: {
          pro: this.highPriorityQueue.length,
          free: this.normalPriorityQueue.length,
        },
      };
    }

    // No encontrado
    return {
      jobId,
      status: 'not_found',
      position: null,
      estimatedWaitSeconds: 0,
      queueLength: {
        pro: this.highPriorityQueue.length,
        free: this.normalPriorityQueue.length,
      },
    };
  }

  /**
   * Obtiene estadísticas de la cola
   */
  getQueueStats(): QueueStats {
    return {
      totalQueued:
        this.highPriorityQueue.length + this.normalPriorityQueue.length,
      totalProcessing: this.processing.size,
      proQueued: this.highPriorityQueue.length,
      freeQueued: this.normalPriorityQueue.length,
      slotsActive: {
        proEnterprise: this.slots.activeProEnterprise,
        free: this.slots.activeFree,
      },
      slotsTotal: {
        proEnterprise: this.slots.proEnterpriseSlots,
        free: this.slots.freeSlots,
      },
    };
  }

  /**
   * Solicitud directa de PNG para previews (respeta rate limit)
   * Este método es más simple y no usa el sistema de colas completo
   */
  async enqueuePngDirect(
    zplContent: string,
    labelSize: LabelSize,
  ): Promise<Buffer> {
    const startTime = Date.now();

    try {
      // Respetar rate limit global
      await this.waitForRateLimit();

      const url = `http://api.labelary.com/v1/printers/8dpmm/labels/${labelSize}/0/`;

      const response = await axios.post(url, zplContent, {
        headers: {
          Accept: 'image/png',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        responseType: 'arraybuffer',
        timeout: 30000, // 30 segundos timeout para una sola etiqueta
      });

      // Trackear éxito
      const responseTime = Date.now() - startTime;
      await this.labelaryAnalyticsService.trackSuccess(responseTime, 1);

      return Buffer.from(response.data);
    } catch (error: any) {
      const responseTime = Date.now() - startTime;

      if (error.response?.status === 429) {
        await this.labelaryAnalyticsService.trackRateLimit(responseTime);
        throw new Error(`Rate limit excedido: ${error.message}`);
      }

      await this.labelaryAnalyticsService.trackError(
        responseTime,
        error.message,
      );
      throw new Error(`Error al obtener imagen de Labelary API: ${error.message}`);
    }
  }
}
