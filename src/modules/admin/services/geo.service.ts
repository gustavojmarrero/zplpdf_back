import { Injectable, Logger } from '@nestjs/common';
import { FirestoreService } from '../../cache/firestore.service.js';
import type { User } from '../../../common/interfaces/user.interface.js';

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

interface IPGuideResponse {
  ip: string;
  location: {
    city: string;
    country: string;
    timezone: string;
    latitude: number;
    longitude: number;
  };
  network: {
    cidr: string;
    hosts: {
      start: string;
      end: string;
    };
    autonomous_system: {
      asn: number;
      name: string;
      organization: string;
      country: string; // Código ISO (MX, US, etc.)
      rir: string;
    };
  };
}

export interface GeoData {
  country: string;
  city: string;
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
  private readonly IP_GUIDE_URL = 'https://ip.guide';

  // Cache en memoria para evitar llamadas repetidas
  private ipCache = new Map<string, { country: string; city: string; timestamp: number }>();
  private readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas
  private readonly GEO_REFRESH_DAYS = 7; // Refrescar geo cada 7 días

  constructor(private readonly firestoreService: FirestoreService) {}

  /**
   * Detecta el país y ciudad de un usuario por su dirección IP usando ip.guide
   */
  async detectCountryByIP(ip: string): Promise<GeoData | null> {
    // Ignorar IPs locales
    if (this.isLocalIP(ip)) {
      this.logger.debug(`Ignoring local IP: ${ip}`);
      return null;
    }

    // Verificar cache
    const cached = this.ipCache.get(ip);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      this.logger.debug(`Using cached geo for IP ${ip}: ${cached.country}/${cached.city}`);
      return { country: cached.country, city: cached.city };
    }

    try {
      const response = await fetch(`${this.IP_GUIDE_URL}/${ip}`);

      if (!response.ok) {
        throw new Error(`ip.guide error: ${response.status}`);
      }

      const data = (await response.json()) as IPGuideResponse;

      // Extraer código ISO del país desde network.autonomous_system.country
      const country = data.network?.autonomous_system?.country || null;
      const city = data.location?.city || '';

      if (!country) {
        throw new Error(`ip.guide returned no country for ${ip}`);
      }

      // Guardar en cache
      this.ipCache.set(ip, { country, city, timestamp: Date.now() });

      this.logger.log(`Detected ${country}/${city} for IP ${ip}`);
      return { country, city };
    } catch (error) {
      this.logger.warn(`Failed to detect geo for IP ${ip}: ${error.message}`);
      return null;
    }
  }

  /**
   * Verifica si debemos refrescar la geolocalización de un usuario
   * Retorna true si han pasado más de 7 días desde la última detección
   */
  shouldRefreshGeo(user: User): boolean {
    if (!user.countryDetectedAt) return true;

    let detectedAt: Date;

    if (user.countryDetectedAt instanceof Date) {
      detectedAt = user.countryDetectedAt;
    } else if (typeof user.countryDetectedAt === 'string') {
      detectedAt = new Date(user.countryDetectedAt);
    } else if (user.countryDetectedAt && typeof (user.countryDetectedAt as any).toDate === 'function') {
      // Firestore Timestamp object
      detectedAt = (user.countryDetectedAt as any).toDate();
    } else if (user.countryDetectedAt && (user.countryDetectedAt as any)._seconds !== undefined) {
      // Firestore Timestamp raw object { _seconds, _nanoseconds }
      detectedAt = new Date((user.countryDetectedAt as any)._seconds * 1000);
    } else {
      // Fallback: try direct conversion
      detectedAt = new Date(user.countryDetectedAt as any);
    }

    // If date is invalid, refresh
    if (isNaN(detectedAt.getTime())) {
      this.logger.warn(`Invalid countryDetectedAt for user, forcing refresh`);
      return true;
    }

    const daysSinceDetection = (Date.now() - detectedAt.getTime()) / (1000 * 60 * 60 * 24);
    return daysSinceDetection >= this.GEO_REFRESH_DAYS;
  }

  /**
   * Actualiza el país y ciudad de un usuario
   */
  async updateUserCountry(
    userId: string,
    country: string,
    source: 'ip' | 'stripe',
    city?: string,
  ): Promise<void> {
    await this.firestoreService.updateUser(userId, {
      country,
      city,
      countrySource: source,
      countryDetectedAt: new Date(),
    });

    this.logger.log(`Updated user ${userId} geo to ${country}/${city || 'unknown'} (source: ${source})`);
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
    // Obtener MRR mensual (últimos 30 días)
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 30);

    const [distribution, conversionRates, revenueData] = await Promise.all([
      this.getUserDistributionByCountry(),
      this.getConversionRatesByCountry(),
      this.getRevenueByCountry(startDate, endDate),
    ]);

    // Crear mapa de revenue por país para búsqueda rápida
    const revenueByCountry = new Map(revenueData.map((r) => [r.country, r]));

    // Calcular métricas promedio para comparación
    const avgConversionRate =
      conversionRates.reduce((sum, c) => sum + c.conversionRate, 0) / conversionRates.length || 0;
    const avgUsers =
      distribution.reduce((sum, c) => sum + c.userCount, 0) / distribution.length || 1;

    const potentials: CountryPotential[] = [];

    for (const country of distribution) {
      const conversionData = conversionRates.find((c) => c.country === country.country);
      const conversionRate = conversionData?.conversionRate || 0;
      const countryRevenue = revenueByCountry.get(country.country);

      // Calcular score basado en:
      // - Cantidad de usuarios (25%)
      // - Tasa de conversión (35%)
      // - Potencial de crecimiento (40%)
      const userScore = Math.min((country.userCount / avgUsers) * 25, 25);
      const conversionScore = Math.min((conversionRate / Math.max(avgConversionRate, 1)) * 35, 35);

      // Potencial de crecimiento: países con muchos free users y baja conversión
      const freeUsers = country.byPlan.free;
      const paidUsers = country.byPlan.pro + country.byPlan.enterprise;
      const growthPotential = freeUsers > 0 && conversionRate < avgConversionRate ? 40 : 20;

      const score = Math.round(userScore + conversionScore + growthPotential);

      // Calcular MRR mensual por usuario (en MXN)
      // Se divide entre TODOS los usuarios para ver el valor promedio por usuario en la región
      const revenuePerUser =
        countryRevenue && country.userCount > 0
          ? countryRevenue.revenueMxn / country.userCount
          : 0;

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
          revenuePerUser,
          growthRate: 0, // TODO: calcular comparando períodos
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
