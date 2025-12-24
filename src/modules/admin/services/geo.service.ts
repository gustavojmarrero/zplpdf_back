import { Injectable, Logger } from '@nestjs/common';
import { FirestoreService } from '../../cache/firestore.service.js';

// Mapeo de códigos de país a nombres
const COUNTRY_NAMES: Record<string, string> = {
  MX: 'México',
  US: 'Estados Unidos',
  ES: 'España',
  AR: 'Argentina',
  CO: 'Colombia',
  CL: 'Chile',
  PE: 'Perú',
  EC: 'Ecuador',
  VE: 'Venezuela',
  GT: 'Guatemala',
  CU: 'Cuba',
  BO: 'Bolivia',
  DO: 'República Dominicana',
  HN: 'Honduras',
  PY: 'Paraguay',
  SV: 'El Salvador',
  NI: 'Nicaragua',
  CR: 'Costa Rica',
  PA: 'Panamá',
  UY: 'Uruguay',
  BR: 'Brasil',
  CA: 'Canadá',
  GB: 'Reino Unido',
  DE: 'Alemania',
  FR: 'Francia',
  IT: 'Italia',
  PT: 'Portugal',
  unknown: 'Desconocido',
};

interface IPAPIResponse {
  status: string;
  country: string;
  countryCode: string;
  region: string;
  regionName: string;
  city: string;
  zip: string;
  lat: number;
  lon: number;
  timezone: string;
  isp: string;
  org: string;
  as: string;
  query: string;
}

export interface CountryDistribution {
  country: string;
  countryName: string;
  userCount: number;
  percentage: number;
  byPlan: {
    free: number;
    pro: number;
    enterprise: number;
  };
}

export interface CountryConversionRate {
  country: string;
  countryName: string;
  freeUsers: number;
  proUsers: number;
  conversionRate: number;
  totalUsers: number;
}

export interface CountryRevenue {
  country: string;
  countryName: string;
  revenue: number;
  revenueMxn: number;
  transactions: number;
  avgTicket: number;
}

export interface CountryPotential {
  country: string;
  countryName: string;
  score: number; // 0-100
  metrics: {
    userCount: number;
    conversionRate: number;
    revenuePerUser: number;
    growthRate: number;
  };
  recommendation: string;
}

@Injectable()
export class GeoService {
  private readonly logger = new Logger(GeoService.name);
  private readonly IP_API_URL = 'http://ip-api.com/json';

  // Cache en memoria para evitar llamadas repetidas
  private ipCache = new Map<string, { country: string; timestamp: number }>();
  private readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas

  constructor(private readonly firestoreService: FirestoreService) {}

  /**
   * Detecta el país de un usuario por su dirección IP
   */
  async detectCountryByIP(ip: string): Promise<string | null> {
    // Ignorar IPs locales
    if (this.isLocalIP(ip)) {
      this.logger.debug(`Ignoring local IP: ${ip}`);
      return null;
    }

    // Verificar cache
    const cached = this.ipCache.get(ip);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      this.logger.debug(`Using cached country for IP ${ip}: ${cached.country}`);
      return cached.country;
    }

