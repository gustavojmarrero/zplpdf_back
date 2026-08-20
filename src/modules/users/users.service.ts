import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
  GoneException,
  NotFoundException,
  PayloadTooLargeException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import sharp from 'sharp';
import { FirestoreService } from '../cache/firestore.service.js';
import { FirebaseAdminService } from '../auth/firebase-admin.service.js';
import {
  PeriodCalculatorService,
  PeriodInfo,
} from '../../common/services/period-calculator.service.js';
import {
  DEFAULT_PLAN_LIMITS,
  PLAN_FEATURES,
} from '../../common/interfaces/user.interface.js';
import type {
  User,
  PlanType,
  PlanLimits,
} from '../../common/interfaces/user.interface.js';
import { ZPL_RETENTION_DAYS } from '../../common/interfaces/conversion-history.interface.js';
import type { ConversionHistoryRecord } from '../../common/interfaces/conversion-history.interface.js';
import { ErrorCodes } from '../../common/constants/error-codes.js';
import { UserProfileDto } from './dto/user-profile.dto.js';
import { UserLimitsDto } from './dto/user-limits.dto.js';
import { VerificationStatusDto } from './dto/verification-status.dto.js';
import { ProfilePhotoResponseDto } from './dto/profile-photo.dto.js';
import {
  GetHistoryQueryDto,
  HistorySortBy,
  HistorySortOrder,
} from './dto/get-history-query.dto.js';
import type {
  ConversionHistoryFacetsDto,
  ConversionHistoryItemDto,
  ConversionHistoryResponseDto,
} from './dto/conversion-history.dto.js';
import type { FirebaseUser } from '../../common/decorators/current-user.decorator.js';
import { BATCH_LIMITS } from '../zpl/interfaces/batch.interface.js';
import { isBlockedEmailDomain } from '../../common/constants/blocked-email-domains.js';
import { GeoService } from '../admin/services/geo.service.js';
import { EmailService } from '../email/email.service.js';
import { StorageService } from '../storage/storage.service.js';
import { normalizeLabelSize } from '../zpl/enums/label-size.enum.js';
import { normalizeOutputFormat } from '../zpl/enums/output-format.enum.js';
import { extractStoragePathFromSignedUrl } from '../../common/utils/storage-url.util.js';
import {
  resolveNotificationPreferences,
  type NotificationPreferences,
} from '../../common/interfaces/notification-preferences.interface.js';

export interface CheckCanConvertResult {
  allowed: boolean;
  error?: string;
  errorCode?: string;
  data?: Record<string, any>;
  periodInfo?: PeriodInfo;
  /**
   * Email del usuario evaluado (null si no se pudo resolver). Se expone para
   * que quien rechaza la conversión pueda registrar el evento en `error_logs`
   * con `userEmail` sin releer el documento: el usuario ya se carga aquí.
   */
  userEmail?: string | null;
}

/** Límite por defecto de ítems por página del historial. */
export const DEFAULT_HISTORY_LIMIT = 25;

/**
 * Tope de documentos que se leen de Firestore por request de historial. Los
 * filtros, la búsqueda y el orden se aplican sobre este bloque (el más reciente),
 * de modo que un usuario con más conversiones ve `pagination.truncated: true`.
 */
export const MAX_HISTORY_SCAN = 1000;

/**
 * Máximo que se ofrece para reconversión. Aunque el parser admite 5 MiB, el
 * ZPL vuelve dentro de JSON y sus saltos, barras y comillas se escapan; reservar
 * 1 MiB deja margen para que esa sobrecarga no haga que `POST /zpl/convert`
 * rechace el body.
 */
export const MAX_RECONVERTIBLE_ZPL_SIZE_BYTES = 4 * 1024 * 1024;

/** Peso máximo admitido para la foto de perfil antes de normalizarla. */
export const MAX_PROFILE_PHOTO_BYTES = 2 * 1024 * 1024;

/** Lado del avatar cuadrado que se guarda en Storage. */
export const PROFILE_PHOTO_SIZE_PX = 256;

/**
 * Tope de píxeles de la imagen de entrada.
 *
 * El límite de 2 MB no acota el trabajo de decodificar: un PNG o un WebP muy
 * comprimidos caben de sobra en 2 MB declarando decenas de miles de píxeles por
 * lado, y descomprimirlos cuesta gigabytes de RAM —el techo por defecto de sharp
 * son 268 MP—. Con varias peticiones a la vez eso tumba la instancia. 40 MP deja
 * pasar cualquier foto de cámara real y corta las bombas de descompresión.
 */
export const MAX_PROFILE_PHOTO_PIXELS = 40_000_000;

/**
 * Formatos admitidos, decididos por el contenido real del archivo (lo que
 * detecta sharp) y no por el `Content-Type` que declara el cliente, que es
 * trivial de falsear. Fuera queda el SVG, que sharp también sabe leer pero que
 * en un bucket público sería un vector de XSS.
 */
export const ALLOWED_PROFILE_PHOTO_FORMATS = ['jpeg', 'png', 'webp'];

/** TTL de la caché en memoria del escaneo de historial. */
const HISTORY_SCAN_CACHE_TTL_MS = 60_000;

/** Tope de usuarios distintos cacheados a la vez por instancia. */
const MAX_HISTORY_CACHE_ENTRIES = 200;

const DAY_IN_MS = 24 * 60 * 60 * 1000;

interface HistoryScanCacheEntry {
  records: ConversionHistoryRecord[];
  /** El usuario tiene más conversiones de las que cabían en el escaneo. */
  truncated: boolean;
  expiresAt: number;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  private stripe: Stripe | null = null;

  /** Caché por instancia del escaneo de historial (ver `getScannedHistory`). */
  private readonly historyScanCache = new Map<string, HistoryScanCacheEntry>();

  /**
   * Cola por usuario para que el objeto del avatar y la URL del perfil cambien
   * como una sola operación. La instancia de Cloud Run está limitada a una, de
   * modo que esta coordinación en memoria cubre todas las peticiones que pueden
   * competir por la ruta fija de un usuario.
   */
  private readonly profilePhotoOperations = new Map<string, Promise<void>>();

  /**
   * Contador monótono de invalidaciones. Permite detectar que se registró una
   * conversión mientras un escaneo estaba en vuelo y descartar su resultado.
   *
   * Es global en vez de por usuario a propósito: un mapa crecería sin límite con
   * los usuarios que convierten sin mirar nunca el historial (Free y Lite ni
   * siquiera tienen acceso), y podarlo podría devolver un contador a su valor
   * inicial justo mientras hay una lectura en vuelo, que es el caso que esta
   * guarda existe para evitar. El coste de un contador único es que la
   * conversión de un usuario impide cachear el escaneo simultáneo de otro: se
   * pierde una oportunidad de caché, nunca se sirven datos obsoletos.
   */
  private historyCacheGeneration = 0;

  constructor(
    private readonly firestoreService: FirestoreService,
    private readonly firebaseAdminService: FirebaseAdminService,
    private readonly periodCalculatorService: PeriodCalculatorService,
    private readonly geoService: GeoService,
    @Inject(forwardRef(() => EmailService))
    private readonly emailService: EmailService,
    private readonly storageService: StorageService,
    private readonly configService: ConfigService,
  ) {
    // Initialize Stripe for subscription status checks
    const stripeSecretKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (stripeSecretKey) {
      this.stripe = new Stripe(stripeSecretKey);
    }
  }

