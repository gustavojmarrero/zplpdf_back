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
import { TemplateRegressionService } from './template-regression.service.js';
import type { CreateBaseline, CreateRun } from './template-regression.types.js';
type Request = { user: { uid: string } };

@Controller('template-regression')
@UseGuards(FirebaseAuthGuard)
export class TemplateRegressionController {
  constructor(private readonly service: TemplateRegressionService) {}
  @Get('fixtures') fixtures(@Req() req: Request) {
    return this.service.fixtures(req.user.uid);
  }
  @Get('baselines') baselines(@Req() req: Request) {
    return this.service.list('baseline', req.user.uid);
  }
  @Post('baselines') createBaseline(
    @Req() req: Request,
    @Body() body: CreateBaseline,
  ) {
    return this.service.createBaseline(req.user.uid, body);
  }
  @Get('baselines/:id') baseline(@Req() req: Request, @Param('id') id: string) {
    return this.service.get('baseline', req.user.uid, id);
  }
  @Post('baselines/:id/approve') approve(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { expectedVersion: number; note: string },
  ) {
    return this.service.approve(req.user.uid, id, body);
  }
  @Get('runs') runs(@Req() req: Request) {
    return this.service.list('run', req.user.uid);
  }
  @Post('runs') createRun(@Req() req: Request, @Body() body: CreateRun) {
    return this.service.createRun(req.user.uid, body);
  }
  @Get('runs/:id') run(@Req() req: Request, @Param('id') id: string) {
    return this.service.get('run', req.user.uid, id);
  }
  @Post('runs/:id/approve-baseline') adopt(
    @Req() req: Request,
    @Param('id') id: string,
    @Body()
    body: { expectedVersion: number; operationId: string; note: string },
  ) {
    return this.service.adopt(req.user.uid, id, body);
  }
}
