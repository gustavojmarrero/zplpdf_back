/**
 * Migration script to create limit_80_percent and limit_100_percent templates in Firestore
 *
 * Run with: npx tsx src/scripts/migrate-limit-templates.ts
 */

import admin from 'firebase-admin';
import dotenv from 'dotenv';
import { readFileSync } from 'fs';

dotenv.config();

// Initialize Firebase Admin
const credentialsPath =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  process.env.FIREBASE_CREDENTIALS;

if (!credentialsPath) {
  console.error(
    'Error: GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_CREDENTIALS environment variable is required',
  );
  process.exit(1);
}

const serviceAccount = JSON.parse(readFileSync(credentialsPath, 'utf-8'));
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount as admin.ServiceAccount),
});

const firestore = admin.firestore();
const EMAIL_TEMPLATES_COLLECTION = 'email_templates';

// Helper function to generate progress bar HTML with variables
function progressBarTemplate(): string {
  return `
    <table role="presentation" style="width: 100%; margin: 16px 0; border-collapse: collapse;">
      <tr>
        <td style="padding: 0;">
          <div style="background-color: #e5e7eb; border-radius: 9999px; overflow: hidden; height: 24px;">
            <div style="background-color: #f59e0b; width: 80%; height: 100%; border-radius: 9999px;"></div>
          </div>
        </td>
      </tr>
      <tr>
        <td style="padding: 8px 0 0; text-align: center;">
          <span style="color: #f59e0b; font-weight: 600; font-size: 18px;">{pdfsUsed}</span>
          <span style="color: #6b7280; font-size: 14px;"> / {limit} PDFs</span>
        </td>
      </tr>
    </table>
  `;
}

function progressBar100Template(): string {
  return `
    <table role="presentation" style="width: 100%; margin: 16px 0; border-collapse: collapse;">
      <tr>
        <td style="padding: 0;">
          <div style="background-color: #e5e7eb; border-radius: 9999px; overflow: hidden; height: 24px;">
            <div style="background-color: #dc2626; width: 100%; height: 100%; border-radius: 9999px;"></div>
          </div>
        </td>
      </tr>
      <tr>
        <td style="padding: 8px 0 0; text-align: center;">
          <span style="color: #dc2626; font-weight: 600; font-size: 18px;">{pdfsUsed}</span>
          <span style="color: #6b7280; font-size: 14px;"> / {limit} PDFs</span>
        </td>
      </tr>
    </table>
  `;
}

function ctaButtonTemplate(text: string, url: string): string {
  return `
    <table role="presentation" style="margin: 24px 0;">
      <tr>
        <td style="background-color: #2563eb; border-radius: 6px;">
          <a href="${url}" style="display: inline-block; padding: 14px 28px; color: #ffffff; text-decoration: none; font-weight: 600; font-size: 16px;">
            ${text}
          </a>
        </td>
      </tr>
    </table>
  `;
}

