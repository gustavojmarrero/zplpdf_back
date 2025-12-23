import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface TrackPurchaseParams {
  userId: string;
  transactionId: string;
  planId: string;
  planName: string;
  price: number;
  currency?: string;
}

@Injectable()
export class GA4Service {
  private readonly logger = new Logger(GA4Service.name);
  private readonly measurementId: string;
  private readonly apiSecret: string;
  private readonly endpoint = 'https://www.google-analytics.com/mp/collect';

  constructor(private readonly configService: ConfigService) {
    this.measurementId = this.configService.get<string>('GA4_MEASUREMENT_ID');
    this.apiSecret = this.configService.get<string>('GA4_API_SECRET');

    if (!this.measurementId || !this.apiSecret) {
      this.logger.warn('GA4 Measurement Protocol not configured. Server-side tracking disabled.');
    } else {
      this.logger.log('GA4 Measurement Protocol configured successfully');
    }
  }

  /**
   * Tracks a purchase event in Google Analytics 4 using Measurement Protocol
   * @param params Purchase parameters
   * @returns true if tracking was successful, false otherwise
   */
  async trackPurchase(params: TrackPurchaseParams): Promise<boolean> {
    if (!this.measurementId || !this.apiSecret) {
      this.logger.debug('GA4 tracking skipped: not configured');
      return false;
    }

    try {
      const url = `${this.endpoint}?measurement_id=${this.measurementId}&api_secret=${this.apiSecret}`;

      const payload = {
        client_id: params.userId,
        user_id: params.userId,
        events: [
          {
            name: 'purchase',
            params: {
              transaction_id: params.transactionId,
              value: params.price,
              currency: params.currency || 'USD',
              source: 'server',
              items: [
                {
                  item_id: params.planId,
                  item_name: params.planName,
                  price: params.price,
                  quantity: 1,
                },
              ],
            },
          },
        ],
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        this.logger.error(`GA4 tracking failed: ${response.status} ${response.statusText}`);
        return false;
      }

      this.logger.log(`GA4 purchase tracked: ${params.transactionId} (${params.planName}, ${params.price} ${params.currency || 'USD'})`);
      return true;
    } catch (error) {
      this.logger.error(`GA4 tracking error: ${error.message}`);
      return false;
    }
  }
}
