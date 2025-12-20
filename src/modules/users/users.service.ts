import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
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

  constructor(
    private readonly firestoreService: FirestoreService,
    private readonly firebaseAdminService: FirebaseAdminService,
    private readonly periodCalculatorService: PeriodCalculatorService,
  ) {}

  async syncUser(firebaseUser: FirebaseUser): Promise<User> {
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
      await this.firestoreService.updateUser(firebaseUser.uid, {
        email: firebaseUser.email,
        displayName: firebaseUser.name,
        emailVerified,
      });

      return {
        ...existingUser,
        email: firebaseUser.email,
        displayName: firebaseUser.name,
        emailVerified,
      };
    }

    // Create new user with free plan
    const newUser: User = {
      id: firebaseUser.uid,
      email: firebaseUser.email,
      displayName: firebaseUser.name,
      emailVerified,
      plan: 'free',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.firestoreService.createUser(newUser);
    this.logger.log(`New user created: ${firebaseUser.uid}`);

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
      plan: user.plan,
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

    // Calcular período basado en plan (Free: desde createdAt, Pro: desde Stripe)
    const periodInfo = await this.periodCalculatorService.calculateCurrentPeriod(user);
    const usage = await this.firestoreService.getOrCreateUsageWithPeriod(userId, periodInfo);
    const limits = this.getPlanLimits(user);
    const batchLimits = BATCH_LIMITS[user.plan] || BATCH_LIMITS.free;

    return {
      plan: user.plan,
      limits: {
        maxLabelsPerPdf: limits.maxLabelsPerPdf,
        maxPdfsPerMonth: limits.maxPdfsPerMonth,
        canDownloadImages: limits.canDownloadImages,
        batchAllowed: batchLimits.batchAllowed,
        maxFilesPerBatch: batchLimits.maxFilesPerBatch,
        maxFileSizeBytes: batchLimits.maxFileSizeBytes,
      },
      currentUsage: {
        pdfCount: usage.pdfCount,
        labelCount: usage.labelCount,
      },
      periodEndsAt: usage.periodEnd,
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

    // Only Pro and Enterprise can access history
    if (user.plan === 'free') {
      throw new ForbiddenException('History is only available for Pro and Enterprise plans');
    }

    const offset = (page - 1) * limit;
    return this.firestoreService.getUserConversionHistory(userId, limit, offset);
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

    const limits = this.getPlanLimits(user);

    // Calcular período basado en plan (Free: desde createdAt, Pro: desde Stripe)
    const periodInfo = await this.periodCalculatorService.calculateCurrentPeriod(user);
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
          const periodInfo = await this.periodCalculatorService.calculateCurrentPeriod(user);
          await this.firestoreService.incrementUsageWithPeriod(userId, periodInfo.periodId, 1, labelCount);
        }
      }
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
}
