import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';
import { FolderAutomationService } from './folder-automation.service.js';
@Controller('integrations/drive')
@UseGuards(FirebaseAuthGuard)
export class FolderAutomationController {
  constructor(private readonly service: FolderAutomationService) {}
  @Post('oauth/start') start(@Req() req: any, @Body() body: unknown) {
    return this.service.start(req.user.uid, body);
  }
  @Post('oauth/complete') complete(@Req() req: any, @Body() body: unknown) {
    return this.service.complete(req.user.uid, body);
  }
  @Get('connections') connections(@Req() req: any) {
    return this.service.connections(req.user.uid);
  }
  @Post('connections/:id/picker-token')
  @Header('Cache-Control', 'no-store')
  picker(@Req() req: any, @Param('id') id: string, @Body() body: unknown) {
    return this.service.picker(req.user.uid, id, body);
  }
  @Patch('connections/:id') configure(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.service.configure(req.user.uid, id, body);
  }
  @Post('connections/:id/state')
  state(@Req() req: any, @Param('id') id: string, @Body() body: unknown) {
    return this.service.setEnabled(req.user.uid, id, body);
  }
  @Post('connections/:id/disconnect') disconnect(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.service.disconnect(req.user.uid, id, body);
  }
  @Get('connections/:id/runs') runs(@Req() req: any, @Param('id') id: string) {
    return this.service.runs(req.user.uid, id);
  }
  @Post('runs/:id/retry') retry(
    @Req() req: any,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string,
  ) {
    return this.service.retry(req.user.uid, id, key);
  }
}
