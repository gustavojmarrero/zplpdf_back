import type { NotificationCategory } from '../../common/interfaces/notification-preferences.interface.js';
import type { EmailType } from './interfaces/email.interface.js';

/**
 * Categoría de preferencias a la que pertenece cada tipo de email.
 *
 * El `Record` va completo a propósito: si mañana se añade un tipo de email a
 * `EmailType` y no se clasifica aquí, el compilador lo rechaza. Sin esa red, un
 * tipo nuevo se enviaría a todo el mundo saltándose unas preferencias que el
 * usuario cree respetadas.
 */
export const EMAIL_NOTIFICATION_CATEGORY: Record<
  EmailType,
  NotificationCategory
> = {
  // Onboarding y ciclo de vida: hablan del producto.
  welcome: 'product',
  tutorial: 'product',
  help: 'product',
  success_story: 'product',
  miss_you: 'product',

  // Cuota: avisan de que el plan se está agotando.
  limit_80_percent: 'usageReminders',
  limit_100_percent: 'usageReminders',
  conversion_blocked: 'usageReminders',
  high_usage: 'usageReminders',

  // Retención y reactivación: contenido de producto, no de facturación.
  pro_inactive_7_days: 'product',
  pro_inactive_14_days: 'product',
  pro_inactive_30_days: 'product',
  pro_power_user: 'product',
  free_never_used_7d: 'product',
  free_never_used_14d: 'product',
  free_tried_abandoned: 'product',
  free_dormant_30d: 'product',
  free_abandoned_60d: 'product',

  // Cobros y suscripción.
  payment_failed: 'billing',
  subscription_downgraded: 'billing',
};

/**
 * Categoría de un tipo de email, o `null` si no está clasificado.
 *
 * La cola guarda `emailType` como string libre, así que puede llegar un valor
 * que no esté en `EmailType` (una plantilla creada a mano en Firestore, por
 * ejemplo). Quien llama decide qué hacer con `null`.
 */
export function getEmailNotificationCategory(
  emailType: string,
): NotificationCategory | null {
  return EMAIL_NOTIFICATION_CATEGORY[emailType as EmailType] ?? null;
}
