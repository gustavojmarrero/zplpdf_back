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
  UseGuards,
} from '@nestjs/common';
import { ZplService } from './zpl.service.js';
import { ConvertZplDto } from './dto/convert-zpl.dto.js';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiConsumes,
  ApiBody,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { LabelSize } from './enums/label-size.enum.js';
import { ZplPreviewItemDto, ZplPreviewResponseDto } from './dto/zpl-preview.dto.js';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';
import { CurrentUser, FirebaseUser } from '../../common/decorators/current-user.decorator.js';

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
  @UseGuards(FirebaseAuthGuard)
  @ApiBearerAuth()
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Iniciar conversion de ZPL a PDF',
    description: 'Recibe codigo ZPL (como texto o archivo) y comienza un proceso asincrono de conversion a PDF. Requiere autenticacion.',
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

    this.validateZplContent(zplContent);

    const jobId = await this.zplService.startZplConversion(
      zplContent,
      convertZplDto.labelSize,
      convertZplDto.language || 'en',
      user.uid,
    );

    return {
      jobId,
      message: 'Conversion iniciada. Use el endpoint /status para verificar el estado.',
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
}
