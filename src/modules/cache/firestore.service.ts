import { Injectable, Logger } from '@nestjs/common';
import { Firestore } from '@google-cloud/firestore';
import { ConfigService } from '@nestjs/config';
import { DEFAULT_PLAN_LIMITS } from '../../common/interfaces/user.interface.js';
import type { User, PlanType } from '../../common/interfaces/user.interface.js';
import type { Usage } from '../../common/interfaces/usage.interface.js';
import type { ConversionHistory } from '../../common/interfaces/conversion-history.interface.js';
import type { BatchJob } from '../zpl/interfaces/batch.interface.js';
import type { HourlyLabelaryStats } from '../zpl/interfaces/labelary-analytics.interface.js';
import { getStartOfDayInTimezone, getDateStringInTimezone } from '../../utils/timezone.util.js';
import type {
  ExchangeRate,
  StripeTransaction,
  Expense,
  MonthlyGoal,
  SubscriptionEvent,
} from '../../common/interfaces/finance.interface.js';
import { ErrorIdGenerator } from '../../common/utils/error-id-generator.js';

// ============== Daily Stats (Aggregated Metrics) ==============

export interface DailyStats {
  date: string; // "2025-12-20" (YYYY-MM-DD)
  totalConversions: number;
  totalLabels: number;
  totalPdfs: number;
  activeUserIds: string[]; // Unique users who converted that day
  errorCount: number;
  successCount: number;
  failureCount: number;
  conversionsByPlan: {
    free: { pdfs: number; labels: number };
    pro: { pdfs: number; labels: number };
    enterprise: { pdfs: number; labels: number };
  };
}

export interface GlobalTotals {
  pdfsTotal: number;
  labelsTotal: number;
  lastUpdated: Date;
}

// ============== Admin Interfaces ==============

export type ErrorStatus = 'open' | 'investigating' | 'resolved' | 'dismissed';
export type ErrorSource = 'frontend' | 'backend' | 'system';

export interface ErrorLogData {
  type: string;
  code: string;
  message: string;
  userId?: string;
  userEmail?: string;
  jobId?: string;
  severity: 'error' | 'warning' | 'critical';
  context?: Record<string, any>;
  // New fields for error management
  errorId?: string; // ERR-YYYYMMDD-XXXXX (auto-generated)
  status?: ErrorStatus;
  notes?: string;
  resolvedAt?: Date;
  source?: ErrorSource;
  userAgent?: string;
  url?: string;
  stackTrace?: string;
}

export interface ErrorLog extends ErrorLogData {
  id: string;
  errorId: string;
  status: ErrorStatus;
  source: ErrorSource;
  createdAt: Date;
  updatedAt?: Date;
}

export interface AdminAuditLogData {
  adminEmail: string;
  adminUid: string;
  action: string;
  endpoint: string;
  ipAddress?: string;
  userAgent?: string;
  requestParams?: Record<string, any>;
}

export interface AdminAuditLog extends AdminAuditLogData {
  id: string;
  createdAt: Date;
}

export interface ErrorFilters {
  page?: number;
  limit?: number;
  severity?: string;
  type?: string;
  startDate?: Date;
  endDate?: Date;
  userId?: string;
  // New filters
  status?: ErrorStatus;
  source?: ErrorSource;
  errorId?: string;
}

export interface PaginatedErrors {
  errors: ErrorLog[];
  summary: {
    total: number;
    bySeverity: Record<string, number>;
    byType: Record<string, number>;
    byStatus: Record<string, number>;
    bySource: Record<string, number>;
  };
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface UserFilters {
  page?: number;
  limit?: number;
  plan?: string;
  search?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  dateFrom?: Date;
  dateTo?: Date;
}

export interface PaginatedUsers {
  users: Array<{
    id: string;
    email: string;
    displayName?: string;
    plan: string;
    usage: {
      pdfCount: number;
      labelCount: number;
    };
    createdAt: Date;
    lastActiveAt?: Date;
  }>;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface ConversionStatus {
  status: 'pending' | 'processing' | 'completed' | 'error';
  progress: number;
  userId?: string;
  resultUrl?: string;
  filename?: string;
  zplContent?: string;
  labelSize?: string;
  outputFormat?: string;
  zplHash?: string;
  createdAt: string;
  updatedAt: string;
  errorMessage?: string;
}

@Injectable()
export class FirestoreService {
  private firestore: Firestore;
  private readonly logger = new Logger(FirestoreService.name);
  private readonly collectionName = 'zpl-conversions';
  private readonly usersCollection = 'users';
  private readonly usageCollection = 'usage';
  private readonly historyCollection = 'conversion_history';
  // Finance collections
  private readonly exchangeRatesCollection = 'exchange_rates';
  private readonly transactionsCollection = 'stripe_transactions';
  private readonly expensesCollection = 'expenses';
  private readonly goalsCollection = 'monthly_goals';
  private readonly subscriptionEventsCollection = 'subscription_events';

  constructor(private configService: ConfigService) {
    let credentials: any = null;

    // Cargar credenciales desde variable de entorno FIREBASE_CREDENTIALS
    const firebaseCredentials = this.configService.get<string>('FIREBASE_CREDENTIALS');
    if (firebaseCredentials) {
      try {
        credentials = JSON.parse(firebaseCredentials);
        // Convertir \n literales a saltos de línea reales en la private_key
        if (credentials.private_key) {
          // Verificar si tiene \n literales (como string "\\n") o ya son saltos de línea
          const hasLiteralNewlines = credentials.private_key.includes('\\n');
          const hasRealNewlines = credentials.private_key.includes('\n');
          this.logger.debug(`Private key: hasLiteralNewlines=${hasLiteralNewlines}, hasRealNewlines=${hasRealNewlines}`);

          if (hasLiteralNewlines) {
            credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
            this.logger.debug('Converted literal \\n to real newlines');
          }
        }
        this.logger.log('Loaded Firebase credentials from environment variable');
      } catch (error) {
        this.logger.error('Error parsing FIREBASE_CREDENTIALS:', error);
      }
    }

    // Inicializar Firestore
    // Si hay credenciales, usarlas; si no, usar ADC (Application Default Credentials)
    const firestoreOptions: any = {};
    if (credentials) {
      firestoreOptions.credentials = credentials;
      firestoreOptions.projectId = credentials.project_id;
    }

    this.firestore = new Firestore(firestoreOptions);

    // Log para diagnóstico
    const projectId = credentials?.project_id || 'default (ADC)';
    this.logger.log(`Firestore initialized with project: ${projectId}`);
  }

  // ============== ZPL Conversions (existing) ==============

  async saveConversionStatus(
    jobId: string,
    status: ConversionStatus,
  ): Promise<void> {
    try {
      await this.firestore
        .collection(this.collectionName)
        .doc(jobId)
        .set(status, { merge: true });

      this.logger.log(`Estado de conversion actualizado para jobId: ${jobId}`);
    } catch (error) {
      this.logger.error(`Error al guardar estado: ${error.message}`);
      throw error;
    }
  }

  async getConversionStatus(jobId: string): Promise<ConversionStatus | null> {
    try {
      const doc = await this.firestore
        .collection(this.collectionName)
        .doc(jobId)
        .get();

      if (!doc.exists) {
        return null;
      }

      return doc.data() as ConversionStatus;
    } catch (error) {
      this.logger.error(`Error al obtener estado: ${error.message}`);
      throw error;
    }
  }

  async updateConversionStatus(
    jobId: string,
    status: Partial<ConversionStatus>,
  ): Promise<void> {
    try {
      await this.firestore
        .collection(this.collectionName)
        .doc(jobId)
        .update({
          ...status,
          updatedAt: new Date().toISOString(),
        });

      this.logger.log(`Estado actualizado para jobId: ${jobId}`);
    } catch (error) {
      this.logger.error(`Error al actualizar estado: ${error.message}`);
      throw error;
    }
  }

  // ============== Users ==============

  async createUser(user: User): Promise<void> {
    try {
      await this.firestore
        .collection(this.usersCollection)
        .doc(user.id)
        .set({
          ...user,
          createdAt: user.createdAt || new Date(),
          updatedAt: new Date(),
        });
      this.logger.log(`Usuario creado: ${user.id}`);
    } catch (error) {
      this.logger.error(`Error al crear usuario: ${error.message}`);
      throw error;
    }
  }

  async getUserById(userId: string): Promise<User | null> {
    try {
      const doc = await this.firestore
        .collection(this.usersCollection)
        .doc(userId)
        .get();

      if (!doc.exists) {
        return null;
      }

      const data = doc.data();
      return {
        ...data,
        createdAt: data.createdAt?.toDate?.() || data.createdAt,
        updatedAt: data.updatedAt?.toDate?.() || data.updatedAt,
        simulationExpiresAt: data.simulationExpiresAt?.toDate?.() || data.simulationExpiresAt,
      } as User;
    } catch (error) {
      this.logger.error(`Error al obtener usuario: ${error.message}`);
      throw error;
    }
  }

  async updateUser(userId: string, data: Partial<User>): Promise<void> {
    try {
      await this.firestore
        .collection(this.usersCollection)
        .doc(userId)
        .update({
          ...data,
          updatedAt: new Date(),
        });
      this.logger.log(`Usuario actualizado: ${userId}`);
    } catch (error) {
      this.logger.error(`Error al actualizar usuario: ${error.message}`);
      throw error;
    }
  }

  async getUserByStripeCustomerId(customerId: string): Promise<User | null> {
    try {
      const snapshot = await this.firestore
        .collection(this.usersCollection)
        .where('stripeCustomerId', '==', customerId)
        .limit(1)
        .get();

      if (snapshot.empty) {
        return null;
      }

      const doc = snapshot.docs[0];
      const data = doc.data();
      return {
        ...data,
        id: doc.id,
        createdAt: data.createdAt?.toDate?.() || data.createdAt,
        updatedAt: data.updatedAt?.toDate?.() || data.updatedAt,
      } as User;
    } catch (error) {
      this.logger.error(
        `Error al buscar usuario por Stripe customer: ${error.message}`,
      );
      throw error;
    }
  }

  // ============== Usage ==============

