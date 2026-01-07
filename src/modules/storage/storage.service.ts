import { Injectable, Logger } from '@nestjs/common';
import { Storage } from '@google-cloud/storage';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { Inject } from '@nestjs/common';

@Injectable()
export class StorageService {
  private storage: Storage;
  private readonly logger = new Logger(StorageService.name);
  private readonly bucketName: string;

  constructor(
    private configService: ConfigService,
    @Inject('GOOGLE_AUTH_OPTIONS') private googleAuthOptions: any,
  ) {
    this.bucketName = this.configService.get<string>('GCP_STORAGE_BUCKET');
    this.storage = new Storage(this.googleAuthOptions);
  }

  generateZplHash(zplContent: string, labelSize: string): string {
    return crypto
      .createHash('md5')
      .update(`${zplContent}_${labelSize}`)
      .digest('hex');
  }

  async pdfExists(zplHash: string): Promise<boolean> {
    try {
      const [exists] = await this.storage
        .bucket(this.bucketName)
        .file(`zpl-pdfs/${zplHash}.pdf`)
        .exists();
      
      return exists;
    } catch (error) {
      this.logger.error(`Error al verificar archivo: ${error.message}`);
      return false;
    }
  }

  async savePdf(pdfBuffer: Buffer, zplHash: string): Promise<string> {
    const file = this.storage
      .bucket(this.bucketName)
      .file(`zpl-pdfs/${zplHash}.pdf`);
    
    await file.save(pdfBuffer, {
      metadata: {
        contentType: 'application/pdf',
        cacheControl: 'public, max-age=86400',
      },
    });
    
    // Generar URL firmada válida por 7 días
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    
    return url;
  }

  async getSignedUrl(zplHash: string): Promise<string> {
    const file = this.storage
      .bucket(this.bucketName)
      .file(`zpl-pdfs/${zplHash}.pdf`);

    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });

    return url;
  }

  /**
   * Genera una URL firmada para cualquier archivo en el bucket
   * @param filePath Path del archivo en el bucket (ej: label-xxx.pdf)
   * @param expirationMinutes Tiempo de expiración en minutos (default: 15)
   * @returns URL firmada
   */
  async generateSignedUrlForPath(filePath: string, expirationMinutes: number = 15): Promise<string> {
    const file = this.storage.bucket(this.bucketName).file(filePath);

    const [url] = await file.getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + expirationMinutes * 60 * 1000,
    });

    return url;
  }
} 