  async syncUser(
    firebaseUser: FirebaseUser,
    clientIP?: string,
    vercelGeo?: { country: string; city?: string },
  ): Promise<User> {
    // Obtener estado fresco de emailVerified desde Firebase Auth
    let emailVerified = false;
    try {
      const fbUser = await this.firebaseAdminService.getUser(firebaseUser.uid);
      emailVerified = fbUser.emailVerified;
    } catch (error) {
      this.logger.warn(
        `Could not fetch Firebase user for emailVerified: ${error.message}`,
      );
    }

    const existingUser = await this.firestoreService.getUserById(
      firebaseUser.uid,
    );

    if (existingUser) {
      // Update existing user
      const updates: Partial<User> = {
        email: firebaseUser.email,
        displayName: firebaseUser.name,
        emailVerified,
      };

      // Detectar geolocalización si:
      // 1. No tiene país, O
      // 2. countrySource es 'ip' y han pasado 7 días (no actualizar si es 'stripe')
      const shouldUpdateGeo =
        !existingUser.country ||
        (existingUser.countrySource === 'ip' &&
          this.geoService.shouldRefreshGeo(existingUser));

      if (shouldUpdateGeo) {
        // Prioridad: 1. Vercel headers (edge), 2. ip.guide API (fallback)
        if (vercelGeo?.country) {
          updates.country = vercelGeo.country;
          updates.city = vercelGeo.city;
          updates.countrySource = 'ip';
          updates.countryDetectedAt = new Date();
          this.logger.log(
            `Using Vercel geo ${vercelGeo.country}/${vercelGeo.city || ''} for existing user ${firebaseUser.uid}`,
          );
        } else if (clientIP) {
          try {
            const geoData = await this.geoService.detectCountryByIP(clientIP);
            if (geoData) {
              updates.country = geoData.country;
              updates.city = geoData.city;
              updates.countrySource = 'ip';
              updates.countryDetectedAt = new Date();
              this.logger.log(
                `Detected geo ${geoData.country}/${geoData.city} for existing user ${firebaseUser.uid}`,
              );
            }
          } catch (error) {
            this.logger.warn(
              `Failed to detect geo for ${firebaseUser.uid}: ${error.message}`,
            );
          }
        }
      }

      await this.firestoreService.updateUser(firebaseUser.uid, updates);

      return {
        ...existingUser,
        ...updates,
      };
    }

    // Detectar geolocalización para nuevos usuarios
    // Prioridad: 1. Vercel headers (edge), 2. ip.guide API (fallback)
    let country: string | undefined;
    let city: string | undefined;

    if (vercelGeo?.country) {
      country = vercelGeo.country;
      city = vercelGeo.city;
      this.logger.log(
        `Using Vercel geo ${country}/${city || ''} for new user ${firebaseUser.uid}`,
      );
    } else if (clientIP) {
      try {
        const geoData = await this.geoService.detectCountryByIP(clientIP);
        if (geoData) {
          country = geoData.country;
          city = geoData.city;
          this.logger.log(
            `Detected geo ${country}/${city} for new user ${firebaseUser.uid}`,
          );
        }
      } catch (error) {
        this.logger.warn(
          `Failed to detect geo for ${firebaseUser.uid}: ${error.message}`,
        );
      }
    }

    // Create new user with free plan
    const newUser: User = {
      id: firebaseUser.uid,
      email: firebaseUser.email,
      displayName: firebaseUser.name,
      emailVerified,
      plan: 'free',
      role: 'user',
      country,
      city,
      countrySource: country ? 'ip' : undefined,
      countryDetectedAt: country ? new Date() : undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.firestoreService.createUser(newUser);
    this.logger.log(`New user created: ${firebaseUser.uid}`);

    // Queue welcome email for new user (fire and forget)
    this.emailService
      .queueWelcomeEmail({
        id: newUser.id,
        email: newUser.email,
        displayName: newUser.displayName,
        language: country ? this.detectLanguageFromCountry(country) : undefined,
      })
      .catch((err) =>
        this.logger.error(`Failed to queue welcome email: ${err.message}`),
      );

    return newUser;
  }

  async getUserProfile(userId: string): Promise<UserProfileDto> {
    const user = await this.firestoreService.getUserById(userId);

    if (!user) {
      throw new ForbiddenException('User not found');
    }

    // Obtener estado fresco de emailVerified desde Firebase Auth
    let emailVerified = user.emailVerified ?? false;
    let authPhotoURL: string | undefined;
    try {
      const firebaseUser = await this.firebaseAdminService.getUser(userId);
      emailVerified = firebaseUser.emailVerified;
      authPhotoURL = firebaseUser.photoURL ?? undefined;
    } catch (error) {
      this.logger.warn(
        `Could not fetch Firebase user for emailVerified: ${error.message}`,
      );
    }

    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      photoURL: this.resolveProfilePhotoURL(user, authPhotoURL),
      emailVerified,
      plan: this.getEffectivePlan(user),
      createdAt: user.createdAt,
      hasStripeSubscription: !!user.stripeSubscriptionId,
    };
  }

  /**
   * Decide qué foto ve el frontend.
   *
   * `photoURL: null` en Firestore significa que el usuario quitó la suya a
   * propósito, y entonces no se cae en la del proveedor de acceso: la respuesta
   * viene sin foto y el frontend pinta las iniciales. El campo ausente es otra
   * cosa —nunca subió ninguna—, y ahí sí vale la de Google.
   */
  resolveProfilePhotoURL(
    user: Pick<User, 'photoURL'>,
    authPhotoURL?: string,
  ): string | undefined {
    if (user.photoURL === null) {
      return undefined;
    }

    return user.photoURL ?? authPhotoURL;
  }

  /**
   * Preferencias de notificación del usuario, siempre con las tres claves.
   *
   * Una cuenta anterior a esta feature no tiene el campo guardado y recibe todo
   * en `true`: nunca pidió dejar de recibir nada.
   */
  async getNotificationPreferences(
    userId: string,
  ): Promise<NotificationPreferences> {
    const user = await this.firestoreService.getUserById(userId);

    if (!user) {
      throw new ForbiddenException('User not found');
    }

    return resolveNotificationPreferences(user.notificationPreferences);
  }

  /**
   * Guarda las preferencias que vengan y devuelve el estado completo resultante.
   *
   * La actualización es parcial a propósito —la pantalla de ajustes cambia un
   * interruptor cada vez—, pero lo que se persiste son siempre las tres claves
   * resueltas: así el documento no depende de en qué orden se tocaron, y una
   * clave que el cliente no envía no se queda a medio camino entre "sin definir"
   * y "desactivada".
   */
  async updateNotificationPreferences(
    userId: string,
    changes: Partial<NotificationPreferences>,
  ): Promise<NotificationPreferences> {
    const user = await this.firestoreService.getUserById(userId);

    if (!user) {
      throw new ForbiddenException('User not found');
    }

    // Clave a clave y no con un spread: un DTO parcial puede traer la clave
    // presente con valor `undefined`, y el spread la impondría sobre la
    // preferencia guardada, desactivando de vuelta un interruptor que el usuario
    // no ha tocado en esta petición.
    const applied: Record<string, boolean> = {};
    for (const key of [
      'product',
      'billing',
      'usageReminders',
    ] as (keyof NotificationPreferences)[]) {
      if (typeof changes[key] === 'boolean') {
        applied[key] = changes[key];
      }
    }

    const current = resolveNotificationPreferences(
      user.notificationPreferences,
    );
    const updated = resolveNotificationPreferences({ ...current, ...applied });

    if (Object.keys(applied).length > 0) {
      // Solo las claves que vienen, con ruta anidada: escribir el objeto entero
      // haría que dos cambios simultáneos se pisaran, revirtiendo el interruptor
      // que el otro acabara de mover.
      await this.firestoreService.updateNotificationPreferences(
        userId,
        applied,
      );

      // La lectura inicial solo sirve para validar la cuenta y completar el
      // caso local. Otro PUT puede haber fusionado una clave distinta mientras
      // este esperaba la escritura; responder aquel snapshot inventaría un
      // estado que ya no es el persistido.
      const persisted = await this.firestoreService.getUserById(userId);
      if (!persisted) {
        throw new ForbiddenException('User not found');
      }
      return resolveNotificationPreferences(persisted.notificationPreferences);
    }

    return updated;
  }

