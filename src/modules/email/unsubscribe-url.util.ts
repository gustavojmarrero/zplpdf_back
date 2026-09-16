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
