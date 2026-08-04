import type Stripe from 'stripe';

export interface BillingPeriod {
  start?: Date;
  end?: Date;
}

/**
 * Fechas del periodo de facturación vigente de una suscripción de Stripe.
 *
 * Desde la versión de API `2025-03-31.basil` el periodo dejó de vivir en la
 * suscripción y pasó a cada línea: `items.data[].current_period_*`. El código
 * anterior leía `subscription.current_period_start` a través de un
 * `as unknown as { current_period_start: number }`, y ese cast es lo que impidió
 * al compilador avisar cuando el proyecto subió a `stripe@20`: el valor pasó a
 * ser `undefined`, los `if` que guardaban el periodo se saltaron sin ruido y
 * `subscriptionPeriodStart/End` dejaron de escribirse para todos los usuarios de
 * pago.
 *
 * Vive aquí y no en un servicio porque lo necesitan tanto los webhooks de pagos
 * como el job de backfill del cron, y la lección del incidente es justamente que
 * este acceso no debe estar duplicado.
 *
 * Devuelve un objeto vacío si no puede resolverlo; corresponde a quien llama
 * decidir si eso merece un aviso.
 */
export function extractBillingPeriod(
  subscription: Stripe.Subscription,
): BillingPeriod {
  const item = subscription?.items?.data?.[0];

  if (!item?.current_period_start || !item?.current_period_end) {
    return {};
  }

  return {
    start: new Date(item.current_period_start * 1000),
    end: new Date(item.current_period_end * 1000),
  };
}

/**
 * Id de la suscripción que originó una factura.
 *
 * Misma historia que el periodo: `invoice.subscription` desapareció del nivel
 * superior en Basil y ahora cuelga de `parent.subscription_details`.
 */
export function getSubscriptionIdFromInvoice(
  invoice: Stripe.Invoice,
): string | null {
  const subscription = invoice?.parent?.subscription_details?.subscription;

  if (!subscription) {
    return null;
  }

  return typeof subscription === 'string' ? subscription : subscription.id;
}