  async getVerificationStatus(userId: string): Promise<VerificationStatusDto> {
    // Obtener estado fresco directamente desde Firebase Auth
    const firebaseUser = await this.firebaseAdminService.getUser(userId);

    return {
      emailVerified: firebaseUser.emailVerified,
      email: firebaseUser.email || '',
    };
  }

  /**
   * Ruta del avatar en el bucket público.
   *
   * Fija por usuario y con extensión fija: cada subida sobrescribe la anterior,
   * de modo que no quedan objetos huérfanos que limpiar después.
   */
  getProfilePhotoPath(userId: string): string {
    return `users/${userId}/avatar.webp`;
  }

  /**
   * Guarda la foto de perfil del usuario: valida, normaliza a un cuadrado
   * WebP de `PROFILE_PHOTO_SIZE_PX` de lado y publica la URL en Firestore y en
   * Firebase Auth.
   */
  async uploadProfilePhoto(
    userId: string,
    file?: Express.Multer.File,
  ): Promise<ProfilePhotoResponseDto> {
    if (!file?.buffer?.length) {
      throw new BadRequestException({
        error: ErrorCodes.NO_FILES,
        message: 'A photo file is required',
      });
    }

    // `size` lo pone multer; el buffer es la fuente de verdad si no viene.
    const size = file.size ?? file.buffer.length;
    if (size > MAX_PROFILE_PHOTO_BYTES) {
      throw new PayloadTooLargeException({
        error: ErrorCodes.IMAGE_TOO_LARGE,
        message: 'Photo exceeds the maximum allowed size',
        data: { maxBytes: MAX_PROFILE_PHOTO_BYTES, bytes: size },
      });
    }

    const user = await this.firestoreService.getUserById(userId);
    if (!user) {
      throw new NotFoundException({
        error: ErrorCodes.USER_NOT_FOUND,
        message: 'User not found',
      });
    }

    const normalized = await this.normalizeProfilePhoto(file.buffer);
    const path = this.getProfilePhotoPath(userId);

    return this.serializeProfilePhotoOperation(userId, async () => {
      // Los bytes anteriores se guardan antes de pisarlos. El objeto vive en una
      // ruta fija —para no acumular huérfanos—, así que la subida es destructiva
      // y `applyProfilePhotoURL` solo sabe revertir la URL, no la imagen: sin
      // esto, una petición que termina en error acabaría mostrando la foto nueva
      // en cuanto caducara la caché. Es un WebP de unos pocos KB.
      const previousBytes = await this.storageService.readPublicFile(path);

      const { url, generation } = await this.storageService.savePublicFile(
        path,
        normalized,
        'image/webp',
      );
      // La ruta del objeto no cambia entre subidas, así que sin versión en la
      // query el navegador —y cualquier caché intermedia— seguiría sirviendo la
      // foto anterior.
      const photoURL = `${url}?v=${Date.now()}`;

      try {
        await this.applyProfilePhotoURL(userId, photoURL);
      } catch (error) {
        await this.restoreProfilePhotoObject(path, previousBytes, generation);
        throw error;
      }

      this.logger.log(`Foto de perfil actualizada para ${userId}`);

      return { photoURL };
    });
  }

  /**
   * Quita la foto de perfil: borra el objeto y deja el campo a `null` en
   * Firestore y en Firebase Auth, que es lo que devuelve al usuario a sus
   * iniciales.
   */
  async deleteProfilePhoto(userId: string): Promise<void> {
    const user = await this.firestoreService.getUserById(userId);
    if (!user) {
      throw new NotFoundException({
        error: ErrorCodes.USER_NOT_FOUND,
        message: 'User not found',
      });
    }

    // El perfil primero y el objeto después: borrar el archivo es lo único
    // irreversible de los tres pasos, y hacerlo antes dejaría —si luego falla
    // una escritura— un perfil apuntando a una imagen que ya responde 404. Al
    // revés, lo peor que queda es un objeto huérfano, que la siguiente subida
    // sobrescribe y que la baja de cuenta (#99) barre igual.
    //
    // `null` explícito, no borrar el campo: distingue "quitó su foto" de "nunca
    // subió ninguna", y es esa diferencia la que decide si el perfil vuelve a
    // caer en la foto del proveedor de acceso.
    await this.serializeProfilePhotoOperation(userId, async () => {
      await this.applyProfilePhotoURL(userId, null);

      await this.storageService.deletePublicFile(
        this.getProfilePhotoPath(userId),
      );

      this.logger.log(`Foto de perfil eliminada para ${userId}`);
    });
  }

  /**
   * Encadena las mutaciones del avatar de un usuario sin bloquear las de los
   * demás. La cola conserva una promesa siempre resuelta para que un fallo no
   * impida ejecutar la siguiente operación y elimina la entrada al vaciarse.
   */
  private async serializeProfilePhotoOperation<T>(
    userId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.profilePhotoOperations.get(userId);
    const result = (previous ?? Promise.resolve()).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );

    this.profilePhotoOperations.set(userId, tail);

