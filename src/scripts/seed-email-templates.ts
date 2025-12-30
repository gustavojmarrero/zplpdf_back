/**
 * Seed script to migrate hardcoded email templates to Firestore
 *
 * Run with: npx tsx src/scripts/seed-email-templates.ts
 *
 * This script:
 * 1. Connects to Firestore
 * 2. Creates email_templates collection with all templates
 * 3. Creates initial versions in email_template_versions
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as dotenv from 'dotenv';

dotenv.config();

// Initialize Firebase Admin
const credentials = process.env.FIREBASE_CREDENTIALS || process.env.GOOGLE_CREDENTIALS;
if (!credentials) {
  console.error('ERROR: FIREBASE_CREDENTIALS or GOOGLE_CREDENTIALS not set');
  process.exit(1);
}

const serviceAccount = JSON.parse(credentials);
initializeApp({ credential: cert(serviceAccount) });
const firestore = getFirestore();

// Collection names
const TEMPLATES_COLLECTION = 'email_templates';
const VERSIONS_COLLECTION = 'email_template_versions';

// Define all templates to seed
const TEMPLATES = [
  // ============== PRO Retention Templates ==============
  {
    templateType: 'pro_retention',
    templateKey: 'pro_inactive_7_days',
    name: 'PRO Retention - 7 Days Inactive',
    description: 'Email sent to PRO users after 7 days of inactivity',
    triggerDays: 7,
    enabled: true,
    variables: ['userName', 'displayName', 'daysInactive', 'appUrl'],
    content: {
      en: {
        subject: 'We noticed you haven\'t converted labels recently',
        body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Hi {userName},</h2>
          <p>We noticed it's been {daysInactive} days since your last label conversion on ZPLPDF.</p>
          <p>As a PRO subscriber, you have access to:</p>
          <ul>
            <li>500 PDFs per month</li>
            <li>500 labels per PDF</li>
            <li>Batch conversion (10 files)</li>
            <li>Image export (PNG/JPEG)</li>
          </ul>
          <p>Don't let your subscription go to waste!</p>
          <p><a href="{appUrl}" style="background-color: #4CAF50; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">Convert Labels Now</a></p>
          <p>Best regards,<br>The ZPLPDF Team</p>
        </div>`,
      },
      es: {
        subject: 'Notamos que no has convertido etiquetas recientemente',
        body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Hola {userName},</h2>
          <p>Notamos que han pasado {daysInactive} días desde tu última conversión en ZPLPDF.</p>
          <p>Como suscriptor PRO, tienes acceso a:</p>
          <ul>
            <li>500 PDFs por mes</li>
            <li>500 etiquetas por PDF</li>
            <li>Conversión en lote (10 archivos)</li>
            <li>Exportación de imagen (PNG/JPEG)</li>
          </ul>
          <p>¡No dejes que tu suscripción se desperdicie!</p>
          <p><a href="{appUrl}" style="background-color: #4CAF50; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">Convertir Etiquetas</a></p>
          <p>Saludos,<br>El Equipo de ZPLPDF</p>
        </div>`,
      },
      zh: {
        subject: '我们注意到您最近没有转换标签',
        body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>你好 {userName},</h2>
          <p>我们注意到您已有 {daysInactive} 天没有在ZPLPDF上转换标签了。</p>
          <p>作为PRO订阅者，您可以使用：</p>
          <ul>
            <li>每月500个PDF</li>
            <li>每个PDF 500个标签</li>
            <li>批量转换（10个文件）</li>
            <li>图片导出（PNG/JPEG）</li>
          </ul>
          <p>不要浪费您的订阅！</p>
          <p><a href="{appUrl}" style="background-color: #4CAF50; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">立即转换标签</a></p>
          <p>祝好，<br>ZPLPDF团队</p>
        </div>`,
      },
    },
  },
  {
    templateType: 'pro_retention',
    templateKey: 'pro_inactive_14_days',
    name: 'PRO Retention - 14 Days Inactive',
    description: 'Email sent to PRO users after 14 days of inactivity',
    triggerDays: 14,
    enabled: true,
    variables: ['userName', 'displayName', 'daysInactive', 'appUrl'],
    content: {
      en: {
        subject: 'Your PRO features are waiting for you',
        body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Hi {userName},</h2>
          <p>It's been {daysInactive} days since we've seen you on ZPLPDF.</p>
          <p>Your PRO subscription is still active and waiting for you. Remember, you can:</p>
          <ul>
            <li>Convert up to 500 PDFs per month</li>
            <li>Process up to 500 labels per PDF</li>
            <li>Batch convert multiple files at once</li>
            <li>Export to PNG and JPEG formats</li>
          </ul>
          <p><a href="{appUrl}" style="background-color: #2196F3; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">Return to ZPLPDF</a></p>
          <p>We'd love to have you back!</p>
          <p>Best,<br>The ZPLPDF Team</p>
        </div>`,
      },
      es: {
        subject: 'Tus funciones PRO te están esperando',
        body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Hola {userName},</h2>
          <p>Han pasado {daysInactive} días desde la última vez que te vimos en ZPLPDF.</p>
          <p>Tu suscripción PRO sigue activa y esperándote. Recuerda que puedes:</p>
          <ul>
            <li>Convertir hasta 500 PDFs por mes</li>
            <li>Procesar hasta 500 etiquetas por PDF</li>
            <li>Convertir múltiples archivos en lote</li>
            <li>Exportar a formatos PNG y JPEG</li>
          </ul>
          <p><a href="{appUrl}" style="background-color: #2196F3; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">Volver a ZPLPDF</a></p>
          <p>¡Nos encantaría verte de nuevo!</p>
          <p>Saludos,<br>El Equipo de ZPLPDF</p>
        </div>`,
      },
      zh: {
        subject: '您的PRO功能正在等您',
        body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>你好 {userName},</h2>
          <p>距离我们上次在ZPLPDF见到您已经 {daysInactive} 天了。</p>
          <p>您的PRO订阅仍然有效。请记住，您可以：</p>
          <ul>
            <li>每月转换多达500个PDF</li>
            <li>每个PDF处理多达500个标签</li>
            <li>批量转换多个文件</li>
            <li>导出为PNG和JPEG格式</li>
          </ul>
          <p><a href="{appUrl}" style="background-color: #2196F3; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">返回ZPLPDF</a></p>
          <p>期待您的回归！</p>
          <p>祝好，<br>ZPLPDF团队</p>
        </div>`,
      },
    },
  },
  {
    templateType: 'pro_retention',
    templateKey: 'pro_inactive_30_days',
    name: 'PRO Retention - 30 Days Inactive',
    description: 'Email sent to PRO users after 30 days of inactivity',
    triggerDays: 30,
    enabled: true,
    variables: ['userName', 'displayName', 'daysInactive', 'appUrl'],
    content: {
      en: {
        subject: 'We miss you at ZPLPDF',
        body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Hi {userName},</h2>
          <p>It's been a month since your last visit to ZPLPDF.</p>
          <p>We wanted to remind you that your PRO subscription is still active. If you're having any issues or need help, please don't hesitate to reach out.</p>
          <p>We'd love to hear your feedback on how we can improve ZPLPDF for your needs.</p>
          <p><a href="{appUrl}" style="background-color: #FF9800; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">Come Back to ZPLPDF</a></p>
          <p>Best regards,<br>The ZPLPDF Team</p>
        </div>`,
      },
      es: {
        subject: 'Te extrañamos en ZPLPDF',
        body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Hola {userName},</h2>
          <p>Ha pasado un mes desde tu última visita a ZPLPDF.</p>
          <p>Queríamos recordarte que tu suscripción PRO sigue activa. Si tienes algún problema o necesitas ayuda, no dudes en contactarnos.</p>
          <p>Nos encantaría escuchar tus comentarios sobre cómo podemos mejorar ZPLPDF para ti.</p>
          <p><a href="{appUrl}" style="background-color: #FF9800; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">Vuelve a ZPLPDF</a></p>
          <p>Saludos,<br>El Equipo de ZPLPDF</p>
        </div>`,
      },
      zh: {
        subject: '我们在ZPLPDF想念您',
        body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>你好 {userName},</h2>
          <p>距离您上次访问ZPLPDF已经一个月了。</p>
          <p>我们想提醒您，您的PRO订阅仍然有效。如果您遇到任何问题或需要帮助，请随时联系我们。</p>
          <p>我们很想听听您的反馈，了解如何改进ZPLPDF以满足您的需求。</p>
          <p><a href="{appUrl}" style="background-color: #FF9800; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">返回ZPLPDF</a></p>
          <p>祝好，<br>ZPLPDF团队</p>
        </div>`,
      },
    },
  },

  // ============== FREE Reactivation Templates ==============
  {
    templateType: 'free_reactivation',
    templateKey: 'free_never_used_7d',
    name: 'FREE Reactivation - Never Used (7 Days)',
    description: 'Email for FREE users who registered 7+ days ago but never converted',
    triggerDays: 7,
    enabled: true,
    variables: ['userName', 'displayName', 'daysSinceRegistration', 'pdfsAvailable', 'appUrl'],
    content: {
      en: {
        subject: '{userName}, your ZPLPDF account is waiting',
        body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Hi {userName},</h2>
          <p>You created your ZPLPDF account {daysSinceRegistration} days ago, but you haven't converted any labels yet!</p>
          <p>Your FREE account includes {pdfsAvailable} PDFs per month. Here's what you can do:</p>
          <ul>
            <li>Convert ZPL shipping labels to PDF instantly</li>
            <li>Support for major carriers (FedEx, UPS, USPS, DHL)</li>
            <li>No software installation required</li>
          </ul>
          <p><a href="{appUrl}" style="background-color: #4CAF50; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">Convert Your First Label</a></p>
          <p>Best,<br>The ZPLPDF Team</p>
        </div>`,
      },
      es: {
        subject: '{userName}, tu cuenta ZPLPDF te espera',
        body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Hola {userName},</h2>
          <p>Creaste tu cuenta ZPLPDF hace {daysSinceRegistration} días, ¡pero aún no has convertido ninguna etiqueta!</p>
          <p>Tu cuenta GRATIS incluye {pdfsAvailable} PDFs por mes. Esto es lo que puedes hacer:</p>
          <ul>
            <li>Convertir etiquetas de envío ZPL a PDF al instante</li>
            <li>Soporte para principales transportistas (FedEx, UPS, DHL)</li>
            <li>Sin necesidad de instalar software</li>
          </ul>
          <p><a href="{appUrl}" style="background-color: #4CAF50; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">Convierte Tu Primera Etiqueta</a></p>
          <p>Saludos,<br>El Equipo de ZPLPDF</p>
        </div>`,
      },
      zh: {
        subject: '{userName}，您的ZPLPDF账户在等您',
        body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>你好 {userName},</h2>
          <p>您在 {daysSinceRegistration} 天前创建了ZPLPDF账户，但还没有转换任何标签！</p>
          <p>您的免费账户每月包含 {pdfsAvailable} 个PDF。您可以：</p>
          <ul>
            <li>即时将ZPL运输标签转换为PDF</li>
            <li>支持主要承运商（FedEx、UPS、DHL）</li>
            <li>无需安装软件</li>
          </ul>
          <p><a href="{appUrl}" style="background-color: #4CAF50; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">转换您的第一个标签</a></p>
          <p>祝好，<br>ZPLPDF团队</p>
        </div>`,
      },
    },
  },
  {
    templateType: 'free_reactivation',
    templateKey: 'free_never_used_14d',
    name: 'FREE Reactivation - Never Used (14 Days)',
    description: 'Email for FREE users who registered 14+ days ago but never converted',
    triggerDays: 14,
    enabled: true,
    variables: ['userName', 'displayName', 'daysSinceRegistration', 'pdfsAvailable', 'appUrl'],
    content: {
      en: {
        subject: 'Still waiting to see your first label, {userName}',
        body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Hi {userName},</h2>
          <p>It's been {daysSinceRegistration} days since you signed up for ZPLPDF, but we haven't seen any conversions yet.</p>
          <p>Is there something holding you back? We're here to help!</p>
          <p>Remember, converting ZPL to PDF is as easy as:</p>
          <ol>
            <li>Paste your ZPL code</li>
            <li>Click "Convert"</li>
            <li>Download your PDF</li>
          </ol>
          <p><a href="{appUrl}" style="background-color: #2196F3; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">Try It Now - It's Free!</a></p>
          <p>Best,<br>The ZPLPDF Team</p>
        </div>`,
      },
      es: {
        subject: 'Aún esperando ver tu primera etiqueta, {userName}',
        body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Hola {userName},</h2>
          <p>Han pasado {daysSinceRegistration} días desde que te registraste en ZPLPDF, pero aún no hemos visto ninguna conversión.</p>
          <p>¿Hay algo que te detenga? ¡Estamos aquí para ayudar!</p>
          <p>Recuerda, convertir ZPL a PDF es tan fácil como:</p>
          <ol>
            <li>Pega tu código ZPL</li>
            <li>Haz clic en "Convertir"</li>
            <li>Descarga tu PDF</li>
          </ol>
          <p><a href="{appUrl}" style="background-color: #2196F3; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">Pruébalo Ahora - ¡Es Gratis!</a></p>
          <p>Saludos,<br>El Equipo de ZPLPDF</p>
        </div>`,
      },
      zh: {
        subject: '还在等待您的第一个标签，{userName}',
        body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>你好 {userName},</h2>
          <p>距离您注册ZPLPDF已经 {daysSinceRegistration} 天了，但我们还没有看到任何转换。</p>
          <p>有什么问题吗？我们随时为您提供帮助！</p>
          <p>记住，将ZPL转换为PDF非常简单：</p>
          <ol>
            <li>粘贴您的ZPL代码</li>
            <li>点击"转换"</li>
            <li>下载您的PDF</li>
          </ol>
          <p><a href="{appUrl}" style="background-color: #2196F3; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">立即试用 - 免费！</a></p>
          <p>祝好，<br>ZPLPDF团队</p>
        </div>`,
      },
    },
  },
  {
    templateType: 'free_reactivation',
    templateKey: 'free_tried_abandoned',
    name: 'FREE Reactivation - Tried & Abandoned',
    description: 'Email for FREE users who converted 1-3 PDFs then stopped (14+ days inactive)',
    triggerDays: 14,
    enabled: true,
    variables: ['userName', 'displayName', 'daysInactive', 'pdfCount', 'pdfsAvailable', 'appUrl'],
    content: {
      en: {
        subject: 'Your labels miss you, {userName}',
        body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Hi {userName},</h2>
          <p>You converted {pdfCount} PDF(s) and then we haven't seen you in {daysInactive} days.</p>
          <p>Did something not work as expected? We'd love to hear your feedback!</p>
          <p>Remember, you still have {pdfsAvailable} free PDFs available this month.</p>
          <p><a href="{appUrl}" style="background-color: #FF9800; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">Continue Converting</a></p>
          <p>If you have any questions, just reply to this email!</p>
          <p>Best,<br>The ZPLPDF Team</p>
        </div>`,
      },
      es: {
        subject: 'Tus etiquetas te extrañan, {userName}',
        body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Hola {userName},</h2>
          <p>Convertiste {pdfCount} PDF(s) y luego no te hemos visto en {daysInactive} días.</p>
          <p>¿Algo no funcionó como esperabas? ¡Nos encantaría escuchar tus comentarios!</p>
          <p>Recuerda, aún tienes {pdfsAvailable} PDFs gratis disponibles este mes.</p>
          <p><a href="{appUrl}" style="background-color: #FF9800; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">Continuar Convirtiendo</a></p>
          <p>Si tienes preguntas, ¡solo responde a este email!</p>
          <p>Saludos,<br>El Equipo de ZPLPDF</p>
        </div>`,
      },
      zh: {
        subject: '您的标签想念您，{userName}',
        body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>你好 {userName},</h2>
          <p>您转换了 {pdfCount} 个PDF，然后我们已经 {daysInactive} 天没见到您了。</p>
          <p>有什么不如预期吗？我们很想听听您的反馈！</p>
          <p>记住，本月您还有 {pdfsAvailable} 个免费PDF可用。</p>
          <p><a href="{appUrl}" style="background-color: #FF9800; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">继续转换</a></p>
          <p>如有问题，直接回复此邮件即可！</p>
          <p>祝好，<br>ZPLPDF团队</p>
        </div>`,
      },
    },
  },
  {
    templateType: 'free_reactivation',
    templateKey: 'free_dormant_30d',
    name: 'FREE Reactivation - Dormant (30 Days)',
    description: 'Email for FREE users with >3 PDFs who have been inactive for 30+ days',
    triggerDays: 30,
    enabled: true,
    variables: ['userName', 'displayName', 'daysInactive', 'pdfCount', 'labelCount', 'appUrl', 'upgradeUrl'],
    content: {
      en: {
        subject: 'A month without labels? Let\'s fix that, {userName}',
        body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Hi {userName},</h2>
          <p>It's been {daysInactive} days since your last conversion. In that time, you've helped convert {labelCount} labels!</p>
          <p>We've been working hard on improvements. Here's what's new:</p>
          <ul>
            <li>Faster conversion speeds</li>
            <li>Better label quality</li>
            <li>Improved batch processing</li>
          </ul>
          <p>Ready to see what's new?</p>
          <p><a href="{appUrl}" style="background-color: #9C27B0; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">Come Back & Convert</a></p>
          <p>Best,<br>The ZPLPDF Team</p>
        </div>`,
      },
      es: {
        subject: '¿Un mes sin etiquetas? Arreglemos eso, {userName}',
        body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Hola {userName},</h2>
          <p>Han pasado {daysInactive} días desde tu última conversión. ¡En ese tiempo, ayudaste a convertir {labelCount} etiquetas!</p>
          <p>Hemos trabajado duro en mejoras. Esto es lo nuevo:</p>
          <ul>
            <li>Velocidades de conversión más rápidas</li>
            <li>Mejor calidad de etiquetas</li>
            <li>Procesamiento en lote mejorado</li>
          </ul>
          <p>¿Listo para ver las novedades?</p>
          <p><a href="{appUrl}" style="background-color: #9C27B0; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">Vuelve y Convierte</a></p>
          <p>Saludos,<br>El Equipo de ZPLPDF</p>
        </div>`,
      },
      zh: {
        subject: '一个月没有标签了？让我们解决这个问题，{userName}',
        body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>你好 {userName},</h2>
          <p>距离您上次转换已经 {daysInactive} 天了。在这段时间里，您帮助转换了 {labelCount} 个标签！</p>
          <p>我们一直在努力改进。以下是新功能：</p>
          <ul>
            <li>更快的转换速度</li>
            <li>更好的标签质量</li>
            <li>改进的批处理</li>
          </ul>
          <p>准备好看看新功能了吗？</p>
          <p><a href="{appUrl}" style="background-color: #9C27B0; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">回来转换</a></p>
          <p>祝好，<br>ZPLPDF团队</p>
        </div>`,
      },
    },
  },
  {
    templateType: 'free_reactivation',
    templateKey: 'free_abandoned_60d',
    name: 'FREE Reactivation - Abandoned (60 Days)',
    description: 'Last chance email for FREE users inactive for 60+ days',
    triggerDays: 60,
    enabled: true,
    variables: ['userName', 'displayName', 'daysInactive', 'appUrl', 'upgradeUrl'],
    content: {
      en: {
        subject: 'It\'s been a while, {userName}. Your account is still here!',
        body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Hi {userName},</h2>
          <p>We noticed it's been {daysInactive} days since you last used ZPLPDF.</p>
          <p>Your account is still active and ready whenever you need to convert shipping labels!</p>
          <p>If you need any help getting started again, we're here for you.</p>
          <p><a href="{appUrl}" style="background-color: #607D8B; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">Visit ZPLPDF</a></p>
          <p>We hope to see you again soon!</p>
          <p>Best,<br>The ZPLPDF Team</p>
        </div>`,
      },
      es: {
        subject: 'Ha pasado un tiempo, {userName}. ¡Tu cuenta sigue aquí!',
        body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Hola {userName},</h2>
          <p>Notamos que han pasado {daysInactive} días desde que usaste ZPLPDF por última vez.</p>
          <p>¡Tu cuenta sigue activa y lista cuando necesites convertir etiquetas de envío!</p>
          <p>Si necesitas ayuda para empezar de nuevo, estamos aquí para ti.</p>
          <p><a href="{appUrl}" style="background-color: #607D8B; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">Visitar ZPLPDF</a></p>
          <p>¡Esperamos verte pronto!</p>
          <p>Saludos,<br>El Equipo de ZPLPDF</p>
        </div>`,
      },
      zh: {
        subject: '已经有一段时间了，{userName}。您的账户还在这里！',
        body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>你好 {userName},</h2>
          <p>我们注意到您已经 {daysInactive} 天没有使用ZPLPDF了。</p>
          <p>您的账户仍然有效，随时可以转换运输标签！</p>
          <p>如果您需要帮助重新开始，我们随时为您服务。</p>
          <p><a href="{appUrl}" style="background-color: #607D8B; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">访问ZPLPDF</a></p>
          <p>希望很快再见到您！</p>
          <p>祝好，<br>ZPLPDF团队</p>
        </div>`,
      },
    },
  },
];

async function seedTemplates() {
  console.log('Starting email templates seed...\n');

  const now = new Date();
  const adminEmail = 'system@zplpdf.com';

  for (const template of TEMPLATES) {
    console.log(`Processing: ${template.templateKey}`);

    // Check if template already exists
    const existingSnapshot = await firestore
      .collection(TEMPLATES_COLLECTION)
      .where('templateKey', '==', template.templateKey)
      .limit(1)
      .get();

    if (!existingSnapshot.empty) {
      console.log(`  - Skipped (already exists)`);
      continue;
    }

    // Create template
    const docRef = await firestore.collection(TEMPLATES_COLLECTION).add({
      ...template,
      createdAt: now,
      updatedAt: now,
      updatedBy: adminEmail,
      version: 1,
    });

    // Create initial version
    await firestore.collection(VERSIONS_COLLECTION).add({
      templateId: docRef.id,
      version: 1,
      content: template.content,
      triggerDays: template.triggerDays,
      enabled: template.enabled,
      createdAt: now,
      createdBy: adminEmail,
      changeDescription: 'Initial version (seed)',
    });

    console.log(`  - Created with ID: ${docRef.id}`);
  }

  console.log('\nSeed completed!');
  console.log(`Total templates processed: ${TEMPLATES.length}`);
}

// Run the seed
seedTemplates()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exit(1);
  });
