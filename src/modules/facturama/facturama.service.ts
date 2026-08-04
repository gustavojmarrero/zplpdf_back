import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import {
  CFDI_EXPORTATION_NOT_APPLICABLE,
  CFDI_MAX_BACKDATE_MS,
  CFDI_PAYMENT_FORM_CREDIT_CARD,
  CFDI_PAYMENT_METHOD_PUE,
  CFDI_PRODUCT_CODE,
  CFDI_TAX_NAME,
  CFDI_TAX_OBJECT,
  CFDI_TAX_RATE,
  CFDI_TYPE_INCOME,
  CFDI_UNIT_CODE,
  CFDI_UNIT_NAME,
  CfdiErrorCodes,
  mapPacErrorToCode,
} from './facturama.constants.js';
import {
  FacturamaError,
  type FacturamaCfdiRequest,
  type FacturamaCfdiResponse,
  type FacturamaItem,
  type StampResult,
  type StampSubscriptionParams,
} from './interfaces/facturama.interface.js';

/**
 * Cliente de Facturama para el timbrado de CFDI 4.0.
 *
 * Es una integración propia y no una llamada al backend de la intranet, que ya
 * factura contra la misma cuenta: aquel endpoint exige que cada concepto exista
 * como SKU en su catálogo de inventario, y colgar el timbrado de un segundo
 * servicio metería una dependencia de disponibilidad en la ruta de un webhook
 * con plazo fiscal. Lo único que se comparte es la cuenta —mismo RFC emisor,
 * mismo CSD, mismos timbres.
 */
@Injectable()
export class FacturamaService {
  private readonly logger = new Logger(FacturamaService.name);
  private readonly http: AxiosInstance | null = null;
  private readonly expeditionPlace: string;

