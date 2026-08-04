import axios from 'axios';
import { FacturamaService } from './facturama.service.js';
import { CfdiErrorCodes, mapPacErrorToCode } from './facturama.constants.js';
import {
  FacturamaError,
  type FacturamaCfdiRequest,
} from './interfaces/facturama.interface.js';

/**
 * El CFDI se emite sin nadie delante: lo dispara un webhook de Stripe. Un
 * desglose de IVA que no cuadre, o un rechazo del PAC mal clasificado, no se
 * detectan hasta que el cliente reclama su factura y el plazo del SAT ya corrió.
 */
describe('FacturamaService', () => {
  function buildService(overrides: { post?: jest.Mock; get?: jest.Mock } = {}) {
    const post = overrides.post ?? jest.fn();
    const get = overrides.get ?? jest.fn();

    const service = Object.create(
      FacturamaService.prototype,
    ) as FacturamaService;
    Object.assign(service, {
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      http: { post, get },
      expeditionPlace: '97308',
      timezone: 'America/Merida',
    });

    return { service, post, get };
  }

  const receiver = {
    Rfc: 'ABC010101AB1',
    Name: 'EMPRESA DEMO',
    CfdiUse: 'G03',
    FiscalRegime: '601',
    TaxZipCode: '97000',
  };

  function stampedResponse() {
    return {
      data: {
        Id: 'cfdi_123',
        Complement: {
          TaxStamp: {
            Uuid: '27568D31-7E57-442F-BA77-798CBF30BD7D',
            Date: '2026-08-04T12:00:00',
          },
        },
      },
    };
  }

  /** Devuelve el payload que se le mandó a Facturama. */
  function sentPayload(post: jest.Mock): FacturamaCfdiRequest {
    return post.mock.calls[0][1] as FacturamaCfdiRequest;
  }

  describe('desglose de IVA', () => {
    it('desglosa hacia atrás un precio con IVA incluido', async () => {
      const { service, post } = buildService({
        post: jest.fn().mockResolvedValue(stampedResponse()),
      });

      // $199 MXN es el total que paga el cliente, no el subtotal.
      await service.stampSubscription({
        receiver,
        total: 199,
        currency: 'MXN',
        description: 'Suscripción ZPLPDF Plan PRO',
      });

      const item = sentPayload(post).Items[0];
      expect(item.Subtotal).toBe('171.551724');
      expect(item.Taxes[0].Total).toBe('27.448276');
      expect(item.Total).toBe('199.000000');
    });

    it('cuadra subtotal + IVA con el total cobrado', async () => {
      const { service, post } = buildService({
        post: jest.fn().mockResolvedValue(stampedResponse()),
      });

      // Importes con decimales incómodos: son los que produce una proración.
      for (const total of [199, 184.61, 1000, 0.99, 3499.37]) {
        post.mockClear();
        await service.stampSubscription({
          receiver,
          total,
          currency: 'MXN',
          description: 'Suscripción ZPLPDF',
        });

        const item = sentPayload(post).Items[0];
        const suma =
          parseFloat(item.Subtotal) + parseFloat(item.Taxes[0].Total);

        // El PAC rechaza el comprobante si la suma no coincide con el total.
        expect(suma.toFixed(6)).toBe(parseFloat(item.Total).toFixed(6));
      }
    });

    it('usa la base del impuesto igual al subtotal', async () => {
      const { service, post } = buildService({
        post: jest.fn().mockResolvedValue(stampedResponse()),
      });

      await service.stampSubscription({
        receiver,
        total: 199,
        currency: 'MXN',
        description: 'Suscripción ZPLPDF',
      });

      const item = sentPayload(post).Items[0];
      expect(item.Taxes[0].Base).toBe(item.Subtotal);
      expect(item.Taxes[0].Rate).toBe('0.160000');
      expect(item.Taxes[0].IsRetention).toBe(false);
    });
  });

  describe('fecha de expedición', () => {
    /** Hora local del emisor (Mérida, UTC-6) de un instante dado. */
    function meridaLocal(date: Date): string {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Merida',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(date);
      const get = (t: string) => parts.find((p) => p.type === t).value;
      return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
    }

    async function stampWith(chargedAt?: Date) {
      const { service, post } = buildService({
        post: jest.fn().mockResolvedValue(stampedResponse()),
      });
      await service.stampSubscription({
        receiver,
        total: 199,
        currency: 'MXN',
        description: 'Suscripción ZPLPDF',
        chargedAt,
      });
      return sentPayload(post).Date;
    }

    it('expide en hora local del emisor, no en UTC', async () => {
      const chargedAt = new Date('2026-08-04T18:30:00.000Z');
      jest.useFakeTimers().setSystemTime(new Date('2026-08-04T19:00:00.000Z'));

      try {
        // Facturama lee `Date` como hora local del emisor. Mandarle el UTC
        // adelantaba seis horas el comprobante y lo dejaba fechado en el futuro,
        // que el PAC rechaza de plano.
        expect(await stampWith(chargedAt)).toBe('2026-08-04T12:30:00');
      } finally {
        jest.useRealTimers();
      }
    });

    it('usa la fecha del cobro si está dentro de las 72 horas', async () => {
      const chargedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);

      // Mantiene cobro y comprobante en el mismo mes cuando el cargo cae a fin
      // de mes y el webhook se procesa ya entrado el siguiente.
      expect(await stampWith(chargedAt)).toBe(meridaLocal(chargedAt));
    });

    it('expide con la hora actual si el cobro tiene más de 72 horas', async () => {
      const viejo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

      const enviado = await stampWith(viejo);

      // Facturama rechaza cualquier fecha más vieja. En un reintento la única
      // fecha válida es la de ahora, y hay que decirlo explícitamente en vez de
      // omitir el campo.
      expect(enviado).not.toBe(meridaLocal(viejo));
      expect(enviado).toBe(meridaLocal(new Date()));
    });

    it('expide con la hora actual si el cobro viene en el futuro', async () => {
      const futuro = new Date(Date.now() + 60 * 60 * 1000);

      expect(await stampWith(futuro)).toBe(meridaLocal(new Date()));
    });

    it('manda siempre la fecha, aunque no se conozca la del cobro', async () => {
      expect(await stampWith(undefined)).toBe(meridaLocal(new Date()));
    });
  });

  describe('respuesta del PAC', () => {
    it('devuelve el UUID y el id de Facturama', async () => {
      const { service } = buildService({
        post: jest.fn().mockResolvedValue(stampedResponse()),
      });

      const result = await service.stampSubscription({
        receiver,
        total: 199,
        currency: 'MXN',
        description: 'Suscripción ZPLPDF',
      });

      expect(result.facturamaId).toBe('cfdi_123');
      expect(result.uuid).toBe('27568D31-7E57-442F-BA77-798CBF30BD7D');
    });

    it('falla si el PAC responde 200 pero sin folio fiscal', async () => {
      const { service } = buildService({
        post: jest.fn().mockResolvedValue({ data: { Id: 'cfdi_123' } }),
      });

      // Sin UUID no hay comprobante fiscal, por muy 200 que sea la respuesta:
      // darlo por bueno dejaría al cliente con un CFDI inexistente marcado como
      // timbrado.
      await expect(
        service.stampSubscription({
          receiver,
          total: 199,
          currency: 'MXN',
          description: 'Suscripción ZPLPDF',
        }),
      ).rejects.toThrow(FacturamaError);
    });
  });

  describe('clasificación de errores', () => {
    function axiosError(status: number | undefined, data: unknown) {
      const error = new Error('Request failed') as Error & {
        isAxiosError: boolean;
        response?: { status: number; data: unknown };
      };
      error.isAxiosError = true;
      if (status !== undefined) {
        error.response = { status, data };
      }
      return error;
    }

    beforeAll(() => {
      jest
        .spyOn(axios, 'isAxiosError')
        .mockImplementation(
          (payload: unknown) =>
            (payload as { isAxiosError?: boolean })?.isAxiosError === true,
        );
    });

    afterAll(() => jest.restoreAllMocks());

    async function stampExpectingCode(post: jest.Mock) {
      const { service } = buildService({ post });
      try {
        await service.stampSubscription({
          receiver,
          total: 199,
          currency: 'MXN',
          description: 'Suscripción ZPLPDF',
        });
        throw new Error('Se esperaba un FacturamaError');
      } catch (error) {
        expect(error).toBeInstanceOf(FacturamaError);
        return error as FacturamaError;
      }
    }

    it('clasifica un 500 del PAC como pac_unavailable', async () => {
      const error = await stampExpectingCode(
        jest.fn().mockRejectedValue(axiosError(500, {})),
      );
      // Reintentable tal cual: no es culpa del perfil del usuario.
      expect(error.code).toBe(CfdiErrorCodes.PAC_UNAVAILABLE);
    });

    it('clasifica un timeout sin respuesta como pac_unavailable', async () => {
      const error = await stampExpectingCode(
        jest.fn().mockRejectedValue(axiosError(undefined, undefined)),
      );
      expect(error.code).toBe(CfdiErrorCodes.PAC_UNAVAILABLE);
    });

    it('marca indeterminado el timbrado que expira sin respuesta', async () => {
      const error = await stampExpectingCode(
        jest.fn().mockRejectedValue(axiosError(undefined, undefined)),
      );

      // El POST pudo procesarse en el PAC y perderse solo la respuesta: quien lo
      // reciba no debe reintentar a ciegas.
      expect(error.indeterminate).toBe(true);
    });

    it('marca indeterminado un 5xx del PAC', async () => {
      const error = await stampExpectingCode(
        jest.fn().mockRejectedValue(axiosError(502, {})),
      );

      expect(error.indeterminate).toBe(true);
    });

    it('NO marca indeterminado un 401: consta que no se timbró', async () => {
      const error = await stampExpectingCode(
        jest.fn().mockRejectedValue(axiosError(401, {})),
      );

      expect(error.indeterminate).toBe(false);
    });

    it('NO marca indeterminada una descarga fallida', async () => {
      const { service } = buildService({
        get: jest.fn().mockRejectedValue(axiosError(503, {})),
      });

      try {
        await service.downloadPdf('cfdi_123');
        throw new Error('Se esperaba un FacturamaError');
      } catch (error) {
        // Una descarga no crea nada; repetirla no tiene riesgo.
        expect((error as FacturamaError).indeterminate).toBe(false);
      }
    });

    it('clasifica un 401 como pac_unavailable, no como error del usuario', async () => {
      const error = await stampExpectingCode(
        jest.fn().mockRejectedValue(axiosError(401, {})),
      );
      // Es un fallo de configuración del emisor; reintentar el mismo CFDI no lo
      // arregla, pero tampoco debe culpar al RFC del cliente.
      expect(error.code).toBe(CfdiErrorCodes.PAC_UNAVAILABLE);
    });

    it('extrae el detalle de ModelState de ASP.NET', async () => {
      const error = await stampExpectingCode(
        jest.fn().mockRejectedValue(
          axiosError(400, {
            Message: 'The request is invalid.',
            ModelState: {
              'Cfdi.Receiver.Rfc': [
                'El RFC del receptor no se encuentra en la lista de RFC inscritos del SAT',
              ],
            },
          }),
        ),
      );

      // El `Message` de primer nivel es genérico; el detalle útil está en las
      // hojas de ModelState.
      expect(error.code).toBe(CfdiErrorCodes.RFC_NOT_FOUND);
      expect(error.message).toContain('no se encuentra en la lista de RFC');
    });
  });

  describe('mapPacErrorToCode', () => {
    const casos: Array<[string, string]> = [
      [
        'El campo Nombre del receptor no coincide con el registrado ante el SAT',
        CfdiErrorCodes.NAME_MISMATCH,
      ],
      [
        'CFDI40161 - El DomicilioFiscalReceptor no corresponde con el código postal',
        CfdiErrorCodes.POSTAL_CODE_MISMATCH,
      ],
      [
        'El RegimenFiscalReceptor no corresponde al RFC del receptor',
        CfdiErrorCodes.REGIME_MISMATCH,
      ],
      [
        'El UsoCFDI no es compatible con el régimen fiscal del receptor',
        CfdiErrorCodes.CFDI_USE_INVALID,
      ],
      [
        'El RFC del receptor no se encuentra en la lista de RFC inscritos',
        CfdiErrorCodes.RFC_NOT_FOUND,
      ],
      ['Un rechazo que nadie previó', CfdiErrorCodes.UNKNOWN],
    ];

    it.each(casos)('mapea «%s»', (mensaje, esperado) => {
      expect(mapPacErrorToCode(mensaje)).toBe(esperado);
    });

    it('prioriza el nombre sobre el RFC cuando el mensaje menciona ambos', () => {
      // Los rechazos por razón social siempre citan también el RFC; si ganara la
      // regla del RFC, el usuario corregiría el campo equivocado.
      expect(
        mapPacErrorToCode(
          'El Nombre del receptor no coincide con el registrado para el RFC ABC010101AB1',
        ),
      ).toBe(CfdiErrorCodes.NAME_MISMATCH);
    });

    it('prioriza el uso de CFDI sobre el régimen cuando menciona ambos', () => {
      // Mismo problema: la incompatibilidad es entre uso y régimen, así que el
      // rechazo nombra los dos. El campo que el usuario debe cambiar es el uso.
      expect(
        mapPacErrorToCode(
          'El UsoCFDI G03 no es compatible con el régimen fiscal 605 del receptor',
        ),
      ).toBe(CfdiErrorCodes.CFDI_USE_INVALID);
    });

    it('mantiene regime_mismatch cuando el rechazo es solo del régimen', () => {
      expect(
        mapPacErrorToCode(
          'El campo RegimenFiscalReceptor no contiene una clave válida para el RFC',
        ),
      ).toBe(CfdiErrorCodes.REGIME_MISMATCH);
    });
  });

  describe('descargas', () => {
    it('decodifica el PDF que llega en base64', async () => {
      const contenido = Buffer.from('%PDF-1.4 contenido');
      const { service, get } = buildService({
        get: jest.fn().mockResolvedValue({
          data: { Content: contenido.toString('base64') },
        }),
      });

      const pdf = await service.downloadPdf('cfdi_123');

      expect(get).toHaveBeenCalledWith('/Cfdi/pdf/issued/cfdi_123');
      expect(pdf.toString()).toBe('%PDF-1.4 contenido');
    });

    it('falla si el XML llega vacío', async () => {
      const { service } = buildService({
        get: jest.fn().mockResolvedValue({ data: {} }),
      });

      await expect(service.downloadXml('cfdi_123')).rejects.toThrow(
        FacturamaError,
      );
    });
  });

  describe('sin credenciales', () => {
    it('no timbra y reporta el PAC como no disponible', async () => {
      const service = Object.create(
        FacturamaService.prototype,
      ) as FacturamaService;
      Object.assign(service, {
        logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
        http: null,
      });

      expect(service.isConfigured).toBe(false);
      await expect(
        service.stampSubscription({
          receiver,
          total: 199,
          currency: 'MXN',
          description: 'Suscripción ZPLPDF',
        }),
      ).rejects.toThrow(FacturamaError);
    });
  });
});