const limit80Template = {
  templateType: 'conversion',
  templateKey: 'limit_80_percent',
  name: 'FREE User 80% Quota Warning',
  description:
    'Email sent to FREE users when they reach 80% of their monthly quota',
  triggerDays: 0,
  enabled: false,
  content: {
    en: {
      subject: "⚠️ You've used 80% of your monthly PDFs",
      body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; line-height: 1.6;">
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Hi {displayName}!</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          You've used <strong>80%</strong> of your monthly PDF quota. Here's your current usage:
        </p>
        ${progressBarTemplate()}
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          To keep converting without interruption, consider upgrading to ZPLPDF Pro:
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li><strong>500 PDFs/month</strong> instead of 25</li>
          <li><strong>500 labels/PDF</strong> instead of 100</li>
          <li>Batch processing & image export</li>
        </ul>
        ${ctaButtonTemplate('View Plans', 'https://zplpdf.com/pricing')}
        <p style="margin-top: 24px; color: #6b7280; font-size: 14px;">Best,<br>The ZPLPDF Team</p>
      </div>`,
    },
    es: {
      subject: '⚠️ Has usado el 80% de tus PDFs mensuales',
      body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; line-height: 1.6;">
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">¡Hola {displayName}!</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Has usado el <strong>80%</strong> de tu cuota mensual de PDFs. Aquí está tu uso actual:
        </p>
        ${progressBarTemplate()}
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Para seguir convirtiendo sin interrupciones, considera actualizar a ZPLPDF Pro:
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li><strong>500 PDFs/mes</strong> en lugar de 25</li>
          <li><strong>500 etiquetas/PDF</strong> en lugar de 100</li>
          <li>Procesamiento por lotes y exportación de imágenes</li>
        </ul>
        ${ctaButtonTemplate('Ver Planes', 'https://zplpdf.com/pricing')}
        <p style="margin-top: 24px; color: #6b7280; font-size: 14px;">Saludos,<br>El Equipo de ZPLPDF</p>
      </div>`,
    },
    zh: {
      subject: '⚠️ 您已使用本月PDF配额的80%',
      body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; line-height: 1.6;">
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">您好 {displayName}！</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          您已使用本月PDF配额的<strong>80%</strong>。以下是您的当前使用情况：
        </p>
        ${progressBarTemplate()}
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          要继续不间断地转换，请考虑升级到ZPLPDF Pro：
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li><strong>每月500个PDF</strong>而不是25个</li>
          <li><strong>每个PDF 500个标签</strong>而不是100个</li>
          <li>批量处理和图像导出</li>
        </ul>
        ${ctaButtonTemplate('查看计划', 'https://zplpdf.com/pricing')}
        <p style="margin-top: 24px; color: #6b7280; font-size: 14px;">祝好，<br>ZPLPDF团队</p>
      </div>`,
    },
    pt: {
      subject: '⚠️ Você usou 80% dos seus PDFs mensais',
      body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; line-height: 1.6;">
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Oi {displayName}!</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Você usou <strong>80%</strong> da sua cota mensal de PDFs. Aqui está seu uso atual:
        </p>
        ${progressBarTemplate()}
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Para continuar convertendo sem interrupção, considere atualizar para o ZPLPDF Pro:
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li><strong>500 PDFs/mês</strong> em vez de 25</li>
          <li><strong>500 etiquetas/PDF</strong> em vez de 100</li>
          <li>Processamento em lote e exportação de imagens</li>
        </ul>
        ${ctaButtonTemplate('Ver Planos', 'https://zplpdf.com/pricing')}
        <p style="margin-top: 24px; color: #6b7280; font-size: 14px;">Abraços,<br>A Equipe ZPLPDF</p>
      </div>`,
    },
  },
  variables: [
    'displayName',
    'userName',
    'pdfsUsed',
    'limit',
    'periodEnd',
    'upgradeUrl',
  ],
  version: 1,
};

