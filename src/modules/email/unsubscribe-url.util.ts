import type { EmailLanguage } from './interfaces/email.interface.js';

/**
 * Base pública del sitio para enlaces dentro de los correos. No hay una
 * constante compartida hoy fuera de este módulo: el resto de plantillas (los
 * scripts de siembra en `templates/email-templates.ts`) hardcodean el dominio
 * directamente, con distintos valores (`zplpdf.com` y `www.zplpdf.com`) según
 * el archivo. Se documenta aquí como punto único para los enlaces de baja.
 */
const APP_BASE_URL = 'https://zplpdf.com';

const SUPPORTED_EMAIL_LANGUAGES: readonly EmailLanguage[] = [
  'en',
  'es',
  'pt',
  'zh',
];

/**
 * Normaliza el idioma de un correo a uno de los cuatro soportados por el
 * sitio. El idioma de origen viaja como string libre (cola de Firestore,
 * parámetro de query del admin, etc.), así que un valor fuera de en|es|pt|zh
 * cae a inglés.
 */
export function resolveEmailLanguage(language: string): EmailLanguage {
  return SUPPORTED_EMAIL_LANGUAGES.includes(language as EmailLanguage)
    ? (language as EmailLanguage)
    : 'en';
}

/**
 * Enlace de baja: lleva a Ajustes con sesión iniciada, no a un endpoint
 * público. Decisión del producto (ver issue zplpdf_back#116): sin token ni
 * cabecera List-Unsubscribe, porque hoy no hay endpoint de baja sin sesión.
 *
 * Compartido entre `EmailService.sendEmail` (correo real) y
 * `EmailTemplatesController` (vista previa y envío de prueba del admin), para
 * que el ejemplo que ve el admin sea exactamente la URL real y no una ruta
 * inexistente.
 */
export function buildUnsubscribeUrl(language: string): string {
  const lang = resolveEmailLanguage(language);
  return `${APP_BASE_URL}/${lang}/dashboard/settings#settings-notifications-heading`;
}

/**
 * Pie de baja para las plantillas de Firestore que no incluyen el placeholder
 * `{unsubscribeUrl}`. La frase original (ver `templates/email-templates.ts`,
 * usada solo para sembrar) prometía un enlace de baja que nunca existió; este
 * pie sí enlaza. Ver issue zplpdf_back#116.
 */
const UNSUBSCRIBE_FOOTER_TEXT: Record<EmailLanguage, string> = {
  en: 'You can manage your email preferences or unsubscribe at any time from your <a href="{unsubscribeUrl}" style="color: #6b7280;">account settings</a>.',
  es: 'Puedes gestionar tus preferencias de correo o darte de baja en cualquier momento desde los <a href="{unsubscribeUrl}" style="color: #6b7280;">ajustes de tu cuenta</a>.',
  zh: '您可以随时通过<a href="{unsubscribeUrl}" style="color: #6b7280;">账户设置</a>管理邮件偏好或取消订阅。',
  pt: 'Você pode gerenciar suas preferências de e-mail ou cancelar a inscrição a qualquer momento nas <a href="{unsubscribeUrl}" style="color: #6b7280;">configurações da sua conta</a>.',
};

/** HTML del pie de baja en el idioma del correo. */
export function buildUnsubscribeFooterHtml(
  language: string,
  unsubscribeUrl: string,
): string {
  const text = UNSUBSCRIBE_FOOTER_TEXT[resolveEmailLanguage(language)].replace(
    '{unsubscribeUrl}',
    unsubscribeUrl,
  );
  return `<p style="margin: 24px 0 0; padding-top: 16px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #9ca3af; text-align: center;">${text}</p>`;
}

/**
 * Inserta `fragment` dentro del documento HTML. Las plantillas sembradas son
 * documentos completos que terminan en `</body></html>`: añadir el pie con
 * `+=` lo dejaba detrás de `</html>`, fuera del documento, y los clientes de
 * correo pueden descartarlo o moverlo fuera del diseño. Se coloca antes del
 * último `</body>`; si no hay, antes del último `</html>`; y si el cuerpo es un
 * fragmento sin esas etiquetas, al final.
 */
export function appendBeforeDocumentEnd(
  html: string,
  fragment: string,
): string {
  const lower = html.toLowerCase();
  for (const closingTag of ['</body>', '</html>']) {
    const index = lower.lastIndexOf(closingTag);
    if (index !== -1) {
      return html.slice(0, index) + fragment + html.slice(index);
    }
  }
  return html + fragment;
}