  constructor(private readonly configService: ConfigService) {
    const username = this.configService.get<string>('FACTURAMA_USERNAME');
    const password = this.configService.get<string>('FACTURAMA_PASSWORD');
    const baseURL = this.configService.get<string>(
      'FACTURAMA_URL_BASE',
      'https://api.facturama.mx',
    );
    this.expeditionPlace = this.configService.get<string>(
      'FACTURAMA_EXPEDITION_PLACE',
      '97308',
    );

    if (!username || !password) {
      // Sin credenciales el módulo queda inerte en vez de tumbar el arranque:
      // el resto de la app (conversión, pagos) no depende del PAC.
      this.logger.warn(
        'Facturama no configurado (FACTURAMA_USERNAME / FACTURAMA_PASSWORD). El timbrado de CFDI queda deshabilitado.',
      );
      return;
    }

    this.http = axios.create({
      baseURL,
      timeout: 30000,
      headers: {
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
    });
  }

  get isConfigured(): boolean {
    return this.http !== null;
  }

  /**
   * Timbra un CFDI de ingreso por una suscripción cobrada.
   *
   * El importe llega con el IVA ya incluido —los precios publicados son finales—
   * así que el desglose se hace hacia atrás: el subtotal es el total entre 1.16 y
   * el IVA es la diferencia. Calcular el impuesto como `subtotal * 0.16` en vez
   * de por diferencia deja descuadres de una millonésima que el PAC rechaza.
   */
  async stampSubscription(
    params: StampSubscriptionParams,
  ): Promise<StampResult> {
    this.assertConfigured();

    const item = this.buildItem(params.total, params.description);

    const payload: FacturamaCfdiRequest = {
      Currency: params.currency.toUpperCase(),
      CfdiType: CFDI_TYPE_INCOME,
      ExpeditionPlace: this.expeditionPlace,
      Exportation: CFDI_EXPORTATION_NOT_APPLICABLE,
      PaymentForm: params.paymentForm ?? CFDI_PAYMENT_FORM_CREDIT_CARD,
      PaymentMethod: CFDI_PAYMENT_METHOD_PUE,
      Receiver: params.receiver,
      Items: [item],
      ...this.resolveExpeditionDate(params.chargedAt),
    };

    this.logger.log(
      `Timbrando CFDI para ${params.receiver.Rfc} por ${params.total} ${params.currency}`,
    );

    const response = await this.request<FacturamaCfdiResponse>(
      'post',
      '/3/cfdis',
      payload,
    );

    const uuid = response.Complement?.TaxStamp?.Uuid;

    if (!response.Id || !uuid) {
      // Sin UUID no hay comprobante fiscal, por muy 200 que devuelva el PAC.
      throw new FacturamaError(
        CfdiErrorCodes.UNKNOWN,
        'Facturama respondió sin folio fiscal (UUID)',
        response,
      );
    }

    this.logger.log(`CFDI timbrado: ${response.Id} — UUID ${uuid}`);

    return {
      facturamaId: response.Id,
      uuid,
      stampedAt: response.Complement?.TaxStamp?.Date
        ? new Date(response.Complement.TaxStamp.Date)
        : new Date(),
    };
  }

  /** Descarga el PDF del CFDI emitido. Facturama lo devuelve en base64. */
  async downloadPdf(facturamaId: string): Promise<Buffer> {
    return this.downloadFile(`/Cfdi/pdf/issued/${facturamaId}`, 'PDF');
  }

  /** Descarga el XML timbrado, que es el comprobante fiscal con validez legal. */
  async downloadXml(facturamaId: string): Promise<Buffer> {
    return this.downloadFile(`/Cfdi/xml/issued/${facturamaId}`, 'XML');
  }

  private async downloadFile(path: string, kind: string): Promise<Buffer> {
    this.assertConfigured();

    const response = await this.request<{ Content?: string }>('get', path);

    if (!response?.Content) {
      throw new FacturamaError(
        CfdiErrorCodes.UNKNOWN,
        `Facturama devolvió un ${kind} vacío`,
        response,
      );
    }

    return Buffer.from(response.Content, 'base64');
  }

  /**
   * Construye el único concepto del CFDI.
   *
   * Seis decimales en los importes unitarios porque es lo que admite el anexo 20
   * y lo que evita que la suma de conceptos no cuadre con el total.
   */
  private buildItem(total: number, description: string): FacturamaItem {
    const subtotal = total / (1 + CFDI_TAX_RATE);
    const tax = total - subtotal;

    const subtotalStr = subtotal.toFixed(6);
    const taxStr = tax.toFixed(6);

    return {
      ProductCode: CFDI_PRODUCT_CODE,
      Description: description,
      UnitCode: CFDI_UNIT_CODE,
      Unit: CFDI_UNIT_NAME,
      UnitPrice: subtotalStr,
      Quantity: '1',
      Subtotal: subtotalStr,
      TaxObject: CFDI_TAX_OBJECT,
      Taxes: [
        {
          Total: taxStr,
          Name: CFDI_TAX_NAME,
          Base: subtotalStr,
          Rate: CFDI_TAX_RATE.toFixed(6),
          IsRetention: false,
        },
      ],
      Total: total.toFixed(6),
    };
  }

  /**
   * Decide la fecha de expedición.
   *
   * Se prefiere la del cobro para que comprobante y cobro caigan en el mismo mes
   * —importa cuando el cargo es de los últimos días—, pero Facturama rechaza
   * cualquier fecha de más de 72 h, así que fuera de esa ventana se omite el
   * campo y el PAC sella con la hora del timbrado.
   */
  private resolveExpeditionDate(chargedAt?: Date): { Date?: string } {
    if (!chargedAt) {
      return {};
    }

    const age = Date.now() - chargedAt.getTime();
    if (age < 0 || age > CFDI_MAX_BACKDATE_MS) {
      return {};
    }

    // Facturama espera hora local sin zona; el sufijo Z se lo rechaza.
    return { Date: chargedAt.toISOString().slice(0, 19) };
  }

  private async request<T>(
    method: 'get' | 'post',
    path: string,
    body?: unknown,
  ): Promise<T> {
    try {
      const { data } =
        method === 'get'
          ? await this.http.get<T>(path)
          : await this.http.post<T>(path, body);
      return data;
    } catch (error) {
      throw this.toFacturamaError(error, path);
    }
  }

  /**
   * Normaliza cualquier fallo a un `FacturamaError` con código estable.
   *
   * Se separa el PAC caído (reintentable, no es culpa del usuario) del rechazo
   * fiscal (el usuario tiene que corregir su perfil): en el primer caso el CFDI
   * se puede reintentar tal cual, en el segundo reintentar sin tocar nada vuelve
   * a fallar igual.
   */
  private toFacturamaError(error: unknown, path: string): FacturamaError {
    if (error instanceof FacturamaError) {
      return error;
    }

    if (!axios.isAxiosError(error)) {
      return new FacturamaError(
        CfdiErrorCodes.UNKNOWN,
        (error as Error)?.message ?? 'Error desconocido de Facturama',
        error,
      );
    }

    const status = error.response?.status;
    const data = error.response?.data;

    // Sin respuesta, timeout o 5xx: el PAC no está disponible.
    if (!status || status >= 500) {
      this.logger.error(
        `Facturama no disponible en ${path}: ${error.message} (status ${status ?? 'sin respuesta'})`,
      );
      return new FacturamaError(
        CfdiErrorCodes.PAC_UNAVAILABLE,
        `Facturama no disponible: ${error.message}`,
        data,
      );
    }

    if (status === 401 || status === 403) {
      // Credenciales o permisos: es un fallo de configuración nuestro, no del
      // usuario, y no se arregla reintentando el mismo CFDI.
      this.logger.error(
        `Facturama rechazó las credenciales en ${path} (status ${status})`,
      );
      return new FacturamaError(
        CfdiErrorCodes.PAC_UNAVAILABLE,
        'Facturama rechazó las credenciales del emisor',
        data,
      );
    }

    const detail = this.extractErrorMessage(data) || error.message;
    const code = mapPacErrorToCode(detail);

    this.logger.error(
      `Facturama rechazó ${path} (status ${status}) [${code}]: ${detail}`,
    );

    return new FacturamaError(code, detail, data);
  }

  /**
   * Extrae el mensaje útil de la respuesta de error.
   *
   * Facturama corre sobre ASP.NET Web API, que reporta las validaciones en
   * `ModelState` como un mapa de campo → lista de errores. El `Message` de
   * primer nivel suele ser genérico («The request is invalid»), así que el
   * detalle aprovechable está en las hojas.
   */
  private extractErrorMessage(data: unknown): string {
    if (!data) return '';
    if (typeof data === 'string') return data;

    const body = data as {
      Message?: string;
      message?: string;
      ModelState?: Record<string, string[]>;
      Error?: string;
    };

    const modelStateErrors = body.ModelState
      ? Object.values(body.ModelState).flat().filter(Boolean)
      : [];

    if (modelStateErrors.length > 0) {
      return modelStateErrors.join(' | ');
    }

    return body.Message || body.message || body.Error || JSON.stringify(data);
  }

  private assertConfigured(): void {
    if (!this.http) {
      throw new FacturamaError(
        CfdiErrorCodes.PAC_UNAVAILABLE,
        'Facturama no está configurado en este entorno',
      );
    }
  }
}