const limit100Template = {
  templateType: 'conversion',
  templateKey: 'limit_100_percent',
  name: 'FREE User 100% Quota Reached',
  description:
    'Email sent to FREE users when they reach 100% of their monthly quota',
  triggerDays: 0,
  enabled: false,
  content: {
    en: {
      subject: "🚨 You've reached your monthly limit - Get 20% OFF",
      body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; line-height: 1.6;">
        <h2 style="margin: 0 0 16px; color: #dc2626; font-size: 24px;">🚨 Monthly Limit Reached</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi {displayName}, you've reached your monthly limit of {limit} PDFs.
        </p>
        ${progressBar100Template()}
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>Good news!</strong> Use code <span style="background-color: #fef3c7; padding: 4px 8px; border-radius: 4px; font-weight: 700; color: #92400e;">{discountCode}</span> to get <strong>20% OFF</strong> your first month of Pro.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          With Pro, you'll get:
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>500 PDFs/month (20x more)</li>
          <li>500 labels per PDF (5x more)</li>
          <li>Batch processing</li>
          <li>Image export (PNG/JPEG)</li>
        </ul>
        ${ctaButtonTemplate('Get 20% OFF Now', 'https://zplpdf.com/pricing?code=UPGRADE20')}
        <p style="margin-top: 24px; color: #6b7280; font-size: 14px;">Best,<br>The ZPLPDF Team</p>
      </div>`,
    },
    es: {
      subject: '🚨 Has alcanzado tu límite mensual - Obtén 20% OFF',
      body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; line-height: 1.6;">
        <h2 style="margin: 0 0 16px; color: #dc2626; font-size: 24px;">🚨 Límite Mensual Alcanzado</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola {displayName}, has alcanzado tu límite mensual de {limit} PDFs.
        </p>
        ${progressBar100Template()}
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>¡Buenas noticias!</strong> Usa el código <span style="background-color: #fef3c7; padding: 4px 8px; border-radius: 4px; font-weight: 700; color: #92400e;">{discountCode}</span> para obtener <strong>20% OFF</strong> en tu primer mes de Pro.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Con Pro, obtendrás:
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>500 PDFs/mes (20x más)</li>
          <li>500 etiquetas por PDF (5x más)</li>
          <li>Procesamiento por lotes</li>
          <li>Exportación de imágenes (PNG/JPEG)</li>
        </ul>
        ${ctaButtonTemplate('Obtener 20% OFF Ahora', 'https://zplpdf.com/pricing?code=UPGRADE20')}
        <p style="margin-top: 24px; color: #6b7280; font-size: 14px;">Saludos,<br>El Equipo de ZPLPDF</p>
      </div>`,
    },
    zh: {
      subject: '🚨 您已达到月度限制 - 享受8折优惠',
      body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; line-height: 1.6;">
        <h2 style="margin: 0 0 16px; color: #dc2626; font-size: 24px;">🚨 月度限制已达到</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          您好 {displayName}，您已达到每月{limit}个PDF的限制。
        </p>
        ${progressBar100Template()}
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>好消息！</strong>使用代码 <span style="background-color: #fef3c7; padding: 4px 8px; border-radius: 4px; font-weight: 700; color: #92400e;">{discountCode}</span> 获得Pro首月<strong>8折优惠</strong>。
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          使用Pro，您将获得：
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>每月500个PDF（多20倍）</li>
          <li>每个PDF 500个标签（多5倍）</li>
          <li>批量处理</li>
          <li>图像导出（PNG/JPEG）</li>
        </ul>
        ${ctaButtonTemplate('立即获得8折优惠', 'https://zplpdf.com/pricing?code=UPGRADE20')}
        <p style="margin-top: 24px; color: #6b7280; font-size: 14px;">祝好，<br>ZPLPDF团队</p>
      </div>`,
    },
    pt: {
      subject: '🚨 Você atingiu seu limite mensal - Ganhe 20% OFF',
      body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; line-height: 1.6;">
        <h2 style="margin: 0 0 16px; color: #dc2626; font-size: 24px;">🚨 Limite Mensal Atingido</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi {displayName}, você atingiu seu limite mensal de {limit} PDFs.
        </p>
        ${progressBar100Template()}
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>Boas notícias!</strong> Use o código <span style="background-color: #fef3c7; padding: 4px 8px; border-radius: 4px; font-weight: 700; color: #92400e;">{discountCode}</span> para ganhar <strong>20% OFF</strong> no seu primeiro mês de Pro.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Com o Pro, você terá:
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>500 PDFs/mês (20x mais)</li>
          <li>500 etiquetas por PDF (5x mais)</li>
          <li>Processamento em lote</li>
          <li>Exportação de imagens (PNG/JPEG)</li>
        </ul>
        ${ctaButtonTemplate('Ganhe 20% OFF Agora', 'https://zplpdf.com/pricing?code=UPGRADE20')}
        <p style="margin-top: 24px; color: #6b7280; font-size: 14px;">Abraços,<br>A Equipe ZPLPDF</p>
      </div>`,
    },
  },
  variables: [
    'displayName',
    'userName',
    'pdfsUsed',
    'limit',
    'periodEnd',
    'discountCode',
    'upgradeUrl',
  ],
  version: 1,
};

async function migrateTemplates() {
  const now = new Date();

  console.log('Starting migration of limit email templates...\n');

  // Check if templates already exist
  const limit80Snapshot = await firestore
    .collection(EMAIL_TEMPLATES_COLLECTION)
    .where('templateKey', '==', 'limit_80_percent')
    .get();

  const limit100Snapshot = await firestore
    .collection(EMAIL_TEMPLATES_COLLECTION)
    .where('templateKey', '==', 'limit_100_percent')
    .get();

  // Create limit_80_percent template
  if (limit80Snapshot.empty) {
    const docRef = await firestore.collection(EMAIL_TEMPLATES_COLLECTION).add({
      ...limit80Template,
      createdAt: now,
      updatedAt: now,
      updatedBy: 'migration-script',
    });
    console.log(`✓ Created limit_80_percent template with ID: ${docRef.id}`);
  } else {
    console.log(
      `⚠ limit_80_percent template already exists (ID: ${limit80Snapshot.docs[0].id})`,
    );
  }

  // Create limit_100_percent template
  if (limit100Snapshot.empty) {
    const docRef = await firestore.collection(EMAIL_TEMPLATES_COLLECTION).add({
      ...limit100Template,
      createdAt: now,
      updatedAt: now,
      updatedBy: 'migration-script',
    });
    console.log(`✓ Created limit_100_percent template with ID: ${docRef.id}`);
  } else {
    console.log(
      `⚠ limit_100_percent template already exists (ID: ${limit100Snapshot.docs[0].id})`,
    );
  }

  console.log('\nMigration completed!');
  console.log(
    '\nNote: Templates are created with enabled=false. Use the frontend admin panel to enable them.',
  );
}

migrateTemplates()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
