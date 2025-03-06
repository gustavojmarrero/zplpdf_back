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
  ParseFilePipe,
  MaxFileSizeValidator,
  HttpException,
} from '@nestjs/common';
import { ZplService } from './zpl.service.js';
import { ConvertZplDto } from './dto/convert-zpl.dto.js';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { LabelSize } from './enums/label-size.enum.js';
import { ZplPreviewItemDto, ZplPreviewResponseDto } from './dto/zpl-preview.dto.js';

interface ProcessZplDto {
  zplContent: string;
  labelSize: LabelSize;
  jobId: string;
  language: string;
}

@ApiTags('zpl')
@Controller('zpl')
export class ZplController {
  constructor(private readonly zplService: ZplService) {}

  @Post('convert')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ 
    summary: 'Iniciar conversión de ZPL a PDF',
    description: 'Recibe código ZPL (como texto o archivo) y comienza un proceso asíncrono de conversión a PDF',
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
          description: 'Contenido ZPL a convertir (opcional si se envía archivo)',
        },
        labelSize: {
          type: 'string',
          enum: [LabelSize.TWO_BY_ONE, LabelSize.TWO_BY_FOUR, LabelSize.FOUR_BY_TWO, LabelSize.FOUR_BY_SIX],
          default: LabelSize.TWO_BY_ONE,
          description: 'Tamaño de la etiqueta (2x1, 2x4, 4x2 o 4x6 pulgadas)',
        },
        language: {
          type: 'string',
          default: 'es',
          description: 'Idioma para los mensajes',
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.ACCEPTED,
    description: 'Conversión iniciada correctamente',
    schema: {
      properties: {
        jobId: {
          type: 'string',
          example: '1234-5678-90ab',
        },
        message: {
          type: 'string',
          example: 'Conversión iniciada. Use el endpoint /status para verificar el estado.',
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
    description: 'Datos de entrada inválidos',
  })
  async convertZpl(
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

    this.validateZplContent(zplContent);

    const jobId = await this.zplService.startZplConversion(
      zplContent,
      convertZplDto.labelSize,
      convertZplDto.language || 'en',
    );
    
    return {
      jobId,
      message: 'Conversión iniciada. Use el endpoint /status para verificar el estado.',
      statusUrl: `/api/zpl/status/${jobId}`,
    };
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
        'El contenido ZPL no es válido. Debe contener al menos una etiqueta con ^XA y ^XZ',
        HttpStatus.BAD_REQUEST
      );
    }
  }

  @Post('process')
  @ApiOperation({
    summary: 'Procesar conversión ZPL (uso interno)',
    description: 'Endpoint para uso interno que realiza la conversión efectiva del ZPL a PDF',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Conversión procesada correctamente',
    schema: {
      properties: {
        message: {
          type: 'string',
          example: 'Conversión procesada correctamente',
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
    
    return { message: 'Conversión procesada correctamente' };
  }

  @Get('status/:jobId')
  @ApiOperation({
    summary: 'Verificar estado de conversión',
    description: 'Consulta el estado actual de un trabajo de conversión de ZPL a PDF',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Estado del trabajo de conversión',
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
          example: 'Conversión completada',
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
    description: 'PDF no encontrado o conversión no completada',
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
    description: 'Recibe un archivo ZPL y devuelve el número total de etiquetas que contiene',
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
          description: 'Contenido ZPL a analizar (opcional si se envía archivo)',
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
          description: 'Indica si la operación fue exitosa',
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
              description: 'Número de etiquetas únicas en el archivo (sin contar copias)',
            },
            totalLabels: {
              type: 'number',
              example: 25,
              description: 'Número total de etiquetas incluyendo copias (considerando el comando ^PQ)',
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
    description: 'Recibe código ZPL y devuelve imágenes PNG de las etiquetas únicas con sus cantidades',
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
          description: 'Contenido ZPL a previsualizar (opcional si se envía archivo)',
        },
        labelSize: {
          type: 'string',
          enum: [LabelSize.TWO_BY_ONE, LabelSize.TWO_BY_FOUR, LabelSize.FOUR_BY_TWO, LabelSize.FOUR_BY_SIX],
          default: LabelSize.TWO_BY_ONE,
          description: 'Tamaño de la etiqueta (2x1, 2x4, 4x2 o 4x6 pulgadas)',
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
    description: 'Datos de entrada inválidos',
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
}
