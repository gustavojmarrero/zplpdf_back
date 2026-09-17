import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiCredentialsService } from './api-credentials.service.js';
import type { ApiScope } from './public-api.types.js';
export const RequireApiScope = (scope: ApiScope) =>
  SetMetadata('public-api-scope', scope);
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly credentials: ApiCredentialsService,
    private readonly reflector: Reflector,
  ) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    const authorization = req.headers.authorization;
    if (
      typeof authorization !== 'string' ||
      !authorization.startsWith('Bearer ')
    )
      throw new UnauthorizedException();
    const principal = await this.credentials.authenticate(
      authorization.slice(7),
    );
    const scope = this.reflector.getAllAndOverride<ApiScope>(
      'public-api-scope',
      [context.getHandler(), context.getClass()],
    );
    if (!scope || !principal.scopes.includes(scope))
      throw new ForbiddenException('API scope required');
    req.apiPrincipal = principal;
    return true;
  }
}
