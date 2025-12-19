import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
  Inject,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FirebaseAdminService } from '../../modules/auth/firebase-admin.service.js';
import { FirestoreService } from '../../modules/cache/firestore.service.js';

export interface AdminUser {
  uid: string;
  email: string;
  name?: string;
}

@Injectable()
export class AdminAuthGuard implements CanActivate {
  private readonly logger = new Logger(AdminAuthGuard.name);
  private adminEmails: string[] = [];

  constructor(
    @Inject(FirebaseAdminService)
    private readonly firebaseAdminService: FirebaseAdminService,
    @Inject(FirestoreService)
    private readonly firestoreService: FirestoreService,
    private readonly configService: ConfigService,
  ) {
    const emails = this.configService.get<string>('ADMIN_EMAILS') || '';
    this.adminEmails = emails
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0);

    if (this.adminEmails.length === 0) {
      this.logger.warn('No admin emails configured in ADMIN_EMAILS environment variable');
    } else {
      this.logger.log(`Admin emails configured: ${this.adminEmails.length} admins`);
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;
    const adminEmailHeader = request.headers['x-admin-email'];
    const firebaseUidHeader = request.headers['x-firebase-uid'];

    // 1. Verificar header Authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid or missing authentication token',
        },
      });
    }

    const token = authHeader.split(' ')[1];

    // 2. Verificar token de Firebase
    let decodedToken;
    try {
      decodedToken = await this.firebaseAdminService.verifyToken(token);
    } catch (error) {
      this.logger.error(`Admin token verification failed: ${error.message}`);
      throw new UnauthorizedException({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid or expired token',
        },
      });
    }

    // 3. Validar que X-Admin-Email coincide con el token
    const tokenEmail = decodedToken.email?.toLowerCase();
    const headerEmail = adminEmailHeader?.toLowerCase();

    if (!tokenEmail) {
      throw new UnauthorizedException({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Token does not contain email claim',
        },
      });
    }

    if (headerEmail && headerEmail !== tokenEmail) {
      this.logger.warn(
        `Admin email mismatch: header=${headerEmail}, token=${tokenEmail}`,
      );
      throw new ForbiddenException({
        success: false,
        error: {
          code: 'ACCESS_DENIED',
          message: 'Email mismatch between header and token',
        },
      });
    }

    // 4. Verificar que el email está en la lista de administradores
    if (!this.adminEmails.includes(tokenEmail)) {
      this.logger.warn(`Unauthorized admin access attempt: ${tokenEmail}`);
      throw new ForbiddenException({
        success: false,
        error: {
          code: 'ACCESS_DENIED',
          message: 'Admin access required',
        },
      });
    }

    // 5. Registrar acceso en admin_audit_log
    try {
      await this.firestoreService.saveAdminAuditLog({
        adminEmail: tokenEmail,
        adminUid: decodedToken.uid,
        action: this.getActionFromRequest(request),
        endpoint: request.url,
        ipAddress: request.ip || request.headers['x-forwarded-for'] || null,
        userAgent: request.headers['user-agent'] || null,
        requestParams: {
          method: request.method,
          query: request.query,
        },
      });
    } catch (error) {
      // No bloquear acceso si falla el logging
      this.logger.error(`Failed to log admin access: ${error.message}`);
    }

    // 6. Inyectar datos del admin en el request
    request.adminUser = {
      uid: decodedToken.uid,
      email: tokenEmail,
      name: decodedToken.name || tokenEmail.split('@')[0],
    };

    this.logger.log(`Admin access granted: ${tokenEmail}`);
    return true;
  }

  private getActionFromRequest(request: any): string {
    const path = request.url.split('?')[0];
    const method = request.method;

    if (path.includes('/metrics')) return 'view_metrics';
    if (path.includes('/users')) return 'view_users';
    if (path.includes('/conversions')) return 'view_conversions';
    if (path.includes('/errors')) return 'view_errors';
    if (path.includes('/plan-usage')) return 'view_plan_usage';

    return `${method.toLowerCase()}_${path.replace(/\//g, '_')}`;
  }
}