  private generateUsageId(userId: string, date: Date = new Date()): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${userId}_${year}${month}`;
  }

  private createNewUsagePeriod(userId: string): Usage {
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    return {
      odId: this.generateUsageId(userId, now),
      userId,
      periodStart,
      periodEnd,
      pdfCount: 0,
      labelCount: 0,
    };
  }

  async getOrCreateUsage(userId: string): Promise<Usage> {
    try {
      const usageId = this.generateUsageId(userId);
      const doc = await this.firestore
        .collection(this.usageCollection)
        .doc(usageId)
        .get();

      if (doc.exists) {
        const data = doc.data();
        return {
          ...data,
          periodStart: data.periodStart?.toDate?.() || data.periodStart,
          periodEnd: data.periodEnd?.toDate?.() || data.periodEnd,
        } as Usage;
      }

      // Create new usage period
      const newUsage = this.createNewUsagePeriod(userId);
      await this.firestore
        .collection(this.usageCollection)
        .doc(usageId)
        .set(newUsage);

      this.logger.log(`Nuevo periodo de uso creado para usuario: ${userId}`);
      return newUsage;
    } catch (error) {
      this.logger.error(`Error al obtener/crear uso: ${error.message}`);
      throw error;
    }
  }

  async incrementUsage(
    userId: string,
    pdfCount: number,
    labelCount: number,
  ): Promise<void> {
    try {
      const usageId = this.generateUsageId(userId);
      const docRef = this.firestore.collection(this.usageCollection).doc(usageId);
      const doc = await docRef.get();

      if (!doc.exists) {
        // Create new usage period with initial counts
        const newUsage = this.createNewUsagePeriod(userId);
        newUsage.pdfCount = pdfCount;
        newUsage.labelCount = labelCount;
        await docRef.set(newUsage);
      } else {
        // Increment existing counts
        await docRef.update({
          pdfCount: (doc.data().pdfCount || 0) + pdfCount,
          labelCount: (doc.data().labelCount || 0) + labelCount,
        });
      }

      this.logger.log(`Uso incrementado para usuario: ${userId}`);
    } catch (error) {
      this.logger.error(`Error al incrementar uso: ${error.message}`);
      throw error;
    }
  }

  async resetExpiredUsage(): Promise<number> {
    try {
      const now = new Date();
      const snapshot = await this.firestore
        .collection(this.usageCollection)
        .where('periodEnd', '<', now)
        .get();

      let resetCount = 0;

      for (const doc of snapshot.docs) {
        const data = doc.data();
        const newUsage = this.createNewUsagePeriod(data.userId);

        await this.firestore
          .collection(this.usageCollection)
          .doc(newUsage.odId)
          .set(newUsage);

        resetCount++;
      }

      this.logger.log(`Reset de uso completado. Usuarios reseteados: ${resetCount}`);
      return resetCount;
    } catch (error) {
      this.logger.error(`Error al resetear uso: ${error.message}`);
      throw error;
    }
  }

  // ============== Usage con Período Calculado ==============

  /**
   * Obtiene o crea un documento de uso usando un período calculado externamente
   * (por PeriodCalculatorService)
   */
  async getOrCreateUsageWithPeriod(
    userId: string,
    periodInfo: { periodStart: Date; periodEnd: Date; periodId: string },
  ): Promise<Usage> {
    try {
      const docRef = this.firestore.collection(this.usageCollection).doc(periodInfo.periodId);
      const doc = await docRef.get();

      if (doc.exists) {
        const data = doc.data();
        return {
          ...data,
          periodStart: data.periodStart?.toDate?.() || data.periodStart,
          periodEnd: data.periodEnd?.toDate?.() || data.periodEnd,
        } as Usage;
      }

      // Crear nuevo período de uso
      const newUsage: Usage = {
        odId: periodInfo.periodId,
        userId,
        periodStart: periodInfo.periodStart,
        periodEnd: periodInfo.periodEnd,
        pdfCount: 0,
        labelCount: 0,
      };

      await docRef.set(newUsage);
      this.logger.log(`Nuevo periodo de uso creado para usuario: ${userId} (${periodInfo.periodId})`);
      return newUsage;
    } catch (error) {
      this.logger.error(`Error al obtener/crear uso con período: ${error.message}`);
      throw error;
    }
  }

  /**
   * Incrementa contadores de uso usando el periodId calculado externamente
   */
  async incrementUsageWithPeriod(
    userId: string,
    periodId: string,
    pdfCount: number,
    labelCount: number,
  ): Promise<void> {
    try {
      const docRef = this.firestore.collection(this.usageCollection).doc(periodId);
      const doc = await docRef.get();

      if (doc.exists) {
        await docRef.update({
          pdfCount: (doc.data().pdfCount || 0) + pdfCount,
          labelCount: (doc.data().labelCount || 0) + labelCount,
        });
        this.logger.log(`Uso incrementado para usuario: ${userId} (${periodId})`);
      } else {
        this.logger.warn(`Documento de uso no encontrado: ${periodId}`);
      }
    } catch (error) {
      this.logger.error(`Error al incrementar uso con período: ${error.message}`);
      throw error;
    }
  }

  /**
   * Obtiene todos los usos expirados (para CRON)
   */
  async getExpiredUsages(beforeDate: Date): Promise<Usage[]> {
    try {
      const snapshot = await this.firestore
        .collection(this.usageCollection)
        .where('periodEnd', '<', beforeDate)
        .get();

      return snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          ...data,
          periodStart: data.periodStart?.toDate?.() || data.periodStart,
          periodEnd: data.periodEnd?.toDate?.() || data.periodEnd,
        } as Usage;
      });
    } catch (error) {
      this.logger.error(`Error al obtener usos expirados: ${error.message}`);
      throw error;
    }
  }

  // ============== Conversion History ==============

  async saveConversionHistory(history: ConversionHistory): Promise<void> {
    try {
      await this.firestore.collection(this.historyCollection).add({
        ...history,
        createdAt: history.createdAt || new Date(),
      });
      this.logger.log(`Historial guardado para usuario: ${history.userId}`);
    } catch (error) {
      this.logger.error(`Error al guardar historial: ${error.message}`);
      throw error;
    }
  }

  async getUserConversionHistory(
    userId: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<ConversionHistory[]> {
    try {
      const snapshot = await this.firestore
        .collection(this.historyCollection)
        .where('userId', '==', userId)
        .orderBy('createdAt', 'desc')
        .limit(limit)
        .offset(offset)
        .get();

      return snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          ...data,
          createdAt: data.createdAt?.toDate?.() || data.createdAt,
        } as ConversionHistory;
      });
    } catch (error) {
      this.logger.error(`Error al obtener historial: ${error.message}`);
      throw error;
    }
  }

  // ============== Database Access ==============

  /**
   * Obtiene la instancia de Firestore para operaciones personalizadas
   */
  getDb(): Firestore {
    return this.firestore;
  }

  // ============== Enterprise Contacts ==============

  async saveEnterpriseContact(contact: {
    companyName: string;
    contactName: string;
    email: string;
    phone?: string;
    estimatedLabelsPerMonth: number;
    message?: string;
  }): Promise<void> {
    try {
      await this.firestore.collection('enterprise_contacts').add({
        ...contact,
        createdAt: new Date(),
        status: 'pending',
      });
      this.logger.log(`Contacto enterprise guardado: ${contact.email}`);
    } catch (error) {
      this.logger.error(`Error al guardar contacto enterprise: ${error.message}`);
      throw error;
    }
  }

  // ============== Daily Stats (Aggregated Metrics) ==============

  private readonly dailyStatsCollection = 'daily_stats';
  private readonly globalTotalsDoc = 'global_totals/totals';

  /**
   * Increment daily stats atomically when a conversion is completed
   */
  async incrementDailyStats(
    userId: string,
    userPlan: 'free' | 'pro' | 'enterprise',
    pdfCount: number,
    labelCount: number,
    status: 'completed' | 'failed',
  ): Promise<void> {
    try {
      const dateKey = getDateStringInTimezone(new Date());
      const docRef = this.firestore.collection(this.dailyStatsCollection).doc(dateKey);
      const globalRef = this.firestore.doc(this.globalTotalsDoc);

      await this.firestore.runTransaction(async (transaction) => {
        const doc = await transaction.get(docRef);
        const globalDoc = await transaction.get(globalRef);

        if (doc.exists) {
          const data = doc.data() as DailyStats;
          const activeUserIds = data.activeUserIds.includes(userId)
            ? data.activeUserIds
            : [...data.activeUserIds, userId];

          transaction.update(docRef, {
            totalConversions: data.totalConversions + 1,
            totalLabels: data.totalLabels + labelCount,
            totalPdfs: data.totalPdfs + pdfCount,
            activeUserIds,
            successCount: status === 'completed' ? data.successCount + 1 : data.successCount,
            failureCount: status === 'failed' ? data.failureCount + 1 : data.failureCount,
            [`conversionsByPlan.${userPlan}.pdfs`]: (data.conversionsByPlan[userPlan]?.pdfs || 0) + pdfCount,
            [`conversionsByPlan.${userPlan}.labels`]: (data.conversionsByPlan[userPlan]?.labels || 0) + labelCount,
          });
        } else {
          const newStats: DailyStats = {
            date: dateKey,
            totalConversions: 1,
            totalLabels: labelCount,
            totalPdfs: pdfCount,
            activeUserIds: [userId],
            errorCount: 0,
            successCount: status === 'completed' ? 1 : 0,
            failureCount: status === 'failed' ? 1 : 0,
            conversionsByPlan: {
              free: { pdfs: 0, labels: 0 },
              pro: { pdfs: 0, labels: 0 },
              enterprise: { pdfs: 0, labels: 0 },
            },
          };
          newStats.conversionsByPlan[userPlan] = { pdfs: pdfCount, labels: labelCount };
          transaction.set(docRef, newStats);
        }

        // Update global totals
        if (status === 'completed') {
          if (globalDoc.exists) {
            const globalData = globalDoc.data() as GlobalTotals;
            transaction.update(globalRef, {
              pdfsTotal: globalData.pdfsTotal + pdfCount,
              labelsTotal: globalData.labelsTotal + labelCount,
              lastUpdated: new Date(),
            });
          } else {
            transaction.set(globalRef, {
              pdfsTotal: pdfCount,
              labelsTotal: labelCount,
              lastUpdated: new Date(),
            });
          }
        }
      });

      this.logger.debug(`Daily stats updated for ${dateKey}`);
    } catch (error) {
      this.logger.error(`Error updating daily stats: ${error.message}`);
      // Don't throw - this is a fire-and-forget operation
    }
  }

  /**
   * Increment error count in daily stats
   */
  async incrementDailyErrorCount(): Promise<void> {
    try {
      const dateKey = getDateStringInTimezone(new Date());
      const docRef = this.firestore.collection(this.dailyStatsCollection).doc(dateKey);

      await this.firestore.runTransaction(async (transaction) => {
        const doc = await transaction.get(docRef);

        if (doc.exists) {
          transaction.update(docRef, {
            errorCount: (doc.data().errorCount || 0) + 1,
          });
        } else {
          const newStats: DailyStats = {
            date: dateKey,
            totalConversions: 0,
            totalLabels: 0,
            totalPdfs: 0,
            activeUserIds: [],
            errorCount: 1,
            successCount: 0,
            failureCount: 0,
            conversionsByPlan: {
              free: { pdfs: 0, labels: 0 },
              pro: { pdfs: 0, labels: 0 },
              enterprise: { pdfs: 0, labels: 0 },
            },
          };
          transaction.set(docRef, newStats);
        }
      });
    } catch (error) {
      this.logger.error(`Error incrementing daily error count: ${error.message}`);
    }
  }

  /**
   * Get daily stats for a specific date
   */
  async getDailyStats(date: string): Promise<DailyStats | null> {
    try {
      const doc = await this.firestore.collection(this.dailyStatsCollection).doc(date).get();
      return doc.exists ? (doc.data() as DailyStats) : null;
    } catch (error) {
      this.logger.error(`Error getting daily stats: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get daily stats for a date range
   */
  async getDailyStatsRange(startDate: string, endDate: string): Promise<DailyStats[]> {
    try {
      const snapshot = await this.firestore
        .collection(this.dailyStatsCollection)
        .where('date', '>=', startDate)
        .where('date', '<=', endDate)
        .orderBy('date', 'asc')
        .get();

      return snapshot.docs.map((doc) => doc.data() as DailyStats);
    } catch (error) {
      this.logger.error(`Error getting daily stats range: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get global totals (all-time cumulative)
   */
  async getGlobalTotals(): Promise<GlobalTotals> {
    try {
      const doc = await this.firestore.doc(this.globalTotalsDoc).get();
      if (doc.exists) {
        const data = doc.data();
        return {
          pdfsTotal: data.pdfsTotal || 0,
          labelsTotal: data.labelsTotal || 0,
          lastUpdated: data.lastUpdated?.toDate?.() || data.lastUpdated,
        };
      }
      return { pdfsTotal: 0, labelsTotal: 0, lastUpdated: new Date() };
    } catch (error) {
      this.logger.error(`Error getting global totals: ${error.message}`);
      throw error;
    }
  }

  /**
   * Set global totals (for migration)
   */
  async setGlobalTotals(totals: GlobalTotals): Promise<void> {
    try {
      await this.firestore.doc(this.globalTotalsDoc).set(totals);
      this.logger.log('Global totals updated');
    } catch (error) {
      this.logger.error(`Error setting global totals: ${error.message}`);
      throw error;
    }
  }

  // ============== Batch Processing ==============

  private readonly batchCollection = 'zpl-batches';
  private readonly errorLogsCollection = 'error_logs';
  private readonly adminAuditCollection = 'admin_audit_log';

  async saveBatchJob(batch: BatchJob): Promise<void> {
    try {
      await this.firestore
        .collection(this.batchCollection)
        .doc(batch.id)
        .set({
          ...batch,
          createdAt: batch.createdAt || new Date(),
          updatedAt: new Date(),
        });
      this.logger.log(`Batch guardado: ${batch.id}`);
    } catch (error) {
      this.logger.error(`Error al guardar batch: ${error.message}`);
      throw error;
    }
  }

  async getBatchJob(batchId: string): Promise<BatchJob | null> {
    try {
      const doc = await this.firestore
        .collection(this.batchCollection)
        .doc(batchId)
        .get();

      if (!doc.exists) {
        return null;
      }

      const data = doc.data();
      return {
        ...data,
        createdAt: data.createdAt?.toDate?.() || data.createdAt,
        updatedAt: data.updatedAt?.toDate?.() || data.updatedAt,
      } as BatchJob;
    } catch (error) {
      this.logger.error(`Error al obtener batch: ${error.message}`);
      throw error;
    }
  }

  async updateBatchJob(batchId: string, data: Partial<BatchJob>): Promise<void> {
    try {
      await this.firestore
        .collection(this.batchCollection)
        .doc(batchId)
        .update({
          ...data,
          updatedAt: new Date(),
        });
      this.logger.log(`Batch actualizado: ${batchId}`);
    } catch (error) {
      this.logger.error(`Error al actualizar batch: ${error.message}`);
      throw error;
    }
  }

  // ============== Admin: Error Logs ==============

  /**
   * Saves an error log with auto-generated errorId
   * @param errorData Error data to save
   * @returns The generated errorId (ERR-YYYYMMDD-XXXXX) or null if failed
   */
  async saveErrorLog(errorData: ErrorLogData): Promise<string | null> {
    try {
      const errorId = errorData.errorId || ErrorIdGenerator.generate();
      const now = new Date();

      await this.firestore.collection(this.errorLogsCollection).add({
        ...errorData,
        errorId,
        status: errorData.status || 'open',
        source: errorData.source || 'backend',
        createdAt: now,
        updatedAt: now,
      });

      this.logger.debug(`Error log guardado: ${errorData.code} (${errorId})`);
      return errorId;
    } catch (error) {
      this.logger.error(`Error al guardar error log: ${error.message}`);
      // No lanzar error para no interrumpir el flujo principal
      return null;
    }
  }

  async getErrorLogs(filters: ErrorFilters): Promise<PaginatedErrors> {
    try {
      const {
        page = 1,
        limit = 100,
        severity,
        type,
        startDate,
        endDate,
        userId,
        status,
        source,
        errorId,
      } = filters;

      // Query base: solo orderBy para evitar necesidad de índices compuestos
      let query: FirebaseFirestore.Query = this.firestore
        .collection(this.errorLogsCollection)
        .orderBy('createdAt', 'desc');

      // Filtros de fecha funcionan con orderBy sin índice adicional
      if (startDate) {
        query = query.where('createdAt', '>=', startDate);
      }
      if (endDate) {
        query = query.where('createdAt', '<=', endDate);
      }

      // Traer todos los documentos para filtrar en memoria
      const snapshot = await query.get();

      // Mapear documentos a ErrorLog
      let allErrors: ErrorLog[] = snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          ...data,
          errorId: data.errorId || doc.id,
          status: data.status || 'open',
          source: data.source || 'backend',
          createdAt: data.createdAt?.toDate?.() || data.createdAt,
          updatedAt: data.updatedAt?.toDate?.() || data.updatedAt,
          resolvedAt: data.resolvedAt?.toDate?.() || data.resolvedAt,
        } as ErrorLog;
      });

      // Filtrar en memoria para evitar queries compuestas que requieren índices
      if (errorId) {
        allErrors = allErrors.filter((e) => e.errorId === errorId);
      }
      if (severity) {
        allErrors = allErrors.filter((e) => e.severity === severity);
      }
      if (type) {
        allErrors = allErrors.filter((e) => e.type === type);
      }
      if (userId) {
        allErrors = allErrors.filter((e) => e.userId === userId);
      }
      if (status) {
        allErrors = allErrors.filter((e) => e.status === status);
      }
      if (source) {
        allErrors = allErrors.filter((e) => e.source === source);
      }

      // Total después de filtrar
      const total = allErrors.length;

      // Aplicar paginación
      const offset = (page - 1) * limit;
      const errors = allErrors.slice(offset, offset + limit);

      // Calculate summary from all docs (not filtered)
      const bySeverity: Record<string, number> = {};
      const byType: Record<string, number> = {};
      const byStatus: Record<string, number> = {};
      const bySource: Record<string, number> = {};

      snapshot.docs.forEach((doc) => {
        const data = doc.data();
        bySeverity[data.severity] = (bySeverity[data.severity] || 0) + 1;
        byType[data.type] = (byType[data.type] || 0) + 1;
        const docStatus = data.status || 'open';
        const docSource = data.source || 'backend';
        byStatus[docStatus] = (byStatus[docStatus] || 0) + 1;
        bySource[docSource] = (bySource[docSource] || 0) + 1;
      });

      return {
        errors,
        summary: {
          total,
          bySeverity,
          byType,
          byStatus,
          bySource,
        },
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      this.logger.error(`Error al obtener error logs: ${error.message}`);
      throw error;
    }
  }

  async getErrorStats(): Promise<{
    recentErrors: ErrorLog[];
    byType: Record<string, number>;
    criticalCount: number;
  }> {
    try {
      // Get recent errors (last 24 hours)
      const yesterday = new Date();
      yesterday.setHours(yesterday.getHours() - 24);

      const recentSnapshot = await this.firestore
        .collection(this.errorLogsCollection)
        .where('createdAt', '>=', yesterday)
        .orderBy('createdAt', 'desc')
        .limit(10)
        .get();

      const recentErrors: ErrorLog[] = recentSnapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          ...data,
          createdAt: data.createdAt?.toDate?.() || data.createdAt,
        } as ErrorLog;
      });

      // Get all error stats
      const allErrorsSnapshot = await this.firestore
        .collection(this.errorLogsCollection)
        .get();

      const byType: Record<string, number> = {};
      let criticalCount = 0;

      allErrorsSnapshot.docs.forEach((doc) => {
        const data = doc.data();
        byType[data.type] = (byType[data.type] || 0) + 1;
        if (data.severity === 'critical') {
          criticalCount++;
        }
      });

      return { recentErrors, byType, criticalCount };
    } catch (error) {
      this.logger.error(`Error al obtener stats de errores: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get error by document ID or errorId (ERR-YYYYMMDD-XXXXX)
   */
  async getErrorById(id: string): Promise<ErrorLog | null> {
    try {
      // If starts with ERR-, search by errorId field
      if (id.startsWith('ERR-')) {
        const snapshot = await this.firestore
          .collection(this.errorLogsCollection)
          .where('errorId', '==', id)
          .limit(1)
          .get();

        if (snapshot.empty) return null;

        const doc = snapshot.docs[0];
        const data = doc.data();
        return {
          id: doc.id,
          ...data,
          errorId: data.errorId || doc.id,
          status: data.status || 'open',
          source: data.source || 'backend',
          createdAt: data.createdAt?.toDate?.() || data.createdAt,
          updatedAt: data.updatedAt?.toDate?.() || data.updatedAt,
          resolvedAt: data.resolvedAt?.toDate?.() || data.resolvedAt,
        } as ErrorLog;
      }

      // Otherwise, search by document ID
      const doc = await this.firestore.collection(this.errorLogsCollection).doc(id).get();

      if (!doc.exists) return null;

      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        errorId: data.errorId || doc.id,
        status: data.status || 'open',
        source: data.source || 'backend',
        createdAt: data.createdAt?.toDate?.() || data.createdAt,
        updatedAt: data.updatedAt?.toDate?.() || data.updatedAt,
        resolvedAt: data.resolvedAt?.toDate?.() || data.resolvedAt,
      } as ErrorLog;
    } catch (error) {
      this.logger.error(`Error al obtener error por ID: ${error.message}`);
      throw error;
    }
  }

  /**
   * Update error status/notes
   */
  async updateErrorLog(
    id: string,
    data: {
      status?: ErrorStatus;
      notes?: string;
    },
  ): Promise<ErrorLog | null> {
    try {
      // First find the error (by doc ID or errorId)
      const error = await this.getErrorById(id);
      if (!error) return null;

      const updateData: Record<string, any> = {
        updatedAt: new Date(),
      };

      if (data.status !== undefined) {
        updateData.status = data.status;
        // Set resolvedAt when status changes to resolved
        if (data.status === 'resolved') {
          updateData.resolvedAt = new Date();
        }
      }

      if (data.notes !== undefined) {
        updateData.notes = data.notes;
      }

      await this.firestore.collection(this.errorLogsCollection).doc(error.id).update(updateData);

      // Return updated error
      return await this.getErrorById(error.id);
    } catch (error) {
      this.logger.error(`Error al actualizar error log: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get detailed error statistics for admin dashboard
   */
  async getDetailedErrorStats(days: number = 30): Promise<{
    total: number;
    byStatus: Record<string, number>;
    bySeverity: Record<string, number>;
    byType: Record<string, number>;
    bySource: Record<string, number>;
    last24Hours: number;
    last7Days: number;
    last30Days: number;
    trend: Array<{ date: string; count: number }>;
  }> {
    try {
      const now = new Date();
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);

      const snapshot = await this.firestore
        .collection(this.errorLogsCollection)
        .where('createdAt', '>=', cutoffDate)
        .get();

      const byStatus: Record<string, number> = {};
      const bySeverity: Record<string, number> = {};
      const byType: Record<string, number> = {};
      const bySource: Record<string, number> = {};
      const trendMap: Record<string, number> = {};

      let last24Hours = 0;
      let last7Days = 0;
      let last30Days = 0;

      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      snapshot.docs.forEach((doc) => {
        const data = doc.data();
        const createdAt = data.createdAt?.toDate?.() || data.createdAt;

        // Count by status
        const status = data.status || 'open';
        byStatus[status] = (byStatus[status] || 0) + 1;

        // Count by severity
        bySeverity[data.severity] = (bySeverity[data.severity] || 0) + 1;

        // Count by type
        byType[data.type] = (byType[data.type] || 0) + 1;

        // Count by source
        const source = data.source || 'backend';
        bySource[source] = (bySource[source] || 0) + 1;

        // Time-based counts
        if (createdAt >= oneDayAgo) last24Hours++;
        if (createdAt >= sevenDaysAgo) last7Days++;
        last30Days++;

        // Trend by date
        const dateKey = createdAt.toISOString().slice(0, 10);
        trendMap[dateKey] = (trendMap[dateKey] || 0) + 1;
      });

      // Convert trend map to sorted array
      const trend = Object.entries(trendMap)
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date));

      return {
        total: snapshot.size,
        byStatus,
        bySeverity,
        byType,
        bySource,
        last24Hours,
        last7Days,
        last30Days,
        trend,
      };
    } catch (error) {
      this.logger.error(`Error al obtener stats detalladas de errores: ${error.message}`);
      throw error;
    }
  }

  /**
   * Delete errors older than specified date (for cleanup cron)
   * @returns Number of deleted errors
   */
  async deleteOldErrors(beforeDate: Date): Promise<number> {
    try {
      const snapshot = await this.firestore
        .collection(this.errorLogsCollection)
        .where('createdAt', '<', beforeDate)
        .get();

      if (snapshot.empty) {
        this.logger.log('No hay errores antiguos para eliminar');
        return 0;
      }

      // Delete in batches of 500 (Firestore limit)
      const batchSize = 500;
      let deletedCount = 0;

      for (let i = 0; i < snapshot.docs.length; i += batchSize) {
        const batch = this.firestore.batch();
        const chunk = snapshot.docs.slice(i, i + batchSize);

        chunk.forEach((doc) => {
          batch.delete(doc.ref);
        });

        await batch.commit();
        deletedCount += chunk.length;
      }

      this.logger.log(`Eliminados ${deletedCount} errores anteriores a ${beforeDate.toISOString()}`);
      return deletedCount;
    } catch (error) {
      this.logger.error(`Error al eliminar errores antiguos: ${error.message}`);
      throw error;
    }
  }

  // ============== Admin: Audit Log ==============

  async saveAdminAuditLog(logData: AdminAuditLogData): Promise<void> {
    try {
      await this.firestore.collection(this.adminAuditCollection).add({
        ...logData,
        createdAt: new Date(),
      });
      this.logger.debug(`Admin audit log: ${logData.adminEmail} - ${logData.action}`);
    } catch (error) {
      this.logger.error(`Error al guardar admin audit log: ${error.message}`);
      // No lanzar error para no interrumpir el flujo
    }
  }

  async getPlanChanges(filters: {
    page?: number;
    limit?: number;
    userId?: string;
    startDate?: Date;
    endDate?: Date;
  }): Promise<{
    changes: Array<{
      userId: string;
      userEmail: string;
      previousPlan: string;
      newPlan: string;
      changedAt: Date;
      reason: 'upgrade' | 'downgrade' | 'admin_change';
      changedBy?: string;
    }>;
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  }> {
    try {
      const { page = 1, limit = 20, userId, startDate, endDate } = filters;

      let query: FirebaseFirestore.Query = this.firestore
        .collection(this.adminAuditCollection)
        .where('action', '==', 'update_user_plan');

      if (startDate) {
        query = query.where('createdAt', '>=', startDate);
      }
      if (endDate) {
        query = query.where('createdAt', '<=', endDate);
      }

      query = query.orderBy('createdAt', 'desc');

      // Get all matching documents (we'll filter by userId in memory if needed)
      const snapshot = await query.get();

      // Filter by userId if provided (Firestore doesn't support nested field queries well)
      let filteredDocs = snapshot.docs;
      if (userId) {
        filteredDocs = snapshot.docs.filter((doc) => {
          const data = doc.data();
          return data.requestParams?.userId === userId;
        });
      }

      const total = filteredDocs.length;

      // Apply pagination
      const offset = (page - 1) * limit;
      const paginatedDocs = filteredDocs.slice(offset, offset + limit);

      // Collect unique user IDs for batch lookup
      const userIds = [...new Set(paginatedDocs.map((doc) => doc.data().requestParams?.userId).filter(Boolean))];

      // Batch read users
      const userDataMap: Record<string, { email: string }> = {};
      if (userIds.length > 0) {
        const userRefs = userIds.map((id) =>
          this.firestore.collection(this.usersCollection).doc(id),
        );
        const userDocs = await this.firestore.getAll(...userRefs);
        userDocs.forEach((doc) => {
          if (doc.exists) {
            const data = doc.data();
            userDataMap[doc.id] = { email: data.email || 'unknown' };
          }
        });
      }

      // Map changes
      const changes = paginatedDocs.map((doc) => {
        const data = doc.data();
        const params = data.requestParams || {};
        const createdAt = data.createdAt?.toDate?.() || new Date(data.createdAt);

        // Determine reason
        let reason: 'upgrade' | 'downgrade' | 'admin_change' = 'admin_change';
        if (params.reason) {
          reason = params.reason;
        } else {
          const planOrder: Record<string, number> = { free: 0, pro: 1, enterprise: 2 };
          const prevOrder = planOrder[params.previousPlan] ?? 0;
          const newOrder = planOrder[params.newPlan] ?? 0;
          if (newOrder > prevOrder) {
            reason = 'upgrade';
          } else if (newOrder < prevOrder) {
            reason = 'downgrade';
          }
        }

        return {
          userId: params.userId,
          userEmail: userDataMap[params.userId]?.email || 'unknown',
          previousPlan: params.previousPlan,
          newPlan: params.newPlan,
          changedAt: createdAt,
          reason,
          changedBy: data.adminEmail,
        };
      });

      return {
        changes,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      this.logger.error(`Error al obtener cambios de plan: ${error.message}`);
      throw error;
    }
  }

  // ============== Admin: User Metrics ==============

  async getUsersCount(): Promise<number> {
    try {
      // Count total users and subtract admins
      const [totalSnapshot, adminSnapshot] = await Promise.all([
        this.firestore.collection(this.usersCollection).count().get(),
        this.firestore
          .collection(this.usersCollection)
          .where('role', '==', 'admin')
          .count()
          .get(),
      ]);
      return totalSnapshot.data().count - adminSnapshot.data().count;
    } catch (error) {
      this.logger.error(`Error al contar usuarios: ${error.message}`);
      throw error;
    }
  }

  async getUsersByPlan(): Promise<{ free: number; pro: number; enterprise: number }> {
    try {
      // Count users by plan and subtract admins from each plan
      const [freeCount, proCount, enterpriseCount, freeAdminCount, proAdminCount, enterpriseAdminCount] = await Promise.all([
        this.firestore
          .collection(this.usersCollection)
          .where('plan', '==', 'free')
          .count()
          .get(),
        this.firestore
          .collection(this.usersCollection)
          .where('plan', '==', 'pro')
          .count()
          .get(),
        this.firestore
          .collection(this.usersCollection)
          .where('plan', '==', 'enterprise')
          .count()
          .get(),
        // Count admins by plan to subtract
        this.firestore
          .collection(this.usersCollection)
          .where('plan', '==', 'free')
          .where('role', '==', 'admin')
          .count()
          .get(),
        this.firestore
          .collection(this.usersCollection)
          .where('plan', '==', 'pro')
          .where('role', '==', 'admin')
          .count()
          .get(),
        this.firestore
          .collection(this.usersCollection)
          .where('plan', '==', 'enterprise')
          .where('role', '==', 'admin')
          .count()
          .get(),
      ]);

      return {
        free: freeCount.data().count - freeAdminCount.data().count,
        pro: proCount.data().count - proAdminCount.data().count,
        enterprise: enterpriseCount.data().count - enterpriseAdminCount.data().count,
      };
    } catch (error) {
      this.logger.error(`Error al obtener usuarios por plan: ${error.message}`);
      throw error;
    }
  }

  async getActiveUsers(period: 'day' | 'week' | 'month'): Promise<number> {
    try {
      const now = new Date();
      let days: number;

      switch (period) {
        case 'day':
          days = 1;
          break;
        case 'week':
          days = 7;
          break;
        case 'month':
          days = 30;
          break;
      }

      // Use daily_stats instead of scanning conversion_history
      const endDate = getDateStringInTimezone(now);
      const startDateObj = new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
      const startDate = getDateStringInTimezone(startDateObj);

      // Get daily stats and admin user IDs in parallel
      const [dailyStats, adminSnapshot] = await Promise.all([
        this.getDailyStatsRange(startDate, endDate),
        this.firestore
          .collection(this.usersCollection)
          .where('role', '==', 'admin')
          .select()
          .get(),
      ]);

      // Get admin user IDs to exclude
      const adminIds = new Set(adminSnapshot.docs.map((doc) => doc.id));

      // Collect unique users across all days, excluding admins
      const uniqueUsers = new Set<string>();
      dailyStats.forEach((day) => {
        day.activeUserIds?.forEach((userId) => {
          if (!adminIds.has(userId)) {
            uniqueUsers.add(userId);
          }
        });
      });

      return uniqueUsers.size;
    } catch (error) {
      this.logger.error(`Error al obtener usuarios activos: ${error.message}`);
      throw error;
    }
  }

  async getRecentRegistrations(limit: number = 10): Promise<User[]> {
    try {
      // Fetch more than needed to account for admin users being filtered out
      const snapshot = await this.firestore
        .collection(this.usersCollection)
        .orderBy('createdAt', 'desc')
        .limit(limit * 2)
        .get();

      const users = snapshot.docs
        .map((doc) => {
          const data = doc.data();
          return {
            id: doc.id,
            ...data,
            createdAt: data.createdAt?.toDate?.() || data.createdAt,
            updatedAt: data.updatedAt?.toDate?.() || data.updatedAt,
          } as User;
        })
        // Exclude admin users from metrics
        .filter((user) => user.role !== 'admin');

      return users.slice(0, limit);
    } catch (error) {
      this.logger.error(`Error al obtener registros recientes: ${error.message}`);
      throw error;
    }
  }

  async getUsersPaginated(filters: UserFilters): Promise<PaginatedUsers> {
    try {
      const { page = 1, limit = 50, plan, search, sortBy = 'createdAt', sortOrder = 'desc', dateFrom, dateTo } = filters;

      // Fields that exist in Firestore users collection
      const firestoreFields = ['createdAt', 'email', 'displayName', 'plan'];
      const canSortInFirestore = firestoreFields.includes(sortBy);

      let query: FirebaseFirestore.Query = this.firestore.collection(this.usersCollection);

      if (plan) {
        query = query.where('plan', '==', plan);
      }

      // Filter by registration date
      if (dateFrom) {
        query = query.where('createdAt', '>=', dateFrom);
      }
      if (dateTo) {
        query = query.where('createdAt', '<=', dateTo);
      }

      // Only sort in Firestore if the field exists there
      if (canSortInFirestore) {
        query = query.orderBy(sortBy, sortOrder);
      } else {
        // Default sort for Firestore, we'll re-sort in memory later
        query = query.orderBy('createdAt', 'desc');
      }

      // Get total count (without sort-dependent fields), excluding admins
      let countQuery: FirebaseFirestore.Query = this.firestore.collection(this.usersCollection);
      let countQueryAdmins: FirebaseFirestore.Query = this.firestore.collection(this.usersCollection);
      if (plan) {
        countQuery = countQuery.where('plan', '==', plan);
        countQueryAdmins = countQueryAdmins.where('plan', '==', plan);
      }
      if (dateFrom) {
        countQuery = countQuery.where('createdAt', '>=', dateFrom);
        countQueryAdmins = countQueryAdmins.where('createdAt', '>=', dateFrom);
      }
      if (dateTo) {
        countQuery = countQuery.where('createdAt', '<=', dateTo);
        countQueryAdmins = countQueryAdmins.where('createdAt', '<=', dateTo);
      }
      countQueryAdmins = countQueryAdmins.where('role', '==', 'admin');
      const [countSnapshot, adminCountSnapshot] = await Promise.all([
        countQuery.count().get(),
        countQueryAdmins.count().get(),
      ]);
      const total = countSnapshot.data().count - adminCountSnapshot.data().count;

      // For pdfCount/lastActiveAt sorting, we need to fetch all users and sort in memory
      // For Firestore-sortable fields, use pagination
      let snapshot;
      if (canSortInFirestore && !search) {
        const offset = (page - 1) * limit;
        snapshot = await query.offset(offset).limit(limit).get();
      } else {
        // Fetch all for in-memory sorting/filtering
        snapshot = await query.get();
      }

      // Get usage for each user
      const users = await Promise.all(
        snapshot.docs.map(async (doc) => {
          const userData = doc.data();
          const userId = doc.id;

          // Get current usage (will be recalculated in AdminService)
          let usage = { pdfCount: 0, labelCount: 0 };
          try {
            const usageDoc = await this.getOrCreateUsage(userId);
            usage = { pdfCount: usageDoc.pdfCount, labelCount: usageDoc.labelCount };
          } catch {
            // Ignore usage errors
          }

          // Get last activity
          let lastActiveAt: Date | undefined;
          try {
            const historySnapshot = await this.firestore
              .collection(this.historyCollection)
              .where('userId', '==', userId)
              .orderBy('createdAt', 'desc')
              .limit(1)
              .get();
            if (!historySnapshot.empty) {
              const historyData = historySnapshot.docs[0].data();
              lastActiveAt = historyData.createdAt?.toDate?.() || historyData.createdAt;
            }
          } catch {
            // Ignore history errors
          }

          // Exclude admin users from metrics
          if (userData.role === 'admin') {
            return null;
          }

          // Apply search filter in memory (Firestore doesn't support LIKE queries)
          if (search) {
            const searchLower = search.toLowerCase();
            const emailMatch = userData.email?.toLowerCase().includes(searchLower);
            const nameMatch = userData.displayName?.toLowerCase().includes(searchLower);
            if (!emailMatch && !nameMatch) {
              return null;
            }
          }

          return {
            id: userId,
            email: userData.email,
            displayName: userData.displayName,
            plan: userData.plan,
            usage,
            createdAt: userData.createdAt?.toDate?.() || userData.createdAt,
            lastActiveAt,
          };
        }),
      );

      // Filter out null values (from search filter and admin filter)
      let filteredUsers = users.filter((u) => u !== null);

      // Sort in memory if needed (pdfCount, lastActiveAt, or search was applied)
      if (!canSortInFirestore || search) {
        filteredUsers.sort((a, b) => {
          let aVal: any;
          let bVal: any;

          if (sortBy === 'pdfCount') {
            aVal = a.usage.pdfCount;
            bVal = b.usage.pdfCount;
          } else if (sortBy === 'lastActiveAt') {
            aVal = a.lastActiveAt ? new Date(a.lastActiveAt).getTime() : 0;
            bVal = b.lastActiveAt ? new Date(b.lastActiveAt).getTime() : 0;
          } else if (sortBy === 'createdAt') {
            aVal = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            bVal = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          } else {
            aVal = a[sortBy] || '';
            bVal = b[sortBy] || '';
          }

          if (sortOrder === 'asc') {
            return aVal > bVal ? 1 : aVal < bVal ? -1 : 0;
          } else {
            return aVal < bVal ? 1 : aVal > bVal ? -1 : 0;
          }
        });

        // Apply pagination in memory
        const offset = (page - 1) * limit;
        filteredUsers = filteredUsers.slice(offset, offset + limit);
      }

      return {
        users: filteredUsers,
        pagination: {
          page,
          limit,
          total: search ? users.filter((u) => u !== null).length : total,
          totalPages: Math.ceil((search ? users.filter((u) => u !== null).length : total) / limit),
        },
      };
    } catch (error) {
      this.logger.error(`Error al obtener usuarios paginados: ${error.message}`);
      throw error;
    }
  }

  async getUsersNearLimit(threshold: number = 80): Promise<Array<{
    id: string;
    email: string;
    plan: PlanType;
    pdfCount: number;
    pdfLimit: number;
    percentUsed: number;
    periodEnd: Date;
  }>> {
    try {
      // Get all current usage documents
      const usageSnapshot = await this.firestore.collection(this.usageCollection).get();

      // Batch read: obtener todos los usuarios únicos en una sola consulta
      const userIds = usageSnapshot.docs.map((doc) => doc.data().userId).filter(Boolean);
      const userDataMap: Record<string, any> = {};

      if (userIds.length > 0) {
        const userRefs = userIds.map((id) =>
          this.firestore.collection(this.usersCollection).doc(id),
        );
        const userDocs = await this.firestore.getAll(...userRefs);
        userDocs.forEach((doc) => {
          if (doc.exists) {
            userDataMap[doc.id] = doc.data();
          }
        });
      }

      const usersNearLimit: Array<{
        id: string;
        email: string;
        plan: PlanType;
        pdfCount: number;
        pdfLimit: number;
        percentUsed: number;
        periodEnd: Date;
      }> = [];

      // Procesar sin consultas adicionales
      for (const doc of usageSnapshot.docs) {
        const usageData = doc.data();
        const userId = usageData.userId;
        const userData = userDataMap[userId];

        if (!userData) continue;

        // Exclude admin users from metrics
        if (userData.role === 'admin') continue;

        const plan = userData.plan as PlanType;
        const planLimits = userData.planLimits || DEFAULT_PLAN_LIMITS[plan];
        const pdfLimit = planLimits?.maxPdfsPerMonth || DEFAULT_PLAN_LIMITS[plan].maxPdfsPerMonth;

        const percentUsed = (usageData.pdfCount / pdfLimit) * 100;

        if (percentUsed >= threshold) {
          usersNearLimit.push({
            id: userId,
            email: userData.email,
            plan,
            pdfCount: usageData.pdfCount,
            pdfLimit,
            percentUsed: Math.round(percentUsed),
            periodEnd: usageData.periodEnd?.toDate?.() || usageData.periodEnd,
          });
        }
      }

      // Sort by percentUsed descending
      usersNearLimit.sort((a, b) => b.percentUsed - a.percentUsed);

      return usersNearLimit.slice(0, 20); // Return top 20
    } catch (error) {
      this.logger.error(`Error al obtener usuarios cerca del límite: ${error.message}`);
      throw error;
    }
  }

  async getUsersNearLabelLimit(threshold: number = 80): Promise<Array<{
    id: string;
    email: string;
    plan: PlanType;
    labelCount: number;
    labelLimit: number;
    percentUsed: number;
    periodEnd: Date;
  }>> {
    try {
      // Get all current usage documents
      const usageSnapshot = await this.firestore.collection(this.usageCollection).get();

      // Batch read: get all unique users in a single query
      const userIds = usageSnapshot.docs.map((doc) => doc.data().userId).filter(Boolean);
      const userDataMap: Record<string, any> = {};

      if (userIds.length > 0) {
        const userRefs = userIds.map((id) =>
          this.firestore.collection(this.usersCollection).doc(id),
        );
        const userDocs = await this.firestore.getAll(...userRefs);
        userDocs.forEach((doc) => {
          if (doc.exists) {
            userDataMap[doc.id] = doc.data();
          }
        });
      }

      const usersNearLabelLimit: Array<{
        id: string;
        email: string;
        plan: PlanType;
        labelCount: number;
        labelLimit: number;
        percentUsed: number;
        periodEnd: Date;
      }> = [];

      // Process without additional queries
      for (const doc of usageSnapshot.docs) {
        const usageData = doc.data();
        const userId = usageData.userId;
        const userData = userDataMap[userId];

        if (!userData) continue;

        // Exclude admin users from metrics
        if (userData.role === 'admin') continue;

        const plan = userData.plan as PlanType;
        const planLimits = userData.planLimits || DEFAULT_PLAN_LIMITS[plan];

        // Calculate monthly label limit as maxPdfsPerMonth * maxLabelsPerPdf
        const maxPdfs = planLimits?.maxPdfsPerMonth || DEFAULT_PLAN_LIMITS[plan].maxPdfsPerMonth;
        const maxLabelsPerPdf = planLimits?.maxLabelsPerPdf || DEFAULT_PLAN_LIMITS[plan].maxLabelsPerPdf;
        const labelLimit = maxPdfs * maxLabelsPerPdf;

        // Skip enterprise users (unlimited)
        if (plan === 'enterprise') continue;

        const percentUsed = (usageData.labelCount / labelLimit) * 100;

        if (percentUsed >= threshold) {
          usersNearLabelLimit.push({
            id: userId,
            email: userData.email,
            plan,
            labelCount: usageData.labelCount,
            labelLimit,
            percentUsed: Math.round(percentUsed),
            periodEnd: usageData.periodEnd?.toDate?.() || usageData.periodEnd,
          });
        }
      }

      // Sort by percentUsed descending
      usersNearLabelLimit.sort((a, b) => b.percentUsed - a.percentUsed);

      return usersNearLabelLimit.slice(0, 20); // Return top 20
    } catch (error) {
      this.logger.error(`Error al obtener usuarios cerca del límite de etiquetas: ${error.message}`);
      throw error;
    }
  }

  async getLabelUsageDistribution(): Promise<{
    '0-25': number;
    '25-50': number;
    '50-75': number;
    '75-100': number;
  }> {
    try {
      // Get all current usage documents
      const usageSnapshot = await this.firestore.collection(this.usageCollection).get();

      // Batch read: get all unique users in a single query
      const userIds = usageSnapshot.docs.map((doc) => doc.data().userId).filter(Boolean);
      const userDataMap: Record<string, any> = {};

      if (userIds.length > 0) {
        const userRefs = userIds.map((id) =>
          this.firestore.collection(this.usersCollection).doc(id),
        );
        const userDocs = await this.firestore.getAll(...userRefs);
        userDocs.forEach((doc) => {
          if (doc.exists) {
            userDataMap[doc.id] = doc.data();
          }
        });
      }

      const distribution = {
        '0-25': 0,
        '25-50': 0,
        '50-75': 0,
        '75-100': 0,
      };

      // Process and categorize users
      for (const doc of usageSnapshot.docs) {
        const usageData = doc.data();
        const userId = usageData.userId;
        const userData = userDataMap[userId];

        if (!userData) continue;

        // Exclude admin users from metrics
        if (userData.role === 'admin') continue;

        const plan = userData.plan as PlanType;

        // Skip enterprise users (unlimited)
        if (plan === 'enterprise') continue;

        const planLimits = userData.planLimits || DEFAULT_PLAN_LIMITS[plan];
        const maxPdfs = planLimits?.maxPdfsPerMonth || DEFAULT_PLAN_LIMITS[plan].maxPdfsPerMonth;
        const maxLabelsPerPdf = planLimits?.maxLabelsPerPdf || DEFAULT_PLAN_LIMITS[plan].maxLabelsPerPdf;
        const labelLimit = maxPdfs * maxLabelsPerPdf;

        const percentUsed = (usageData.labelCount / labelLimit) * 100;

        if (percentUsed <= 25) {
          distribution['0-25']++;
        } else if (percentUsed <= 50) {
          distribution['25-50']++;
        } else if (percentUsed <= 75) {
          distribution['50-75']++;
        } else {
          distribution['75-100']++;
        }
      }

      return distribution;
    } catch (error) {
      this.logger.error(`Error al obtener distribución de uso de etiquetas: ${error.message}`);
      throw error;
    }
  }

  async getConsumptionProjection(): Promise<Array<{
    id: string;
    email: string;
    name: string;
    plan: PlanType;
    billingPeriodStart: Date;
    billingPeriodEnd: Date;
    planLimit: number;
    pdfsUsed: number;
    daysElapsed: number;
    dailyRate: number;
    projectedDaysToExhaust: number;
    status: 'critical' | 'risk' | 'normal';
  }>> {
    try {
      const now = new Date();

      // Get all current usage documents
      const usageSnapshot = await this.firestore.collection(this.usageCollection).get();

      // Batch read: get all unique users in a single query
      const userIds = usageSnapshot.docs.map((doc) => doc.data().userId).filter(Boolean);
      const userDataMap: Record<string, any> = {};

      if (userIds.length > 0) {
        const userRefs = userIds.map((id) =>
          this.firestore.collection(this.usersCollection).doc(id),
        );
        const userDocs = await this.firestore.getAll(...userRefs);
        userDocs.forEach((doc) => {
          if (doc.exists) {
            userDataMap[doc.id] = doc.data();
          }
        });
      }

      const projections: Array<{
        id: string;
        email: string;
        name: string;
        plan: PlanType;
        billingPeriodStart: Date;
        billingPeriodEnd: Date;
        planLimit: number;
        pdfsUsed: number;
        daysElapsed: number;
        dailyRate: number;
        projectedDaysToExhaust: number;
        status: 'critical' | 'risk' | 'normal';
      }> = [];

      for (const doc of usageSnapshot.docs) {
        const usageData = doc.data();
        const userId = usageData.userId;
        const userData = userDataMap[userId];

        if (!userData) continue;

        // Exclude admin users from metrics
        if (userData.role === 'admin') continue;

        const pdfsUsed = usageData.pdfCount || 0;

        // Only include users with activity (pdfsUsed > 0)
        if (pdfsUsed === 0) continue;

        const plan = userData.plan as PlanType;
        const planLimits = userData.planLimits || DEFAULT_PLAN_LIMITS[plan];
        const planLimit = planLimits?.maxPdfsPerMonth || DEFAULT_PLAN_LIMITS[plan].maxPdfsPerMonth;

        // Get period dates
        const periodStart = usageData.periodStart?.toDate?.() || new Date(usageData.periodStart);
        const periodEnd = usageData.periodEnd?.toDate?.() || new Date(usageData.periodEnd);

        // Calculate days elapsed (minimum 1 to avoid division by zero)
        const daysElapsed = Math.max(1, Math.ceil((now.getTime() - periodStart.getTime()) / (1000 * 60 * 60 * 24)));

        // Calculate daily rate
        const dailyRate = pdfsUsed / daysElapsed;

        // Calculate projected days to exhaust plan
        // If dailyRate is 0, set to Infinity (will never exhaust)
        const projectedDaysToExhaust = dailyRate > 0 ? Math.round((planLimit / dailyRate) * 10) / 10 : 999;

        // Determine status based on projected days
        let status: 'critical' | 'risk' | 'normal';
        if (projectedDaysToExhaust < 15) {
          status = 'critical';
        } else if (projectedDaysToExhaust < 24) {
          status = 'risk';
        } else {
          status = 'normal';
        }

        projections.push({
          id: userId,
          email: userData.email || 'unknown',
          name: userData.displayName || '',
          plan,
          billingPeriodStart: periodStart,
          billingPeriodEnd: periodEnd,
          planLimit,
          pdfsUsed,
          daysElapsed,
          dailyRate: Math.round(dailyRate * 100) / 100,
          projectedDaysToExhaust,
          status,
        });
      }

      // Sort by projectedDaysToExhaust ascending (most critical first)
      projections.sort((a, b) => a.projectedDaysToExhaust - b.projectedDaysToExhaust);

      return projections;
    } catch (error) {
      this.logger.error(`Error al obtener proyección de consumo: ${error.message}`);
      throw error;
    }
  }

  // ============== Admin: Conversion Metrics ==============

  async getConversionStats(
    period: 'day' | 'week' | 'month' = 'week',
    startDate?: Date,
    endDate?: Date,
  ): Promise<{
    summary: {
      totalPdfs: number;
      totalLabels: number;
      successCount: number;
      failureCount: number;
      avgLabelsPerPdf: number;
    };
    byPlan: Record<string, { pdfs: number; labels: number }>;
  }> {
    try {
      const now = new Date();
      let days: number;

      if (startDate && endDate) {
        days = Math.ceil((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
      } else {
        switch (period) {
          case 'day':
            days = 1;
            break;
          case 'week':
            days = 7;
            break;
          case 'month':
            days = 30;
            break;
        }
      }

      // Use daily_stats instead of scanning conversion_history
      const endDateStr = getDateStringInTimezone(endDate || now);
      const startDateObj = startDate || new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
      const startDateStr = getDateStringInTimezone(startDateObj);

      const dailyStats = await this.getDailyStatsRange(startDateStr, endDateStr);

      // Aggregate from daily stats
      let totalPdfs = 0;
      let totalLabels = 0;
      let successCount = 0;
      let failureCount = 0;
      const byPlan: Record<string, { pdfs: number; labels: number }> = {
        free: { pdfs: 0, labels: 0 },
        pro: { pdfs: 0, labels: 0 },
        enterprise: { pdfs: 0, labels: 0 },
      };

      dailyStats.forEach((day) => {
        totalPdfs += day.totalPdfs || 0;
        totalLabels += day.totalLabels || 0;
        successCount += day.successCount || 0;
        failureCount += day.failureCount || 0;

        // Aggregate by plan
        if (day.conversionsByPlan) {
          Object.entries(day.conversionsByPlan).forEach(([plan, stats]) => {
            if (byPlan[plan]) {
              byPlan[plan].pdfs += stats.pdfs || 0;
              byPlan[plan].labels += stats.labels || 0;
            }
          });
        }
      });

      return {
        summary: {
          totalPdfs,
          totalLabels,
          successCount,
          failureCount,
          avgLabelsPerPdf: totalPdfs > 0 ? Math.round((totalLabels / totalPdfs) * 10) / 10 : 0,
        },
        byPlan,
      };
    } catch (error) {
      this.logger.error(`Error al obtener estadísticas de conversiones: ${error.message}`);
      throw error;
    }
  }

  async getHistoricalTotals(): Promise<{ pdfsTotal: number; labelsTotal: number }> {
    try {
      // Use global_totals instead of scanning all conversion_history
      const totals = await this.getGlobalTotals();
      return {
        pdfsTotal: totals.pdfsTotal,
        labelsTotal: totals.labelsTotal,
      };
    } catch (error) {
      this.logger.error(`Error al obtener totales históricos: ${error.message}`);
      throw error;
    }
  }

  async getConversionTrend(days: number = 7): Promise<Array<{
    date: string;
    pdfs: number;
    labels: number;
    failures: number;
  }>> {
    try {
      const now = new Date();

      // Use daily_stats instead of scanning conversion_history
      const endDateStr = getDateStringInTimezone(now);
      const startDateObj = new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
      const startDateStr = getDateStringInTimezone(startDateObj);

      const dailyStats = await this.getDailyStatsRange(startDateStr, endDateStr);

      // Create a map for easy lookup
      const statsMap = new Map<string, DailyStats>();
      dailyStats.forEach((stat) => statsMap.set(stat.date, stat));

      // Build result array with all dates (fill missing with zeros)
      const result: Array<{ date: string; pdfs: number; labels: number; failures: number }> = [];
      for (let i = days - 1; i >= 0; i--) {
        const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
        const dateKey = getDateStringInTimezone(date);
        const stat = statsMap.get(dateKey);

        result.push({
          date: dateKey,
          pdfs: stat?.totalPdfs || 0,
          labels: stat?.totalLabels || 0,
          failures: stat?.failureCount || 0,
        });
      }

      return result;
    } catch (error) {
      this.logger.error(`Error al obtener tendencia de conversiones: ${error.message}`);
      throw error;
    }
  }

  async getTopUsers(limit: number = 10): Promise<Array<{
    id: string;
    email: string;
    plan: string;
    pdfs: number;
    labels: number;
  }>> {
    try {
      // Get conversions from last 7 days
      const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const snapshot = await this.firestore
        .collection(this.historyCollection)
        .where('createdAt', '>=', startDate)
        .get();

      // Aggregate by user
      const userStats: Record<string, { pdfs: number; labels: number }> = {};

      snapshot.docs.forEach((doc) => {
        const data = doc.data();
        const userId = data.userId;
        if (!userId) return;

        if (!userStats[userId]) {
          userStats[userId] = { pdfs: 0, labels: 0 };
        }
        userStats[userId].pdfs++;
        userStats[userId].labels += data.labelCount || 0;
      });

      // Sort by pdfs and get top users (fetch more to account for admin filtering)
      const sortedUsers = Object.entries(userStats)
        .sort(([, a], [, b]) => b.pdfs - a.pdfs)
        .slice(0, limit * 2);

      // Get user details, excluding admins
      const topUsers = (await Promise.all(
        sortedUsers.map(async ([userId, stats]) => {
          const userDoc = await this.firestore.collection(this.usersCollection).doc(userId).get();
          const userData = userDoc.exists ? userDoc.data() : { email: 'unknown', plan: 'free' };

          // Exclude admin users from metrics
          if (userData.role === 'admin') {
            return null;
          }

          return {
            id: userId,
            email: userData.email,
            plan: userData.plan,
            pdfs: stats.pdfs,
            labels: stats.labels,
          };
        }),
      )).filter((user) => user !== null);

      return topUsers.slice(0, limit);
    } catch (error) {
      this.logger.error(`Error al obtener top usuarios: ${error.message}`);
      throw error;
    }
  }

  // ============== Admin: Plan Usage Metrics ==============

  async getPlanDistribution(): Promise<{
    distribution: Record<string, { users: number; percentage: number }>;
    conversionRates: { freeTrialToPro: number; proToEnterprise: number };
  }> {
    try {
      const byPlan = await this.getUsersByPlan();
      const total = byPlan.free + byPlan.pro + byPlan.enterprise;

      const distribution = {
        free: { users: byPlan.free, percentage: total > 0 ? Math.round((byPlan.free / total) * 1000) / 10 : 0 },
        pro: { users: byPlan.pro, percentage: total > 0 ? Math.round((byPlan.pro / total) * 1000) / 10 : 0 },
        enterprise: { users: byPlan.enterprise, percentage: total > 0 ? Math.round((byPlan.enterprise / total) * 1000) / 10 : 0 },
      };

      // Calculate conversion rates (simplified - would need historical data for accurate rates)
      const freeTrialToPro = byPlan.free > 0 ? Math.round((byPlan.pro / (byPlan.free + byPlan.pro)) * 1000) / 10 : 0;
      const proToEnterprise = byPlan.pro > 0 ? Math.round((byPlan.enterprise / (byPlan.pro + byPlan.enterprise)) * 1000) / 10 : 0;

      return {
        distribution,
        conversionRates: { freeTrialToPro, proToEnterprise },
      };
    } catch (error) {
      this.logger.error(`Error al obtener distribución de planes: ${error.message}`);
      throw error;
    }
  }

  async getUpgradeOpportunities(): Promise<{
    freeToProCandidates: number;
    proToEnterpriseCandidates: number;
  }> {
    try {
      const usersNearLimit = await this.getUsersNearLimit(70);

      let freeToProCandidates = 0;
      let proToEnterpriseCandidates = 0;

      usersNearLimit.forEach((user) => {
        if (user.plan === 'free' && user.percentUsed >= 70) {
          freeToProCandidates++;
        } else if (user.plan === 'pro' && user.percentUsed >= 70) {
          proToEnterpriseCandidates++;
        }
      });

      return { freeToProCandidates, proToEnterpriseCandidates };
    } catch (error) {
      this.logger.error(`Error al obtener oportunidades de upgrade: ${error.message}`);
      throw error;
    }
  }

  // ============== Admin: User Usage History ==============

  async getUserUsageHistory(
    userId: string,
    days: number = 30,
  ): Promise<Array<{ date: string; pdfs: number; labels: number }>> {
    try {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      const snapshot = await this.firestore
        .collection(this.historyCollection)
        .where('userId', '==', userId)
        .where('createdAt', '>=', startDate)
        .orderBy('createdAt', 'desc')
        .get();

      // Initialize all dates with zeros using GMT-6 timezone
      const byDate: Record<string, { pdfs: number; labels: number }> = {};
      for (let i = 0; i < days; i++) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        // Use GMT-6 timezone for date key
        const dateKey = getDateStringInTimezone(date);
        byDate[dateKey] = { pdfs: 0, labels: 0 };
      }

      // Aggregate data by date using GMT-6 timezone
      snapshot.docs.forEach((doc) => {
        const data = doc.data();
        const createdAt = data.createdAt?.toDate?.() || new Date(data.createdAt);
        // Convert to GMT-6 date string
        const dateKey = getDateStringInTimezone(createdAt);

        if (byDate[dateKey]) {
          byDate[dateKey].pdfs++;
          byDate[dateKey].labels += data.labelCount || 0;
        }
      });

      // Convert to array and sort by date descending
      return Object.entries(byDate)
        .map(([date, stats]) => ({ date, ...stats }))
        .sort((a, b) => b.date.localeCompare(a.date));
    } catch (error) {
      this.logger.error(`Error al obtener historial de uso del usuario: ${error.message}`);
      throw error;
    }
  }

  // ============== Admin: Conversions List (Individual) ==============

  async getConversionsPaginated(filters: {
    page?: number;
    limit?: number;
    userId?: string;
    startDate?: Date;
    endDate?: Date;
    status?: 'completed' | 'failed';
  }): Promise<{
    conversions: Array<{
      id: string;
      userId: string;
      userEmail: string;
      createdAt: Date;
      labelCount: number;
      labelSize: string;
      status: 'completed' | 'failed';
      outputFormat: 'pdf' | 'png' | 'jpeg';
      fileUrl?: string;
    }>;
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  }> {
    try {
      const { page = 1, limit = 20, userId, startDate, endDate, status } = filters;

      let query: FirebaseFirestore.Query = this.firestore.collection(this.historyCollection);

      // Apply filters
      if (userId) {
        query = query.where('userId', '==', userId);
      }
      if (status) {
        query = query.where('status', '==', status);
      }
      if (startDate) {
        query = query.where('createdAt', '>=', startDate);
      }
      if (endDate) {
        query = query.where('createdAt', '<=', endDate);
      }

      query = query.orderBy('createdAt', 'desc');

      // Get total count
      const countSnapshot = await query.count().get();
      const total = countSnapshot.data().count;

      // Apply pagination
      const offset = (page - 1) * limit;
      const snapshot = await query.offset(offset).limit(limit).get();

      // Collect unique user IDs for batch user lookup
      const userIds = [...new Set(snapshot.docs.map((doc) => doc.data().userId).filter(Boolean))];

      // Batch read users
      const userDataMap: Record<string, { email: string }> = {};
      if (userIds.length > 0) {
        const userRefs = userIds.map((id) =>
          this.firestore.collection(this.usersCollection).doc(id),
        );
        const userDocs = await this.firestore.getAll(...userRefs);
        userDocs.forEach((doc) => {
          if (doc.exists) {
            const data = doc.data();
            userDataMap[doc.id] = { email: data.email || 'unknown' };
          }
        });
      }

      // Map conversions with user emails
      const conversions = snapshot.docs.map((doc) => {
        const data = doc.data();
        const createdAt = data.createdAt?.toDate?.() || new Date(data.createdAt);

        return {
          id: data.jobId || doc.id,
          userId: data.userId,
          userEmail: userDataMap[data.userId]?.email || 'unknown',
          createdAt,
          labelCount: data.labelCount || 0,
          labelSize: data.labelSize || 'unknown',
          status: data.status as 'completed' | 'failed',
          outputFormat: data.outputFormat as 'pdf' | 'png' | 'jpeg',
          fileUrl: data.fileUrl,
        };
      });

      return {
        conversions,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      this.logger.error(`Error al obtener conversiones paginadas: ${error.message}`);
      throw error;
    }
  }

  // ============== Labelary Hourly Stats ==============

  private readonly labelaryStatsCollection = 'labelary_hourly_stats';

  /**
   * Guarda o actualiza estadísticas por hora de Labelary
   * Usa transacción para hacer merge de datos existentes
   */
  async saveLabelaryHourlyStats(stats: HourlyLabelaryStats): Promise<void> {
    try {
      const docRef = this.firestore
        .collection(this.labelaryStatsCollection)
        .doc(stats.hourKey);

      await this.firestore.runTransaction(async (transaction) => {
        const doc = await transaction.get(docRef);

        if (doc.exists) {
          const existing = doc.data() as HourlyLabelaryStats;
          transaction.update(docRef, {
            totalCalls: existing.totalCalls + stats.totalCalls,
            successCount: existing.successCount + stats.successCount,
            errorCount: existing.errorCount + stats.errorCount,
            rateLimitHits: existing.rateLimitHits + stats.rateLimitHits,
            totalResponseTimeMs:
              existing.totalResponseTimeMs + stats.totalResponseTimeMs,
            minResponseTimeMs: Math.min(
              existing.minResponseTimeMs || Infinity,
              stats.minResponseTimeMs,
            ),
            maxResponseTimeMs: Math.max(
              existing.maxResponseTimeMs || 0,
              stats.maxResponseTimeMs,
            ),
            labelCount: existing.labelCount + stats.labelCount,
            uniqueLabelCount:
              (existing.uniqueLabelCount || 0) + (stats.uniqueLabelCount || 0),
            updatedAt: new Date(),
          });
        } else {
          transaction.set(docRef, {
            ...stats,
            updatedAt: new Date(),
          });
        }
      });

      this.logger.debug(`Labelary stats saved for hour: ${stats.hourKey}`);
    } catch (error) {
      this.logger.error(`Error saving Labelary hourly stats: ${error.message}`);
      throw error;
    }
  }

  /**
   * Obtiene estadísticas por hora en un rango de tiempo
   */
  async getLabelaryHourlyStatsRange(
    startHour: string,
    endHour: string,
  ): Promise<(HourlyLabelaryStats & { avgResponseTimeMs: number })[]> {
    try {
      const snapshot = await this.firestore
        .collection(this.labelaryStatsCollection)
        .where('hourKey', '>=', startHour)
        .where('hourKey', '<=', endHour)
        .orderBy('hourKey', 'asc')
        .get();

      return snapshot.docs.map((doc) => {
        const data = doc.data() as HourlyLabelaryStats;
        return {
          ...data,
          avgResponseTimeMs:
            data.totalCalls > 0
              ? Math.round(data.totalResponseTimeMs / data.totalCalls)
              : 0,
        };
      });
    } catch (error) {
      this.logger.error(`Error getting Labelary hourly stats: ${error.message}`);
      throw error;
    }
  }

  /**
   * Obtiene estadísticas de una hora específica
   */
  async getLabelaryHourlyStats(
    hourKey: string,
  ): Promise<(HourlyLabelaryStats & { avgResponseTimeMs: number }) | null> {
    try {
      const doc = await this.firestore
        .collection(this.labelaryStatsCollection)
        .doc(hourKey)
        .get();

      if (!doc.exists) {
        return null;
      }

      const data = doc.data() as HourlyLabelaryStats;
      return {
        ...data,
        avgResponseTimeMs:
          data.totalCalls > 0
            ? Math.round(data.totalResponseTimeMs / data.totalCalls)
            : 0,
      };
    } catch (error) {
      this.logger.error(`Error getting Labelary stats for ${hourKey}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Elimina estadísticas antiguas (más de N días)
   */
  async cleanupOldLabelaryStats(daysToKeep: number = 90): Promise<number> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

      // Formato: "2025-12-23T14"
      const cutoffHour = cutoffDate.toISOString().slice(0, 13);

      const snapshot = await this.firestore
        .collection(this.labelaryStatsCollection)
        .where('hourKey', '<', cutoffHour)
        .get();

      const batch = this.firestore.batch();
      let count = 0;

      snapshot.docs.forEach((doc) => {
        batch.delete(doc.ref);
        count++;
      });

      if (count > 0) {
        await batch.commit();
        this.logger.log(`Cleaned up ${count} old Labelary stats documents`);
      }

      return count;
    } catch (error) {
      this.logger.error(`Error cleaning up old Labelary stats: ${error.message}`);
      throw error;
    }
  }

  /**
   * Obtiene estadísticas de Labelary para el día actual (agregadas por hora)
   * Retorna datos agregados de todas las horas del día en GMT-6
   */
  async getLabelaryTodayStats(): Promise<{
    totalCalls: number;
    successCount: number;
    errorCount: number;
    rateLimitHits: number;
    avgResponseTimeMs: number;
    labelCount: number;
    uniqueLabelCount: number;
    peakHour: string;
    peakHourRequests: number;
  }> {
    try {
      const today = getDateStringInTimezone(new Date());
      const startHour = `${today}T00`;
      const endHour = `${today}T23`;

      const snapshot = await this.firestore
        .collection(this.labelaryStatsCollection)
        .where('hourKey', '>=', startHour)
        .where('hourKey', '<=', endHour)
        .get();

      let totalCalls = 0;
      let successCount = 0;
      let errorCount = 0;
      let rateLimitHits = 0;
      let totalResponseTimeMs = 0;
      let labelCount = 0;
      let uniqueLabelCount = 0;
      let peakHour = '';
      let peakHourRequests = 0;

      for (const doc of snapshot.docs) {
        const data = doc.data() as HourlyLabelaryStats;
        totalCalls += data.totalCalls;
        successCount += data.successCount;
        errorCount += data.errorCount;
        rateLimitHits += data.rateLimitHits;
        totalResponseTimeMs += data.totalResponseTimeMs;
        labelCount += data.labelCount;
        uniqueLabelCount += data.uniqueLabelCount || 0;

        if (data.totalCalls > peakHourRequests) {
          peakHourRequests = data.totalCalls;
          // Extraer solo la hora del hourKey (e.g., "2025-12-23T14" -> "14:00")
          const hourNum = data.hourKey.split('T')[1];
          peakHour = `${hourNum}:00`;
        }
      }

      return {
        totalCalls,
        successCount,
        errorCount,
        rateLimitHits,
        avgResponseTimeMs:
          totalCalls > 0 ? Math.round(totalResponseTimeMs / totalCalls) : 0,
        labelCount,
        uniqueLabelCount,
        peakHour: peakHour || '00:00',
        peakHourRequests,
      };
    } catch (error) {
      this.logger.error(`Error getting today Labelary stats: ${error.message}`);
      throw error;
    }
  }

  /**
   * Obtiene histórico semanal de estadísticas de Labelary
   * Agrega datos por día para los últimos N días
   */
  async getLabelaryWeeklyHistory(
    days: number = 7,
  ): Promise<
    Array<{
      date: string;
      requests: number;
      errors: number;
      uniqueLabels: number;
    }>
  > {
    try {
      const results: Array<{
        date: string;
        requests: number;
        errors: number;
        uniqueLabels: number;
      }> = [];

      // Calcular fecha de inicio (hace N días)
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days + 1);

      for (let i = 0; i < days; i++) {
        const currentDate = new Date(startDate);
        currentDate.setDate(startDate.getDate() + i);
        const dateStr = getDateStringInTimezone(currentDate);

        const startHour = `${dateStr}T00`;
        const endHour = `${dateStr}T23`;

        const snapshot = await this.firestore
          .collection(this.labelaryStatsCollection)
          .where('hourKey', '>=', startHour)
          .where('hourKey', '<=', endHour)
          .get();

        let requests = 0;
        let errors = 0;
        let uniqueLabels = 0;

        for (const doc of snapshot.docs) {
          const data = doc.data() as HourlyLabelaryStats;
          requests += data.totalCalls;
          errors += data.errorCount + data.rateLimitHits;
          uniqueLabels += data.uniqueLabelCount || 0;
        }

        results.push({
          date: dateStr,
          requests,
          errors,
          uniqueLabels,
        });
      }

      return results;
    } catch (error) {
      this.logger.error(`Error getting weekly Labelary history: ${error.message}`);
      throw error;
    }
  }

  /**
   * Obtiene la distribución horaria del día actual
   */
  async getLabelaryHourlyDistribution(): Promise<
    Array<{
      hour: string;
      requests: number;
      errors: number;
    }>
  > {
    try {
      const today = getDateStringInTimezone(new Date());
      const startHour = `${today}T00`;
      const endHour = `${today}T23`;

      const snapshot = await this.firestore
        .collection(this.labelaryStatsCollection)
        .where('hourKey', '>=', startHour)
        .where('hourKey', '<=', endHour)
        .orderBy('hourKey', 'asc')
        .get();

      // Crear array con todas las 24 horas
      const hourlyMap = new Map<string, { requests: number; errors: number }>();

      // Inicializar todas las horas con 0
      for (let h = 0; h < 24; h++) {
        const hourStr = String(h).padStart(2, '0');
        hourlyMap.set(`${hourStr}:00`, { requests: 0, errors: 0 });
      }

      // Llenar con datos reales
      for (const doc of snapshot.docs) {
        const data = doc.data() as HourlyLabelaryStats;
        const hourNum = data.hourKey.split('T')[1];
        const hourKey = `${hourNum}:00`;

        hourlyMap.set(hourKey, {
          requests: data.totalCalls,
          errors: data.errorCount + data.rateLimitHits,
        });
      }

      // Convertir a array
      return Array.from(hourlyMap.entries())
        .map(([hour, data]) => ({
          hour,
          requests: data.requests,
          errors: data.errors,
        }))
        .sort((a, b) => a.hour.localeCompare(b.hour));
    } catch (error) {
      this.logger.error(`Error getting hourly distribution: ${error.message}`);
      throw error;
    }
  }

  // ============================================
  // FINANCE: Exchange Rates
  // ============================================

  async getExchangeRate(date: string): Promise<ExchangeRate | null> {
    try {
      const docId = `rate_${date.replace(/-/g, '')}`;
      const doc = await this.firestore.collection(this.exchangeRatesCollection).doc(docId).get();

      if (!doc.exists) {
        return null;
      }

      const data = doc.data();
      return {
        id: doc.id,
        date: data.date,
        usdToMxn: data.usdToMxn,
        source: data.source,
        fetchedAt: data.fetchedAt?.toDate ? data.fetchedAt.toDate() : new Date(data.fetchedAt),
      };
    } catch (error) {
      this.logger.error(`Error getting exchange rate: ${error.message}`);
      return null;
    }
  }

  async saveExchangeRate(rate: ExchangeRate): Promise<void> {
    try {
      await this.firestore.collection(this.exchangeRatesCollection).doc(rate.id).set({
        ...rate,
        fetchedAt: rate.fetchedAt,
      });
    } catch (error) {
      this.logger.error(`Error saving exchange rate: ${error.message}`);
      throw error;
    }
  }

  // ============================================
  // FINANCE: Stripe Transactions
  // ============================================

  async saveTransaction(transaction: StripeTransaction): Promise<void> {
    try {
      await this.firestore.collection(this.transactionsCollection).doc(transaction.id).set({
        ...transaction,
        createdAt: transaction.createdAt,
      });
      this.logger.log(`Saved transaction: ${transaction.id}`);
    } catch (error) {
      this.logger.error(`Error saving transaction: ${error.message}`);
      throw error;
    }
  }

  async getTransactions(filters: {
    startDate?: Date;
    endDate?: Date;
    userId?: string;
    currency?: 'usd' | 'mxn';
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<{ transactions: StripeTransaction[]; total: number }> {
    try {
      let query = this.firestore.collection(this.transactionsCollection) as FirebaseFirestore.Query;

      if (filters.startDate) {
        query = query.where('createdAt', '>=', filters.startDate);
      }
      if (filters.endDate) {
        query = query.where('createdAt', '<=', filters.endDate);
      }
      if (filters.userId) {
        query = query.where('userId', '==', filters.userId);
      }
      if (filters.currency) {
        query = query.where('currency', '==', filters.currency);
      }
      if (filters.status) {
        query = query.where('status', '==', filters.status);
      }

      query = query.orderBy('createdAt', 'desc');

      // Get total count
      const countSnapshot = await query.count().get();
      const total = countSnapshot.data().count;

      // Apply pagination
      const page = filters.page || 1;
      const limit = filters.limit || 50;
      const offset = (page - 1) * limit;

      query = query.offset(offset).limit(limit);

      const snapshot = await query.get();
      const transactions: StripeTransaction[] = snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          stripeEventId: data.stripeEventId,
          stripeEventType: data.stripeEventType,
          userId: data.userId,
          userEmail: data.userEmail,
          amount: data.amount,
          currency: data.currency,
          amountMxn: data.amountMxn,
          exchangeRate: data.exchangeRate,
          type: data.type,
          plan: data.plan,
          stripeCustomerId: data.stripeCustomerId,
          stripeSubscriptionId: data.stripeSubscriptionId,
          stripeInvoiceId: data.stripeInvoiceId,
          stripePaymentIntentId: data.stripePaymentIntentId,
          status: data.status,
          billingCountry: data.billingCountry,
          createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : new Date(data.createdAt),
          metadata: data.metadata,
        };
      });

      return { transactions, total };
    } catch (error) {
      this.logger.error(`Error getting transactions: ${error.message}`);
      throw error;
    }
  }

  async getRevenueByPeriod(
    startDate: Date,
    endDate: Date,
  ): Promise<{ totalUsd: number; totalMxn: number; count: number }> {
    try {
      const snapshot = await this.firestore
        .collection(this.transactionsCollection)
        .where('createdAt', '>=', startDate)
        .where('createdAt', '<=', endDate)
        .where('status', '==', 'succeeded')
        .get();

      let totalUsd = 0;
      let totalMxn = 0;

      for (const doc of snapshot.docs) {
        const data = doc.data();
        if (data.currency === 'usd') {
          totalUsd += data.amount;
        } else {
          totalMxn += data.amount;
        }
      }

      return {
        totalUsd: totalUsd / 100, // Convertir de centavos
        totalMxn: totalMxn / 100,
        count: snapshot.size,
      };
    } catch (error) {
      this.logger.error(`Error getting revenue: ${error.message}`);
      throw error;
    }
  }

  // ============================================
  // FINANCE: Expenses
  // ============================================

  async saveExpense(expense: Expense): Promise<void> {
    try {
      await this.firestore.collection(this.expensesCollection).doc(expense.id).set({
        ...expense,
        createdAt: expense.createdAt,
        updatedAt: expense.updatedAt || new Date(),
      });
      this.logger.log(`Saved expense: ${expense.id}`);
    } catch (error) {
      this.logger.error(`Error saving expense: ${error.message}`);
      throw error;
    }
  }

  async getExpenses(filters: {
    startDate?: Date;
    endDate?: Date;
    category?: string;
    type?: 'recurring' | 'one_time';
    page?: number;
    limit?: number;
  }): Promise<{ expenses: Expense[]; total: number }> {
    try {
      let query = this.firestore.collection(this.expensesCollection) as FirebaseFirestore.Query;

      if (filters.startDate) {
        query = query.where('createdAt', '>=', filters.startDate);
      }
      if (filters.endDate) {
        query = query.where('createdAt', '<=', filters.endDate);
      }
      if (filters.category) {
        query = query.where('category', '==', filters.category);
      }
      if (filters.type) {
        query = query.where('type', '==', filters.type);
      }

      query = query.orderBy('createdAt', 'desc');

      const countSnapshot = await query.count().get();
      const total = countSnapshot.data().count;

      const page = filters.page || 1;
      const limit = filters.limit || 50;
      const offset = (page - 1) * limit;

      query = query.offset(offset).limit(limit);

      const snapshot = await query.get();
      const expenses: Expense[] = snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          amount: data.amount,
          currency: data.currency,
          amountMxn: data.amountMxn,
          exchangeRate: data.exchangeRate,
          type: data.type,
          category: data.category,
          description: data.description,
          vendor: data.vendor,
          recurrenceType: data.recurrenceType,
          nextGenerationDate: data.nextGenerationDate?.toDate
            ? data.nextGenerationDate.toDate()
            : data.nextGenerationDate
              ? new Date(data.nextGenerationDate)
              : undefined,
          parentExpenseId: data.parentExpenseId,
          createdBy: data.createdBy,
          createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : new Date(data.createdAt),
          updatedAt: data.updatedAt?.toDate ? data.updatedAt.toDate() : undefined,
          isAutoGenerated: data.isAutoGenerated,
        };
      });