    try {
      // Usar ip-api.com (gratuito, 45 req/min)
      const response = await fetch(`${this.IP_API_URL}/${ip}?fields=status,countryCode`);

      if (!response.ok) {
        throw new Error(`IP API error: ${response.status}`);
      }

      const data = (await response.json()) as IPAPIResponse;

      if (data.status !== 'success') {
        throw new Error(`IP API failed for ${ip}`);
      }

      const country = data.countryCode;

      // Guardar en cache
      this.ipCache.set(ip, { country, timestamp: Date.now() });

      this.logger.log(`Detected country ${country} for IP ${ip}`);
      return country;
    } catch (error) {
      this.logger.warn(`Failed to detect country for IP ${ip}: ${error.message}`);
      return null;
    }
  }

  /**
   * Actualiza el país de un usuario
   */
  async updateUserCountry(
    userId: string,
    country: string,
    source: 'ip' | 'stripe',
  ): Promise<void> {
    await this.firestoreService.updateUser(userId, {
      country,
      countrySource: source,
      countryDetectedAt: new Date(),
    });

    this.logger.log(`Updated user ${userId} country to ${country} (source: ${source})`);
  }

  /**
   * Obtiene distribución de usuarios por país
   */
  async getUserDistributionByCountry(): Promise<CountryDistribution[]> {
    const data = await this.firestoreService.getUsersByCountry();

    // Calcular total de usuarios
    const totalUsers = data.reduce((sum, c) => sum + c.total, 0);

    return data.map((countryData) => ({
      country: countryData.country,
      countryName: this.getCountryName(countryData.country),
      userCount: countryData.total,
      percentage: totalUsers > 0 ? (countryData.total / totalUsers) * 100 : 0,
      byPlan: countryData.byPlan,
    }));
  }

  /**
   * Obtiene tasas de conversión Free→Pro por país
   */
  async getConversionRatesByCountry(): Promise<CountryConversionRate[]> {
    const data = await this.firestoreService.getConversionRatesByCountry();

    return data
      .map((countryData) => ({
        country: countryData.country,
        countryName: this.getCountryName(countryData.country),
        freeUsers: countryData.freeUsers,
        proUsers: countryData.proUsers,
        conversionRate: countryData.conversionRate,
        totalUsers: countryData.freeUsers + countryData.proUsers,
      }))
      .sort((a, b) => b.conversionRate - a.conversionRate);
  }

  /**
   * Obtiene ingresos por país
   */
  async getRevenueByCountry(startDate: Date, endDate: Date): Promise<CountryRevenue[]> {
    const data = await this.firestoreService.getRevenueByCountry(startDate, endDate);

    return data.map((countryData) => ({
      country: countryData.country,
      countryName: this.getCountryName(countryData.country),
      revenue: countryData.revenue,
      revenueMxn: countryData.revenueMxn,
      transactions: countryData.transactions,
      avgTicket: countryData.transactions > 0 ? countryData.revenueMxn / countryData.transactions : 0,
    }));
  }

  /**
   * Identifica países con mayor potencial
   */
  async getCountriesWithPotential(): Promise<CountryPotential[]> {
    const [distribution, conversionRates] = await Promise.all([
      this.getUserDistributionByCountry(),
      this.getConversionRatesByCountry(),
    ]);

    // Calcular métricas promedio para comparación
    const avgConversionRate =
      conversionRates.reduce((sum, c) => sum + c.conversionRate, 0) / conversionRates.length || 0;
    const avgUsers =
      distribution.reduce((sum, c) => sum + c.userCount, 0) / distribution.length || 1;

    const potentials: CountryPotential[] = [];

    for (const country of distribution) {
      const conversionData = conversionRates.find((c) => c.country === country.country);
      const conversionRate = conversionData?.conversionRate || 0;

      // Calcular score basado en:
      // - Cantidad de usuarios (25%)
      // - Tasa de conversión (35%)
      // - Potencial de crecimiento (40%)
      const userScore = Math.min((country.userCount / avgUsers) * 25, 25);
      const conversionScore = Math.min((conversionRate / Math.max(avgConversionRate, 1)) * 35, 35);

      // Potencial de crecimiento: países con muchos free users y baja conversión
      const freeUsers = country.byPlan.free;
      const totalPaid = country.byPlan.pro + country.byPlan.enterprise;
      const growthPotential = freeUsers > 0 && conversionRate < avgConversionRate ? 40 : 20;

      const score = Math.round(userScore + conversionScore + growthPotential);

      // Generar recomendación
      let recommendation: string;
      if (score >= 80) {
        recommendation = 'Alta prioridad: invertir en marketing y localización';
      } else if (score >= 60) {
        recommendation = 'Potencial alto: considerar campañas de conversión';
      } else if (score >= 40) {
        recommendation = 'Potencial moderado: monitorear y evaluar ROI';
      } else {
        recommendation = 'Bajo potencial: mantener presencia básica';
      }

      potentials.push({
        country: country.country,
        countryName: country.countryName,
        score,
        metrics: {
          userCount: country.userCount,
          conversionRate,
          revenuePerUser: totalPaid > 0 ? 0 : 0, // Se podría calcular con datos de revenue
          growthRate: 0, // Se podría calcular comparando períodos
        },
        recommendation,
      });
    }

    return potentials.sort((a, b) => b.score - a.score);
  }

  // ============================================
  // Helper Methods
  // ============================================

  private isLocalIP(ip: string): boolean {
    return (
      ip === '127.0.0.1' ||
      ip === '::1' ||
      ip === 'localhost' ||
      ip.startsWith('192.168.') ||
      ip.startsWith('10.') ||
      ip.startsWith('172.16.') ||
      ip.startsWith('172.17.') ||
      ip.startsWith('172.18.') ||
      ip.startsWith('172.19.') ||
      ip.startsWith('172.20.') ||
      ip.startsWith('172.21.') ||
      ip.startsWith('172.22.') ||
      ip.startsWith('172.23.') ||
      ip.startsWith('172.24.') ||
      ip.startsWith('172.25.') ||
      ip.startsWith('172.26.') ||
      ip.startsWith('172.27.') ||
      ip.startsWith('172.28.') ||
      ip.startsWith('172.29.') ||
      ip.startsWith('172.30.') ||
      ip.startsWith('172.31.')
    );
  }

  private getCountryName(code: string): string {
    return COUNTRY_NAMES[code] || code;
  }
}
