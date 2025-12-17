import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  HttpStatus,
  HttpCode,
  UseInterceptors,
  UploadedFile,
  UploadedFiles,
  ParseFilePipe,
  MaxFileSizeValidator,
  HttpException,
  UseGuards,
} from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { ZplService } from './zpl.service.js';
import { ConvertZplDto } from './dto/convert-zpl.dto.js';
import { ValidateZplDto } from './dto/validate-zpl.dto.js';
import { ValidationResponseDto } from './dto/validation-response.dto.js';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiConsumes,
  ApiBody,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { LabelSize } from './enums/label-size.enum.js';
import { OutputFormat } from './enums/output-format.enum.js';
import { ZplPreviewItemDto, ZplPreviewResponseDto } from './dto/zpl-preview.dto.js';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { FirebaseUser } from '../../common/decorators/current-user.decorator.js';
import { ZplValidatorService } from './validation/zpl-validator.service.js';
import {
  BatchConvertDto,
  BatchConvertResponseDto,
  BatchStatusResponseDto,
  BatchDownloadResponseDto,
} from './dto/batch.dto.js';

interface ProcessZplDto {
  zplContent: string;
  labelSize: LabelSize;
  jobId: string;
  language: string;
}

@ApiTags('zpl')
@Controller('zpl')
export class ZplController {
  constructor(
    private readonly zplService: ZplService,
    private readonly zplValidatorService: ZplValidatorService,
  ) {}

