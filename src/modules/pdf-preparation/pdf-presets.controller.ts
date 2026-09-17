import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';
import { PdfPresetsService } from './pdf-presets.service.js';
@Controller('pdf-preparation/presets')
@UseGuards(FirebaseAuthGuard)
export class PdfPresetsController {
  constructor(private readonly presets: PdfPresetsService) {}
  @Get() list(@Req() req: { user: { uid: string } }) {
    return this.presets.list(req.user.uid);
  }
  @Post() create(@Req() req: { user: { uid: string } }, @Body() body: unknown) {
    return this.presets.create(req.user.uid, body);
  }
  @Get(':id/versions') versions(
    @Req() req: { user: { uid: string } },
    @Param('id') id: string,
  ) {
    return this.presets.versions(req.user.uid, id);
  }
  @Post(':id/versions') update(
    @Req() req: { user: { uid: string } },
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.presets.update(req.user.uid, id, body);
  }
  @Post(':id/archive') archive(
    @Req() req: { user: { uid: string } },
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.presets.archive(req.user.uid, id, body);
  }
}
