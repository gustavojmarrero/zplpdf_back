import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
/** Cloud Run may be public: verify the scheduler identity inside the application. */
@Injectable()
export class GrowthSchedulerGuard implements CanActivate {
  private readonly verifier = new OAuth2Client();
  constructor(private readonly config: ConfigService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const audience = this.config.get<string>('GROWTH_SCHEDULER_AUDIENCE');
    const email = this.config.get<string>('GROWTH_SCHEDULER_SERVICE_ACCOUNT');
    const authorization = context.switchToHttp().getRequest()
      .headers.authorization;
    if (
      !audience ||
      !email ||
      typeof authorization !== 'string' ||
      !authorization.startsWith('Bearer ')
    )
      throw new UnauthorizedException('Scheduler authentication required');
    try {
      const ticket = await this.verifier.verifyIdToken({
        idToken: authorization.slice(7),
        audience,
      });
      const claims = ticket.getPayload();
      if (
        !claims ||
        claims.email !== email ||
        claims.email_verified !== true ||
        !claims.sub
      )
        throw new Error();
      return true;
    } catch {
      throw new UnauthorizedException('Invalid scheduler identity');
    }
  }
}
