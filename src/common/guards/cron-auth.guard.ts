import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class CronAuthGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const cronSecret = request.headers['x-cron-secret'];
    const expectedSecret = this.configService.get<string>('CRON_SECRET_KEY');

    if (!expectedSecret) {
      throw new UnauthorizedException('Cron secret not configured');
    }

    if (!cronSecret || cronSecret !== expectedSecret) {
      throw new UnauthorizedException('Invalid cron secret');
    }

    return true;
  }
}
