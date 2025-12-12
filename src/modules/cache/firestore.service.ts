import { Injectable, Logger } from '@nestjs/common';
import { Firestore } from '@google-cloud/firestore';
import { ConfigService } from '@nestjs/config';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { DEFAULT_PLAN_LIMITS } from '../../common/interfaces/user.interface.js';
import type { User, PlanType } from '../../common/interfaces/user.interface.js';
import type { Usage } from '../../common/interfaces/usage.interface.js';
import type { ConversionHistory } from '../../common/interfaces/conversion-history.interface.js';

export interface ConversionStatus {
  status: 'pending' | 'processing' | 'completed' | 'error';
  progress: number;
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

    // Opción 1: Intentar cargar desde archivo firebase-credentials.json
    const credentialsPath = join(process.cwd(), 'firebase-credentials.json');
    if (existsSync(credentialsPath)) {
      try {
        const fileContent = readFileSync(credentialsPath, 'utf-8');
        credentials = JSON.parse(fileContent);
        this.logger.log('Loaded Firebase credentials from file');
      } catch (error) {
        this.logger.error('Error loading firebase-credentials.json:', error);
      }
    } else {
      // Opción 2: Usar variable de entorno FIREBASE_CREDENTIALS
      const firebaseCredentials = this.configService.get<string>('FIREBASE_CREDENTIALS');
      if (firebaseCredentials) {
        try {
          credentials = JSON.parse(firebaseCredentials);
        } catch (error) {
          this.logger.error('Error parsing FIREBASE_CREDENTIALS:', error);
        }
      }
    }

    // Inicializar Firestore con projectId explícito
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
}
