import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExchangeRate } from '../../../common/interfaces/finance.interface.js';

interface BanxicoResponse {
  bmx: {
    series: Array<{
      idSerie: string;
      titulo: string;
      datos: Array<{
        fecha: string;
        dato: string;
      }>;
    }>;
  };
}

@Injectable()
export class ExchangeRateService {
  private readonly logger = new Logger(ExchangeRateService.name);
  private readonly BANXICO_SERIES_ID = 'SF43718'; // Tipo de cambio FIX
  private readonly BANXICO_API_URL = 'https://www.banxico.org.mx/SieAPIRest/service/v1/series';
  private readonly CACHE_TTL_HOURS = 24;

  // Cache en memoria para evitar llamadas repetidas
  private memoryCache: { rate: number; fetchedAt: Date } | null = null;

  constructor(private readonly configService: ConfigService) {}

  /**
   * Obtiene el tipo de cambio USD→MXN
   * Primero busca en cache de memoria, luego en Firestore, finalmente en Banxico
   */
  async getExchangeRate(
    firestoreService: {
      getExchangeRate: (date: string) => Promise<ExchangeRate | null>;
      saveExchangeRate: (rate: ExchangeRate) => Promise<void>;
    },
    date?: Date,
  ): Promise<number> {
    const targetDate = date || new Date();
    const dateString = this.formatDate(targetDate);

    // 1. Verificar cache en memoria (para el día actual)
    if (!date && this.memoryCache) {
      const hoursSinceCache =
        (Date.now() - this.memoryCache.fetchedAt.getTime()) / (1000 * 60 * 60);
      if (hoursSinceCache < this.CACHE_TTL_HOURS) {
        this.logger.debug(`Using memory cache: ${this.memoryCache.rate}`);
        return this.memoryCache.rate;
      }
    }

    // 2. Buscar en Firestore
    try {
      const cached = await firestoreService.getExchangeRate(dateString);
      if (cached) {
        const hoursSinceCache =
          (Date.now() - new Date(cached.fetchedAt).getTime()) / (1000 * 60 * 60);
        if (hoursSinceCache < this.CACHE_TTL_HOURS) {
          this.logger.debug(`Using Firestore cache: ${cached.usdToMxn}`);
          // Actualizar cache en memoria
          if (!date) {
            this.memoryCache = { rate: cached.usdToMxn, fetchedAt: new Date(cached.fetchedAt) };
          }
          return cached.usdToMxn;
        }
      }
    } catch (error) {
      this.logger.warn(`Error reading exchange rate from Firestore: ${error.message}`);
    }

    // 3. Obtener de Banxico
    const rate = await this.fetchFromBanxico();

    // 4. Guardar en cache
    try {
      const exchangeRate: ExchangeRate = {
        id: `rate_${dateString.replace(/-/g, '')}`,
        date: dateString,
        usdToMxn: rate,
        source: 'banxico',
        fetchedAt: new Date(),
      };
      await firestoreService.saveExchangeRate(exchangeRate);
      this.logger.log(`Saved exchange rate to Firestore: ${rate}`);
    } catch (error) {
      this.logger.warn(`Error saving exchange rate to Firestore: ${error.message}`);
    }

    // Actualizar cache en memoria
    if (!date) {
      this.memoryCache = { rate, fetchedAt: new Date() };
    }

    return rate;
  }

  /**
   * Obtiene el tipo de cambio de la API de Banxico
   */
  async fetchFromBanxico(): Promise<number> {
    const token = this.configService.get<string>('BANXICO_API_TOKEN');

    if (!token) {
      this.logger.warn('BANXICO_API_TOKEN not configured, using fallback rate');
      return this.getFallbackRate();
    }

    try {
      const today = new Date();
      const endDate = this.formatDate(today);
      // Buscar últimos 7 días para asegurar encontrar un dato (fines de semana no hay)
      const startDate = this.formatDate(new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000));

      const url = `${this.BANXICO_API_URL}/${this.BANXICO_SERIES_ID}/datos/${startDate}/${endDate}`;

      const response = await fetch(url, {
        headers: {
          'Bmx-Token': token,
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Banxico API error: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as BanxicoResponse;

      if (!data?.bmx?.series?.[0]?.datos?.length) {
        throw new Error('No exchange rate data in Banxico response');
      }

      // Obtener el dato más reciente
      const latestData = data.bmx.series[0].datos[data.bmx.series[0].datos.length - 1];
      const rate = parseFloat(latestData.dato.replace(',', '.'));

      if (isNaN(rate) || rate <= 0) {
        throw new Error(`Invalid exchange rate value: ${latestData.dato}`);
      }

      this.logger.log(`Fetched exchange rate from Banxico: ${rate} (${latestData.fecha})`);
      return rate;
    } catch (error) {
      this.logger.error(`Error fetching from Banxico: ${error.message}`);
      return this.getFallbackRate();
    }
  }

  /**
   * Convierte un monto de USD a MXN
   */
  async convertUsdToMxn(
    amountUsd: number,
    firestoreService: {
      getExchangeRate: (date: string) => Promise<ExchangeRate | null>;
      saveExchangeRate: (rate: ExchangeRate) => Promise<void>;
    },
    date?: Date,
  ): Promise<{ amountMxn: number; rate: number }> {
    const rate = await this.getExchangeRate(firestoreService, date);
    const amountMxn = Math.round(amountUsd * rate * 100) / 100; // Redondear a 2 decimales

    return { amountMxn, rate };
  }

  /**
   * Actualiza el cache del tipo de cambio (llamado por cron)
   */
  async updateRateCache(firestoreService: {
    getExchangeRate: (date: string) => Promise<ExchangeRate | null>;
    saveExchangeRate: (rate: ExchangeRate) => Promise<void>;
  }): Promise<{ rate: number; source: string }> {
    const rate = await this.fetchFromBanxico();
    const dateString = this.formatDate(new Date());

    const exchangeRate: ExchangeRate = {
      id: `rate_${dateString.replace(/-/g, '')}`,
      date: dateString,
      usdToMxn: rate,
      source: 'banxico',
      fetchedAt: new Date(),
    };

    await firestoreService.saveExchangeRate(exchangeRate);

    // Actualizar cache en memoria
    this.memoryCache = { rate, fetchedAt: new Date() };

    this.logger.log(`Updated exchange rate cache: ${rate}`);
    return { rate, source: 'banxico' };
  }

  /**
   * Tipo de cambio de respaldo en caso de falla de API
   */
  private getFallbackRate(): number {
    // Tipo de cambio aproximado de respaldo
    // En producción, podrías guardar el último tipo de cambio conocido
    const fallbackRate = 20.0;
    this.logger.warn(`Using fallback exchange rate: ${fallbackRate}`);
    return fallbackRate;
  }

  /**
   * Formatea una fecha a YYYY-MM-DD
   */
  private formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}
