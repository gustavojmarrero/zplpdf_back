import { Injectable, Logger } from '@nestjs/common';
import { Firestore } from '@google-cloud/firestore';
import { ConfigService } from '@nestjs/config';
import { DEFAULT_PLAN_LIMITS } from '../../common/interfaces/user.interface.js';
import type { User, PlanType } from '../../common/interfaces/user.interface.js';
import type { Usage } from '../../common/interfaces/usage.interface.js';
import type { ConversionHistory } from '../../common/interfaces/conversion-history.interface.js';
import type { BatchJob } from '../zpl/interfaces/batch.interface.js';

// ============== Admin Interfaces ==============

export interface ErrorLogData {
  type: string;
  code: string;
  message: string;
  userId?: string;
  userEmail?: string;
  jobId?: string;
  severity: 'error' | 'warning' | 'critical';
  context?: Record<string, any>;
}

export interface ErrorLog extends ErrorLogData {
  id: string;
  createdAt: Date;
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
}

export interface PaginatedErrors {
  errors: ErrorLog[];
  summary: {
    total: number;
    bySeverity: Record<string, number>;
    byType: Record<string, number>;
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

  async saveErrorLog(errorData: ErrorLogData): Promise<void> {
    try {
      await this.firestore.collection(this.errorLogsCollection).add({
        ...errorData,
        createdAt: new Date(),
      });
      this.logger.debug(`Error log guardado: ${errorData.code}`);
    } catch (error) {
      this.logger.error(`Error al guardar error log: ${error.message}`);
      // No lanzar error para no interrumpir el flujo principal
    }
  }

  async getErrorLogs(filters: ErrorFilters): Promise<PaginatedErrors> {
    try {
      const { page = 1, limit = 100, severity, type, startDate, endDate, userId } = filters;

      let query: FirebaseFirestore.Query = this.firestore.collection(this.errorLogsCollection);

      if (severity) {
        query = query.where('severity', '==', severity);
      }
      if (type) {
        query = query.where('type', '==', type);
      }
      if (userId) {
        query = query.where('userId', '==', userId);
      }
      if (startDate) {
        query = query.where('createdAt', '>=', startDate);
      }
      if (endDate) {
        query = query.where('createdAt', '<=', endDate);
      }

      query = query.orderBy('createdAt', 'desc');

      // Get total count (without pagination)
      const countSnapshot = await query.count().get();
      const total = countSnapshot.data().count;

      // Apply pagination
      const offset = (page - 1) * limit;
      const snapshot = await query.offset(offset).limit(limit).get();

      const errors: ErrorLog[] = snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          ...data,
          createdAt: data.createdAt?.toDate?.() || data.createdAt,
        } as ErrorLog;
      });

      // Calculate summary
      const summarySnapshot = await this.firestore.collection(this.errorLogsCollection).get();
      const bySeverity: Record<string, number> = {};
      const byType: Record<string, number> = {};

      summarySnapshot.docs.forEach((doc) => {
        const data = doc.data();
        bySeverity[data.severity] = (bySeverity[data.severity] || 0) + 1;
        byType[data.type] = (byType[data.type] || 0) + 1;
      });

