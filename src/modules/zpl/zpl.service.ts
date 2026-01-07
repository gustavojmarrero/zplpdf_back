import { Injectable, Logger, HttpException, HttpStatus, Inject, forwardRef, ForbiddenException, Optional } from '@nestjs/common';
import { ErrorCodes } from '../../common/constants/error-codes.js';
import axios from 'axios';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import PDFMerger from 'pdf-merger-js';
import { PDFDocument } from 'pdf-lib';
import { Storage } from '@google-cloud/storage';
import { ConfigService } from '@nestjs/config';
import archiver from 'archiver';
import { Writable } from 'stream';
import { pdfToPng, PngPageOutput } from 'pdf-to-png-converter';
import { FirestoreService, ConversionStatus, ErrorLogData } from '../cache/firestore.service.js';
import { UsersService } from '../users/users.service.js';
import { OutputFormat } from './enums/output-format.enum.js';
import type { BatchJob, BatchFileJob, BatchLimits } from './interfaces/batch.interface.js';
import { BATCH_LIMITS } from './interfaces/batch.interface.js';
import { LabelaryQueueService } from './services/labelary-queue.service.js';
import type { UserPlan, QueuePositionResponse } from './interfaces/queue.interface.js';

export enum LabelSize {
  TWO_BY_ONE = '2x1',
  TWO_BY_FOUR = '2x4',
  FOUR_BY_TWO = '4x2',
  FOUR_BY_SIX = '4x6',
}

// Interfaz para el estado de conversión
interface ConversionJob {
  id: string;
  zplContent: string;
  labelSize: LabelSize;
  outputFormat: OutputFormat;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  resultUrl?: string;
  filename?: string;
  error?: string;
  createdAt: Date;
  originalFilename?: string;
  userPlan?: string;
}

interface ZplBlock {
  content: string;
  index: number;
}

// Nuevo tipo para guardar contenido sin ^PQ y la cantidad de copias
interface ParsedZplBlock {
  normalizedContent: string;
  copies: number;
  originalIndex: number;
}

interface ChunkRange {
  start: number;
  end: number;
}

interface UniqueBlocksResult {
  uniqueBlocks: ParsedZplBlock[];
  originalSequence: number[];
}

interface ZplPreviewItemDto {
  img: string;
  qty: number;
}

@Injectable()
export class ZplService {
  private readonly logger = new Logger(ZplService.name);
  private readonly CHUNK_SIZE = 50;
  private readonly jobs = new Map<string, ConversionJob>();
  private readonly storage: Storage;
  private readonly bucket: string;
  private readonly storageBasePath: string;
  private readonly URL_EXPIRATION_TIME = 15 * 60 * 1000; // 15 minutos en milisegundos

  constructor(
    private configService: ConfigService,
    private firestoreService: FirestoreService,
    @Inject(forwardRef(() => UsersService))
    private usersService: UsersService,
    @Inject('GOOGLE_AUTH_OPTIONS') @Optional() private googleAuthOptions: any,
    private labelaryQueueService: LabelaryQueueService,
  ) {
    // Inicializar el cliente de Storage usando GoogleAuthProvider
    // En Cloud Run, si no hay credenciales, usará ADC automáticamente
    this.storage = new Storage(this.googleAuthOptions || {});

    // Nombre del bucket desde configuración o valor por defecto
    this.bucket = this.configService.get<string>('GCP_STORAGE_BUCKET') || 'zplpdf-app-files';

    // Configurar la URL base para acceder a los archivos
    this.storageBasePath = `https://storage.googleapis.com/${this.bucket}/`;

    // Verificar que el bucket existe
    this.storage
      .bucket(this.bucket)
      .exists()
      .then(([exists]) => {
        if (exists) {
          this.logger.log(`Bucket ${this.bucket} conectado correctamente`);
        } else {
          this.logger.error(`Bucket ${this.bucket} no encontrado`);
        }
      })
      .catch(error => {
        this.logger.error(`Error al conectar con el bucket: ${error.message}`);
      });
  }

  /**
   * Registra un error en el log de errores de admin
   */
  private async logError(
    type: string,
    code: string,
    message: string,
    severity: 'error' | 'warning' | 'critical',
    context?: Record<string, any>,
    userId?: string,
    userEmail?: string,
    jobId?: string,
  ): Promise<void> {
    try {
      await this.firestoreService.saveErrorLog({
        type,
        code,
        message,
        severity,
        context,
        userId,
        userEmail,
        jobId,
      });
    } catch (error) {
      this.logger.error(`Error logging to error_logs: ${error.message}`);
    }
  }