    try {
      return await result;
    } finally {
      if (this.profilePhotoOperations.get(userId) === tail) {
        this.profilePhotoOperations.delete(userId);
      }
    }
  }

  /**
   * Devuelve el objeto del avatar a como estaba antes de una subida que no llegó
   * a confirmarse: sus bytes anteriores, o ninguno si el usuario no tenía foto.
   *
   * La restauración va condicionada a la generación que escribió esa subida. Sin
   * esa precondición, dos subidas solapadas se pisan: si la segunda confirma y la
   * primera falla después, la primera restauraría su foto vieja encima de la que
   * el perfil ya da por buena. Con la precondición, GCS responde 412 y aquí no se
   * toca nada.
   *
   * Un fallo tampoco se propaga: el error que le interesa al cliente es el que
   * abortó la subida, no el de una compensación. Queda en el log.
   */
  private async restoreProfilePhotoObject(
    path: string,
    previousBytes: Buffer | null,
    generation?: string,
  ): Promise<void> {
    try {
      if (previousBytes) {
        await this.storageService.savePublicFile(
          path,
          previousBytes,
          'image/webp',
          { ifGenerationMatch: generation },
        );
      } else {
        await this.storageService.deletePublicFile(path, {
          ifGenerationMatch: generation,
        });
      }
    } catch (error) {
      if (error?.code === 412) {
        this.logger.warn(
          `No se restauró la foto anterior en ${path}: otra subida más reciente ya está confirmada`,
        );
        return;
      }

      this.logger.error(
        `No se pudo restaurar la foto anterior en ${path}: ${error.message}`,
      );
    }
  }

  /**
   * Publica la URL —o su borrado— en Firebase Auth y en Firestore dejando los
   * dos de acuerdo.
   *
   * Auth va primero porque de ahí sale el claim `picture` del token, que es lo
   * que el frontend pinta nada más refrescarlo. Si Firestore falla después, se
   * devuelve Auth a lo que tenía: sin esa compensación el token mostraría una
   * foto y `GET /users/me` otra —Firestore manda en esa lectura— y el desajuste
   * no se corregiría solo, porque nadie vuelve a mirarlo.
   *
   * El valor anterior se lee de Auth y no de Firestore: la foto del proveedor de
   * acceso solo existe ahí, y revertir a `null` la borraría de una cuenta que
   * nunca subió ninguna. Si esa lectura falla no se revierte nada —volver a un
   * valor inventado sería peor— y queda constancia en el log.
   */
  private async applyProfilePhotoURL(
    userId: string,
    photoURL: string | null,
  ): Promise<void> {
    let previous: string | null = null;
    let previousKnown = false;

    try {
      previous =
        (await this.firebaseAdminService.getUser(userId)).photoURL ?? null;
      previousKnown = true;
    } catch (error) {
      this.logger.warn(
        `No se pudo leer la foto actual de Firebase Auth para ${userId}: ${error.message}`,
      );
    }

    await this.firebaseAdminService.updateUser(userId, { photoURL });

    try {
      await this.firestoreService.updateUser(userId, { photoURL });
    } catch (error) {
      if (previousKnown) {
        await this.firebaseAdminService
          .updateUser(userId, { photoURL: previous })
          .catch((rollbackError) =>
            this.logger.error(
              `Firebase Auth quedó desalineado con el perfil de ${userId}: ${rollbackError.message}`,
            ),
          );
      } else {
        this.logger.error(
          `Firebase Auth quedó desalineado con el perfil de ${userId}: no se pudo revertir`,
        );
      }

      throw error;
    }
  }

  /**
   * Valida el formato por el contenido del archivo y devuelve el avatar ya
   * recortado a cuadrado, reescalado y convertido a WebP. Servir el original
   * significaría mandar 8 MP para pintarlos en 64 px.
   */
  private async normalizeProfilePhoto(buffer: Buffer): Promise<Buffer> {
    let metadata: sharp.Metadata | undefined;

    try {
      // `metadata()` solo inspecciona la cabecera: aquí necesitamos conocer las
      // dimensiones aunque excedan el presupuesto para poder responder con el
      // 413 documentado. El límite sigue activo abajo, en la decodificación que
      // sí reserva memoria.
      metadata = await sharp(buffer, {
        limitInputPixels: false,
      }).metadata();
    } catch (error) {
      this.logger.warn(`Foto de perfil ilegible: ${error.message}`);
    }

    const format = metadata?.format;
    if (!format || !ALLOWED_PROFILE_PHOTO_FORMATS.includes(format)) {
      throw this.unsupportedImageError(format);
    }

    this.assertWithinPixelBudget(format, metadata?.width, metadata?.height);

    try {
      // El tope va también aquí, no solo en la comprobación de arriba: es la
      // decodificación —no la lectura de la cabecera— la que reserva la memoria,
      // y así el límite se respeta aunque alguien añada otro camino de entrada.
      return await sharp(buffer, { limitInputPixels: MAX_PROFILE_PHOTO_PIXELS })
        // La orientación EXIF se aplica antes de recortar: sin esto, una foto de
        // móvil se recorta girada y el encuadre sale mal.
        .rotate()
        .resize(PROFILE_PHOTO_SIZE_PX, PROFILE_PHOTO_SIZE_PX, {
          fit: 'cover',
          position: 'centre',
        })
        .webp({ quality: 82 })
        .toBuffer();
    } catch (error) {
      // La cabecera puede pasar el examen y el archivo romperse al decodificar
      // —una imagen truncada dice ser PNG y lo es, solo que a medias—. Eso sigue
      // siendo entrada inválida: devolverlo como 500 le diría al usuario que el
      // fallo es nuestro, y sin el código que el frontend traduce.
      this.logger.warn(`Foto de perfil no decodificable: ${error.message}`);
      throw this.unsupportedImageError(format);
    }
  }

  /**
   * Rechaza lo que no cabe en el presupuesto de píxeles antes de decodificar.
   *
   * Sin dimensiones no hay nada que medir, y una imagen cuya cabecera no las
   * declara no es una imagen que sepamos tratar: eso es formato inválido, no
   * exceso de tamaño.
   */
  private assertWithinPixelBudget(
    format: string,
    width?: number,
    height?: number,
  ): void {
    if (!width || !height) {
      throw this.unsupportedImageError(format);
    }

    const pixels = width * height;
    if (pixels > MAX_PROFILE_PHOTO_PIXELS) {
      throw new PayloadTooLargeException({
        error: ErrorCodes.IMAGE_TOO_LARGE,
        message: 'Image dimensions exceed the maximum allowed',
        data: { maxPixels: MAX_PROFILE_PHOTO_PIXELS, pixels, width, height },
      });
    }
  }

  private unsupportedImageError(format?: string): BadRequestException {
    return new BadRequestException({
      error: ErrorCodes.UNSUPPORTED_IMAGE_TYPE,
      message: 'Unsupported image format',
      data: {
        allowed: ALLOWED_PROFILE_PHOTO_FORMATS,
        format: format ?? null,
      },
    });
  }

  async getUserLimits(userId: string): Promise<UserLimitsDto> {
    const user = await this.firestoreService.getUserById(userId);

    if (!user) {
      throw new ForbiddenException('User not found');
    }

    // Calcular período basado en plan (Free: desde createdAt, Pro: desde Firestore)
    const periodInfo =
      this.periodCalculatorService.calculateCurrentPeriod(user);
    const usage = await this.firestoreService.getOrCreateUsageWithPeriod(
      userId,
      periodInfo,
    );

    // Usar límites efectivos (considera simulación para admins)
    const effectivePlan = this.getEffectivePlan(user);
    const limits = this.getEffectivePlanLimits(user);
    const batchLimits = BATCH_LIMITS[effectivePlan] || BATCH_LIMITS.free;

    // Admin sin simulación = ilimitado
    const isAdminUnlimited =
      user.role === 'admin' && !this.isSimulationActive(user);

    // Get Stripe subscription status if user has a subscription
    let subscriptionStatus: string | null = null;
    if (user.stripeSubscriptionId && this.stripe) {
      try {
        const subscription = await this.stripe.subscriptions.retrieve(
          user.stripeSubscriptionId,
        );
        subscriptionStatus = subscription.status; // 'active' | 'past_due' | 'unpaid' | 'canceled' | etc
      } catch (error) {
        // Subscription might not exist (e.g., test/live mode mismatch)
        this.logger.warn(
          `Could not fetch subscription ${user.stripeSubscriptionId}: ${error.message}`,
        );
      }
    }

    return {
      plan: effectivePlan,
      limits: {
        maxLabelsPerPdf: isAdminUnlimited ? 999999 : limits.maxLabelsPerPdf,
        maxPdfsPerMonth: isAdminUnlimited ? 999999 : limits.maxPdfsPerMonth,
        canDownloadImages: isAdminUnlimited ? true : limits.canDownloadImages,
        batchAllowed: isAdminUnlimited ? true : batchLimits.batchAllowed,
        maxFilesPerBatch: isAdminUnlimited ? 100 : batchLimits.maxFilesPerBatch,
        maxFileSizeBytes: isAdminUnlimited
          ? 50 * 1024 * 1024
          : batchLimits.maxFileSizeBytes,
      },
      currentUsage: {
        pdfCount: usage.pdfCount,
        labelCount: usage.labelCount,
      },
      periodEndsAt: usage.periodEnd,
      subscriptionStatus,
      // Campos adicionales para admins
      ...(user.role === 'admin' && {
        isAdmin: true,
        isSimulating: this.isSimulationActive(user),
        simulatedPlan: user.simulatedPlan,
        simulationExpiresAt: user.simulationExpiresAt,
      }),
    };
  }

  /**
   * Gate de plan del historial, compartido por todos sus endpoints (listar,
   * borrar, recuperar el ZPL). Vive aparte para que una acción nueva sobre el
   * historial no pueda olvidarse de comprobarlo.
   */
  private async assertCanViewHistory(userId: string): Promise<void> {
    const user = await this.firestoreService.getUserById(userId);

    if (!user) {
      throw new ForbiddenException('User not found');
    }

    // Admins sin simulación tienen acceso ilimitado
    const isAdminUnlimited =
      user.role === 'admin' && !this.isSimulationActive(user);

    // Usar plan efectivo (considera simulación para admins)
    const effectivePlan = this.getEffectivePlan(user);

    // El historial es una feature premium: Free y Lite NO tienen acceso (solo Pro/Pro Max/Enterprise)
    if (!isAdminUnlimited && !PLAN_FEATURES[effectivePlan].canViewHistory) {
      throw new ForbiddenException(
        'History is only available for Pro, Pro Max and Enterprise plans',
      );
    }
  }

  /**
   * Carga un registro de historial exigiendo que sea del usuario.
   *
   * Un registro ajeno se responde igual que uno inexistente (404): un 403
   * delataría que el id existe, y el id es adivinable.
   */
  private async getOwnedHistoryRecord(
    userId: string,
    historyId: string,
  ): Promise<ConversionHistoryRecord> {
    const record =
      await this.firestoreService.getConversionHistoryById(historyId);

    if (!record || record.userId !== userId) {
      throw new NotFoundException({
        error: ErrorCodes.HISTORY_NOT_FOUND,
        message: 'History record not found',
      });
    }

    return record;
  }

  /**
   * Indica si el registro sigue dentro de la ventana de retención del bucket.
   * Se calcula por edad, sin tocar Storage: comprobar el objeto fila a fila
   * costaría una llamada a GCS por cada una.
   */
  private isWithinZplRetention(createdAt: Date | undefined): boolean {
    if (!createdAt) return false;

    // Firestore devuelve Date, pero los registros antiguos pueden traer la
    // fecha como string ISO: normalizar aquí evita un NaN silencioso.
    const created =
      createdAt instanceof Date ? createdAt : new Date(createdAt as string);
    if (Number.isNaN(created.getTime())) return false;

    const ageMs = Date.now() - created.getTime();
    return ageMs < ZPL_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  }

  /**
   * Marca cada fila con si admite "reconvertir". Las condiciones deben cumplirse
   * a la vez:
   *
   *  - que se guardara el ZPL (una sola consulta en lote para toda la página).
   *    No todas las filas lo tienen: hasta este cambio, el flujo batch creaba
   *    historial sin guardar ZPL, así que esas filas nunca podrán reconvertirse.
   *  - que el ZPL siga dentro de la ventana de retención, porque el doc de
   *    metadata sobrevive al archivo que el bucket ya borró.
   *  - que el tamaño conocido quepa en el body JSON del conversor. La metadata
   *    antigua sin `fileSize` no se bloquea porque podría ser perfectamente apta.
   *
   * La ventana se cuenta desde que se guardó el ZPL, no desde que se registró
   * la conversión: el objeto se sube al empezar y la fila del historial nace al
   * terminar, así que el lifecycle lleva ya un rato corriendo cuando aparece la
   * fila. Solo se recurre a la fecha del historial si el doc de metadata es
   * antiguo y no la trae.
   *
   * Si la consulta en lote falla, marca todo como no reconvertible: un botón de
   * más deshabilitado es preferible a prometer algo que devolverá 410.
   */
  private async resolverReconvertibles(
    records: ConversionHistoryRecord[],
  ): Promise<Set<string>> {
    let zplsGuardados = new Map<
      string,
      { createdAt: Date | null; fileSize: number | null }
    >();
    try {
      zplsGuardados = await this.firestoreService.getSavedZplDatesByJobId(
        records.map((record) => record.jobId),
      );
    } catch (error) {
      this.logger.warn(
        `Failed to resolve canReconvert flags: ${error.message}`,
      );
    }

    return new Set(
      records
        .filter((record) => {
          const zplGuardado = zplsGuardados.get(record.jobId);
          return (
            zplGuardado !== undefined &&
            this.isWithinZplRetention(
              zplGuardado.createdAt ?? record.createdAt,
            ) &&
            (zplGuardado.fileSize === null ||
              zplGuardado.fileSize <= MAX_RECONVERTIBLE_ZPL_SIZE_BYTES)
          );
        })
        .map((record) => record.id),
    );
  }

  async getUserHistory(
    userId: string,
    query: GetHistoryQueryDto = {},
  ): Promise<ConversionHistoryResponseDto> {
    await this.assertCanViewHistory(userId);

    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_HISTORY_LIMIT;

    // Se lee un bloque acotado del historial y se filtra/ordena/pagina en memoria:
    // así `search`, `sortBy=labelCount` y las combinaciones de filtros no exigen
    // un índice compuesto por cada permutación (ver issue #89).
    const { records: scanned, truncated } =
      await this.getScannedHistory(userId);

    // Los facets salen del escaneo completo, no de la página: describen lo que
    // el usuario tiene, para que el frontend pueble los selects sin hardcodear.
    const facets = this.buildHistoryFacets(scanned);

    const filtered = this.filterHistory(scanned, query);
    this.sortHistory(filtered, query);

    const total = filtered.length;
    const offset = (page - 1) * limit;
    const pageRecords = filtered.slice(offset, offset + limit);

    // Solo para la página que se devuelve: el frontend deshabilita
    // "reconvertir" con este flag en vez de descubrir la caducidad a base de
    // 410s al pulsar el botón.
    const reconvertibles = await this.resolverReconvertibles(pageRecords);

    // Firmar solo los registros que se devuelven, ya filtrados y paginados
    const data = await Promise.all(
      pageRecords.map((record) =>
        this.toHistoryItem(record, reconvertibles.has(record.id)),
      ),
    );

    return {
      success: true,
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        ...(truncated && { truncated: true }),
      },
      facets,
    };
  }

  /**
   * Escaneo del historial del usuario con caché corta en memoria.
   *
   * La caché absorbe el tecleo del buscador y los cambios de filtro/página, que
   * de otro modo repetirían hasta `MAX_HISTORY_SCAN` lecturas de Firestore por
   * pulsación. Es por instancia: en Cloud Run cada instancia mantiene la suya, y
   * el TTL corto acota la ventana en la que una conversión nueva no aparece.
   */
  private async getScannedHistory(
    userId: string,
  ): Promise<{ records: ConversionHistoryRecord[]; truncated: boolean }> {
    const cached = this.historyScanCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return { records: cached.records, truncated: cached.truncated };
    }

    // Generación antes de leer: si `recordConversion` invalida mientras el
    // escaneo está en vuelo, al resolverse hay que descartarlo. Sin esta guarda
    // se recachearía una instantánea previa a la conversión recién guardada y
    // quedaría oculta durante todo el TTL.
    const generation = this.historyCacheGeneration;

    // Se pide un documento de más: si llega, es que quedaron conversiones fuera.
    // Con `length >= MAX_HISTORY_SCAN` un usuario con exactamente ese número se
    // marcaría como truncado sin haberse omitido nada.
    const scanned = await this.firestoreService.scanUserConversionHistory(
      userId,
      MAX_HISTORY_SCAN + 1,
    );
    const truncated = scanned.length > MAX_HISTORY_SCAN;
    const records = truncated ? scanned.slice(0, MAX_HISTORY_SCAN) : scanned;

    if (this.historyCacheGeneration === generation) {
      // Evitar que la caché crezca sin límite en instancias longevas
      if (this.historyScanCache.size >= MAX_HISTORY_CACHE_ENTRIES) {
        this.pruneHistoryScanCache();
      }

      this.historyScanCache.set(userId, {
        records,
        truncated,
        expiresAt: Date.now() + HISTORY_SCAN_CACHE_TTL_MS,
      });
    }

    return { records, truncated };
  }

  /** Invalida la caché del historial de un usuario (tras registrar una conversión). */
  private invalidateHistoryScanCache(userId: string): void {
    this.historyCacheGeneration++;
    this.historyScanCache.delete(userId);
  }

  /** Elimina las entradas caducadas; si todas siguen vivas, vacía la caché entera. */
  private pruneHistoryScanCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.historyScanCache) {
      if (entry.expiresAt <= now) {
        this.historyScanCache.delete(key);
      }
    }
    if (this.historyScanCache.size >= MAX_HISTORY_CACHE_ENTRIES) {
      this.historyScanCache.clear();
    }
  }

  private buildHistoryFacets(
    records: ConversionHistoryRecord[],
  ): ConversionHistoryFacetsDto {
    const labelSizes = new Set<string>();
    const outputFormats = new Set<string>();
    const statuses = new Set<string>();

    for (const record of records) {
      if (record.labelSize) labelSizes.add(record.labelSize);
      if (record.outputFormat) outputFormats.add(record.outputFormat);
      if (record.status) statuses.add(record.status);
    }

    return {
      labelSizes: [...labelSizes].sort(),
      outputFormats: [...outputFormats].sort(),
      statuses: [...statuses].sort(),
    };
  }

  private filterHistory(
    records: ConversionHistoryRecord[],
    query: GetHistoryQueryDto,
  ): ConversionHistoryRecord[] {
    const search = query.search?.trim().toLowerCase();
    const dateFrom = this.toTimestamp(query.dateFrom);
    const dateTo = this.toRangeEndTimestamp(query.dateTo);

    return records.filter((record) => {
      if (query.status && record.status !== query.status) return false;
      if (query.outputFormat && record.outputFormat !== query.outputFormat) {
        return false;
      }
      if (query.labelSize && record.labelSize !== query.labelSize) return false;

      if (search && !this.matchesSearch(record, search)) {
        return false;
      }

      if (dateFrom !== null || dateTo !== null) {
        const createdAt = this.toTimestamp(record.createdAt);
        if (createdAt === null) return false;
        if (dateFrom !== null && createdAt < dateFrom) return false;
        if (dateTo !== null && createdAt > dateTo) return false;
      }

      return true;
    });
  }

  /**
   * issue #94: `search` era prefix-match solo sobre `jobId`, justo el único
   * campo visible en el historial que el buscador no cubría — `labelSize`,
   * `outputFormat` y `status` ya tienen filtros dedicados. Pasa a subcadena
   * (no prefijo: un usuario que pega el tramo final de un jobId copiado de una
   * URL de descarga antes no encontraba nada) y a multi-campo, para que un
   * único cuadro de búsqueda vuelva a cubrir lo que el filtrado en cliente
   * ofrecía antes de que el historial se paginara en servidor.
   *
   * Sigue siendo en memoria sobre el bloque ya escaneado (`getScannedHistory`),
   * así que no exige índices nuevos en Firestore.
   *
   * `search` ya llega en minúsculas (recortado en `filterHistory`).
   */
  private matchesSearch(
    record: ConversionHistoryRecord,
    search: string,
  ): boolean {
    if (record.jobId?.toLowerCase().includes(search)) return true;
    if (record.labelSize?.toLowerCase().includes(search)) return true;
    if (record.outputFormat?.toLowerCase().includes(search)) return true;

    // labelCount es numérico: compararlo como subcadena de texto contra un
    // término no numérico ("png", "4x6"...) no podría dar falso positivo —
    // ninguna cifra contiene letras—, pero limitar la comparación a términos
    // numéricos deja explícito que este campo solo entra en juego cuando el
    // usuario busca por cantidad de etiquetas.
    if (
      /^\d+$/.test(search) &&
      String(record.labelCount ?? '').includes(search)
    ) {
      return true;
    }

    return false;
  }

  private sortHistory(
    records: ConversionHistoryRecord[],
    query: GetHistoryQueryDto,
  ): void {
    const sortBy = query.sortBy ?? HistorySortBy.CREATED_AT;
    const direction = query.sortOrder === HistorySortOrder.ASC ? 1 : -1;

    records.sort((a, b) => {
      const aVal =
        sortBy === HistorySortBy.LABEL_COUNT
          ? (a.labelCount ?? 0)
          : (this.toTimestamp(a.createdAt) ?? 0);
      const bVal =
        sortBy === HistorySortBy.LABEL_COUNT
          ? (b.labelCount ?? 0)
          : (this.toTimestamp(b.createdAt) ?? 0);

      if (aVal === bVal) {
        // Desempate estable por fecha para que el paginado no baraje filas
        // con el mismo labelCount entre requests.
        const aTime = this.toTimestamp(a.createdAt) ?? 0;
        const bTime = this.toTimestamp(b.createdAt) ?? 0;
        if (aTime !== bTime) return bTime - aTime;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      }

      return (aVal - bVal) * direction;
    });
  }

  private toTimestamp(value: Date | string | undefined): number | null {
    if (!value) return null;
    const time =
      value instanceof Date
        ? value.getTime()
        : Date.parse(this.assumeUtc(value));
    return Number.isNaN(time) ? null : time;
  }

  /**
   * Fuerza a UTC las fechas-hora sin offset. `2026-01-20T12:00:00` es válido y
   * `Date.parse` lo resuelve en la zona local del proceso: el mismo filtro
   * significaría las 12:00 UTC en Cloud Run y las 18:00 desarrollando en Mérida
   * (GMT-6). Una fecha suelta (`YYYY-MM-DD`) ya es UTC por especificación, así
   * que se deja intacta.
   *
   * El formato de entrada lo garantiza `ISO_DATE_PATTERN` en el DTO.
   */
  private assumeUtc(value: string): string {
    const hasTime = value.includes('T');
    const hasZone = /(Z|[+-]\d{2}:\d{2})$/.test(value);
    return hasTime && !hasZone ? `${value}Z` : value;
  }

  /**
   * Extremo superior de un rango de fechas. Un `dateTo` sin hora (`YYYY-MM-DD`,
   * lo que envía un date-picker) se interpreta como el final de ese día: con la
   * medianoche que devuelve `Date.parse` el usuario perdería las conversiones
   * del propio día que acaba de seleccionar.
   */
  private toRangeEndTimestamp(value: string | undefined): number | null {
    const time = this.toTimestamp(value);
    if (time === null) return null;
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? time + DAY_IN_MS - 1 : time;
  }

  /**
   * Convierte un registro de Firestore al ítem de respuesta, regenerando la URL
   * firmada solo si la conversión se completó con archivo.
   */
  private async toHistoryItem(
    record: ConversionHistoryRecord,
    canReconvert: boolean,
  ): Promise<ConversionHistoryItemDto> {
    const createdAt = this.toTimestamp(record.createdAt);

    const item: ConversionHistoryItemDto = {
      id: record.id,
      jobId: record.jobId,
      labelCount: record.labelCount,
      labelSize: record.labelSize,
      status: record.status,
      outputFormat: record.outputFormat,
      canReconvert,
      createdAt: createdAt !== null ? new Date(createdAt).toISOString() : null,
    };

    if (record.fileUrl && record.status === 'completed') {
      item.fileUrl = record.fileUrl;
      const { storagePath, downloadFilename } = this.extractStorageInfo(
        record.fileUrl,
      );
      if (storagePath) {
        try {
          item.fileUrl = await this.storageService.generateSignedUrlForPath(
            storagePath,
            downloadFilename,
          );
        } catch (error) {
          this.logger.warn(
            `Failed to regenerate URL for ${record.jobId}: ${error.message}`,
          );
        }
      }
    }

    return item;
  }

  /**
   * Elimina un registro del historial del usuario.
   *
   * Deliberadamente NO toca `usage`: si borrar filas descontara PDFs del
   * período, cualquiera podría reiniciar su cuota vaciando el historial. El
   * historial es un registro de consulta; la cuota se lleva aparte. Tampoco
   * borra el PDF de Cloud Storage, que tiene su propio ciclo de vida.
   */
  async deleteHistoryEntry(
    userId: string,
    historyId: string,
  ): Promise<{ id: string; deleted: true }> {
    await this.assertCanViewHistory(userId);
    const record = await this.getOwnedHistoryRecord(userId, historyId);

    // La escritura de `lastActivityAt` al convertir es fire-and-forget. Si
    // falló, borrar esta fila eliminaría la única fecha fiable y podría hacer
    // que un cliente recién activo pareciera inactivo desde su alta.
    try {
      // El máximo se calcula dentro de una transacción: dos borrados paralelos
      // no pueden confirmar una fecha antigua después de otra más reciente.
      await this.firestoreService.preserveLastActivityAt(
        userId,
        record.createdAt,
      );
    } catch (error) {
      // Preservar la señal de actividad es defensivo; un fallo aquí no debe
      // convertir en imborrable una fila que el usuario ya decidió eliminar.
      this.logger.warn(
        `Failed to preserve lastActivityAt before deleting history ${historyId}: ${error.message}`,
      );
    }

    await this.firestoreService.deleteConversionHistory(historyId);

    // El listado sirve de una caché de 60s: sin invalidarla, el usuario borra
    // una fila, la tabla se recarga y la fila sigue ahí.
    this.invalidateHistoryScanCache(userId);

    return { id: historyId, deleted: true };
  }

  /**
   * Devuelve el ZPL original de una conversión para que el frontend lo
   * precargue en el conversor. La reconversión en sí pasa por el flujo normal
   * (`POST /zpl/convert`), que es donde viven los límites de plan.
   *
   * El ZPL no está en Firestore — `ConversionStatus.zplContent` existe en el
   * tipo pero nunca se escribe, y un ZPL de varios MB no cabría en un
   * documento. La copia real está en el bucket, bajo `debug-zpl/`, indexada
   * por jobId en `zpl_debug_files`. Ese prefijo caduca a los
   * ZPL_RETENTION_DAYS días: pasado ese plazo la respuesta es 410, no 500.
   */
  async getHistoryZpl(
    userId: string,
    historyId: string,
  ): Promise<{
    zplContent: string;
    labelSize: string;
    outputFormat: 'pdf' | 'png' | 'jpeg';
  }> {
    await this.assertCanViewHistory(userId);
    const record = await this.getOwnedHistoryRecord(userId, historyId);

    const zplNoLongerAvailable = new GoneException({
      error: ErrorCodes.ZPL_NOT_AVAILABLE,
      message: `The original ZPL is only kept for ${ZPL_RETENTION_DAYS} days and is no longer available for this conversion`,
      data: { retentionDays: ZPL_RETENTION_DAYS },
    });

    const debugFile = await this.firestoreService.getZplDebugFileByJobId(
      record.jobId,
    );

    // El lifecycle puede tardar hasta 24h en borrar el objeto. Respetar la edad
    // de la metadata evita que ese retraso amplíe la ventana contractual. Los
    // docs antiguos sin fecha usan la misma fecha de respaldo que el listado,
    // para que `canReconvert` y este endpoint no discrepen.
    if (
      !debugFile ||
      debugFile.userId !== userId ||
      !this.isWithinZplRetention(debugFile.createdAt ?? record.createdAt)
    ) {
      throw zplNoLongerAvailable;
    }

    // El doc de `zpl_debug_files` sobrevive al archivo — el lifecycle solo
    // borra en GCS —, así que su presencia no garantiza nada: la única prueba
    // de que el ZPL sigue ahí es leer el objeto.
    const zplContent = await this.storageService.readTextFile(
      debugFile.storagePath,
    );

    if (!zplContent) {
      throw zplNoLongerAvailable;
    }

    return {
      zplContent,
      // Normalizado, no crudo: el batch acepta el tamaño como string libre
      // (`large`, `small`, o cualquier cosa) y así queda guardado en el
      // historial, pero `POST /zpl/convert` lo valida con `@IsEnum(LabelSize)`.
      // Devolverlo tal cual haría que reconvertir fallara con un 400 usando el
      // mismo tamaño con el que la conversión original funcionó.
      labelSize: normalizeLabelSize(record.labelSize),
      // El batch también guarda el formato sin validar. La normalización debe
      // seguir su rama efectiva: solo `pdf` y `png` exactos son especiales;
      // cualquier otro string generó JPEG.
      outputFormat: normalizeOutputFormat(record.outputFormat),
    };
  }

  /**
   * Extrae el path del archivo y el nombre de descarga de una URL firmada de Google Cloud Storage
   * @param signedUrl URL firmada completa
   * @returns Objeto con storagePath y downloadFilename
   */
  private extractStorageInfo(signedUrl: string): {
    storagePath: string | null;
    downloadFilename: string | null;
  } {
    // Extraer path: https://storage.googleapis.com/bucket/label-xxx.pdf?X-Goog-...
    const storagePath = extractStoragePathFromSignedUrl(signedUrl);

    // Extraer nombre de descarga del parámetro response-content-disposition
    // Formato: ...&response-content-disposition=attachment%3B%20filename%3D%22nombre.pdf%22&...
    let downloadFilename: string | null = null;
    try {
      const url = new URL(signedUrl);
      const disposition = url.searchParams.get('response-content-disposition');
      if (disposition) {
        // Formato: attachment; filename="nombre.pdf"
        const filenameMatch = disposition.match(/filename="([^"]+)"/);
        if (filenameMatch) {
          downloadFilename = filenameMatch[1];
        }
      }
    } catch {
      // Si no se puede parsear la URL, intentar con regex
      const filenameMatch = signedUrl.match(/filename%3D%22([^%]+)%22/i);
      if (filenameMatch) {
        downloadFilename = decodeURIComponent(filenameMatch[1]);
      }
    }

    return { storagePath, downloadFilename };
  }

  async checkCanConvert(
    userId: string,
    labelCount: number,
  ): Promise<CheckCanConvertResult> {
    if (await this.firestoreService.isAccountDeletionMarked(userId)) {
      return {
        allowed: false,
        error: 'User not found',
        errorCode: ErrorCodes.USER_NOT_FOUND,
        userEmail: null,
      };
    }

    const user = await this.firestoreService.getUserById(userId);

    if (!user) {
      return {
        allowed: false,
        error: 'User not found',
        errorCode: 'USER_NOT_FOUND',
        userEmail: null,
      };
    }

    const userEmail = user.email || null;

    // Admins sin simulación activa tienen acceso ilimitado
    if (user.role === 'admin' && !this.isSimulationActive(user)) {
      const periodInfo =
        this.periodCalculatorService.calculateCurrentPeriod(user);
      return { allowed: true, periodInfo, userEmail };
    }

    // Check email verification (defense in depth - frontend should handle this)
    if (!user.emailVerified) {
      return {
        allowed: false,
        error: 'Please verify your email before using the service',
        errorCode: 'EMAIL_NOT_VERIFIED',
        userEmail,
      };
    }

    // Block disposable/temporary email domains
    if (isBlockedEmailDomain(user.email)) {
      return {
        allowed: false,
        error: 'Temporary/disposable email addresses are not allowed',
        errorCode: 'BLOCKED_EMAIL_DOMAIN',
        userEmail,
      };
    }

    const limits = this.getEffectivePlanLimits(user);

    // Calcular período basado en plan (Free: desde createdAt, Pro: desde Firestore)
    const periodInfo =
      this.periodCalculatorService.calculateCurrentPeriod(user);
    const usage = await this.firestoreService.getOrCreateUsageWithPeriod(
      userId,
      periodInfo,
    );

    // Check labels per PDF limit
    if (labelCount > limits.maxLabelsPerPdf) {
      return {
        allowed: false,
        error: `Your plan allows ${limits.maxLabelsPerPdf} labels per PDF`,
        errorCode: 'LABEL_LIMIT_EXCEEDED',
        data: {
          requested: labelCount,
          allowed: limits.maxLabelsPerPdf,
        },
        userEmail,
      };
    }

    // Check monthly PDF limit
    if (usage.pdfCount >= limits.maxPdfsPerMonth) {
      return {
        allowed: false,
        error: "You've reached your monthly limit",
        errorCode: 'MONTHLY_LIMIT_EXCEEDED',
        data: {
          current: usage.pdfCount,
          allowed: limits.maxPdfsPerMonth,
          resetsAt: usage.periodEnd.toISOString().split('T')[0],
        },
        userEmail,
      };
    }

    return { allowed: true, periodInfo, userEmail };
  }

  async recordConversion(
    userId: string,
    jobId: string,
    labelCount: number,
    labelSize: string,
    status: 'completed' | 'failed',
    outputFormat: 'pdf' | 'png' | 'jpeg' = 'pdf',
    fileUrl?: string,
    periodInfo?: PeriodInfo,
    userPlan?: PlanType,
  ): Promise<void> {
    // Una conversión puede terminar mucho después de la request que la inició.
    // La segunda comprobación evita que ese trabajo reanime datos ya barridos;
    // Firestore repite la misma condición dentro de las escrituras para cerrar
    // también la carrera entre esta lectura y el commit.
    if (await this.firestoreService.isAccountDeletionMarked(userId)) {
      throw new GoneException('Account deletion in progress');
    }

    // Save to history (use null instead of undefined for Firestore)
    await this.firestoreService.saveConversionHistory({
      userId,
      jobId,
      labelCount,
      labelSize,
      status,
      outputFormat,
      fileUrl: fileUrl || null,
      createdAt: new Date(),
    });

    // La conversión recién guardada debe aparecer en el historial al instante
    this.invalidateHistoryScanCache(userId);

    // Update lastActivityAt and reset inactive notification flags
    this.firestoreService
      .updateUser(userId, {
        lastActivityAt: new Date(),
        notifiedInactive7Days: false,
        notifiedInactive30Days: false,
      })
      .catch((err) =>
        this.logger.error(`Failed to update lastActivityAt: ${err.message}`),
      );

    // Get user plan if not provided
    let plan = userPlan;
    if (!plan) {
      const user = await this.firestoreService.getUserById(userId);
      plan = (user?.plan as PlanType) || 'free';
    }

    // Update daily stats (fire-and-forget for performance)
    this.firestoreService
      .incrementDailyStats(userId, plan, 1, labelCount, status)
      .catch((err) =>
        this.logger.error(`Failed to update daily stats: ${err.message}`),
      );

    // Increment usage only for completed conversions
    if (status === 'completed') {
      let effectivePeriod = periodInfo;
      if (!effectivePeriod) {
        const user = await this.firestoreService.getUserById(userId);
        if (user) {
          effectivePeriod =
            this.periodCalculatorService.calculateCurrentPeriod(user);
        }
      }
      if (effectivePeriod) {
        await this.firestoreService.incrementUsageWithPeriod(
          userId,
          effectivePeriod,
          1,
          labelCount,
        );
      }

      // Check and trigger limit emails (fire-and-forget)
      this.checkAndTriggerLimitEmails(userId, userPlan || 'free').catch((err) =>
        this.logger.error(`Failed to check limit emails: ${err.message}`),
      );
    }
  }

  /**
   * Check if user has reached limit thresholds and trigger appropriate emails
   * Called after each successful conversion
   *
   * The template must be enabled in Firestore (controlled via frontend toggle).
   */
  private async checkAndTriggerLimitEmails(
    userId: string,
    userPlan: PlanType,
  ): Promise<void> {
    // Solo Free y Lite tienen cuota mensual baja y reciben avisos de límite.
    // Pro/Pro Max/Enterprise tienen cuotas altas y no se les notifica.
    if (userPlan !== 'free' && userPlan !== 'lite') {
      return;
    }

    try {
      const user = await this.firestoreService.getUserById(userId);
      if (!user) return;

      // Get usage data for pdfCount and period dates (período actual del usuario)
      const periodInfo =
        this.periodCalculatorService.calculateCurrentPeriod(user);
      const usage = await this.firestoreService.getOrCreateUsageWithPeriod(
        userId,
        periodInfo,
      );
      const pdfCount = usage.pdfCount || 0;
      const limit =
        user.planLimits?.maxPdfsPerMonth ||
        DEFAULT_PLAN_LIMITS[user.plan]?.maxPdfsPerMonth ||
        DEFAULT_PLAN_LIMITS.free.maxPdfsPerMonth;
      const percentage = (pdfCount / limit) * 100;

      const periodStart = usage.periodStart;
      const periodEnd = usage.periodEnd;

      // Detect language from user country
      const language = this.detectLanguageFromCountry(user.country);

      // Check if user just hit 100% (exactly at limit)
      if (pdfCount === limit) {
        await this.emailService.queueLimitEmail(userId, 'limit_100_percent', {
          pdfsUsed: pdfCount,
          limit,
          periodStart,
          periodEnd,
          discountCode: 'UPGRADE20',
          displayName: user.displayName,
          email: user.email,
          language,
        });
        this.logger.log(`Queued limit_100_percent email for user ${userId}`);
      }
      // Check if user just crossed 80% threshold
      else if (percentage >= 80 && percentage < 100) {
        // Only trigger if previous count was below 80%
        const previousCount = pdfCount - 1;
        const previousPercentage = (previousCount / limit) * 100;

        if (previousPercentage < 80) {
          await this.emailService.queueLimitEmail(userId, 'limit_80_percent', {
            pdfsUsed: pdfCount,
            limit,
            periodStart,
            periodEnd,
            displayName: user.displayName,
            email: user.email,
            language,
          });
          this.logger.log(`Queued limit_80_percent email for user ${userId}`);
        }
      }
    } catch (error) {
      this.logger.error(
        `Error checking limit emails for ${userId}: ${error.message}`,
      );
    }
  }

  async getUserById(userId: string): Promise<User | null> {
    return this.firestoreService.getUserById(userId);
  }

  private getPlanLimits(user: User): PlanLimits {
    // Para enterprise con límites personalizados, usar esos
    if (user.plan === 'enterprise' && user.planLimits) {
      return user.planLimits;
    }

    // Usar límites por defecto del plan
    return DEFAULT_PLAN_LIMITS[user.plan] || DEFAULT_PLAN_LIMITS.free;
  }

  /**
   * Verifica si un admin tiene una simulación de plan activa
   */
  private isSimulationActive(user: User): boolean {
    if (user.role !== 'admin') return false;
    if (!user.simulatedPlan || !user.simulationExpiresAt) return false;
    return new Date() < new Date(user.simulationExpiresAt);
  }

  /**
   * Obtiene los límites efectivos considerando simulación de plan
   */
  private getEffectivePlanLimits(user: User): PlanLimits {
    // Si es admin con simulación activa, usar límites del plan simulado
    if (this.isSimulationActive(user) && user.simulatedPlan) {
      return (
        DEFAULT_PLAN_LIMITS[user.simulatedPlan] || DEFAULT_PLAN_LIMITS.free
      );
    }

    return this.getPlanLimits(user);
  }

  /**
   * Obtiene el plan efectivo (real o simulado)
   */
  getEffectivePlan(user: User): PlanType {
    if (this.isSimulationActive(user) && user.simulatedPlan) {
      return user.simulatedPlan;
    }
    return user.plan;
  }

  /**
   * Detect email language from country code
   */
  private detectLanguageFromCountry(country?: string): string {
    if (!country) return 'en';

    const spanishCountries = [
      'MX',
      'ES',
      'AR',
      'CO',
      'PE',
      'CL',
      'VE',
      'EC',
      'GT',
      'CU',
      'BO',
      'DO',
      'HN',
      'SV',
      'NI',
      'CR',
      'PA',
      'UY',
      'PR',
    ];
    const chineseCountries = ['CN', 'TW', 'HK', 'MO', 'SG'];

    if (spanishCountries.includes(country)) return 'es';
    if (chineseCountries.includes(country)) return 'zh';

    return 'en';
  }
}