  @Post('convert')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(FirebaseAuthGuard)
  @ApiBearerAuth()
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Iniciar conversion de ZPL a PDF/PNG/JPEG',
    description: 'Recibe codigo ZPL (como texto o archivo) y comienza un proceso asincrono de conversion. PDF disponible para todos los usuarios. PNG y JPEG solo para usuarios Pro y Enterprise. Requiere autenticacion.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Archivo ZPL a convertir (max 1MB)',
        },
        zplContent: {
          type: 'string',
          description: 'Contenido ZPL a convertir (opcional si se envia archivo)',
        },
        labelSize: {
          type: 'string',
          enum: [LabelSize.TWO_BY_ONE, LabelSize.TWO_BY_FOUR, LabelSize.FOUR_BY_TWO, LabelSize.FOUR_BY_SIX],
          default: LabelSize.TWO_BY_ONE,
          description: 'Tamano de la etiqueta (2x1, 2x4, 4x2 o 4x6 pulgadas)',
        },
        language: {
          type: 'string',
          default: 'es',
          description: 'Idioma para los mensajes',
        },
        outputFormat: {
          type: 'string',
          enum: [OutputFormat.PDF, OutputFormat.PNG, OutputFormat.JPEG],
          default: OutputFormat.PDF,
          description: 'Formato de salida (pdf, png, jpeg). PNG y JPEG solo para Pro/Enterprise',
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.ACCEPTED,
    description: 'Conversion iniciada correctamente',
    schema: {
      properties: {
        jobId: {
          type: 'string',
          example: '1234-5678-90ab',
        },
        message: {
          type: 'string',
          example: 'Conversion iniciada. Use el endpoint /status para verificar el estado.',
        },
        statusUrl: {
          type: 'string',
          example: '/api/zpl/status/1234-5678-90ab',
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Datos de entrada invalidos',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Token de autenticacion invalido o faltante',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Limite de plan excedido',
    schema: {
      properties: {
        error: { type: 'string', example: 'LABEL_LIMIT_EXCEEDED' },
        message: { type: 'string', example: 'Your plan allows 100 labels per PDF' },
        data: {
          type: 'object',
          properties: {
            requested: { type: 'number', example: 150 },
            allowed: { type: 'number', example: 100 },
          },
        },
      },
    },
  })
  async convertZpl(
    @CurrentUser() user: FirebaseUser,
    @Body() convertZplDto: ConvertZplDto,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 1024 * 1024 }), // 1MB max
        ],
        fileIsRequired: false,
      }),
    ) file?: Express.Multer.File,
  ) {
    // Si se proporciona un archivo, usar su contenido
    const zplContent = file
      ? file.buffer.toString('utf-8')
      : convertZplDto.zplContent;

    // Validacion basica
    this.validateZplContent(zplContent);

    // Validacion robusta antes de procesar
    const language = (convertZplDto.language || 'es') as 'es' | 'en';
    const validation = await this.zplValidatorService.validate(zplContent, {
      language,
    });

    // Si hay errores criticos, rechazar
    if (!validation.isValid) {
      throw new HttpException(
        {
          error: 'VALIDATION_FAILED',
          message:
            language === 'es'
              ? 'El contenido ZPL tiene errores de sintaxis'
              : 'ZPL content has syntax errors',
          errors: validation.errors.slice(0, 5),
          summary: validation.summary,
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const jobId = await this.zplService.startZplConversion(
      zplContent,
      convertZplDto.labelSize,
      convertZplDto.language || 'en',
      user.uid,
      convertZplDto.outputFormat || OutputFormat.PDF,
      file?.originalname,
    );

    // Incluir warnings en la respuesta si los hay
    const response: {
      jobId: string;
      message: string;
      statusUrl: string;
      warnings?: typeof validation.warnings;
    } = {
      jobId,
      message: 'Conversion iniciada. Use el endpoint /status para verificar el estado.',
      statusUrl: `/api/zpl/status/${jobId}`,
    };

    if (validation.warnings.length > 0) {
      response.warnings = validation.warnings.slice(0, 3);
    }

    return response;
  }

  private validateZplContent(content: string): void {
    if (!content || typeof content !== 'string') {
      throw new HttpException(
        'El contenido ZPL es requerido y debe ser texto',
        HttpStatus.BAD_REQUEST
      );
    }

    if (!content.includes('^XA') || !content.includes('^XZ')) {
      throw new HttpException(
        'El contenido ZPL no es valido. Debe contener al menos una etiqueta con ^XA y ^XZ',
        HttpStatus.BAD_REQUEST
      );
    }
  }

  @Post('process')
  @ApiOperation({
    summary: 'Procesar conversion ZPL (uso interno)',
    description: 'Endpoint para uso interno que realiza la conversion efectiva del ZPL a PDF',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Conversion procesada correctamente',
    schema: {
      properties: {
        message: {
          type: 'string',
          example: 'Conversion procesada correctamente',
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Error en el procesamiento',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Job ID no encontrado',
  })
  async processZpl(@Body() processZplDto: ProcessZplDto) {
    await this.zplService.processZplConversion(
      processZplDto.zplContent,
      processZplDto.labelSize,
      processZplDto.jobId,
    );

    return { message: 'Conversion procesada correctamente' };
  }

  @Get('status/:jobId')
  @ApiOperation({
    summary: 'Verificar estado de conversion',
    description: 'Consulta el estado actual de un trabajo de conversion de ZPL a PDF',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Estado del trabajo de conversion',
    schema: {
      properties: {
        status: {
          type: 'string',
          example: 'completed',
          enum: ['pending', 'processing', 'completed', 'failed'],
        },
        progress: {
          type: 'number',
          example: 100,
        },
        message: {
          type: 'string',
          example: 'Conversion completada',
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Job ID no encontrado',
  })
  async checkStatus(@Param('jobId') jobId: string) {
    return await this.zplService.getConversionStatus(jobId);
  }

  @Get('download/:jobId')
  @ApiOperation({
    summary: 'Descargar PDF convertido',
    description: 'Obtiene la URL y nombre del archivo PDF generado para su descarga',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'URL y nombre del archivo PDF para descargar',
    schema: {
      properties: {
        url: {
          type: 'string',
          example: 'https://storage.example.com/files/label-1234.pdf',
        },
        filename: {
          type: 'string',
          example: 'label-1234.pdf',
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'PDF no encontrado o conversion no completada',
  })
  async downloadPdf(@Param('jobId') jobId: string) {
    const { url, filename } = await this.zplService.getPdfDownloadUrl(jobId);
    return { url, filename };
  }

  @Post('count-labels')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Contar etiquetas en archivo ZPL',
    description: 'Recibe un archivo ZPL y devuelve el numero total de etiquetas que contiene',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Archivo ZPL a analizar (max 1MB)',
        },
        zplContent: {
          type: 'string',
          description: 'Contenido ZPL a analizar (opcional si se envia archivo)',
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Conteo de etiquetas exitoso',
    schema: {
      properties: {
        success: {
          type: 'boolean',
          example: true,
          description: 'Indica si la operacion fue exitosa',
        },
        message: {
          type: 'string',
          example: 'Conteo de etiquetas realizado exitosamente',
          description: 'Mensaje descriptivo del resultado',
        },
        data: {
          type: 'object',
          properties: {
            totalUniqueLabels: {
              type: 'number',
              example: 10,
              description: 'Numero de etiquetas unicas en el archivo (sin contar copias)',
            },
            totalLabels: {
              type: 'number',
              example: 25,
              description: 'Numero total de etiquetas incluyendo copias (considerando el comando ^PQ)',
            },
          },
        },
      },
    },
  })
  async countLabels(
    @Body() body: { zplContent?: string },
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 1024 * 1024 }), // 1MB max
        ],
        fileIsRequired: false,
      }),
    ) file?: Express.Multer.File,
  ) {
    const zplContent = file
      ? file.buffer.toString('utf-8')
      : body.zplContent;

    this.validateZplContent(zplContent);

    return await this.zplService.countLabels(zplContent);
  }

  @Post('preview')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Obtener vista previa de etiquetas ZPL',
    description: 'Recibe codigo ZPL y devuelve imagenes PNG de las etiquetas unicas con sus cantidades',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Archivo ZPL a previsualizar (max 1MB)',
        },
        zplContent: {
          type: 'string',
          description: 'Contenido ZPL a previsualizar (opcional si se envia archivo)',
        },
        labelSize: {
          type: 'string',
          enum: [LabelSize.TWO_BY_ONE, LabelSize.TWO_BY_FOUR, LabelSize.FOUR_BY_TWO, LabelSize.FOUR_BY_SIX],
          default: LabelSize.TWO_BY_ONE,
          description: 'Tamano de la etiqueta (2x1, 2x4, 4x2 o 4x6 pulgadas)',
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Vista previa generada correctamente',
    schema: {
      properties: {
        success: {
          type: 'boolean',
          example: true,
        },
        message: {
          type: 'string',
          example: 'Vista previa generada correctamente',
        },
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              img: {
                type: 'string',
                description: 'Imagen PNG en base64',
                example: 'data:image/png;base64,...',
              },
              qty: {
                type: 'number',
                description: 'Cantidad de veces que se repite la etiqueta',
                example: 5,
              },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Datos de entrada invalidos',
  })
  async previewZpl(
    @Body() body: { zplContent?: string; labelSize?: string },
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 1024 * 1024 }), // 1MB max
        ],
        fileIsRequired: false,
      }),
    ) file?: Express.Multer.File,
  ): Promise<ZplPreviewResponseDto> {
    const zplContent = file
      ? file.buffer.toString('utf-8')
      : body.zplContent;

    this.validateZplContent(zplContent);

    const size = body.labelSize || LabelSize.TWO_BY_ONE;
    const previews = await this.zplService.getLabelsPreview(zplContent, size as LabelSize);

    return {
      success: true,
      message: 'Vista previa generada correctamente',
      data: previews,
    };
  }

  @Post('validate')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Validar contenido ZPL sin convertir',
    description:
      'Analiza el ZPL y retorna errores/warnings sin enviarlo a Labelary. Util para pre-validacion antes de conversion.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Archivo ZPL a validar (max 1MB)',
        },
        zplContent: {
          type: 'string',
          description: 'Contenido ZPL a validar (opcional si se envia archivo)',
        },
        language: {
          type: 'string',
          enum: ['es', 'en'],
          default: 'es',
          description: 'Idioma para mensajes de error',
        },
        strictMode: {
          type: 'boolean',
          default: false,
          description: 'Modo estricto: warnings se tratan como errores',
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Resultado de validacion',
    type: ValidationResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Contenido ZPL no proporcionado',
  })
  async validateZpl(
    @Body() validateDto: ValidateZplDto,
    @UploadedFile(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: 1024 * 1024 })],
        fileIsRequired: false,
      }),
    )
    file?: Express.Multer.File,
  ): Promise<ValidationResponseDto> {
    const zplContent = file
      ? file.buffer.toString('utf-8')
      : validateDto.zplContent;

    if (!zplContent) {
      throw new HttpException(
        validateDto.language === 'en'
          ? 'ZPL content is required'
          : 'El contenido ZPL es requerido',
        HttpStatus.BAD_REQUEST,
      );
    }

    const result = await this.zplValidatorService.validate(zplContent, {
      language: validateDto.language || 'es',
      strictMode: validateDto.strictMode || false,
    });

    const message =
      validateDto.language === 'en'
        ? result.isValid
          ? 'Validation successful'
          : 'Issues found in ZPL content'
        : result.isValid
          ? 'Validacion exitosa'
          : 'Se encontraron problemas en el contenido ZPL';

    return {
      success: true,
      message,
      data: {
        isValid: result.isValid,
        errors: result.errors,
        warnings: result.warnings,
        summary: result.summary,
      },
    };
  }

  // ============== BATCH PROCESSING ENDPOINTS ==============

  @Post('batch/convert')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(FirebaseAuthGuard)
  @ApiBearerAuth()
  @UseInterceptors(FilesInterceptor('files', 50))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Iniciar conversion batch de multiples archivos ZPL',
    description: 'Recibe multiples archivos ZPL y comienza un proceso asincrono de conversion. Solo disponible para usuarios Pro y Enterprise.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
          description: 'Archivos ZPL a convertir',
        },
        fileIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'IDs de cada archivo (opcional)',
        },
        labelSize: {
          type: 'string',
          example: '4x6',
          description: 'Tamano de etiqueta',
        },
        outputFormat: {
          type: 'string',
          enum: ['pdf', 'png', 'jpeg'],
          default: 'pdf',
        },
      },
      required: ['files', 'labelSize'],
    },
  })
  @ApiResponse({
    status: HttpStatus.ACCEPTED,
    description: 'Conversion batch iniciada correctamente',
    type: BatchConvertResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Plan no permite batch o limite excedido',
    schema: {
      properties: {
        error: { type: 'string', example: 'BATCH_NOT_ALLOWED' },
        message: { type: 'string', example: 'El procesamiento batch no esta disponible para tu plan' },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Datos de entrada invalidos o archivo muy grande',
  })
  async batchConvert(
    @CurrentUser() user: FirebaseUser,
    @UploadedFiles() files: Express.Multer.File[],
    @Body() body: { fileIds?: string | string[]; labelSize: string; outputFormat?: string },
  ): Promise<BatchConvertResponseDto> {
    // Validar que hay archivos
    if (!files || files.length === 0) {
      throw new HttpException(
        { error: 'NO_FILES', message: 'Se requiere al menos un archivo' },
        HttpStatus.BAD_REQUEST,
      );
    }

    // Validar labelSize
    if (!body.labelSize) {
      throw new HttpException(
        { error: 'INVALID_INPUT', message: 'labelSize es requerido' },
        HttpStatus.BAD_REQUEST,
      );
    }

    // Parsear fileIds (puede ser string o array según cómo llegue del FormData)
    let fileIds: string[] = [];
    if (body.fileIds) {
      if (Array.isArray(body.fileIds)) {
        fileIds = body.fileIds;
      } else if (typeof body.fileIds === 'string') {
        fileIds = [body.fileIds];
      }
    }

    // Transformar archivos al formato interno
    const batchFiles = files.map((file, index) => ({
      id: fileIds[index] || uuidv4(),
      content: file.buffer.toString('utf-8'),
      fileName: file.originalname,
    }));

    const result = await this.zplService.startBatchConversion(
      user.uid,
      batchFiles,
      body.labelSize,
      (body.outputFormat as 'pdf' | 'png' | 'jpeg') || 'pdf',
    );

    return {
      batchId: result.batchId,
      jobs: result.jobs,
    };
  }

  @Get('batch/status/:batchId')
  @ApiOperation({
    summary: 'Verificar estado de conversion batch',
    description: 'Consulta el estado actual de un trabajo de conversion batch',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Estado del batch',
    type: BatchStatusResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Batch no encontrado',
  })
  async getBatchStatus(@Param('batchId') batchId: string): Promise<BatchStatusResponseDto> {
    const result = await this.zplService.getBatchStatus(batchId);

    return {
      batchId: result.batchId,
      status: result.status,
      totalFiles: result.totalFiles,
      completedFiles: result.completedFiles,
      jobs: result.jobs.map((j) => ({
        jobId: j.jobId,
        status: j.status as 'pending' | 'processing' | 'completed' | 'failed',
        progress: j.progress,
        error: j.error,
      })),
      downloadUrl: result.downloadUrl,
    };
  }

  @Get('batch/download/:batchId')
  @ApiOperation({
    summary: 'Descargar archivos del batch completado',
    description: 'Obtiene la URL y nombre del archivo ZIP con todos los archivos convertidos',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'URL de descarga del ZIP',
    type: BatchDownloadResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Batch no encontrado o descarga no disponible',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Batch aun en procesamiento',
  })
  async getBatchDownload(@Param('batchId') batchId: string): Promise<BatchDownloadResponseDto> {
    return await this.zplService.getBatchDownload(batchId);
  }
}