  /**
   * Inicia un proceso de conversion ZPL
   * @param zplContent Contenido ZPL a convertir
   * @param labelSize Tamano de la etiqueta
   * @param language Idioma para los mensajes
   * @param userId ID del usuario autenticado
   * @param outputFormat Formato de salida (pdf, png, jpeg)
   * @returns ID del trabajo creado
   */
  async startZplConversion(
    zplContent: string,
    labelSize: string,
    language = 'en',
    userId: string,
    outputFormat: OutputFormat = OutputFormat.PDF,
    originalFilename?: string,
  ): Promise<string> {
    try {
      if (!zplContent) {
        throw new HttpException(
          'Debe proporcionar el contenido ZPL ya sea como texto o como archivo',
          HttpStatus.BAD_REQUEST,
        );
      }

      // Count labels in ZPL content
      const countResult = await this.countLabels(zplContent);
      const labelCount = countResult.data.totalLabels;

      // Check user limits before processing
      const canConvert = await this.usersService.checkCanConvert(userId, labelCount);
      if (!canConvert.allowed) {
        // Log limit exceeded error
        await this.logError(
          'LIMIT_EXCEEDED',
          canConvert.errorCode || ErrorCodes.MONTHLY_LIMIT_EXCEEDED,
          canConvert.error,
          'warning',
          { labelCount, ...canConvert.data },
          userId,
        );
        throw new HttpException(
          {
            error: canConvert.errorCode,
            message: canConvert.error,
            data: canConvert.data,
          },
          HttpStatus.FORBIDDEN,
        );
      }

      // Obtener información del usuario
      const user = await this.usersService.getUserById(userId);
      const userPlan = user?.plan || 'free';

      // Validate Pro plan for image formats
      if (outputFormat !== OutputFormat.PDF) {
        if (!user || user.plan === 'free') {
          throw new HttpException(
            {
              error: ErrorCodes.IMAGE_FORMAT_PRO_ONLY,
              message: 'PNG and JPEG formats are only available for Pro and Enterprise plans',
            },
            HttpStatus.FORBIDDEN,
          );
        }
      }

      const size = this.getLabelSize(labelSize);
      const jobId = uuidv4();
      const now = new Date();

      // Crear y guardar el trabajo en memoria (cache local)
      this.jobs.set(jobId, {
        id: jobId,
        zplContent,
        labelSize: size,
        outputFormat,
        status: 'pending',
        progress: 0,
        createdAt: now,
        originalFilename,
        userPlan,
      });

      // Guardar en Firestore para persistencia entre instancias
      try {
        await this.firestoreService.saveConversionStatus(jobId, {
          status: 'pending',
          progress: 0,
          userId: userId,
          labelSize: labelSize,
          outputFormat: outputFormat,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
      } catch (firestoreError) {
        this.logger.error(`Error al guardar en Firestore: ${firestoreError.message}`);
        // Continuar aunque falle Firestore - el job puede procesarse con el cache local
      }

      // Encolar el trabajo para procesamiento asincrono
      const periodId = canConvert.periodInfo?.periodId;
      setTimeout(() => {
        this.processZplConversionWithUser(zplContent, labelSize, jobId, userId, labelCount, outputFormat, periodId, userPlan as 'free' | 'pro' | 'enterprise');
      }, 100);

      return jobId;
    } catch (error) {
      this.logger.error(`Error al iniciar conversion ZPL: ${error.message}`);
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Error al iniciar la conversion ZPL',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Procesa la conversion ZPL con tracking de usuario
   */
  private async processZplConversionWithUser(
    zplContent: string,
    labelSize: string,
    jobId: string,
    userId: string,
    labelCount: number,
    outputFormat: OutputFormat = OutputFormat.PDF,
    periodId?: string,
    userPlan?: 'free' | 'pro' | 'enterprise',
  ): Promise<void> {
    try {
      await this.processZplConversion(zplContent, labelSize, jobId, outputFormat, userId, userPlan);

      // Get the job to check if it completed successfully
      const job = this.jobs.get(jobId);
      if (job && job.status === 'completed') {
        // Record successful conversion
        await this.usersService.recordConversion(
          userId,
          jobId,
          labelCount,
          labelSize,
          'completed',
          outputFormat,
          job.resultUrl,
          periodId,
          userPlan,
        );
      } else if (job && job.status === 'failed') {
        // Record failed conversion
        await this.usersService.recordConversion(
          userId,
          jobId,
          labelCount,
          labelSize,
          'failed',
          outputFormat,
          undefined,
          periodId,
          userPlan,
        );
      }
    } catch (error) {
      this.logger.error(`Error in processZplConversionWithUser: ${error.message}`);
      // Record failed conversion
      try {
        await this.usersService.recordConversion(
          userId,
          jobId,
          labelCount,
          labelSize,
          'failed',
          outputFormat,
          undefined,
          periodId,
          userPlan,
        );
      } catch (recordError) {
        this.logger.error(`Error recording failed conversion: ${recordError.message}`);
      }
    }
  }

  /**
   * Procesa la conversión ZPL a PDF/PNG/JPEG (método que sería llamado por un worker)
   * @param zplContent Contenido ZPL a convertir
   * @param labelSize Tamaño de la etiqueta
   * @param jobId ID del trabajo
   * @param outputFormat Formato de salida
   * @param userId ID del usuario (para sistema de colas)
   * @param userPlan Plan del usuario (para prioridad en cola)
   */
  async processZplConversion(
    zplContent: string,
    labelSize: string,
    jobId: string,
    outputFormat: OutputFormat = OutputFormat.PDF,
    userId?: string,
    userPlan?: 'free' | 'pro' | 'enterprise',
  ): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) {
      this.logger.error(`Trabajo no encontrado: ${jobId}`);
      return;
    }

    try {
      // Actualizar estado a procesando
      job.status = 'processing';
      job.progress = 10;
      this.jobs.set(jobId, job);

      // Actualizar Firestore
      this.firestoreService.updateConversionStatus(jobId, {
        status: 'processing',
        progress: 10,
      }).catch(err => this.logger.error(`Error actualizando Firestore: ${err.message}`));

      const size = job.labelSize;
      const effectiveUserPlan: UserPlan = userPlan || 'free';
      const effectiveUserId = userId || 'anonymous';
      let resultBuffer: Buffer;
      let contentType: string;
      let fileExtension: string;

      // Convertir según el formato solicitado
      if (outputFormat === OutputFormat.PDF) {
        resultBuffer = await this.convertZplToPdf(zplContent, size, jobId, effectiveUserId, effectiveUserPlan);
        contentType = 'application/pdf';
        fileExtension = 'pdf';
      } else {
        // PNG o JPEG - crear archivo ZIP con las imágenes
        resultBuffer = await this.convertZplToImages(zplContent, size, outputFormat, jobId, effectiveUserId, effectiveUserPlan);
        contentType = 'application/zip';
        fileExtension = 'zip';
      }

      // Generar nombres de archivo
      this.logger.log(`Generando nombre: originalFilename=${job.originalFilename}, userPlan=${job.userPlan}`);
      const { storageFilename, downloadFilename } = this.generateFilenames(
        jobId,
        labelSize,
        outputFormat,
        fileExtension,
        job.originalFilename,
        job.userPlan,
      );
      this.logger.log(`Nombre generado: ${downloadFilename}`);

      // Guardar el archivo en Google Cloud Storage
      await this.storage
        .bucket(this.bucket)
        .file(storageFilename)
        .save(resultBuffer, {
          contentType,
        });

      // Generar URL firmada
      const signedUrl = await this.generateSignedUrl(storageFilename, downloadFilename);

      // Actualizar estado a completado
      job.status = 'completed';
      job.progress = 100;
      job.resultUrl = signedUrl;
      job.filename = downloadFilename;
      this.jobs.set(jobId, job);

      // Actualizar Firestore con resultado
      this.firestoreService.updateConversionStatus(jobId, {
        status: 'completed',
        progress: 100,
        resultUrl: signedUrl,
        filename: downloadFilename,
      }).catch(err => this.logger.error(`Error actualizando Firestore: ${err.message}`));

      this.logger.log(`Conversión completada para trabajo ${jobId} (formato: ${outputFormat})`);
    } catch (error) {
      this.logger.error(`Error al procesar conversión ZPL: ${error.message}`);

      // Log error for admin dashboard
      const errorType = error.message?.includes('ZPL') ? 'INVALID_ZPL' : 'SERVER_ERROR';
      const severity = errorType === 'SERVER_ERROR' ? 'critical' : 'error';
      await this.logError(
        errorType,
        errorType,
        error.message,
        severity,
        { labelSize, outputFormat },
        undefined,
        undefined,
        jobId,
      );

      // Actualizar estado a fallido
      job.status = 'failed';
      job.error = error.message;
      this.jobs.set(jobId, job);

      // Actualizar Firestore con error
      this.firestoreService.updateConversionStatus(jobId, {
        status: 'error',
        errorMessage: error.message,
      }).catch(err => this.logger.error(`Error actualizando Firestore: ${err.message}`));
    }
  }

  /**
   * Obtiene el estado actual de una conversión
   * @param jobId ID del trabajo
   * @returns Estado del trabajo
   */
  async getConversionStatus(jobId: string) {
    // Primero buscar en caché local
    let job = this.jobs.get(jobId);

    // Si no está en caché, buscar en Firestore
    if (!job) {
      try {
        const firestoreStatus = await this.firestoreService.getConversionStatus(jobId);
        if (firestoreStatus) {
          // Mapear status de Firestore a formato interno
          const mappedStatus = firestoreStatus.status === 'error' ? 'failed' : firestoreStatus.status;
          return {
            status: mappedStatus,
            progress: firestoreStatus.progress || 0,
            message: this.getStatusMessageFromFirestore(firestoreStatus),
          };
        }
      } catch (firestoreError) {
        this.logger.error(`Error al consultar Firestore: ${firestoreError.message}`);
      }
      throw new HttpException(
        { error: ErrorCodes.JOB_NOT_FOUND, message: 'Trabajo no encontrado', data: { jobId } },
        HttpStatus.NOT_FOUND,
      );
    }

    return {
      status: job.status,
      progress: job.progress,
      message: this.getStatusMessage(job),
    };
  }

  /**
   * Obtiene un mensaje de estado desde datos de Firestore
   */
  private getStatusMessageFromFirestore(status: ConversionStatus): string {
    switch (status.status) {
      case 'pending':
        return 'Conversión en cola';
      case 'processing':
        return `Procesando (${status.progress || 0}%)`;
      case 'completed':
        return 'Conversión completada';
      case 'error':
        return `Error: ${status.errorMessage || 'Desconocido'}`;
      default:
        return 'Estado desconocido';
    }
  }

  /**
   * Obtiene la URL de descarga del PDF convertido
   * @param jobId ID del trabajo
   * @returns URL y nombre del archivo
   */
  async getPdfDownloadUrl(jobId: string, userId: string) {
    // Primero buscar en caché local
    let job = this.jobs.get(jobId);

    // Si no está en caché, buscar en Firestore
    if (!job) {
      try {
        const firestoreStatus = await this.firestoreService.getConversionStatus(jobId);
        if (firestoreStatus) {
          // Validar propiedad del recurso
          if (firestoreStatus.userId && firestoreStatus.userId !== userId) {
            throw new ForbiddenException('No tienes acceso a este recurso');
          }
          if (firestoreStatus.status !== 'completed') {
            throw new HttpException(
              'La conversión no está completa',
              HttpStatus.BAD_REQUEST,
            );
          }
          if (!firestoreStatus.resultUrl || !firestoreStatus.filename) {
            throw new HttpException(
              'No se encuentra el archivo de resultado',
              HttpStatus.NOT_FOUND,
            );
          }
          return {
            url: firestoreStatus.resultUrl,
            filename: firestoreStatus.filename,
          };
        }
      } catch (error) {
        if (error instanceof HttpException || error instanceof ForbiddenException) {
          throw error;
        }
        this.logger.error(`Error al consultar Firestore: ${error.message}`);
      }
      throw new HttpException(
        { error: ErrorCodes.JOB_NOT_FOUND, message: 'Trabajo no encontrado', data: { jobId } },
        HttpStatus.NOT_FOUND,
      );
    }

    if (job.status !== 'completed') {
      throw new HttpException(
        { error: ErrorCodes.JOB_NOT_COMPLETE, message: 'La conversión no está completa', data: { jobId, currentStatus: job.status } },
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!job.resultUrl || !job.filename) {
      throw new HttpException(
        { error: ErrorCodes.DOWNLOAD_NOT_AVAILABLE, message: 'No se encuentra el archivo de resultado', data: { jobId } },
        HttpStatus.NOT_FOUND,
      );
    }

    return {
      url: job.resultUrl,
      filename: job.filename,
    };
  }

  /**
   * Obtiene un mensaje de estado según el estado del trabajo
   * @param job Trabajo de conversión
   * @returns Mensaje descriptivo
   */
  private getStatusMessage(job: ConversionJob): string {
    switch (job.status) {
      case 'pending':
        return 'Conversión en cola';
      case 'processing':
        return `Procesando (${job.progress}%)`;
      case 'completed':
        return 'Conversión completada';
      case 'failed':
        return `Error: ${job.error || 'Desconocido'}`;
      default:
        return 'Estado desconocido';
    }
  }

  /**
   * Convierte ZPL a PDF
   * @param zplRaw Contenido ZPL
   * @param labelSize Tamaño de etiqueta
   * @param jobId ID del trabajo
   * @param userId ID del usuario
   * @param userPlan Plan del usuario
   * @returns Buffer del PDF
   */
  private async convertZplToPdf(
    zplRaw: string,
    labelSize: LabelSize,
    jobId: string,
    userId: string,
    userPlan: UserPlan,
  ): Promise<Buffer> {
    try {
      if (!zplRaw) {
        throw new HttpException('ZPL content is required', HttpStatus.BAD_REQUEST);
      }
      // 1. Extraer y normalizar bloques ZPL
      const parsedBlocks = this.splitAndExtractCopies(zplRaw);
      if (parsedBlocks.length === 0) {
        throw new HttpException(
          'No valid ZPL blocks found',
          HttpStatus.BAD_REQUEST
        );
      }

      // 2. Identificar bloques únicos y su secuencia original
      const { uniqueBlocks, originalSequence } = this.identifyUniqueBlocks(parsedBlocks);

      // 3. Dividir bloques únicos en chunks de 50 (límite de Labelary)
      const chunkRanges = this.calculateChunkRanges(uniqueBlocks.length);

      // 4. Convertir cada chunk de bloques únicos a PDF
      const chunkPdfs: Buffer[] = [];
      for (const range of chunkRanges) {
        const chunkBlocks = uniqueBlocks.slice(range.start, range.end);

        const formattedBlocks = chunkBlocks.map(({ normalizedContent }) => {
          let content = normalizedContent;
          if (!content.startsWith('^XA')) content = '^XA' + content;
          if (!content.endsWith('^XZ')) content += '^XZ';
          return content;
        });

        const chunkZpl = formattedBlocks.join('\n');
        const labelCount = chunkBlocks.length;
        const pdfBuffer = await this.callLabelary(chunkZpl, labelSize, jobId, userId, userPlan, labelCount);
        chunkPdfs.push(pdfBuffer);
      }

      // 5. Reconstruir el PDF final (replicando cada bloque según copies)
      return this.reconstructFinalPdf(chunkPdfs, originalSequence);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Error converting ZPL to PDF',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Convierte ZPL a imágenes PNG o JPEG y las empaqueta en un archivo ZIP
   * Usa la misma lógica de batch que PDF para reducir llamadas a Labelary
   * @param zplRaw Contenido ZPL
   * @param labelSize Tamaño de etiqueta
   * @param outputFormat Formato de imagen (png o jpeg)
   * @param jobId ID del trabajo
   * @param userId ID del usuario
   * @param userPlan Plan del usuario
   * @returns Buffer del archivo ZIP
   */
  private async convertZplToImages(
    zplRaw: string,
    labelSize: LabelSize,
    outputFormat: OutputFormat,
    jobId: string,
    userId: string,
    userPlan: UserPlan,
  ): Promise<Buffer> {
    try {
      if (!zplRaw) {
        throw new HttpException('ZPL content is required', HttpStatus.BAD_REQUEST);
      }

      // 1. Extraer y normalizar bloques ZPL
      const parsedBlocks = this.splitAndExtractCopies(zplRaw);
      if (parsedBlocks.length === 0) {
        throw new HttpException(
          'No valid ZPL blocks found',
          HttpStatus.BAD_REQUEST
        );
      }

      // 2. Identificar bloques únicos y su secuencia original
      const { uniqueBlocks, originalSequence } = this.identifyUniqueBlocks(parsedBlocks);

      // 3. Dividir en chunks de 50 (mismo que PDF)
      const chunkRanges = this.calculateChunkRanges(uniqueBlocks.length);

      // 4. Obtener PDFs por chunks y convertir a imágenes
      const allUniqueImages: Buffer[] = [];
      for (const range of chunkRanges) {
        const chunkBlocks = uniqueBlocks.slice(range.start, range.end);

        const formattedBlocks = chunkBlocks.map(({ normalizedContent }) => {
          let content = normalizedContent;
          if (!content.startsWith('^XA')) content = '^XA' + content;
          if (!content.endsWith('^XZ')) content += '^XZ';
          return content;
        });

        const chunkZpl = formattedBlocks.join('\n');
        const labelCount = chunkBlocks.length;

        // Obtener PDF del chunk desde Labelary
        const pdfBuffer = await this.callLabelary(chunkZpl, labelSize, jobId, userId, userPlan, labelCount);

        // Convertir PDF a imágenes PNG
        const images = await this.pdfToImages(pdfBuffer);
        allUniqueImages.push(...images);
      }

      // 5. Crear ZIP con imágenes duplicadas según secuencia original
      return this.createImagesZip(allUniqueImages, originalSequence, outputFormat);
    } catch (error) {
      this.logger.error(`Error converting ZPL to images: ${error.message}`);
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Error converting ZPL to images',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Convierte un PDF multi-página a un array de imágenes PNG
   * @param pdfBuffer Buffer del PDF
   * @returns Array de buffers PNG (uno por página)
   */
  private async pdfToImages(pdfBuffer: Buffer): Promise<Buffer[]> {
    try {
      // Convert Buffer to ArrayBuffer for pdfToPng compatibility
      const arrayBuffer = pdfBuffer.buffer.slice(
        pdfBuffer.byteOffset,
        pdfBuffer.byteOffset + pdfBuffer.byteLength,
      );
      const pages: PngPageOutput[] = await pdfToPng(arrayBuffer, {
        disableFontFace: true,
        useSystemFonts: true,
        viewportScale: 2.0, // Mayor resolución
      });

      return pages.map(page => page.content);
    } catch (error) {
      this.logger.error(`Error converting PDF to images: ${error.message}`);
      throw new HttpException(
        'Error converting PDF to images',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Crea un archivo ZIP con las imágenes
   * @param uniqueImages Array de buffers PNG de imágenes únicas
   * @param sequence Secuencia de índices que representa el orden y repetición de las imágenes
   * @param outputFormat Formato de imagen (png o jpeg)
   * @returns Buffer del archivo ZIP
   */
  private async createImagesZip(
    uniqueImages: Buffer[],
    sequence: number[],
    outputFormat: OutputFormat,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const archive = archiver('zip', { zlib: { level: 9 } });

      // Crear un writable stream para capturar el ZIP
      const writableStream = new Writable({
        write(chunk, encoding, callback) {
          chunks.push(chunk);
          callback();
        },
      });

      writableStream.on('finish', () => {
        resolve(Buffer.concat(chunks));
      });

      archive.on('error', (err) => {
        reject(err);
      });

      archive.pipe(writableStream);

      // Procesar imágenes secuencialmente para conversión JPEG
      const processImages = async () => {
        const extension = outputFormat === OutputFormat.JPEG ? 'jpg' : 'png';

        for (let i = 0; i < sequence.length; i++) {
          const blockIdx = sequence[i];
          const pngBuffer = uniqueImages[blockIdx];

          let imageBuffer: Buffer;
          if (outputFormat === OutputFormat.JPEG) {
            // Convertir PNG a JPEG usando sharp
            imageBuffer = await sharp(pngBuffer)
              .jpeg({ quality: 90 })
              .toBuffer();
          } else {
            imageBuffer = pngBuffer;
          }

          // Nombre del archivo con índice secuencial (1-based)
          const filename = `label_${String(i + 1).padStart(4, '0')}.${extension}`;
          archive.append(imageBuffer, { name: filename });
        }

        await archive.finalize();
      };

      processImages().catch(reject);
    });
  }

  /**
   * Divide ZPL en bloques, extrae copias ^PQ y elimina ^PQ del contenido
   * @param zpl Contenido ZPL
   * @returns Bloques ZPL procesados
   */
  private splitAndExtractCopies(zpl: string): ParsedZplBlock[] {
    const blockMatches = zpl.match(/\^XA.*?\^XZ/gs) || [];
    let parsed: ParsedZplBlock[] = [];
    blockMatches.forEach((rawBlock, i) => {
      const normalized = this.normalizeZplBlock(rawBlock);
      const pqMatch = normalized.match(/\^PQ(\d+)/i);
      let copies = 1;
      if (pqMatch && pqMatch[1]) {
        copies = parseInt(pqMatch[1], 10) || 1;
      }
      const cleaned = normalized.replace(/\^PQ[^\^]+/i, '');

      parsed.push({
        normalizedContent: cleaned.trim(),
        copies,
        originalIndex: i,
      });
    });
    return parsed;
  }

  /**
   * Deduplica bloques ignorando 'copies' para la llamada a la API,
   * pero almacena las copias reales en originalSequence
   */
  private identifyUniqueBlocks(
    blocks: ParsedZplBlock[]
  ): UniqueBlocksResult {
    const uniqueBlocks: ParsedZplBlock[] = [];
    const blockMap = new Map<string, number>();
    const originalSequence: number[] = [];

    for (const pb of blocks) {
      const contentKey = pb.normalizedContent;
      let idx = blockMap.get(contentKey);
      if (idx === undefined) {
        idx = uniqueBlocks.length;
        blockMap.set(contentKey, idx);
        uniqueBlocks.push({
          normalizedContent: contentKey,
          copies: pb.copies,
          originalIndex: pb.originalIndex,
        });
      }
      for (let c = 0; c < pb.copies; c++) {
        originalSequence.push(idx);
      }
    }

    return {
      uniqueBlocks,
      originalSequence,
    };
  }

  /**
   * Calcula rangos de chunks para procesar bloques en lotes
   * @param totalBlocks Número total de bloques a procesar
   * @returns Array de rangos de chunks
   */
  private calculateChunkRanges(totalBlocks: number): ChunkRange[] {
    const ranges: ChunkRange[] = [];
    for (let i = 0; i < totalBlocks; i += this.CHUNK_SIZE) {
      ranges.push({
        start: i,
        end: Math.min(i + this.CHUNK_SIZE, totalBlocks),
      });
    }
    return ranges;
  }

  /**
   * Normaliza un bloque ZPL eliminando espacios innecesarios y estandarizando el formato
   * @param block Bloque ZPL a normalizar
   * @returns Bloque ZPL normalizado
   */
  private normalizeZplBlock(block: string): string {
    let normalized = block
      .replace(/[\r\n]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!normalized.startsWith('^XA')) {
      normalized = '^XA' + normalized;
    }
    if (!normalized.endsWith('^XZ')) {
      normalized = normalized + '^XZ';
    }

    return normalized;
  }

  /**
   * Llama a la API de Labelary para convertir ZPL a PDF
   * Usa el sistema de colas con prioridad por plan
   * @param zplBatch Cadena ZPL a convertir
   * @param labelSize Tamaño de la etiqueta
   * @param jobId ID del trabajo
   * @param userId ID del usuario
   * @param userPlan Plan del usuario (para prioridad en cola)
   * @param labelCount Número de etiquetas en el batch
   * @returns Buffer del PDF
   */
  private async callLabelary(
    zplBatch: string,
    labelSize: LabelSize,
    jobId: string,
    userId: string,
    userPlan: UserPlan,
    labelCount: number,
  ): Promise<Buffer> {
    // Validar límite de etiquetas por solicitud
    const actualLabelCount = (zplBatch.match(/\^XA/g) || []).length;
    if (actualLabelCount > this.CHUNK_SIZE) {
      throw new HttpException(
        `El número de etiquetas (${actualLabelCount}) excede el límite permitido (${this.CHUNK_SIZE} etiquetas por solicitud)`,
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }

    try {
      // Usar el sistema de colas con prioridad
      return await this.labelaryQueueService.enqueue(
        jobId,
        userId,
        userPlan,
        zplBatch,
        labelSize,
        labelCount,
      );
    } catch (error: any) {
      // Manejar errores específicos
      if (error instanceof HttpException) {
        throw error;
      }

      if (error.response?.status === 413) {
        this.logError(
          'LABEL_LIMIT_EXCEEDED',
          'LABELARY_PAYLOAD_TOO_LARGE',
          'Labels exceed 50 per request limit',
          'error',
          { labelSize },
        );
        throw new HttpException(
          'El número de etiquetas excede el límite permitido (50 etiquetas por solicitud)',
          HttpStatus.PAYLOAD_TOO_LARGE,
        );
      }

      // Log generic Labelary error
      this.logError(
        'SERVER_ERROR',
        'LABELARY_API_ERROR',
        `Labelary API error: ${error.message}`,
        'error',
        { status: error.response?.status },
      );
      throw new HttpException(
        'Error in Labelary API conversion',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Obtiene la posición en cola de un job
   * @param jobId ID del trabajo
   * @returns Información de posición en cola
   */
  getQueuePosition(jobId: string): QueuePositionResponse {
    return this.labelaryQueueService.getQueuePosition(jobId);
  }

  /**
   * Reconstruye el PDF final usando la secuencia original
   * OPTIMIZADO: Pre-carga chunks en paralelo y agrupa operaciones por chunk
   * @param chunkPdfs Array de buffers PDF de chunks
   * @param originalSequence Array de índices que representan el orden original
   * @returns Buffer del PDF final fusionado
   */
  private async reconstructFinalPdf(
    chunkPdfs: Buffer[],
    originalSequence: number[],
  ): Promise<Buffer> {
    const startTime = Date.now();
    try {
      // Validar que hay chunks para procesar
      if (!chunkPdfs || chunkPdfs.length === 0) {
        throw new Error('No hay PDFs para fusionar');
      }

      const validChunks = chunkPdfs.filter(chunk => chunk && chunk.length > 0);
      if (validChunks.length === 0) {
        throw new Error('Todos los chunks PDF están vacíos o son inválidos');
      }

      if (validChunks.length !== chunkPdfs.length) {
        this.logger.warn(`${chunkPdfs.length - validChunks.length} chunks PDF fueron descartados por estar vacíos`);
      }

      // OPTIMIZACIÓN 1: Pre-cargar todos los documentos en paralelo
      const loadStartTime = Date.now();
      const loadedDocs = await Promise.all(
        chunkPdfs.map(async (chunk, index) => {
          if (!chunk || chunk.length === 0) return null;
          try {
            return await PDFDocument.load(chunk, { ignoreEncryption: true });
          } catch (error) {
            this.logger.warn(`Error cargando chunk ${index}: ${error.message}`);
            return null;
          }
        })
      );
      this.logger.debug(`Pre-carga de ${chunkPdfs.length} chunks completada en ${Date.now() - loadStartTime}ms`);

      const finalDoc = await PDFDocument.create();
      finalDoc.setProducer('zplpdf-service');

      // OPTIMIZACIÓN 2: Agrupar páginas por chunk para copiar en batch
      const chunkPageGroups = new Map<number, {
        pageIndices: number[];
        outputPositions: number[];
      }>();

      originalSequence.forEach((blockIdx, outputPosition) => {
        const chunkNumber = Math.floor(blockIdx / this.CHUNK_SIZE);
        const pageInChunk = blockIdx % this.CHUNK_SIZE;

        if (!chunkPageGroups.has(chunkNumber)) {
          chunkPageGroups.set(chunkNumber, { pageIndices: [], outputPositions: [] });
        }

        const group = chunkPageGroups.get(chunkNumber)!;
        group.pageIndices.push(pageInChunk);
        group.outputPositions.push(outputPosition);
      });

      // OPTIMIZACIÓN 3: Copiar páginas en batch por chunk
      const copyStartTime = Date.now();
      const copiedPagesWithPositions: { page: any; position: number }[] = [];
      let skippedPages = 0;

      for (const [chunkNumber, group] of chunkPageGroups) {
        const srcDoc = loadedDocs[chunkNumber];

        if (!srcDoc) {
          this.logger.warn(`Chunk ${chunkNumber} no disponible, saltando ${group.pageIndices.length} páginas`);
          skippedPages += group.pageIndices.length;
          continue;
        }

        try {
          // Copiar TODAS las páginas necesarias de este chunk en UNA sola operación
          const copiedPages = await finalDoc.copyPages(srcDoc, group.pageIndices);
          copiedPages.forEach((page, i) => {
            copiedPagesWithPositions.push({
              page,
              position: group.outputPositions[i],
            });
          });
        } catch (error) {
          this.logger.warn(`Error copiando páginas del chunk ${chunkNumber}: ${error.message}`);
          skippedPages += group.pageIndices.length;
        }
      }
      this.logger.debug(`Copia de páginas completada en ${Date.now() - copyStartTime}ms`);

      // Ordenar y agregar páginas en el orden correcto
      const sortStartTime = Date.now();
      copiedPagesWithPositions.sort((a, b) => a.position - b.position);

      for (const { page } of copiedPagesWithPositions) {
        finalDoc.addPage(page);
      }
      this.logger.debug(`Ordenamiento y agregado de ${copiedPagesWithPositions.length} páginas en ${Date.now() - sortStartTime}ms`);

      if (skippedPages > 0) {
        this.logger.warn(`Se omitieron ${skippedPages} páginas durante la fusión`);
      }

      // Guardar como buffer
      const saveStartTime = Date.now();
      const pdfBytes = await finalDoc.save();
      const result = Buffer.from(pdfBytes);
      this.logger.debug(`Guardado de PDF (${result.length} bytes) completado en ${Date.now() - saveStartTime}ms`);

      if (!result || result.length === 0) {
        throw new Error('El PDF resultante está vacío');
      }

      this.logger.log(`Fusión de PDF completada: ${originalSequence.length} páginas en ${Date.now() - startTime}ms`);
      return result;
    } catch (error) {
      this.logger.error(`Error al fusionar PDFs: ${error.message}`);
      throw new HttpException(
        'Error merging PDF files',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Genera un nombre de archivo para almacenamiento y descarga
   * @param jobId ID del trabajo
   * @param labelSize Tamaño de la etiqueta
   * @param outputFormat Formato de salida
   * @param fileExtension Extensión del archivo
   * @param originalFilename Nombre original del archivo (opcional)
   * @param userPlan Plan del usuario (free, pro, enterprise)
   * @returns Objeto con nombres de archivo
   */
  private generateFilenames(
    jobId: string,
    labelSize: string,
    outputFormat: OutputFormat = OutputFormat.PDF,
    fileExtension: string = 'pdf',
    originalFilename?: string,
    userPlan?: string,
  ): { storageFilename: string; downloadFilename: string } {
    const storageFilename = `label-${jobId}.${fileExtension}`;

    // Para usuarios Pro/Enterprise con nombre original, usar ese nombre
    if (originalFilename && userPlan && userPlan !== 'free') {
      // Remover extensión original (.zpl, .txt, etc) y agregar la nueva
      const baseName = originalFilename.replace(/\.(zpl|txt|ZPL|TXT)$/i, '');
      return {
        storageFilename,
        downloadFilename: `${baseName}.${fileExtension}`,
      };
    }

    // Para usuarios Free, usar formato estándar zplpdf_size_timestamp
    let size: string;
    switch (labelSize.toLowerCase()) {
      case 'small':
      case '2x1':
        size = '2x1';
        break;
      case '2x4':
        size = '2x4';
        break;
      case '4x2':
        size = '4x2';
        break;
      case 'large':
      case '4x6':
        size = '4x6';
        break;
      default:
        size = labelSize;
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 14);
    const formatSuffix = outputFormat !== OutputFormat.PDF ? `_${outputFormat}` : '';
    return {
      storageFilename,
      downloadFilename: `zplpdf_${size}${formatSuffix}_${timestamp}.${fileExtension}`,
    };
  }

  /**
   * Genera una URL firmada para un archivo en Google Cloud Storage
   * @param storageFilename Nombre del archivo en storage
   * @param downloadFilename Nombre del archivo para descarga
   * @returns URL firmada con tiempo de expiración
   */
  private async generateSignedUrl(storageFilename: string, downloadFilename: string): Promise<string> {
    try {
      const options = {
        version: 'v4' as const,
        action: 'read' as const,
        expires: Date.now() + this.URL_EXPIRATION_TIME,
        responseDisposition: `attachment; filename="${downloadFilename}"`,
      };

      const file = this.storage.bucket(this.bucket).file(storageFilename);
      const [url] = await file.getSignedUrl(options);

      return url;
    } catch (error) {
      this.logger.error(`Error al generar URL firmada: ${error.message}`);
      throw new HttpException(
        'Error al generar URL de descarga',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Obtiene el tamaño de etiqueta correspondiente del enum
   * @param labelSize Tamaño de etiqueta en string
   * @returns LabelSize enum value
   */
  private getLabelSize(labelSize: string): LabelSize {
    switch (labelSize.toLowerCase()) {
      case 'small':
      case '2x1':
        return LabelSize.TWO_BY_ONE;
      case '2x4':
        return LabelSize.TWO_BY_FOUR;
      case '4x2':
        return LabelSize.FOUR_BY_TWO;
      case 'large':
      case '4x6':
        return LabelSize.FOUR_BY_SIX;
      default:
        return LabelSize.TWO_BY_ONE;
    }
  }

  /**
   * Cuenta el número total de etiquetas y copias en el contenido ZPL
   * @param zplContent Contenido ZPL a analizar
   * @returns Objeto con la respuesta formateada según estándares REST
   */
  async countLabels(zplContent: string): Promise<{
    success: boolean;
    message: string;
    data: {
      totalUniqueLabels: number;
      totalLabels: number;
    };
  }> {
    try {
      // Extraer y normalizar bloques ZPL
      const parsedBlocks = this.splitAndExtractCopies(zplContent);
      
      if (parsedBlocks.length === 0) {
        throw new HttpException(
          'No se encontraron etiquetas válidas en el contenido ZPL',
          HttpStatus.BAD_REQUEST
        );
      }

      // Calcular totales
      const totalUniqueLabels = parsedBlocks.length;
      const totalLabels = parsedBlocks.reduce((sum, block) => sum + block.copies, 0);

      return {
        success: true,
        message: 'Conteo de etiquetas realizado exitosamente',
        data: {
          totalUniqueLabels,
          totalLabels
        }
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Error al contar las etiquetas ZPL',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Obtiene una imagen PNG de una etiqueta ZPL desde Labelary
   * @param zplContent Contenido ZPL de una sola etiqueta
   * @param labelSize Tamaño de la etiqueta
   * @returns Buffer de la imagen PNG
   */
  private async getSingleLabelaryPngImage(zplContent: string, labelSize: LabelSize): Promise<Buffer> {
    try {
      this.logger.debug(`Enviando solicitud a Labelary para una etiqueta PNG`);
      return await this.labelaryQueueService.enqueuePngDirect(zplContent, labelSize);
    } catch (error) {
      this.logger.error(`Error en Labelary API (PNG): ${error.message}`);
      throw error;
    }
  }

  /**
   * Obtiene las imágenes PNG de las etiquetas desde Labelary
   * @param zplContent Contenido ZPL a convertir
   * @param labelSize Tamaño de la etiqueta
   * @returns Array de buffers PNG
   */
  private async getLabelaryPngImages(zplContent: string, labelSize: LabelSize): Promise<Buffer[]> {
    try {
      // Extraer etiquetas individuales
      const labelMatches = zplContent.match(/\^XA.*?\^XZ/gs);
      if (!labelMatches) {
        throw new HttpException(
          'No se encontraron etiquetas válidas en el contenido ZPL',
          HttpStatus.BAD_REQUEST
        );
      }

      this.logger.debug(`Procesando ${labelMatches.length} etiquetas individuales`);
      
      // Procesar cada etiqueta individualmente
      const pngPromises = labelMatches.map(label => 
        this.getSingleLabelaryPngImage(label, labelSize)
      );
      
      // Esperar a que todas las solicitudes se completen
      const pngBuffers = await Promise.all(pngPromises);
      
      this.logger.debug(`Imágenes PNG obtenidas: ${pngBuffers.length}`);
      return pngBuffers;
    } catch (error) {
      this.logger.error(`Error al obtener imágenes: ${error.message}`);
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        'Error al obtener imágenes de Labelary API',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Obtiene las previsualizaciones de las etiquetas únicas con sus cantidades
   * @param zplContent Contenido ZPL a analizar
   * @param labelSize Tamaño de la etiqueta
   * @returns Array de objetos con imagen y cantidad de cada etiqueta única
   */
  async getLabelsPreview(zplContent: string, labelSize: LabelSize): Promise<ZplPreviewItemDto[]> {
    try {
      // 1. Extraer etiquetas individuales (separar por ^XA...^XZ)
      const labelMatches = zplContent.match(/\^XA.*?\^XZ/gs);
      if (!labelMatches) {
        throw new HttpException(
          'No se encontraron etiquetas válidas en el contenido ZPL',
          HttpStatus.BAD_REQUEST
        );
      }

      // 2. Procesar etiquetas y contar duplicados
      const uniqueLabels = new Map<string, number>();
      const normalizedLabels: string[] = [];

      for (const label of labelMatches) {
        let normalized = label
          .replace(/[\r\n]+/g, '') // Eliminar saltos de línea
          .replace(/\s+/g, ' ')    // Normalizar espacios
          .trim();

        // Extraer y eliminar ^PQ para contar copias
        const pqMatch = normalized.match(/\^PQ(\d+)/);
        const copies = pqMatch ? parseInt(pqMatch[1], 10) : 1;
        normalized = normalized.replace(/\^PQ\d+,?\d*,?\d*,?\d*/g, '');

        // Asegurar formato ZPL correcto
        if (!normalized.startsWith('^XA')) normalized = '^XA' + normalized;
        if (!normalized.endsWith('^XZ')) normalized += '^XZ';

        uniqueLabels.set(normalized, (uniqueLabels.get(normalized) || 0) + copies);
        if (!normalizedLabels.includes(normalized)) {
          normalizedLabels.push(normalized);
        }
      }

      this.logger.debug(`Total de etiquetas encontradas: ${labelMatches.length}`);
      this.logger.debug(`Total de etiquetas únicas: ${normalizedLabels.length}`);

      // 3. Procesar etiquetas y generar previsualizaciones
      const labelPreviews: ZplPreviewItemDto[] = [];

      // Procesar cada etiqueta única individualmente, pero secuencialmente para evitar errores de rate limit
      for (const zpl of normalizedLabels) {
        try {
          const buffer = await this.getSingleLabelaryPngImage(zpl, labelSize);
          labelPreviews.push({
            img: `data:image/png;base64,${buffer.toString('base64')}`,
            qty: uniqueLabels.get(zpl) || 0,
          });
        } catch (error) {
          this.logger.error(`Error al procesar etiqueta: ${error.message}`);
          // Continuar con la siguiente etiqueta
        }
      }

      this.logger.debug(`Total de previsualizaciones generadas: ${labelPreviews.length}`);
      return labelPreviews;
    } catch (error) {
      this.logger.error(`Error al obtener previsualizaciones: ${error.message}`);
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        'Error al generar previsualizaciones de etiquetas',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  // ============== BATCH PROCESSING ==============

  /**
   * Inicia una conversión batch de múltiples archivos ZPL
   * @param userId ID del usuario
   * @param files Array de archivos ZPL
   * @param labelSize Tamaño de etiqueta
   * @param outputFormat Formato de salida
   * @returns Objeto con batchId y array de jobs
   */
  async startBatchConversion(
    userId: string,
    files: { id: string; content: string; fileName: string }[],
    labelSize: string,
    outputFormat: 'pdf' | 'png' | 'jpeg' = 'pdf',
  ): Promise<{ batchId: string; jobs: { fileId: string; jobId: string }[] }> {
    try {
      // Validar plan del usuario
      const user = await this.usersService.getUserById(userId);
      if (!user) {
        throw new HttpException(
          { error: ErrorCodes.USER_NOT_FOUND, message: 'Usuario no encontrado' },
          HttpStatus.NOT_FOUND,
        );
      }

      const planLimits = BATCH_LIMITS[user.plan] || BATCH_LIMITS.free;

      if (!planLimits.batchAllowed) {
        throw new HttpException(
          { error: ErrorCodes.BATCH_NOT_ALLOWED, message: 'El procesamiento batch no está disponible para tu plan' },
          HttpStatus.FORBIDDEN,
        );
      }

      if (files.length > planLimits.maxFilesPerBatch) {
        throw new HttpException(
          {
            error: ErrorCodes.BATCH_LIMIT_EXCEEDED,
            message: `Excedes el límite de ${planLimits.maxFilesPerBatch} archivos por batch`,
            data: { maxFiles: planLimits.maxFilesPerBatch, requestedFiles: files.length }
          },
          HttpStatus.FORBIDDEN,
        );
      }

      // Validar tamaño de cada archivo
      for (const file of files) {
        const fileSize = Buffer.byteLength(file.content, 'utf8');
        if (fileSize > planLimits.maxFileSizeBytes) {
          throw new HttpException(
            {
              error: ErrorCodes.FILE_TOO_LARGE,
              message: `El archivo ${file.fileName} excede el límite de ${planLimits.maxFileSizeBytes / (1024 * 1024)}MB`,
              data: { fileName: file.fileName, size: fileSize, maxSize: planLimits.maxFileSizeBytes }
            },
            HttpStatus.PAYLOAD_TOO_LARGE,
          );
        }
      }

      // Validar total de labels en todos los archivos del batch
      let totalLabels = 0;
      for (const file of files) {
        try {
          const countResult = await this.countLabels(file.content);
          totalLabels += countResult.data.totalLabels;
        } catch (error) {
          this.logger.warn(`Error contando labels en ${file.fileName}: ${error.message}`);
          // Asumir al menos 1 label si hay error
          totalLabels += 1;
        }
      }

      // Verificar límites de usuario
      const userLimits = await this.usersService.checkCanConvert(userId, totalLabels);
      if (!userLimits.allowed) {
        throw new HttpException(
          {
            error: userLimits.errorCode || 'LIMIT_EXCEEDED',
            message: userLimits.error,
            data: {
              ...userLimits.data,
              totalLabelsInBatch: totalLabels,
            },
          },
          HttpStatus.FORBIDDEN,
        );
      }

      // Generar IDs
      const batchId = `batch_${uuidv4()}`;
      const now = new Date();

      // Crear jobs para cada archivo
      const batchJobs: BatchFileJob[] = files.map((file) => ({
        jobId: `job_${uuidv4()}`,
        fileId: file.id,
        fileName: file.fileName,
        status: 'pending' as const,
        progress: 0,
      }));

      // Crear el batch completo
      const batch: BatchJob = {
        id: batchId,
        userId,
        status: 'processing',
        totalFiles: files.length,
        completedFiles: 0,
        failedFiles: 0,
        outputFormat,
        labelSize,
        jobs: batchJobs,
        createdAt: now,
        updatedAt: now,
      };

      // Guardar en Firestore
      await this.firestoreService.saveBatchJob(batch);

      // Procesar archivos en paralelo (con límite)
      const jobsMapping = batchJobs.map((job) => ({
        fileId: job.fileId,
        jobId: job.jobId,
      }));

      // Iniciar procesamiento asíncrono
      const periodId = userLimits.periodInfo?.periodId;
      this.processBatchFiles(batchId, files, batchJobs, labelSize, outputFormat, periodId);

      return { batchId, jobs: jobsMapping };
    } catch (error) {
      this.logger.error(`Error al iniciar batch: ${error.message}`);
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        'Error al iniciar procesamiento batch',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Procesa los archivos de un batch de forma asíncrona
   */
  private async processBatchFiles(
    batchId: string,
    files: { id: string; content: string; fileName: string }[],
    jobs: BatchFileJob[],
    labelSize: string,
    outputFormat: 'pdf' | 'png' | 'jpeg',
    periodId?: string,
  ): Promise<void> {
    const size = this.getLabelSize(labelSize);
    let completedCount = 0;
    let failedCount = 0;

    // Obtener el userId y userPlan del batch desde Firestore
    const batch = await this.firestoreService.getBatchJob(batchId);
    const userId = batch?.userId;

    // Obtener el plan del usuario (batch solo disponible para pro/enterprise)
    let userPlan: UserPlan = 'pro';
    if (userId) {
      try {
        const user = await this.usersService.getUserById(userId);
        userPlan = (user?.plan as UserPlan) || 'pro';
      } catch {
        userPlan = 'pro'; // Default para batch
      }
    }

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const job = jobs[i];

      // Contar labels en el archivo actual
      let labelCount = 1;
      try {
        const countResult = await this.countLabels(file.content);
        labelCount = countResult.data.totalLabels;
      } catch (error) {
        this.logger.warn(`Error contando labels en ${file.fileName}: ${error.message}`);
      }

      try {
        // Actualizar estado a procesando
        job.status = 'processing';
        job.progress = 10;
        await this.updateBatchJobProgress(batchId, jobs, completedCount, failedCount);

        // Convertir el archivo
        let resultBuffer: Buffer;
        let contentType: string;
        let fileExtension: string;

        if (outputFormat === 'pdf') {
          resultBuffer = await this.convertZplToPdf(file.content, size, job.jobId, userId || 'batch', userPlan);
          contentType = 'application/pdf';
          fileExtension = 'pdf';
        } else {
          resultBuffer = await this.convertZplToImages(
            file.content,
            size,
            outputFormat === 'png' ? OutputFormat.PNG : OutputFormat.JPEG,
            job.jobId,
            userId || 'batch',
            userPlan,
          );
          contentType = 'application/zip';
          fileExtension = 'zip';
        }

        // Guardar archivo temporal en GCS
        const tempPath = `batches/${batchId}/temp/${job.jobId}.${fileExtension}`;
        await this.storage.bucket(this.bucket).file(tempPath).save(resultBuffer, { contentType });

        // Marcar como completado
        job.status = 'completed';
        job.progress = 100;
        job.tempStoragePath = tempPath;
        completedCount++;

        // Registrar conversión exitosa para este archivo del batch
        if (userId) {
          await this.usersService.recordConversion(
            userId,
            job.jobId,
            labelCount,
            labelSize,
            'completed',
            outputFormat,
            undefined,
            periodId,
          );
        }

        this.logger.log(`Batch ${batchId}: Archivo ${file.fileName} completado`);
      } catch (error) {
        this.logger.error(`Batch ${batchId}: Error procesando ${file.fileName}: ${error.message}`);
        job.status = 'failed';
        job.error = error.message;
        failedCount++;

        // Registrar conversión fallida
        if (userId) {
          try {
            await this.usersService.recordConversion(
              userId,
              job.jobId,
              labelCount,
              labelSize,
              'failed',
              outputFormat,
              undefined,
              periodId,
            );
          } catch (recordError) {
            this.logger.error(`Error registrando conversión fallida: ${recordError.message}`);
          }
        }
      }

      await this.updateBatchJobProgress(batchId, jobs, completedCount, failedCount);
    }

    // Finalizar el batch
    await this.finalizeBatch(batchId, jobs, completedCount, failedCount, outputFormat);
  }

  /**
   * Actualiza el progreso del batch en Firestore
   */
  private async updateBatchJobProgress(
    batchId: string,
    jobs: BatchFileJob[],
    completedCount: number,
    failedCount: number,
  ): Promise<void> {
    await this.firestoreService.updateBatchJob(batchId, {
      jobs,
      completedFiles: completedCount,
      failedFiles: failedCount,
    });
  }

  /**
   * Finaliza un batch creando el ZIP con todos los archivos
   */
  private async finalizeBatch(
    batchId: string,
    jobs: BatchFileJob[],
    completedCount: number,
    failedCount: number,
    outputFormat: 'pdf' | 'png' | 'jpeg',
  ): Promise<void> {
    try {
      const completedJobs = jobs.filter((j) => j.status === 'completed' && j.tempStoragePath);

      if (completedJobs.length === 0) {
        await this.firestoreService.updateBatchJob(batchId, {
          status: 'failed',
          jobs,
          completedFiles: completedCount,
          failedFiles: failedCount,
        });
        return;
      }

      // Crear ZIP con todos los archivos completados
      const zipBuffer = await this.createBatchZip(batchId, completedJobs, outputFormat);

      // Guardar ZIP en GCS
      const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 14);
      const zipFilename = `zpl-batch-${timestamp}.zip`;
      const zipPath = `batches/${batchId}/${zipFilename}`;

      await this.storage.bucket(this.bucket).file(zipPath).save(zipBuffer, {
        contentType: 'application/zip',
      });

      // Generar URL firmada
      const downloadUrl = await this.generateSignedUrl(zipPath, zipFilename);

      // Determinar estado final
      let status: 'completed' | 'partial' | 'failed' = 'completed';
      if (failedCount > 0 && completedCount > 0) {
        status = 'partial';
      } else if (failedCount > 0 && completedCount === 0) {
        status = 'failed';
      }

      await this.firestoreService.updateBatchJob(batchId, {
        status,
        jobs,
        completedFiles: completedCount,
        failedFiles: failedCount,
        downloadUrl,
        zipFilename,
      });

      // Limpiar archivos temporales
      this.cleanupBatchTempFiles(batchId, completedJobs);

      this.logger.log(`Batch ${batchId} finalizado con estado: ${status}`);
    } catch (error) {
      this.logger.error(`Error finalizando batch ${batchId}: ${error.message}`);
      await this.firestoreService.updateBatchJob(batchId, {
        status: 'failed',
        jobs,
        completedFiles: completedCount,
        failedFiles: failedCount,
      });
    }
  }

  /**
   * Crea un ZIP con todos los archivos del batch
   */
  private async createBatchZip(
    batchId: string,
    jobs: BatchFileJob[],
    outputFormat: 'pdf' | 'png' | 'jpeg',
  ): Promise<Buffer> {
    return new Promise(async (resolve, reject) => {
      const chunks: Buffer[] = [];
      const archive = archiver('zip', { zlib: { level: 9 } });

      const writableStream = new Writable({
        write(chunk, encoding, callback) {
          chunks.push(chunk);
          callback();
        },
      });

      writableStream.on('finish', () => {
        resolve(Buffer.concat(chunks));
      });

      archive.on('error', reject);
      archive.pipe(writableStream);

      // Agregar cada archivo al ZIP
      for (const job of jobs) {
        if (!job.tempStoragePath) continue;

        try {
          const file = this.storage.bucket(this.bucket).file(job.tempStoragePath);
          const [fileBuffer] = await file.download();

          // Determinar extensión según el formato
          const extension = outputFormat === 'pdf' ? 'pdf' : 'zip';
          const fileName = job.fileName.replace(/\.(zpl|txt)$/i, '') + `.${extension}`;

          archive.append(fileBuffer, { name: fileName });
        } catch (error) {
          this.logger.error(`Error agregando archivo ${job.fileName} al ZIP: ${error.message}`);
        }
      }

      await archive.finalize();
    });
  }

  /**
   * Limpia los archivos temporales de un batch
   */
  private async cleanupBatchTempFiles(batchId: string, jobs: BatchFileJob[]): Promise<void> {
    try {
      for (const job of jobs) {
        if (job.tempStoragePath) {
          await this.storage.bucket(this.bucket).file(job.tempStoragePath).delete().catch(() => {});
        }
      }
      this.logger.log(`Archivos temporales del batch ${batchId} eliminados`);
    } catch (error) {
      this.logger.warn(`Error limpiando archivos temporales del batch ${batchId}: ${error.message}`);
    }
  }

  /**
   * Obtiene el estado de un batch (con validación de propiedad)
   * @param batchId ID del batch
   * @param userId ID del usuario
   * @returns Estado del batch con todos los jobs
   */
  async getBatchStatus(batchId: string, userId: string): Promise<{
    batchId: string;
    status: string;
    totalFiles: number;
    completedFiles: number;
    jobs: { jobId: string; status: string; progress: number; error?: string }[];
    downloadUrl?: string;
  }> {
    const batch = await this.firestoreService.getBatchJob(batchId);

    if (!batch) {
      throw new HttpException(
        { error: ErrorCodes.BATCH_NOT_FOUND, message: 'Batch no encontrado', data: { batchId } },
        HttpStatus.NOT_FOUND,
      );
    }

    // Validar propiedad del recurso
    if (batch.userId !== userId) {
      throw new HttpException(
        { error: ErrorCodes.ACCESS_DENIED, message: 'No tienes acceso a este recurso' },
        HttpStatus.FORBIDDEN,
      );
    }

    return {
      batchId: batch.id,
      status: batch.status,
      totalFiles: batch.totalFiles,
      completedFiles: batch.completedFiles,
      jobs: batch.jobs.map((j) => ({
        jobId: j.jobId,
        status: j.status,
        progress: j.progress,
        error: j.error,
      })),
      downloadUrl: batch.downloadUrl,
    };
  }

  /**
   * Obtiene el estado de un batch (público, sin validación de propiedad)
   * La validación de propiedad se hace en el endpoint de descarga
   * @param batchId ID del batch
   * @returns Estado del batch con todos los jobs
   */
  async getBatchStatusPublic(batchId: string): Promise<{
    batchId: string;
    status: string;
    totalFiles: number;
    completedFiles: number;
    jobs: { jobId: string; status: string; progress: number; error?: string }[];
    downloadUrl?: string;
  }> {
    const batch = await this.firestoreService.getBatchJob(batchId);

    if (!batch) {
      throw new HttpException(
        { error: ErrorCodes.BATCH_NOT_FOUND, message: 'Batch no encontrado', data: { batchId } },
        HttpStatus.NOT_FOUND,
      );
    }

    return {
      batchId: batch.id,
      status: batch.status,
      totalFiles: batch.totalFiles,
      completedFiles: batch.completedFiles,
      jobs: batch.jobs.map((j) => ({
        jobId: j.jobId,
        status: j.status,
        progress: j.progress,
        error: j.error,
      })),
      downloadUrl: batch.downloadUrl,
    };
  }

  /**
   * Obtiene la URL de descarga de un batch completado
   * @param batchId ID del batch
   * @returns URL de descarga y metadata
   */
  async getBatchDownload(batchId: string, userId: string): Promise<{
    url: string;
    filename: string;
    expiresAt: string;
  }> {
    const batch = await this.firestoreService.getBatchJob(batchId);

    if (!batch) {
      throw new HttpException(
        { error: ErrorCodes.BATCH_NOT_FOUND, message: 'Batch no encontrado', data: { batchId } },
        HttpStatus.NOT_FOUND,
      );
    }

    // Validar propiedad del recurso
    if (batch.userId !== userId) {
      throw new HttpException(
        { error: ErrorCodes.ACCESS_DENIED, message: 'No tienes acceso a este recurso' },
        HttpStatus.FORBIDDEN,
      );
    }

    if (batch.status === 'processing') {
      throw new HttpException(
        { error: ErrorCodes.BATCH_PROCESSING, message: 'El batch aún está procesándose', data: { batchId, currentStatus: batch.status } },
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!batch.downloadUrl || !batch.zipFilename) {
      throw new HttpException(
        { error: ErrorCodes.DOWNLOAD_NOT_AVAILABLE, message: 'No hay archivos disponibles para descargar', data: { batchId } },
        HttpStatus.NOT_FOUND,
      );
    }

    // Regenerar URL firmada si es necesario
    const zipPath = `batches/${batchId}/${batch.zipFilename}`;
    const freshUrl = await this.generateSignedUrl(zipPath, batch.zipFilename);
    const expiresAt = new Date(Date.now() + this.URL_EXPIRATION_TIME).toISOString();

    return {
      url: freshUrl,
      filename: batch.zipFilename,
      expiresAt,
    };
  }
} 