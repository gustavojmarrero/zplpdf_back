import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import axios from 'axios';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import PDFMerger from 'pdf-merger-js';
import { Storage } from '@google-cloud/storage';
import { ConfigService } from '@nestjs/config';
import Bottleneck from 'bottleneck';

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
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  resultUrl?: string;
  filename?: string;
  error?: string;
  createdAt: Date;
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
  
  // Limiter para la API de Labelary (3 llamadas por segundo con reintentos)
  private readonly labelaryLimiter = new Bottleneck({
    maxConcurrent: 1,
    minTime: 350, // 350ms entre llamadas = ~3 llamadas por segundo
    reservoir: 10, // Máximo 10 solicitudes en cola
    reservoirRefreshAmount: 10,
    reservoirRefreshInterval: 5 * 1000, // Refresca cada 5 segundos
    
    // Estrategia de reintentos
    retryLimit: 3,
    retryDelay: 1000 // 1 segundo entre reintentos
  });

  constructor(private configService: ConfigService) {
    const credentials = JSON.parse(
      this.configService.get<string>('GOOGLE_CREDENTIALS'),
    );
    // Inicializar el cliente de Storage
    this.storage = new Storage({
      credentials,
      projectId: credentials.project_id,
    });
    // Nombre del bucket
    this.bucket = 'zplpdf-app-files';
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
   * Inicia un proceso de conversión ZPL
   * @param zplContent Contenido ZPL a convertir
   * @param labelSize Tamaño de la etiqueta
   * @param language Idioma para los mensajes
   * @returns ID del trabajo creado
   */
  async startZplConversion(
    zplContent: string,
    labelSize: string,
    language = 'en',
  ): Promise<string> {
    try {
      if (!zplContent) {
        throw new HttpException(
          'Debe proporcionar el contenido ZPL ya sea como texto o como archivo',
          HttpStatus.BAD_REQUEST,
        );
      }

      const size = this.getLabelSize(labelSize);
      const jobId = uuidv4();

      // Crear y guardar el trabajo
      this.jobs.set(jobId, {
        id: jobId,
        zplContent,
        labelSize: size,
        status: 'pending',
        progress: 0,
        createdAt: new Date(),
      });

      // Encolar el trabajo para procesamiento asíncrono
      // (En un caso real, esto podría ir a un sistema de colas como Bull/Redis)
      setTimeout(() => {
        this.processZplConversion(zplContent, labelSize, jobId);
      }, 100);

      return jobId;
    } catch (error) {
      this.logger.error(`Error al iniciar conversión ZPL: ${error.message}`);
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Error al iniciar la conversión ZPL',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Procesa la conversión ZPL a PDF (método que sería llamado por un worker)
   * @param zplContent Contenido ZPL a convertir
   * @param labelSize Tamaño de la etiqueta
   * @param jobId ID del trabajo
   */
  async processZplConversion(
    zplContent: string,
    labelSize: string,
    jobId: string,
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

      // Convertir ZPL a PDF
      const size = job.labelSize;
      const pdfBuffer = await this.convertZplToPdf(zplContent, size);

      // Generar nombres de archivo
      const { storageFilename, downloadFilename } = this.generateFilenames(jobId, labelSize);

      // Guardar el archivo en Google Cloud Storage
      await this.storage
        .bucket(this.bucket)
        .file(storageFilename)
        .save(pdfBuffer, {
          contentType: 'application/pdf',
        });

      // Generar URL firmada
      const signedUrl = await this.generateSignedUrl(storageFilename, downloadFilename);

      // Actualizar estado a completado
      job.status = 'completed';
      job.progress = 100;
      job.resultUrl = signedUrl;
      job.filename = downloadFilename;
      this.jobs.set(jobId, job);

      this.logger.log(`Conversión completada para trabajo ${jobId}`);
    } catch (error) {
      this.logger.error(`Error al procesar conversión ZPL: ${error.message}`);
      
      // Actualizar estado a fallido
      job.status = 'failed';
      job.error = error.message;
      this.jobs.set(jobId, job);
    }
  }

  /**
   * Obtiene el estado actual de una conversión
   * @param jobId ID del trabajo
   * @returns Estado del trabajo
   */
  async getConversionStatus(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new HttpException('Trabajo no encontrado', HttpStatus.NOT_FOUND);
    }

    return {
      status: job.status,
      progress: job.progress,
      message: this.getStatusMessage(job),
    };
  }

  /**
   * Obtiene la URL de descarga del PDF convertido
   * @param jobId ID del trabajo
   * @returns URL y nombre del archivo
   */
  async getPdfDownloadUrl(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new HttpException('Trabajo no encontrado', HttpStatus.NOT_FOUND);
    }

    if (job.status !== 'completed') {
      throw new HttpException(
        'La conversión no está completa', 
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!job.resultUrl || !job.filename) {
      throw new HttpException(
        'No se encuentra el archivo de resultado', 
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
   * @returns Buffer del PDF
   */
  private async convertZplToPdf(zplRaw: string, labelSize: LabelSize): Promise<Buffer> {
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
        const pdfBuffer = await this.callLabelary(chunkZpl, labelSize);
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
   * @param zpl Cadena ZPL a convertir
   * @param labelSize Tamaño de la etiqueta
   * @returns Buffer del PDF
   */
  private async callLabelary(zplBatch: string, labelSize: LabelSize): Promise<Buffer> {
    try {
      const url = `http://api.labelary.com/v1/printers/8dpmm/labels/${labelSize}`;

      const labelCount = (zplBatch.match(/\^XA/g) || []).length;

      if (labelCount > this.CHUNK_SIZE) {
        throw new HttpException(
          `El número de etiquetas (${labelCount}) excede el límite permitido (${this.CHUNK_SIZE} etiquetas por solicitud)`,
          HttpStatus.PAYLOAD_TOO_LARGE
        );
      }

      const response = await axios.post(url, zplBatch, {
        headers: {
          Accept: 'application/pdf',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        responseType: 'arraybuffer',
      });

      if (response.status !== 200) {
        throw new Error(`Labelary API error: ${response.status}`);
      }

      return Buffer.from(response.data);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      if (error.response?.status === 413) {
        throw new HttpException(
          'El número de etiquetas excede el límite permitido (50 etiquetas por solicitud)',
          HttpStatus.PAYLOAD_TOO_LARGE
        );
      }
      throw new HttpException(
        'Error in Labelary API conversion',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Reconstruye el PDF final usando la secuencia original
   * @param chunkPdfs Array de buffers PDF de chunks
   * @param originalSequence Array de índices que representan el orden original
   * @returns Buffer del PDF final fusionado
   */
  private async reconstructFinalPdf(
    chunkPdfs: Buffer[],
    originalSequence: number[],
  ): Promise<Buffer> {
    try {
      const merger = new PDFMerger();
      let lastChunkUsed = -1;
      let lastDocPages = 0;

      for (const blockIdx of originalSequence) {
        const chunkNumber = Math.floor(blockIdx / this.CHUNK_SIZE);
        const pageInChunk = (blockIdx % this.CHUNK_SIZE) + 1;

        if (chunkNumber !== lastChunkUsed) {
          lastChunkUsed = chunkNumber;
          const chunkPdfData = chunkPdfs[chunkNumber];
          const tempMerger = new PDFMerger();
          await tempMerger.add(chunkPdfData);
          lastDocPages = (await tempMerger.saveAsBuffer()).length;
        }

        await merger.add(chunkPdfs[chunkNumber], pageInChunk.toString());
      }

      return await merger.saveAsBuffer();
    } catch (error) {
      this.logger.error('Error al fusionar PDFs:', error);
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
   * @returns Objeto con nombres de archivo
   */
  private generateFilenames(jobId: string, labelSize: string): { storageFilename: string; downloadFilename: string } {
    const size = labelSize === 'large' ? '4x6' : '2x1';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 14); // YYYYMMDDHHmmss
    return {
      storageFilename: `label-${jobId}.pdf`,
      downloadFilename: `zplpdf_${size}_${timestamp}.pdf`
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
    return this.labelaryLimiter.schedule(async () => {
      try {
        const url = `http://api.labelary.com/v1/printers/8dpmm/labels/${labelSize}/0/`;
        
        this.logger.debug(`Enviando solicitud a Labelary para una etiqueta`);

        const response = await axios({
          method: 'post',
          url: url,
          data: zplContent,
          headers: {
            Accept: 'image/png',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          responseType: 'arraybuffer',
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          transformRequest: [(data) => data],
        });

        if (response.status !== 200) {
          throw new Error(`Labelary API respondió con estado ${response.status}`);
        }

        return Buffer.from(response.data);
      } catch (error) {
        this.logger.error(`Error en Labelary API: ${error.message}`);
        if (error.response?.data) {
          const errorText = Buffer.from(error.response.data).toString();
          this.logger.error(`Respuesta de error de Labelary: ${errorText}`);
        }
        
        // Si es un error 429 (rate limit), lanzar un error especial para que Bottleneck lo reintente
        if (error.response?.status === 429) {
          throw new Bottleneck.BottleneckError(`Rate limit excedido: ${error.message}`);
        }
        
        throw new Error(`Error al obtener imagen de Labelary API: ${error.message}`);
      }
    });
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
} 