import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Inject,
  Logger,
} from '@nestjs/common';
import { FirebaseAdminService } from '../../modules/auth/firebase-admin.service.js';
import { FirestoreService } from '../../modules/cache/firestore.service.js';
import type { User } from '../interfaces/user.interface.js';

@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  private readonly logger = new Logger(FirebaseAuthGuard.name);

  constructor(
    @Inject(FirebaseAdminService)
    private readonly firebaseAdminService: FirebaseAdminService,
    @Inject(FirestoreService)
    private readonly firestoreService: FirestoreService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid authorization header');
    }

    const token = authHeader.split(' ')[1];

    let decodedToken;
    try {
      decodedToken = await this.firebaseAdminService.verifyToken(token);
    } catch (error) {
      this.logger.error(`Token verification failed: ${error.message}`);
      throw new UnauthorizedException('Invalid or expired token');
    }

    // Lazy user creation: buscar o crear usuario en Firestore
    try {
      let user = await this.firestoreService.getUserById(decodedToken.uid);

      if (!user) {
        // Crear usuario con plan free
        const newUser: User = {
          id: decodedToken.uid,
          email: decodedToken.email || '',
          displayName: decodedToken.name || decodedToken.email?.split('@')[0] || 'Usuario',
          plan: 'free',
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        await this.firestoreService.createUser(newUser);
        user = newUser;
        this.logger.log(`New user auto-created: ${decodedToken.uid}`);
      }

      request.user = {
        uid: user.id,
        email: user.email,
        name: user.displayName,
        picture: decodedToken.picture,
      };
      return true;
    } catch (error) {
      this.logger.error(`Firestore error: ${error.message}`);
      // Si Firestore falla, aún permitimos el acceso con datos del token
      request.user = {
        uid: decodedToken.uid,
        email: decodedToken.email,
        name: decodedToken.name || decodedToken.email?.split('@')[0] || 'Usuario',
        picture: decodedToken.picture,
      };
      return true;
    }
  }
}
