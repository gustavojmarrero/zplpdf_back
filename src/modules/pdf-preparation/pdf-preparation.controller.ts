import { GrowthSchedulerGuard } from '../../common/guards/growth-scheduler.guard.js';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';
import { PdfPreparationService } from './pdf-preparation.service.js';
@Controller('pdf-preparation')
export class PdfPreparationController {
  constructor(private readonly service: PdfPreparationService) {}
  @Post('export')
  @UseGuards(FirebaseAuthGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 20 * 1024 * 1024, files: 1, fieldSize: 128 * 1024 },
    }),
  )
  export(
    @Req() req: { user: { uid: string } },
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { operationId: string; recipe: string },
  ) {
    if (!file?.buffer || typeof body.recipe !== 'string')
      throw new BadRequestException('PDF_AND_RECIPE_REQUIRED');
    let recipe;
    try {
      recipe = JSON.parse(body.recipe);
    } catch {
      throw new BadRequestException('PDF_RECIPE_INVALID');
    }
    return this.service.export(
      req.user.uid,
      body.operationId,
      file.buffer,
      recipe,
    );
  }
  @Post('internal/recover')
  @UseGuards(GrowthSchedulerGuard)
  recover() {
    return this.service.recover();
  }

  @Get(':operationId')
  @UseGuards(FirebaseAuthGuard)
  status(
    @Req() req: { user: { uid: string } },
    @Param('operationId') id: string,
  ) {
    return this.service.status(req.user.uid, id);
  }
}
