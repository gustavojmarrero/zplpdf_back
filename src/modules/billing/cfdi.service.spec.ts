import type Stripe from 'stripe';
import { CfdiService } from './cfdi.service.js';
import { CfdiErrorCodes } from '../facturama/facturama.constants.js';
import { FacturamaError } from '../facturama/interfaces/facturama.interface.js';

/**
 * El timbrado corre dentro de un webhook de Stripe, y eso impone dos reglas que
 * no son negociables: no puede lanzar —Stripe reintentaría el evento— y no puede
 * emitir dos veces el mismo comprobante, porque un CFDI duplicado no se borra,
 * se cancela a mano ante el SAT.
 */
describe('CfdiService', () => {
  function buildService(
    overrides: {
      user?: Record<string, unknown> | null;
      profile?: Record<string, unknown> | null;
      reserved?: boolean;
      stampSubscription?: jest.Mock;
      existingCfdi?: Record<string, unknown> | null;
      saveFile?: jest.Mock;
      downloadPdf?: jest.Mock;
      downloadXml?: jest.Mock;
    } = {},
  ) {
    const updates: Record<string, unknown>[] = [];
    const stampSubscription =
      overrides.stampSubscription ??
      jest.fn().mockResolvedValue({
        facturamaId: 'cfdi_123',
        uuid: 'UUID-1',
        stampedAt: new Date('2026-08-04T12:00:00.000Z'),
      });

    const reserveCfdi = jest
      .fn()
      .mockResolvedValue(
        overrides.reserved === false ? null : { status: 'pending' },
      );

    const firestoreService = {
      getUserByStripeCustomerId: jest
        .fn()
        .mockResolvedValue(
          overrides.user === undefined
            ? { id: 'uid-1', country: 'MX', plan: 'pro' }
            : overrides.user,
        ),
      getTaxProfile: jest.fn().mockResolvedValue(
        overrides.profile === undefined
          ? {
              type: 'mx',
              isComplete: true,
              rfc: 'ABC010101AB1',
              legalName: 'EMPRESA DEMO',
              cfdiUse: 'G03',
              taxRegime: '601',
              postalCode: '97000',
            }
          : overrides.profile,
      ),
      reserveCfdi,
      getCfdiByInvoiceId: jest
        .fn()
        .mockResolvedValue(overrides.existingCfdi ?? null),
      updateCfdi: jest
        .fn()
        .mockImplementation((_id: string, data: Record<string, unknown>) => {
          updates.push(data);
          return Promise.resolve();
        }),
    };

    const facturamaService = {
      stampSubscription,
      downloadPdf:
        overrides.downloadPdf ??
        jest.fn().mockResolvedValue(Buffer.from('pdf')),
      downloadXml:
        overrides.downloadXml ??
        jest.fn().mockResolvedValue(Buffer.from('xml')),
    };

    const storageService = {
      saveFile: overrides.saveFile ?? jest.fn().mockResolvedValue(undefined),
    };

    const service = Object.create(CfdiService.prototype) as CfdiService;
    Object.assign(service, {
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      firestoreService,
      facturamaService,
      storageService,
    });

    return {
      service,
      firestoreService,
      facturamaService,
      storageService,
      stampSubscription,
      reserveCfdi,
      updates,
    };
  }

  function invoice(overrides: Partial<Stripe.Invoice> = {}): Stripe.Invoice {
    return {
      id: 'in_123',
      customer: 'cus_123',
      amount_paid: 19900,
      currency: 'mxn',
      period_start: 1754006400,
      period_end: 1756684800,
      status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
      lines: { data: [] },
      ...overrides,
    } as unknown as Stripe.Invoice;
  }

  describe('a quién se le timbra', () => {
    it('timbra a un usuario mexicano con perfil completo', async () => {
      const { service, stampSubscription } = buildService();

      await service.stampForInvoice(invoice());

      expect(stampSubscription).toHaveBeenCalledWith(
        expect.objectContaining({
          total: 199,
          currency: 'mxn',
          receiver: expect.objectContaining({ Rfc: 'ABC010101AB1' }),
        }),
      );
    });

    it('timbra el primer cobro, que handleInvoicePaid descarta', async () => {
      const { service, stampSubscription } = buildService();

      // `billing_reason: 'subscription_create'` no llega a handleInvoicePaid
      // porque el alta la resuelve checkout.session.completed. Fiscalmente sí
      // hay que facturarlo: es el primer cobro del cliente.
      await service.stampForInvoice(
        invoice({
          billing_reason: 'subscription_create',
        } as Partial<Stripe.Invoice>),
      );

      expect(stampSubscription).toHaveBeenCalled();
    });

    it('no timbra a un usuario no mexicano', async () => {
      const { service, stampSubscription } = buildService({
        user: { id: 'uid-1', country: 'ES', plan: 'pro' },
      });

      await service.stampForInvoice(invoice());

      expect(stampSubscription).not.toHaveBeenCalled();
    });

    it('no timbra sin perfil fiscal completo', async () => {
      const { service, stampSubscription } = buildService({
        profile: { type: 'mx', isComplete: false },
      });

      await service.stampForInvoice(invoice());

      expect(stampSubscription).not.toHaveBeenCalled();
    });

    it('no timbra una factura de importe cero', async () => {
      const { service, stampSubscription, reserveCfdi } = buildService();

      // Cupón al 100 % o periodo de prueba: no ampara ningún ingreso.
      await service.stampForInvoice(invoice({ amount_paid: 0 }));

      expect(stampSubscription).not.toHaveBeenCalled();
      expect(reserveCfdi).not.toHaveBeenCalled();
    });

    it('no timbra si el customer no corresponde a ningún usuario', async () => {
      const { service, stampSubscription } = buildService({ user: null });

      await service.stampForInvoice(invoice());

      expect(stampSubscription).not.toHaveBeenCalled();
    });
  });

  describe('idempotencia', () => {
    it('no timbra dos veces la misma factura', async () => {
      const { service, stampSubscription } = buildService({ reserved: false });

      // La reserva ya la tiene otra entrega del mismo webhook.
      await service.stampForInvoice(invoice());

      expect(stampSubscription).not.toHaveBeenCalled();
    });

    it('reserva usando el id de la factura de Stripe como clave', async () => {
      const { service, reserveCfdi } = buildService();

      await service.stampForInvoice(invoice());

      expect(reserveCfdi).toHaveBeenCalledWith(
        expect.objectContaining({ stripeInvoiceId: 'in_123', userId: 'uid-1' }),
      );
    });
  });

  describe('fallos', () => {
    it('no propaga el error del PAC: el webhook debe responder 200', async () => {
      const { service } = buildService({
        stampSubscription: jest
          .fn()
          .mockRejectedValue(
            new FacturamaError(CfdiErrorCodes.RFC_NOT_FOUND, 'RFC no inscrito'),
          ),
      });

      await expect(service.stampForInvoice(invoice())).resolves.toBeUndefined();
    });

    it('guarda el código estable del rechazo', async () => {
      const { service, updates } = buildService({
        stampSubscription: jest
          .fn()
          .mockRejectedValue(
            new FacturamaError(
              CfdiErrorCodes.NAME_MISMATCH,
              'Nombre no coincide',
            ),
          ),
      });

      await service.stampForInvoice(invoice());

      expect(updates[0]).toMatchObject({
        status: 'failed',
        error: { code: CfdiErrorCodes.NAME_MISMATCH },
        attempts: 1,
      });
    });

    it('clasifica como unknown un error que no viene del PAC', async () => {
      const { service, updates } = buildService({
        stampSubscription: jest.fn().mockRejectedValue(new Error('boom')),
      });

      await service.stampForInvoice(invoice());

      expect(updates[0]).toMatchObject({
        status: 'failed',
        error: { code: CfdiErrorCodes.UNKNOWN },
      });
    });

    it('no timbra un cobro en divisa distinta de MXN', async () => {
      const { service, stampSubscription, updates } = buildService();

      await service.stampForInvoice(invoice({ currency: 'usd' }));

      // Emitirlo como si fueran pesos declararía un importe que no es el
      // cobrado; hacerlo en USD exigiría TipoCambio.
      expect(stampSubscription).not.toHaveBeenCalled();
      expect(updates[0]).toMatchObject({
        status: 'failed',
        error: { code: CfdiErrorCodes.INVOICE_NOT_STAMPABLE },
      });
    });

    it('cuenta los intentos acumulados sobre un CFDI ya fallido', async () => {
      const { service, updates } = buildService({
        existingCfdi: { attempts: 2, status: 'failed' },
        stampSubscription: jest
          .fn()
          .mockRejectedValue(
            new FacturamaError(CfdiErrorCodes.PAC_UNAVAILABLE, 'caído'),
          ),
      });

      await service.stampForInvoice(invoice());

      expect(updates[0]).toMatchObject({ attempts: 3 });
    });
  });

  describe('archivado del comprobante', () => {
    it('guarda PDF y XML en Storage y registra sus rutas', async () => {
      const saveFile = jest.fn().mockResolvedValue(undefined);
      const { service, updates } = buildService({ saveFile });

      await service.stampForInvoice(invoice());

      expect(saveFile).toHaveBeenCalledWith(
        'cfdis/uid-1/in_123.pdf',
        expect.any(Buffer),
        'application/pdf',
      );
      expect(saveFile).toHaveBeenCalledWith(
        'cfdis/uid-1/in_123.xml',
        expect.any(Buffer),
        'application/xml',
      );
      expect(updates[0]).toMatchObject({
        status: 'stamped',
        uuid: 'UUID-1',
        pdfPath: 'cfdis/uid-1/in_123.pdf',
        xmlPath: 'cfdis/uid-1/in_123.xml',
      });
    });

    it('deja el CFDI como stamped aunque falle el archivado', async () => {
      const { service, updates } = buildService({
        saveFile: jest.fn().mockRejectedValue(new Error('bucket caído')),
      });

      await service.stampForInvoice(invoice());

      // El comprobante ya existe ante el SAT. Marcarlo failed llevaría a emitir
      // un duplicado al reintentar; solo se pierden los enlaces de descarga.
      expect(updates[0]).toMatchObject({ status: 'stamped', uuid: 'UUID-1' });
      expect(updates[0].pdfPath).toBeUndefined();
    });
  });

  describe('datos del comprobante', () => {
    it('describe el plan y el periodo facturado', async () => {
      const { service, stampSubscription } = buildService();

      await service.stampForInvoice(invoice());

      const { description } = stampSubscription.mock.calls[0][0];
      expect(description).toContain('Plan PRO');
      expect(description).toContain('periodo');
    });

    it('usa la forma de pago de débito cuando Stripe la informa', async () => {
      const { service, stampSubscription } = buildService();

      await service.stampForInvoice(
        invoice({
          payment_intent: {
            payment_method: { card: { funding: 'debit' } },
          },
        } as unknown as Partial<Stripe.Invoice>),
      );

      expect(stampSubscription.mock.calls[0][0].paymentForm).toBe('28');
    });

    it('cae a tarjeta de crédito cuando no puede saberlo', async () => {
      const { service, stampSubscription } = buildService();

      // En el webhook `payment_intent` llega como id sin expandir.
      await service.stampForInvoice(
        invoice({
          payment_intent: 'pi_123',
        } as unknown as Partial<Stripe.Invoice>),
      );

      expect(stampSubscription.mock.calls[0][0].paymentForm).toBe('04');
    });
  });

  describe('retry', () => {
    it('propaga el error para que el usuario sepa si su corrección funcionó', async () => {
      const { service } = buildService({
        stampSubscription: jest
          .fn()
          .mockRejectedValue(
            new FacturamaError(CfdiErrorCodes.RFC_NOT_FOUND, 'sigue mal'),
          ),
      });

      await expect(
        service.retry(invoice(), { id: 'uid-1', country: 'MX' } as never),
      ).rejects.toThrow(FacturamaError);
    });

    it('rechaza el reintento si el perfil fiscal está incompleto', async () => {
      const { service } = buildService({ profile: null });

      await expect(
        service.retry(invoice(), { id: 'uid-1', country: 'MX' } as never),
      ).rejects.toMatchObject({ code: CfdiErrorCodes.INVOICE_NOT_STAMPABLE });
    });
  });
});
