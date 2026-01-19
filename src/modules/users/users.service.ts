import { Injectable, Logger, ForbiddenException, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { FirestoreService } from '../cache/firestore.service.js';
import { FirebaseAdminService } from '../auth/firebase-admin.service.js';
import { PeriodCalculatorService, PeriodInfo } from '../../common/services/period-calculator.service.js';
import { DEFAULT_PLAN_LIMITS } from '../../common/interfaces/user.interface.js';
import type { User, PlanType, PlanLimits } from '../../common/interfaces/user.interface.js';
import type { ConversionHistory } from '../../common/interfaces/conversion-history.interface.js';
import { UserProfileDto } from './dto/user-profile.dto.js';
import { UserLimitsDto } from './dto/user-limits.dto.js';
import { VerificationStatusDto } from './dto/verification-status.dto.js';
import type { FirebaseUser } from '../../common/decorators/current-user.decorator.js';
import { BATCH_LIMITS } from '../zpl/interfaces/batch.interface.js';
import { isBlockedEmailDomain } from '../../common/constants/blocked-email-domains.js';
import { GeoService } from '../admin/services/geo.service.js';
import { EmailService } from '../email/email.service.js';
import { StorageService } from '../storage/storage.service.js';

export interface CheckCanConvertResult {
  allowed: boolean;
  error?: string;
  errorCode?: string;
  data?: Record<string, any>;
  periodInfo?: PeriodInfo;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  private stripe: Stripe | null = null;

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
      this.logger.warn(`Could not fetch Firebase user for emailVerified: ${error.message}`);
    }

    const existingUser = await this.firestoreService.getUserById(firebaseUser.uid);

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
      const shouldUpdateGeo = !existingUser.country ||
        (existingUser.countrySource === 'ip' && this.geoService.shouldRefreshGeo(existingUser));

      if (shouldUpdateGeo) {
        // Prioridad: 1. Vercel headers (edge), 2. ip.guide API (fallback)
        if (vercelGeo?.country) {
          updates.country = vercelGeo.country;
          updates.city = vercelGeo.city;
          updates.countrySource = 'ip';
          updates.countryDetectedAt = new Date();
          this.logger.log(`Using Vercel geo ${vercelGeo.country}/${vercelGeo.city || ''} for existing user ${firebaseUser.uid}`);
        } else if (clientIP) {
          try {
            const geoData = await this.geoService.detectCountryByIP(clientIP);
            if (geoData) {
              updates.country = geoData.country;
              updates.city = geoData.city;
              updates.countrySource = 'ip';
              updates.countryDetectedAt = new Date();
              this.logger.log(`Detected geo ${geoData.country}/${geoData.city} for existing user ${firebaseUser.uid}`);
            }
          } catch (error) {
            this.logger.warn(`Failed to detect geo for ${firebaseUser.uid}: ${error.message}`);
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
      this.logger.log(`Using Vercel geo ${country}/${city || ''} for new user ${firebaseUser.uid}`);
    } else if (clientIP) {
      try {
        const geoData = await this.geoService.detectCountryByIP(clientIP);
        if (geoData) {
          country = geoData.country;
          city = geoData.city;
          this.logger.log(`Detected geo ${country}/${city} for new user ${firebaseUser.uid}`);
        }
      } catch (error) {
        this.logger.warn(`Failed to detect geo for ${firebaseUser.uid}: ${error.message}`);
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
      .catch((err) => this.logger.error(`Failed to queue welcome email: ${err.message}`));

    return newUser;
  }

  async getUserProfile(userId: string): Promise<UserProfileDto> {
    const user = await this.firestoreService.getUserById(userId);

    if (!user) {
      throw new ForbiddenException('User not found');
    }

    // Obtener estado fresco de emailVerified desde Firebase Auth
    let emailVerified = user.emailVerified ?? false;
    try {
      const firebaseUser = await this.firebaseAdminService.getUser(userId);
      emailVerified = firebaseUser.emailVerified;
    } catch (error) {
      this.logger.warn(`Could not fetch Firebase user for emailVerified: ${error.message}`);
    }

    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      emailVerified,
      plan: this.getEffectivePlan(user),
      createdAt: user.createdAt,
      hasStripeSubscription: !!user.stripeSubscriptionId,
    };
  }

  async getVerificationStatus(userId: string): Promise<VerificationStatusDto> {
    // Obtener estado fresco directamente desde Firebase Auth
    const firebaseUser = await this.firebaseAdminService.getUser(userId);

    return {
      emailVerified: firebaseUser.emailVerified,
      email: firebaseUser.email || '',
    };
  }

  async getUserLimits(userId: string): Promise<UserLimitsDto> {
    const user = await this.firestoreService.getUserById(userId);

    if (!user) {
      throw new ForbiddenException('User not found');
    }

    // Calcular período basado en plan (Free: desde createdAt, Pro: desde Firestore)
    const periodInfo = this.periodCalculatorService.calculateCurrentPeriod(user);
    const usage = await this.firestoreService.getOrCreateUsageWithPeriod(userId, periodInfo);

    // Usar límites efectivos (considera simulación para admins)
    const effectivePlan = this.getEffectivePlan(user);
    const limits = this.getEffectivePlanLimits(user);
    const batchLimits = BATCH_LIMITS[effectivePlan] || BATCH_LIMITS.free;

    // Admin sin simulación = ilimitado
    const isAdminUnlimited = user.role === 'admin' && !this.isSimulationActive(user);

    // Get Stripe subscription status if user has a subscription
    let subscriptionStatus: string | null = null;
    if (user.stripeSubscriptionId && this.stripe) {
      try {
        const subscription = await this.stripe.subscriptions.retrieve(user.stripeSubscriptionId);
        subscriptionStatus = subscription.status; // 'active' | 'past_due' | 'unpaid' | 'canceled' | etc
      } catch (error) {
        // Subscription might not exist (e.g., test/live mode mismatch)
        this.logger.warn(`Could not fetch subscription ${user.stripeSubscriptionId}: ${error.message}`);
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
        maxFileSizeBytes: isAdminUnlimited ? 50 * 1024 * 1024 : batchLimits.maxFileSizeBytes,
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

  async getUserHistory(
    userId: string,
    page: number = 1,
    limit: number = 50,
  ): Promise<ConversionHistory[]> {
    const user = await this.firestoreService.getUserById(userId);

    if (!user) {
      throw new ForbiddenException('User not found');
    }

    // Admins sin simulación tienen acceso ilimitado
    const isAdminUnlimited = user.role === 'admin' && !this.isSimulationActive(user);

    // Usar plan efectivo (considera simulación para admins)
    const effectivePlan = this.getEffectivePlan(user);

    // Solo Free no tiene acceso al historial (Pro, Pro Max y Enterprise sí)
    if (!isAdminUnlimited && effectivePlan === 'free') {
      throw new ForbiddenException('History is only available for Pro, Pro Max and Enterprise plans');
    }

    const offset = (page - 1) * limit;
    const history = await this.firestoreService.getUserConversionHistory(userId, limit, offset);

    // Regenerar URLs firmadas frescas para cada registro completado
    return Promise.all(
      history.map(async (record) => {
        if (record.fileUrl && record.status === 'completed') {
          const { storagePath, downloadFilename } = this.extractStorageInfo(record.fileUrl);
          if (storagePath) {
            try {
              record.fileUrl = await this.storageService.generateSignedUrlForPath(
                storagePath,
                downloadFilename,
              );
            } catch (error) {
              this.logger.warn(`Failed to regenerate URL for ${record.jobId}: ${error.message}`);
            }
          }
        }
        return record;
      }),
    );
  }

  /**
   * Extrae el path del archivo y el nombre de descarga de una URL firmada de Google Cloud Storage
   * @param signedUrl URL firmada completa
   * @returns Objeto con storagePath y downloadFilename
   */
  private extractStorageInfo(signedUrl: string): { storagePath: string | null; downloadFilename: string | null } {
    // Extraer path: https://storage.googleapis.com/bucket/label-xxx.pdf?X-Goog-...
    const pathMatch = signedUrl.match(/googleapis\.com\/[^/]+\/([^?]+)/);
    const storagePath = pathMatch ? pathMatch[1] : null;

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
    const user = await this.firestoreService.getUserById(userId);

    if (!user) {
      return {
        allowed: false,
        error: 'User not found',
        errorCode: 'USER_NOT_FOUND',
      };
    }

    // Admins sin simulación activa tienen acceso ilimitado
    if (user.role === 'admin' && !this.isSimulationActive(user)) {
      const periodInfo = this.periodCalculatorService.calculateCurrentPeriod(user);
      return { allowed: true, periodInfo };
    }

    // Check email verification (defense in depth - frontend should handle this)
    if (!user.emailVerified) {
      return {
        allowed: false,
        error: 'Please verify your email before using the service',
        errorCode: 'EMAIL_NOT_VERIFIED',
      };
    }

    // Block disposable/temporary email domains
    if (isBlockedEmailDomain(user.email)) {
      return {
        allowed: false,
        error: 'Temporary/disposable email addresses are not allowed',
        errorCode: 'BLOCKED_EMAIL_DOMAIN',
      };
    }

    const limits = this.getEffectivePlanLimits(user);

    // Calcular período basado en plan (Free: desde createdAt, Pro: desde Firestore)
    const periodInfo = this.periodCalculatorService.calculateCurrentPeriod(user);
    const usage = await this.firestoreService.getOrCreateUsageWithPeriod(userId, periodInfo);

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
      };
    }

    return { allowed: true, periodInfo };
  }

  async recordConversion(
    userId: string,
    jobId: string,
    labelCount: number,
    labelSize: string,
    status: 'completed' | 'failed',
    outputFormat: 'pdf' | 'png' | 'jpeg' = 'pdf',
    fileUrl?: string,
    periodId?: string,
    userPlan?: 'free' | 'pro' | 'enterprise',
  ): Promise<void> {
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

    // Update lastActivityAt and reset inactive notification flags
    this.firestoreService
      .updateUser(userId, {
        lastActivityAt: new Date(),
        notifiedInactive7Days: false,
        notifiedInactive30Days: false,
      })
      .catch((err) => this.logger.error(`Failed to update lastActivityAt: ${err.message}`));

    // Get user plan if not provided
    let plan = userPlan;
    if (!plan) {
      const user = await this.firestoreService.getUserById(userId);
      plan = (user?.plan as 'free' | 'pro' | 'enterprise') || 'free';
    }

    // Update daily stats (fire-and-forget for performance)
    this.firestoreService
      .incrementDailyStats(userId, plan, 1, labelCount, status)
      .catch((err) => this.logger.error(`Failed to update daily stats: ${err.message}`));

    // Increment usage only for completed conversions
    if (status === 'completed') {
      if (periodId) {
        // Usar el periodId proporcionado (más eficiente)
        await this.firestoreService.incrementUsageWithPeriod(userId, periodId, 1, labelCount);
      } else {
        // Fallback: calcular período (para compatibilidad hacia atrás)
        const user = await this.firestoreService.getUserById(userId);
        if (user) {
          const periodInfo = this.periodCalculatorService.calculateCurrentPeriod(user);
          await this.firestoreService.incrementUsageWithPeriod(userId, periodInfo.periodId, 1, labelCount);
        }
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
  private async checkAndTriggerLimitEmails(userId: string, userPlan: 'free' | 'pro' | 'enterprise'): Promise<void> {
    // Only trigger for free users
    if (userPlan !== 'free') {
      return;
    }

    try {
      const user = await this.firestoreService.getUserById(userId);
      if (!user) return;

      // Get usage data for pdfCount and period dates
      const usage = await this.firestoreService.getOrCreateUsage(userId);
      const pdfCount = usage.pdfCount || 0;
      const limit = user.planLimits?.maxPdfsPerMonth || DEFAULT_PLAN_LIMITS.free.maxPdfsPerMonth;
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
      this.logger.error(`Error checking limit emails for ${userId}: ${error.message}`);
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
      return DEFAULT_PLAN_LIMITS[user.simulatedPlan] || DEFAULT_PLAN_LIMITS.free;
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
      'MX', 'ES', 'AR', 'CO', 'PE', 'CL', 'VE', 'EC', 'GT', 'CU',
      'BO', 'DO', 'HN', 'SV', 'NI', 'CR', 'PA', 'UY', 'PR',
    ];
    const chineseCountries = ['CN', 'TW', 'HK', 'MO', 'SG'];

    if (spanishCountries.includes(country)) return 'es';
    if (chineseCountries.includes(country)) return 'zh';

    return 'en';
  }
}