      return {
        errors,
        summary: {
          total,
          bySeverity,
          byType,
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

  // ============== Admin: User Metrics ==============

  async getUsersCount(): Promise<number> {
    try {
      const snapshot = await this.firestore.collection(this.usersCollection).count().get();
      return snapshot.data().count;
    } catch (error) {
      this.logger.error(`Error al contar usuarios: ${error.message}`);
      throw error;
    }
  }

  async getUsersByPlan(): Promise<{ free: number; pro: number; enterprise: number }> {
    try {
      const snapshot = await this.firestore.collection(this.usersCollection).get();

      const byPlan = { free: 0, pro: 0, enterprise: 0 };
      snapshot.docs.forEach((doc) => {
        const plan = doc.data().plan as PlanType;
        if (plan in byPlan) {
          byPlan[plan]++;
        }
      });

      return byPlan;
    } catch (error) {
      this.logger.error(`Error al obtener usuarios por plan: ${error.message}`);
      throw error;
    }
  }

  async getActiveUsers(period: 'day' | 'week' | 'month'): Promise<number> {
    try {
      const now = new Date();
      let startDate: Date;

      switch (period) {
        case 'day':
          startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          break;
        case 'week':
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case 'month':
          startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          break;
      }

      // Get unique users from conversion_history in the period
      const snapshot = await this.firestore
        .collection(this.historyCollection)
        .where('createdAt', '>=', startDate)
        .get();

      const uniqueUsers = new Set<string>();
      snapshot.docs.forEach((doc) => {
        const userId = doc.data().userId;
        if (userId) {
          uniqueUsers.add(userId);
        }
      });

      return uniqueUsers.size;
    } catch (error) {
      this.logger.error(`Error al obtener usuarios activos: ${error.message}`);
      throw error;
    }
  }

  async getRecentRegistrations(limit: number = 10): Promise<User[]> {
    try {
      const snapshot = await this.firestore
        .collection(this.usersCollection)
        .orderBy('createdAt', 'desc')
        .limit(limit)
        .get();

      return snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          ...data,
          createdAt: data.createdAt?.toDate?.() || data.createdAt,
          updatedAt: data.updatedAt?.toDate?.() || data.updatedAt,
        } as User;
      });
    } catch (error) {
      this.logger.error(`Error al obtener registros recientes: ${error.message}`);
      throw error;
    }
  }

  async getUsersPaginated(filters: UserFilters): Promise<PaginatedUsers> {
    try {
      const { page = 1, limit = 50, plan, search, sortBy = 'createdAt', sortOrder = 'desc' } = filters;

      let query: FirebaseFirestore.Query = this.firestore.collection(this.usersCollection);

      if (plan) {
        query = query.where('plan', '==', plan);
      }

      // Sort
      query = query.orderBy(sortBy, sortOrder);

      // Get total count
      const countSnapshot = await query.count().get();
      const total = countSnapshot.data().count;

      // Apply pagination
      const offset = (page - 1) * limit;
      const snapshot = await query.offset(offset).limit(limit).get();

      // Get usage for each user
      const users = await Promise.all(
        snapshot.docs.map(async (doc) => {
          const userData = doc.data();
          const userId = doc.id;

          // Get current usage
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

      // Filter out null values (from search filter)
      const filteredUsers = users.filter((u) => u !== null);

      return {
        users: filteredUsers,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
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

      const usersNearLimit: Array<{
        id: string;
        email: string;
        plan: PlanType;
        pdfCount: number;
        pdfLimit: number;
        percentUsed: number;
        periodEnd: Date;
      }> = [];

      for (const doc of usageSnapshot.docs) {
        const usageData = doc.data();
        const userId = usageData.userId;

        // Get user info
        const userDoc = await this.firestore.collection(this.usersCollection).doc(userId).get();
        if (!userDoc.exists) continue;

        const userData = userDoc.data();
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
      let queryStartDate = startDate;
      let queryEndDate = endDate || now;

      if (!queryStartDate) {
        switch (period) {
          case 'day':
            queryStartDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            break;
          case 'week':
            queryStartDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            break;
          case 'month':
            queryStartDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            break;
        }
      }

      const snapshot = await this.firestore
        .collection(this.historyCollection)
        .where('createdAt', '>=', queryStartDate)
        .where('createdAt', '<=', queryEndDate)
        .get();

      let totalPdfs = 0;
      let totalLabels = 0;
      let successCount = 0;
      let failureCount = 0;
      const byPlan: Record<string, { pdfs: number; labels: number }> = {
        free: { pdfs: 0, labels: 0 },
        pro: { pdfs: 0, labels: 0 },
        enterprise: { pdfs: 0, labels: 0 },
      };

      // Cache user plans
      const userPlanCache: Record<string, string> = {};

      for (const doc of snapshot.docs) {
        const data = doc.data();
        totalPdfs++;
        totalLabels += data.labelCount || 0;

        if (data.status === 'completed') {
          successCount++;
        } else if (data.status === 'failed') {
          failureCount++;
        }

        // Get user plan
        let userPlan = userPlanCache[data.userId];
        if (!userPlan && data.userId) {
          const userDoc = await this.firestore.collection(this.usersCollection).doc(data.userId).get();
          userPlan = userDoc.exists ? userDoc.data().plan : 'free';
          userPlanCache[data.userId] = userPlan;
        }

        if (userPlan && byPlan[userPlan]) {
          byPlan[userPlan].pdfs++;
          byPlan[userPlan].labels += data.labelCount || 0;
        }
      }

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

  async getConversionTrend(days: number = 7): Promise<Array<{
    date: string;
    pdfs: number;
    labels: number;
    failures: number;
  }>> {
    try {
      const now = new Date();
      const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

      const snapshot = await this.firestore
        .collection(this.historyCollection)
        .where('createdAt', '>=', startDate)
        .get();

      // Group by date
      const byDate: Record<string, { pdfs: number; labels: number; failures: number }> = {};

      // Initialize all dates
      for (let i = 0; i < days; i++) {
        const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
        const dateKey = date.toISOString().split('T')[0];
        byDate[dateKey] = { pdfs: 0, labels: 0, failures: 0 };
      }

      // Aggregate data
      snapshot.docs.forEach((doc) => {
        const data = doc.data();
        const createdAt = data.createdAt?.toDate?.() || new Date(data.createdAt);
        const dateKey = createdAt.toISOString().split('T')[0];

        if (byDate[dateKey]) {
          byDate[dateKey].pdfs++;
          byDate[dateKey].labels += data.labelCount || 0;
          if (data.status === 'failed') {
            byDate[dateKey].failures++;
          }
        }
      });

      // Convert to array and sort by date
      return Object.entries(byDate)
        .map(([date, stats]) => ({ date, ...stats }))
        .sort((a, b) => a.date.localeCompare(b.date));
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

      // Sort by pdfs and get top users
      const sortedUsers = Object.entries(userStats)
        .sort(([, a], [, b]) => b.pdfs - a.pdfs)
        .slice(0, limit);

      // Get user details
      const topUsers = await Promise.all(
        sortedUsers.map(async ([userId, stats]) => {
          const userDoc = await this.firestore.collection(this.usersCollection).doc(userId).get();
          const userData = userDoc.exists ? userDoc.data() : { email: 'unknown', plan: 'free' };

          return {
            id: userId,
            email: userData.email,
            plan: userData.plan,
            pdfs: stats.pdfs,
            labels: stats.labels,
          };
        }),
      );

      return topUsers;
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
}
