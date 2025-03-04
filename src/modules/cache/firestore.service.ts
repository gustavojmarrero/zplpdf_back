import { Injectable, Logger, Inject } from '@nestjs/common';
import { Firestore } from '@google-cloud/firestore';
import { ConfigService } from '@nestjs/config';

interface ConversionStatus {
  status: 'pending' | 'processing' | 'completed' | 'error';
  zplContent?: string;
  labelSize?: string;
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

  constructor(
    private configService: ConfigService,
    @Inject('GOOGLE_AUTH_OPTIONS') private googleAuthOptions: any,
  ) {
    this.firestore = new Firestore(this.googleAuthOptions);
  }

  async saveConversionStatus(
    jobId: string,
    status: ConversionStatus,
  ): Promise<void> {
    try {
      await this.firestore
        .collection(this.collectionName)
        .doc(jobId)
        .set(status, { merge: true });
      
      this.logger.log(`Estado de conversión actualizado para jobId: ${jobId}`);
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
} 