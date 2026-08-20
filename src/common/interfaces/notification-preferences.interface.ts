/**
 * Preferencias de notificación por email, agrupadas por tipo de contenido.
 *
 * Viven dentro del documento de `users` (campo `notificationPreferences`) en vez
 * de en su propia colección: son tres booleanos que se consultan justo antes de
 * enviar cada email, y el doc de usuario ya se lee en ese punto.
 *
 * Ausente equivale a "todo activado": la opción por defecto tiene que ser la
 * misma para las cuentas antiguas —creadas antes de que existieran estas
 * preferencias— y para las nuevas, y ninguna de las dos ha pedido dejar de
 * recibir nada.
 */
export interface NotificationPreferences {
  /** Novedades y cambios del producto. */
  product: boolean;
  /** Cobros, fallos de pago y facturas. */
  billing: boolean;
  /** Avisos al acercarse al límite del plan. */
  usageReminders: boolean;
}

export type NotificationCategory = keyof NotificationPreferences;

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  product: true,
  billing: true,
  usageReminders: true,
};

/**
 * Normaliza lo que haya en Firestore a las tres claves del contrato.
 *
 * Rellena con los valores por defecto lo que falte —un documento anterior a
 * esta feature no tiene el campo— y descarta cualquier clave extra, para que la
 * respuesta del endpoint no dependa de lo que se haya persistido alguna vez.
 */
export function resolveNotificationPreferences(
  stored?: Partial<NotificationPreferences> | null,
): NotificationPreferences {
  return {
    product: stored?.product ?? DEFAULT_NOTIFICATION_PREFERENCES.product,
    billing: stored?.billing ?? DEFAULT_NOTIFICATION_PREFERENCES.billing,
    usageReminders:
      stored?.usageReminders ?? DEFAULT_NOTIFICATION_PREFERENCES.usageReminders,
  };
}