      return { expenses, total };
    } catch (error) {
      this.logger.error(`Error getting expenses: ${error.message}`);
      throw error;
    }
  }

  async updateExpense(id: string, data: Partial<Expense>): Promise<void> {
    try {
      await this.firestore
        .collection(this.expensesCollection)
        .doc(id)
        .update({
          ...data,
          updatedAt: new Date(),
        });
    } catch (error) {
      this.logger.error(`Error updating expense: ${error.message}`);
      throw error;
    }
  }

  async deleteExpense(id: string): Promise<void> {
    try {
      await this.firestore.collection(this.expensesCollection).doc(id).delete();
      this.logger.log(`Deleted expense: ${id}`);
    } catch (error) {
      this.logger.error(`Error deleting expense: ${error.message}`);
      throw error;
    }
  }

  async getRecurringExpensesDueToday(): Promise<Expense[]> {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const snapshot = await this.firestore
        .collection(this.expensesCollection)
        .where('type', '==', 'recurring')
        .where('nextGenerationDate', '>=', today)
        .where('nextGenerationDate', '<', tomorrow)
        .get();

      return snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          amount: data.amount,
          currency: data.currency,
          amountMxn: data.amountMxn,
          exchangeRate: data.exchangeRate,
          type: data.type,
          category: data.category,
          description: data.description,
          vendor: data.vendor,
          recurrenceType: data.recurrenceType,
          nextGenerationDate: data.nextGenerationDate?.toDate
            ? data.nextGenerationDate.toDate()
            : new Date(data.nextGenerationDate),
          parentExpenseId: data.parentExpenseId,
          createdBy: data.createdBy,
          createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : new Date(data.createdAt),
          isAutoGenerated: data.isAutoGenerated,
        };
      });
    } catch (error) {
      this.logger.error(`Error getting recurring expenses due today: ${error.message}`);
      throw error;
    }
  }

  async getExpenseSummary(
    startDate: Date,
    endDate: Date,
  ): Promise<{
    total: number;
    totalMxn: number;
    byCategory: Record<string, number>;
    byType: { recurring: number; one_time: number };
  }> {
    try {
      const snapshot = await this.firestore
        .collection(this.expensesCollection)
        .where('createdAt', '>=', startDate)
        .where('createdAt', '<=', endDate)
        .get();

      let totalMxn = 0;
      const byCategory: Record<string, number> = {};
      const byType = { recurring: 0, one_time: 0 };

      for (const doc of snapshot.docs) {
        const data = doc.data();
        totalMxn += data.amountMxn;

        byCategory[data.category] = (byCategory[data.category] || 0) + data.amountMxn;
        byType[data.type as 'recurring' | 'one_time'] += data.amountMxn;
      }

      return { total: snapshot.size, totalMxn, byCategory, byType };
    } catch (error) {
      this.logger.error(`Error getting expense summary: ${error.message}`);
      throw error;
    }
  }

  // ============================================
  // FINANCE: Monthly Goals
  // ============================================

  async saveGoal(goal: MonthlyGoal): Promise<void> {
    try {
      await this.firestore.collection(this.goalsCollection).doc(goal.id).set({
        ...goal,
        createdAt: goal.createdAt,
        updatedAt: goal.updatedAt || new Date(),
      });
      this.logger.log(`Saved goal: ${goal.id}`);
    } catch (error) {
      this.logger.error(`Error saving goal: ${error.message}`);
      throw error;
    }
  }

  async getGoal(month: string): Promise<MonthlyGoal | null> {
    try {
      const docId = `goal_${month.replace(/-/g, '')}`;
      const doc = await this.firestore.collection(this.goalsCollection).doc(docId).get();

      if (!doc.exists) {
        return null;
      }

      const data = doc.data();
      return {
        id: doc.id,
        month: data.month,
        targets: data.targets,
        actual: data.actual,
        alerts: data.alerts,
        createdBy: data.createdBy,
        createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : new Date(data.createdAt),
        updatedAt: data.updatedAt?.toDate ? data.updatedAt.toDate() : undefined,
      };
    } catch (error) {
      this.logger.error(`Error getting goal: ${error.message}`);
      return null;
    }
  }

  async updateGoalActuals(
    month: string,
    actual: { revenue: number; newUsers: number; proConversions: number },
    alerts?: { belowPaceRevenue: boolean; belowPaceUsers: boolean; belowPaceConversions: boolean },
  ): Promise<void> {
    try {
      const docId = `goal_${month.replace(/-/g, '')}`;
      await this.firestore
        .collection(this.goalsCollection)
        .doc(docId)
        .update({
          actual,
          alerts,
          updatedAt: new Date(),
        });
    } catch (error) {
      this.logger.error(`Error updating goal actuals: ${error.message}`);
      throw error;
    }
  }

  // ============================================
  // FINANCE: Subscription Events
  // ============================================

  async saveSubscriptionEvent(event: SubscriptionEvent): Promise<void> {
    try {
      await this.firestore.collection(this.subscriptionEventsCollection).doc(event.id).set({
        ...event,
        createdAt: event.createdAt,
      });
      this.logger.log(`Saved subscription event: ${event.id}`);
    } catch (error) {
      this.logger.error(`Error saving subscription event: ${error.message}`);
      throw error;
    }
  }

  async getSubscriptionEvents(filters: {
    startDate?: Date;
    endDate?: Date;
    eventType?: string;
    userId?: string;
  }): Promise<SubscriptionEvent[]> {
    try {
      let query = this.firestore.collection(
        this.subscriptionEventsCollection,
      ) as FirebaseFirestore.Query;

      if (filters.startDate) {
        query = query.where('createdAt', '>=', filters.startDate);
      }
      if (filters.endDate) {
        query = query.where('createdAt', '<=', filters.endDate);
      }
      if (filters.eventType) {
        query = query.where('eventType', '==', filters.eventType);
      }
      if (filters.userId) {
        query = query.where('userId', '==', filters.userId);
      }

      query = query.orderBy('createdAt', 'desc');

      const snapshot = await query.get();
      return snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          userId: data.userId,
          userEmail: data.userEmail,
          eventType: data.eventType,
          plan: data.plan,
          previousPlan: data.previousPlan,
          currency: data.currency,
          mrr: data.mrr,
          mrrMxn: data.mrrMxn,
          stripeSubscriptionId: data.stripeSubscriptionId,
          cancellationReason: data.cancellationReason,
          country: data.country,
          createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : new Date(data.createdAt),
        };
      });
    } catch (error) {
      this.logger.error(`Error getting subscription events: ${error.message}`);
      throw error;
    }
  }

  async getActiveSubscribersCount(): Promise<number> {
    try {
      const snapshot = await this.firestore
        .collection(this.usersCollection)
        .where('plan', 'in', ['pro', 'enterprise'])
        .where('stripeSubscriptionId', '!=', null)
        .count()
        .get();

      return snapshot.data().count;
    } catch (error) {
      this.logger.error(`Error getting active subscribers count: ${error.message}`);
      return 0;
    }
  }

  async getChurnedUsersInPeriod(startDate: Date, endDate: Date): Promise<number> {
    try {
      const snapshot = await this.firestore
        .collection(this.subscriptionEventsCollection)
        .where('eventType', 'in', ['canceled', 'churned'])
        .where('createdAt', '>=', startDate)
        .where('createdAt', '<=', endDate)
        .count()
        .get();

      return snapshot.data().count;
    } catch (error) {
      this.logger.error(`Error getting churned users: ${error.message}`);
      return 0;
    }
  }

  // ============================================
  // GEOGRAPHIC: User Distribution by Country
  // ============================================

  async getUsersByCountry(): Promise<
    Array<{
      country: string;
      total: number;
      byPlan: { free: number; pro: number; enterprise: number };
    }>
  > {
    try {
      // Obtener todos los usuarios (sin filtrar por country)
      const usersSnapshot = await this.firestore
        .collection(this.usersCollection)
        .get();

      // Obtener países desde transacciones exitosas
      const txSnapshot = await this.firestore
        .collection(this.transactionsCollection)
        .where('status', '==', 'succeeded')
        .get();

      // Mapear stripeCustomerId → país desde transacciones
      const customerCountryMap = new Map<string, string>();
      for (const doc of txSnapshot.docs) {
        const data = doc.data();
        if (data.stripeCustomerId && data.billingCountry) {
          customerCountryMap.set(data.stripeCustomerId, data.billingCountry);
        }
      }

      const countryMap = new Map<
        string,
        { total: number; byPlan: { free: number; pro: number; enterprise: number } }
      >();

      for (const doc of usersSnapshot.docs) {
        const data = doc.data();
        // Prioridad: user.country > transacción.billingCountry > 'unknown'
        const country =
          data.country ||
          customerCountryMap.get(data.stripeCustomerId) ||
          'unknown';

        if (!countryMap.has(country)) {
          countryMap.set(country, {
            total: 0,
            byPlan: { free: 0, pro: 0, enterprise: 0 },
          });
        }

        const countryData = countryMap.get(country)!;
        countryData.total++;
        const plan = data.plan as 'free' | 'pro' | 'enterprise';
        if (plan && countryData.byPlan[plan] !== undefined) {
          countryData.byPlan[plan]++;
        } else {
          countryData.byPlan.free++;
        }
      }

      return Array.from(countryMap.entries())
        .map(([country, data]) => ({
          country,
          ...data,
        }))
        .sort((a, b) => b.total - a.total);
    } catch (error) {
      this.logger.error(`Error getting users by country: ${error.message}`);
      throw error;
    }
  }

  async getConversionRatesByCountry(): Promise<
    Array<{
      country: string;
      freeUsers: number;
      proUsers: number;
      conversionRate: number;
    }>
  > {
    try {
      const usersByCountry = await this.getUsersByCountry();

      return usersByCountry.map((countryData) => {
        const freeUsers = countryData.byPlan.free;
        const proUsers = countryData.byPlan.pro + countryData.byPlan.enterprise;
        const conversionRate = freeUsers + proUsers > 0 ? (proUsers / (freeUsers + proUsers)) * 100 : 0;

        return {
          country: countryData.country,
          freeUsers,
          proUsers,
          conversionRate: Math.round(conversionRate * 100) / 100,
        };
      });
    } catch (error) {
      this.logger.error(`Error getting conversion rates by country: ${error.message}`);
      throw error;
    }
  }

  async getRevenueByCountry(
    startDate: Date,
    endDate: Date,
  ): Promise<Array<{ country: string; revenue: number; revenueMxn: number; transactions: number }>> {
    try {
      const snapshot = await this.firestore
        .collection(this.transactionsCollection)
        .where('createdAt', '>=', startDate)
        .where('createdAt', '<=', endDate)
        .where('status', '==', 'succeeded')
        .get();

      const countryMap = new Map<string, { revenue: number; revenueMxn: number; transactions: number }>();

      for (const doc of snapshot.docs) {
        const data = doc.data();
        const country = data.billingCountry || 'unknown';

        if (!countryMap.has(country)) {
          countryMap.set(country, { revenue: 0, revenueMxn: 0, transactions: 0 });
        }

        const countryData = countryMap.get(country)!;
        countryData.revenue += (data.amount || 0) / 100; // Convertir de centavos
        countryData.revenueMxn += data.amountMxn || 0;
        countryData.transactions++;
      }

      return Array.from(countryMap.entries())
        .map(([country, data]) => ({
          country,
          ...data,
        }))
        .sort((a, b) => b.revenueMxn - a.revenueMxn);
    } catch (error) {
      this.logger.error(`Error getting revenue by country: ${error.message}`);
      throw error;
    }
  }

  async getNewUsersInPeriod(startDate: Date, endDate: Date): Promise<number> {
    try {
      const snapshot = await this.firestore
        .collection(this.usersCollection)
        .where('createdAt', '>=', startDate)
        .where('createdAt', '<=', endDate)
        .count()
        .get();

      return snapshot.data().count;
    } catch (error) {
      this.logger.error(`Error getting new users in period: ${error.message}`);
      return 0;
    }
  }

  async getProConversionsInPeriod(startDate: Date, endDate: Date): Promise<number> {
    try {
      const snapshot = await this.firestore
        .collection(this.subscriptionEventsCollection)
        .where('eventType', '==', 'started')
        .where('createdAt', '>=', startDate)
        .where('createdAt', '<=', endDate)
        .count()
        .get();

      return snapshot.data().count;
    } catch (error) {
      this.logger.error(`Error getting pro conversions in period: ${error.message}`);
      return 0;
    }
  }
}
