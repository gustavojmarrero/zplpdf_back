import type Stripe from 'stripe';
import {
  extractBillingPeriod,
  getSubscriptionIdFromInvoice,
} from './stripe-billing-period.util.js';

/**
 * Estos dos accesos llevaban meses devolviendo `undefined` en producción sin que
 * nada lo delatara: los campos que leían desaparecieron del nivel superior en la
 * versión de API `2025-03-31.basil`, y los `as unknown as {...}` que envolvían el
 * acceso impidieron al compilador avisar al subir a `stripe@20`.
 *
 * El síntoma no era un error, era una ausencia: `subscriptionPeriodStart/End`
 * dejaron de escribirse y la cuota mensual de todo usuario de pago pasó a
 * calcularse desde su día de registro en vez de su día de facturación.
 */
describe('stripe-billing-period.util', () => {
  describe('extractBillingPeriod', () => {
    const START = 1754006400;
    const END = 1756684800;

    it('lee el periodo de items.data[0], donde vive desde Basil', () => {
      const subscription = {
        id: 'sub_1',
        items: {
          data: [{ current_period_start: START, current_period_end: END }],
        },
      } as unknown as Stripe.Subscription;

      const period = extractBillingPeriod(subscription);

      expect(period.start).toEqual(new Date(START * 1000));
      expect(period.end).toEqual(new Date(END * 1000));
    });

    it('ignora el campo del nivel superior, que ya no existe', () => {
      // Forma anterior a Basil: si alguien la reintroduce, no debe colarse.
      const subscription = {
        id: 'sub_1',
        current_period_start: START,
        current_period_end: END,
        items: { data: [] },
      } as unknown as Stripe.Subscription;

      expect(extractBillingPeriod(subscription)).toEqual({});
    });

    it('devuelve vacío si la suscripción no tiene líneas', () => {
      const subscription = {
        id: 'sub_1',
        items: { data: [] },
      } as unknown as Stripe.Subscription;

      expect(extractBillingPeriod(subscription)).toEqual({});
    });

    it('devuelve vacío si falta una de las dos fechas', () => {
      const subscription = {
        id: 'sub_1',
        items: { data: [{ current_period_start: START }] },
      } as unknown as Stripe.Subscription;

      // Un periodo a medias no sirve: `calculateCurrentPeriod` exige las dos.
      expect(extractBillingPeriod(subscription)).toEqual({});
    });

    it('no revienta con una suscripción malformada', () => {
      expect(extractBillingPeriod({} as Stripe.Subscription)).toEqual({});
      expect(extractBillingPeriod(undefined as never)).toEqual({});
    });
  });

  describe('getSubscriptionIdFromInvoice', () => {
    it('lee el id de parent.subscription_details', () => {
      const invoice = {
        id: 'in_1',
        parent: { subscription_details: { subscription: 'sub_123' } },
      } as unknown as Stripe.Invoice;

      expect(getSubscriptionIdFromInvoice(invoice)).toBe('sub_123');
    });

    it('acepta la suscripción expandida como objeto', () => {
      const invoice = {
        id: 'in_1',
        parent: { subscription_details: { subscription: { id: 'sub_123' } } },
      } as unknown as Stripe.Invoice;

      expect(getSubscriptionIdFromInvoice(invoice)).toBe('sub_123');
    });

    it('ignora invoice.subscription, que ya no existe', () => {
      // Esta era exactamente la lectura rota: devolvía `undefined` en todas las
      // facturas, así que el bloque que actualizaba plan y periodo se saltaba
      // entero y en silencio.
      const invoice = {
        id: 'in_1',
        subscription: 'sub_123',
      } as unknown as Stripe.Invoice;

      expect(getSubscriptionIdFromInvoice(invoice)).toBeNull();
    });

    it('devuelve null en una factura que no viene de una suscripción', () => {
      const invoice = {
        id: 'in_1',
        parent: { subscription_details: null },
      } as unknown as Stripe.Invoice;

      expect(getSubscriptionIdFromInvoice(invoice)).toBeNull();
      expect(
        getSubscriptionIdFromInvoice({ id: 'in_1' } as Stripe.Invoice),
      ).toBeNull();
    });
  });
});
