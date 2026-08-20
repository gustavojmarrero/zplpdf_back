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
      throw new UnauthorizedException(
        'Missing or invalid authorization header',
      );
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
      // La cuenta de Auth todavía puede existir mientras la baja barre datos o
      // si su borrado fue el último paso en fallar. La lápida de Firestore es la
      // segunda red: bloquea tráfico nuevo y, sobre todo, impide que el camino
      // de creación perezosa resucite el perfil entre ambos borrados.
      if (
        await this.firestoreService.isAccountDeletionMarked(decodedToken.uid)
      ) {
        throw new UnauthorizedException('Account no longer exists');
      }

      let user = await this.firestoreService.getUserById(decodedToken.uid);

      if (!user) {
        // Antes de crear nada: comprobar que la cuenta sigue existiendo en
        // Firebase Auth. Un ID token sigue siendo criptográficamente válido
        // hasta una hora después de borrar la cuenta, así que sin esta
        // comprobación la primera petición posterior a una baja recrearía el
        // documento y la cuenta "borrada" volvería a existir. Solo se paga en
        // el alta —el resto de peticiones encuentran el documento y no pasan
        // por aquí—, así que no añade latencia al camino normal.
        await this.assertAuthAccountExists(decodedToken.uid);

        // Crear usuario con plan free
        const newUser: User = {
          id: decodedToken.uid,
          email: decodedToken.email || '',
          displayName:
            decodedToken.name || decodedToken.email?.split('@')[0] || 'Usuario',
          emailVerified: decodedToken.email_verified || false,
          plan: 'free',
          role: 'user',
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
      // El rechazo por cuenta inexistente es una decisión, no un fallo de
      // Firestore: degradarlo al acceso permitido de abajo reabriría justo el
      // agujero que cierra.
      if (error instanceof UnauthorizedException) {
        throw error;
      }

      this.logger.error(`Firestore error: ${error.message}`);
      // Si Firestore falla, aún permitimos el acceso con datos del token
      request.user = {
        uid: decodedToken.uid,
        email: decodedToken.email,
        name:
          decodedToken.name || decodedToken.email?.split('@')[0] || 'Usuario',
        picture: decodedToken.picture,
      };
      return true;
    }
  }

  /**
   * Rechaza al portador de un token cuya cuenta de Firebase Auth ya no existe.
   *
   * Solo `auth/user-not-found` bloquea: cualquier otro fallo (Auth caído, SDK
   * sin credenciales) dejaría sin registrarse a usuarios legítimos, y esta
   * comprobación es una salvaguarda contra la resurrección de una cuenta
   * borrada, no el control de acceso principal.
   */
  private async assertAuthAccountExists(uid: string): Promise<void> {
    try {
      await this.firebaseAdminService.getUser(uid);
    } catch (error) {
      if (error?.code === 'auth/user-not-found') {
        this.logger.warn(
          `Token válido de una cuenta ya borrada (${uid}); no se recrea el perfil`,
        );
        throw new UnauthorizedException('Account no longer exists');
      }

      this.logger.warn(
        `No se pudo comprobar la cuenta ${uid} en Firebase Auth: ${error.message}`,
      );
    }
  }
}
