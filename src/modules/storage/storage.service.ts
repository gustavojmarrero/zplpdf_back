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
    // Mismo fallback que ZplService, AdminService y app.config: sin él, este
    // servicio resolvía `undefined` y leía de un bucket distinto al que escribe
    // quien guarda los archivos. Un ZPL guardado por ZplService no se podría
    // recuperar, y el fallo sería un 500 opaco en `.bucket(undefined)`.
    this.bucketName =
      this.configService.get<string>('GCP_STORAGE_BUCKET') ||
      'zplpdf-app-files';
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
   * Guarda un archivo en una ruta arbitraria del bucket.
   *
   * Sin URL firmada de vuelta: los CFDI se conservan cinco años y su descarga se
   * autoriza por usuario en cada petición, así que la URL se genera al leer y no
   * al guardar.
   */
  async saveFile(
    filePath: string,
    content: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.storage
      .bucket(this.bucketName)
      .file(filePath)
      .save(content, { metadata: { contentType } });
  }

  /**
   * Lee un archivo de texto del bucket.
   *
   * Devuelve `null` cuando el objeto ya no existe (404 de GCS) en vez de
   * lanzar: los archivos con ciclo de vida — el ZPL original de una conversión
   * caduca a los 15 días — desaparecen por diseño, y quien llama traduce esa
   * ausencia a un 410, no a un 500.
   *
   * @param filePath Path del archivo en el bucket (ej: debug-zpl/uid/2026-08-08/job.zpl)
   */
  async readTextFile(filePath: string): Promise<string | null> {
    try {
      const [contents] = await this.storage
        .bucket(this.bucketName)
        .file(filePath)
        .download();

      return contents.toString('utf-8');
    } catch (error) {
      if (error?.code === 404) {
        return null;
      }
      this.logger.error(
        `Error al leer el archivo ${filePath}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Genera una URL firmada para cualquier archivo en el bucket
   * @param filePath Path del archivo en el bucket (ej: label-xxx.pdf)
   * @param downloadFilename Nombre del archivo para descarga (opcional)
   * @param expirationMinutes Tiempo de expiración en minutos (default: 15)
   * @returns URL firmada
   */
  async generateSignedUrlForPath(
    filePath: string,
    downloadFilename?: string,
    expirationMinutes: number = 15,
  ): Promise<string> {
    const file = this.storage.bucket(this.bucketName).file(filePath);

    const options: any = {
      version: 'v4',
      action: 'read',
      expires: Date.now() + expirationMinutes * 60 * 1000,
    };

    // Si se proporciona nombre de descarga, añadir responseDisposition
    if (downloadFilename) {
      options.responseDisposition = `attachment; filename="${downloadFilename}"`;
    }

    const [url] = await file.getSignedUrl(options);

    return url;
  }
}
