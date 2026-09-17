import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';
import { DirectPrintService } from './direct-print.service.js';
@Controller('print')
@UseGuards(FirebaseAuthGuard)
export class DirectPrintController {
  constructor(private readonly service: DirectPrintService) {}
  @Post('connections') connect(@Req() req: any, @Body() body: unknown) {
    return this.service.connect(req.user.uid, body);
  }
  @Get('connections') connections(@Req() req: any) {
    return this.service.connections(req.user.uid);
  }
  @Delete('connections/:id') disconnect(
    @Req() req: any,
    @Param('id') id: string,
  ) {
    return this.service.disconnect(req.user.uid, id);
  }
  @Get('connections/:id/printers') printers(
    @Req() req: any,
    @Param('id') id: string,
  ) {
    return this.service.printers(req.user.uid, id);
  }
  @Post('jobs') @HttpCode(202) create(
    @Req() req: any,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
  ) {
    return this.service.create(req.user.uid, key, body);
  }
  @Get('jobs') jobs(@Req() req: any) {
    return this.service.jobs(req.user.uid);
  }
  @Get('jobs/:id') status(@Req() req: any, @Param('id') id: string) {
    return this.service.status(req.user.uid, id);
  }
  @Post('jobs/:id/reprint') @HttpCode(202) reprint(
    @Req() req: any,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
  ) {
    return this.service.reprint(req.user.uid, id, key, body);
  }
  @Post('jobs/:id/confirm') confirm(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.service.confirm(req.user.uid, id, body);
  }
}
