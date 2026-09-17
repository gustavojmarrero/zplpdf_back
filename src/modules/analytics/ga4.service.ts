import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface AnalyticsContext {
  consent: 'granted';
  clientId: string;
  sessionId?: number;
}

export interface TrackPurchaseParams {
  userId: string;
  transactionId: string;
  planId: string;
  planName: string;
  price: number;
  currency?: string;
  analytics?: AnalyticsContext;
}

export interface TrackInactivityParams {
  userId: string;
  /** Compatibility only: never exported or logged. */
  userEmail?: string;
  daysInactive: 7 | 30;
  userPlan: string;
  lastActivityAt?: Date;
  analytics?: AnalyticsContext;
}

@Injectable()
export class GA4Service {
  private readonly logger = new Logger(GA4Service.name);
  private readonly measurementId: string;
  private readonly apiSecret: string;

  constructor(config: ConfigService) {
    this.measurementId = config.get<string>('GA4_MEASUREMENT_ID');
    this.apiSecret = config.get<string>('GA4_API_SECRET');
  }

  /** True means transport accepted, not verified GA4 processing or a billing fact. */
  async trackPurchase(params: TrackPurchaseParams): Promise<boolean> {
    const currency = params.currency || 'USD';
    if (
      !Number.isFinite(params.price) ||
      params.price <= 0 ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(params.transactionId) ||
      !/^(plan_)?(lite|pro|promax|enterprise)(_yearly)?$/.test(params.planId) ||
      !/^[A-Z]{3}$/.test(currency)
    )
      return false;
    return this.send(
      'purchase',
      {
        transaction_id: params.transactionId,
        value: params.price,
        currency,
        source: 'server',
        items: [{ item_id: params.planId, price: params.price, quantity: 1 }],
      },
      params.analytics,
    );
  }

  async trackInactivity(params: TrackInactivityParams): Promise<boolean> {
    if (
      ![7, 30].includes(params.daysInactive) ||
      !/^(free|lite|pro|promax|enterprise)$/.test(params.userPlan)
    )
      return false;
    return this.send(
      `user_inactive_${params.daysInactive}_days`,
      {
        days_inactive: params.daysInactive,
        user_plan: params.userPlan,
        source: 'server',
      },
      params.analytics,
    );
  }

  private async send(
    name: string,
    params: Record<string, unknown>,
    context?: AnalyticsContext,
  ): Promise<boolean> {
    // A Firebase UID is not a browser client ID. Legacy callers deliberately skip export.
    if (
      !this.measurementId ||
      !this.apiSecret ||
      context?.consent !== 'granted' ||
      !/^\d{1,20}\.\d{1,20}$/.test(context.clientId) ||
      (context.sessionId !== undefined &&
        (!Number.isSafeInteger(context.sessionId) || context.sessionId <= 0))
    )
      return false;
    const query = new URLSearchParams({
      measurement_id: this.measurementId,
      api_secret: this.apiSecret,
    });
    try {
      const response = await fetch(
        `https://www.google-analytics.com/mp/collect?${query}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: context.clientId,
            events: [
              {
                name,
                params: {
                  ...params,
                  ...(context.sessionId === undefined
                    ? {}
                    : { session_id: context.sessionId }),
                },
              },
            ],
          }),
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!response.ok) {
        this.logger.warn(`GA4 transport rejected: HTTP ${response.status}`);
        return false;
      }
      this.logger.debug('GA4 transport accepted; processing unverified');
      return true;
    } catch {
      // Fetch errors may contain the URL with its API secret.
      this.logger.warn('GA4 transport unavailable');
      return false;
    }
  }
}
