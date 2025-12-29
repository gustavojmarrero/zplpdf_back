import type { EmailType, AbVariant, EmailLanguage, EmailContent } from '../interfaces/email.interface.js';

interface TemplateData {
  displayName: string;
  email: string;
  pdfCount?: number;
}

// Subject lines for each email type and variant
const SUBJECTS: Record<EmailType, Record<AbVariant, Record<EmailLanguage, string>>> = {
  welcome: {
    A: {
      en: 'Welcome to ZPLPDF!',
      es: '¡Bienvenido a ZPLPDF!',
      zh: '欢迎使用ZPLPDF！',
    },
    B: {
      en: 'Your ZPL journey starts now',
      es: 'Tu viaje ZPL comienza ahora',
      zh: '您的ZPL之旅现在开始',
    },
  },
  tutorial: {
    A: {
      en: 'Quick Tutorial: Convert your first ZPL',
      es: 'Tutorial rápido: Convierte tu primer ZPL',
      zh: '快速教程：转换您的第一个ZPL',
    },
    B: {
      en: 'See ZPL to PDF in action',
      es: 'Ve ZPL a PDF en acción',
      zh: '查看ZPL转PDF的实际操作',
    },
  },
  help: {
    A: {
      en: 'Need help with ZPLPDF?',
      es: '¿Necesitas ayuda con ZPLPDF?',
      zh: '需要ZPLPDF的帮助吗？',
    },
    B: {
      en: "We noticed you haven't converted yet",
      es: 'Notamos que aún no has convertido',
      zh: '我们注意到您还没有转换',
    },
  },
  success_story: {
    A: {
      en: 'How businesses use ZPLPDF',
      es: 'Cómo las empresas usan ZPLPDF',
      zh: '企业如何使用ZPLPDF',
    },
    B: {
      en: "You're doing great!",
      es: '¡Lo estás haciendo genial!',
      zh: '你做得很棒！',
    },
  },
  miss_you: {
    A: {
      en: 'We miss you at ZPLPDF',
      es: 'Te extrañamos en ZPLPDF',
      zh: '我们在ZPLPDF想念你',
    },
    B: {
      en: 'Still struggling with ZPL?',
      es: '¿Aún tienes problemas con ZPL?',
      zh: '还在为ZPL烦恼吗？',
    },
  },
};

// Base HTML template with consistent styling
function baseTemplate(content: string, language: EmailLanguage): string {
  const footer = {
    en: 'You received this email because you signed up for ZPLPDF. If you no longer wish to receive these emails, you can unsubscribe at any time.',
    es: 'Recibiste este correo porque te registraste en ZPLPDF. Si ya no deseas recibir estos correos, puedes darte de baja en cualquier momento.',
    zh: '您收到此邮件是因为您注册了ZPLPDF。如果您不希望收到这些邮件，可以随时取消订阅。',
  };

  return `
<!DOCTYPE html>
<html lang="${language}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ZPLPDF</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="padding: 32px 40px; background-color: #2563eb; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 700;">ZPLPDF</h1>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              ${content}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding: 24px 40px; background-color: #f9fafb; border-top: 1px solid #e5e7eb;">
              <p style="margin: 0; color: #6b7280; font-size: 12px; line-height: 1.5; text-align: center;">
                ${footer[language]}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;
}

// CTA button component
function ctaButton(text: string, url: string): string {
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

// Welcome email templates
function getWelcomeContent(variant: AbVariant, lang: EmailLanguage, data: TemplateData): string {
  const appUrl = 'https://zplpdf.com';

  const content = {
    A: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Hi ${data.displayName}!</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Welcome to ZPLPDF! We're excited to have you on board.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          ZPLPDF is the easiest way to convert your ZPL files to PDF. Whether you're working with shipping labels,
          barcodes, or any ZPL content, we've got you covered.
        </p>
        <p style="margin: 0 0 24px; color: #374151; font-size: 16px; line-height: 1.6;">
          Ready to get started? Click the button below to convert your first ZPL file:
        </p>
        ${ctaButton('Start Converting', appUrl)}
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">¡Hola ${data.displayName}!</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          ¡Bienvenido a ZPLPDF! Estamos emocionados de tenerte con nosotros.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          ZPLPDF es la forma más fácil de convertir tus archivos ZPL a PDF. Ya sea que trabajes con etiquetas de envío,
          códigos de barras o cualquier contenido ZPL, te tenemos cubierto.
        </p>
        <p style="margin: 0 0 24px; color: #374151; font-size: 16px; line-height: 1.6;">
          ¿Listo para empezar? Haz clic en el botón de abajo para convertir tu primer archivo ZPL:
        </p>
        ${ctaButton('Comenzar a Convertir', appUrl)}
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">你好 ${data.displayName}！</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          欢迎使用ZPLPDF！我们很高兴您的加入。
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          ZPLPDF是将ZPL文件转换为PDF的最简单方法。无论您处理的是运输标签、条形码还是任何ZPL内容，我们都能满足您的需求。
        </p>
        <p style="margin: 0 0 24px; color: #374151; font-size: 16px; line-height: 1.6;">
          准备好开始了吗？点击下面的按钮转换您的第一个ZPL文件：
        </p>
        ${ctaButton('开始转换', appUrl)}
      `,
    },
    B: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Your ZPL journey begins!</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hey ${data.displayName}, thanks for joining ZPLPDF!
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          You now have access to the fastest ZPL to PDF converter on the web. No installations, no complicated setup –
          just paste your ZPL code and get your PDF in seconds.
        </p>
        ${ctaButton('Try It Now', appUrl)}
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">¡Tu viaje ZPL comienza!</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${data.displayName}, ¡gracias por unirte a ZPLPDF!
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Ahora tienes acceso al convertidor de ZPL a PDF más rápido de la web. Sin instalaciones, sin configuraciones
          complicadas – solo pega tu código ZPL y obtén tu PDF en segundos.
        </p>
        ${ctaButton('Pruébalo Ahora', appUrl)}
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">您的ZPL之旅开始了！</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          嗨 ${data.displayName}，感谢您加入ZPLPDF！
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          您现在可以使用网络上最快的ZPL转PDF转换器。无需安装，无需复杂设置 - 只需粘贴您的ZPL代码，几秒钟内即可获得PDF。
        </p>
        ${ctaButton('立即尝试', appUrl)}
      `,
    },
  };

  return content[variant][lang];
}

// Tutorial email templates
function getTutorialContent(variant: AbVariant, lang: EmailLanguage, data: TemplateData): string {
  const appUrl = 'https://zplpdf.com';

  const content = {
    A: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Quick Tutorial</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${data.displayName}, we noticed you haven't tried converting a ZPL file yet. Here's a quick guide to get you started:
        </p>
        <ol style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>Paste your ZPL code in the editor</li>
          <li>Select your label size (4x6, 4x4, etc.)</li>
          <li>Click "Convert" and download your PDF</li>
        </ol>
        <p style="margin: 0 0 24px; color: #374151; font-size: 16px; line-height: 1.6;">
          It's that simple! Try it now:
        </p>
        ${ctaButton('Convert Your First ZPL', appUrl)}
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Tutorial Rápido</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${data.displayName}, notamos que aún no has probado convertir un archivo ZPL. Aquí tienes una guía rápida para comenzar:
        </p>
        <ol style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>Pega tu código ZPL en el editor</li>
          <li>Selecciona el tamaño de tu etiqueta (4x6, 4x4, etc.)</li>
          <li>Haz clic en "Convertir" y descarga tu PDF</li>
        </ol>
        <p style="margin: 0 0 24px; color: #374151; font-size: 16px; line-height: 1.6;">
          ¡Es así de simple! Pruébalo ahora:
        </p>
        ${ctaButton('Convierte Tu Primer ZPL', appUrl)}
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">快速教程</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          嗨 ${data.displayName}，我们注意到您还没有尝试转换ZPL文件。以下是快速入门指南：
        </p>
        <ol style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>将您的ZPL代码粘贴到编辑器中</li>
          <li>选择标签尺寸（4x6、4x4等）</li>
          <li>点击"转换"并下载您的PDF</li>
        </ol>
        <p style="margin: 0 0 24px; color: #374151; font-size: 16px; line-height: 1.6;">
          就是这么简单！现在就试试：
        </p>
        ${ctaButton('转换您的第一个ZPL', appUrl)}
      `,
    },
    B: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">See ZPLPDF in Action</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hey ${data.displayName}! Want to see how easy it is to convert ZPL to PDF?
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Just paste your ZPL code and watch the magic happen. Our converter handles shipping labels,
          barcodes, and complex layouts with ease.
        </p>
        ${ctaButton('Watch the Magic', appUrl)}
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Ve ZPLPDF en Acción</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          ¡Hola ${data.displayName}! ¿Quieres ver lo fácil que es convertir ZPL a PDF?
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Solo pega tu código ZPL y observa la magia. Nuestro convertidor maneja etiquetas de envío,
          códigos de barras y diseños complejos con facilidad.
        </p>
        ${ctaButton('Ve la Magia', appUrl)}
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">查看ZPLPDF的实际效果</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          嗨 ${data.displayName}！想看看将ZPL转换为PDF有多简单吗？
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          只需粘贴您的ZPL代码，见证奇迹发生。我们的转换器可以轻松处理运输标签、条形码和复杂布局。
        </p>
        ${ctaButton('见证奇迹', appUrl)}
      `,
    },
  };

  return content[variant][lang];
}

// Help email templates
function getHelpContent(variant: AbVariant, lang: EmailLanguage, data: TemplateData): string {
  const appUrl = 'https://zplpdf.com';
  const docsUrl = 'https://zplpdf.com/docs';

  const content = {
    A: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Need Help?</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${data.displayName}, we noticed you haven't converted any ZPL files yet. Is there anything we can help with?
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Common questions we can help with:
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>How to format ZPL code correctly</li>
          <li>Choosing the right label size</li>
          <li>Handling multiple labels in one file</li>
        </ul>
        ${ctaButton('Check Our Docs', docsUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          Or just reply to this email – we're happy to help!
        </p>
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">¿Necesitas Ayuda?</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${data.displayName}, notamos que aún no has convertido ningún archivo ZPL. ¿Hay algo en lo que podamos ayudarte?
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Preguntas comunes con las que podemos ayudar:
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>Cómo formatear el código ZPL correctamente</li>
          <li>Elegir el tamaño de etiqueta correcto</li>
          <li>Manejar múltiples etiquetas en un archivo</li>
        </ul>
        ${ctaButton('Ver Documentación', docsUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          O simplemente responde a este correo – ¡estaremos encantados de ayudar!
        </p>
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">需要帮助吗？</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          嗨 ${data.displayName}，我们注意到您还没有转换任何ZPL文件。有什么我们可以帮助的吗？
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          我们可以帮助解答的常见问题：
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>如何正确格式化ZPL代码</li>
          <li>选择正确的标签尺寸</li>
          <li>在一个文件中处理多个标签</li>
        </ul>
        ${ctaButton('查看文档', docsUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          或者直接回复这封邮件 - 我们很乐意帮助！
        </p>
      `,
    },
    B: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Having Trouble?</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${data.displayName}, we noticed you signed up but haven't converted any files yet. Don't worry – we're here to help!
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Getting started is easy. Just paste your ZPL code and click convert. If you're having any issues,
          our documentation has answers to most common questions.
        </p>
        ${ctaButton('Get Started', appUrl)}
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">¿Tienes Problemas?</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${data.displayName}, notamos que te registraste pero aún no has convertido ningún archivo. ¡No te preocupes – estamos aquí para ayudar!
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Comenzar es fácil. Solo pega tu código ZPL y haz clic en convertir. Si tienes algún problema,
          nuestra documentación tiene respuestas a las preguntas más comunes.
        </p>
        ${ctaButton('Comenzar', appUrl)}
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">遇到问题了吗？</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          嗨 ${data.displayName}，我们注意到您注册了但还没有转换任何文件。别担心 - 我们随时为您提供帮助！
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          入门很简单。只需粘贴您的ZPL代码并点击转换。如果您遇到任何问题，我们的文档有大多数常见问题的答案。
        </p>
        ${ctaButton('开始使用', appUrl)}
      `,
    },
  };

  return content[variant][lang];
}

// Success story email templates
function getSuccessStoryContent(variant: AbVariant, lang: EmailLanguage, data: TemplateData): string {
  const pricingUrl = 'https://zplpdf.com/pricing';

  const content = {
    A: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">How Businesses Use ZPLPDF</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${data.displayName}, great job on your conversions! You've already converted ${data.pdfCount || 'several'} PDFs.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Did you know that businesses use ZPLPDF Pro to:
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>Convert up to 500 PDFs per month</li>
          <li>Process up to 500 labels per PDF</li>
          <li>Batch convert multiple files at once</li>
          <li>Export to PNG and JPEG formats</li>
        </ul>
        ${ctaButton('Upgrade to Pro', pricingUrl)}
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Cómo las Empresas Usan ZPLPDF</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${data.displayName}, ¡excelente trabajo con tus conversiones! Ya has convertido ${data.pdfCount || 'varios'} PDFs.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          ¿Sabías que las empresas usan ZPLPDF Pro para:
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>Convertir hasta 500 PDFs por mes</li>
          <li>Procesar hasta 500 etiquetas por PDF</li>
          <li>Convertir múltiples archivos a la vez</li>
          <li>Exportar a formatos PNG y JPEG</li>
        </ul>
        ${ctaButton('Actualizar a Pro', pricingUrl)}
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">企业如何使用ZPLPDF</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          嗨 ${data.displayName}，您的转换做得很好！您已经转换了 ${data.pdfCount || '多个'} 个PDF。
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          您知道企业使用ZPLPDF Pro可以：
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>每月转换多达500个PDF</li>
          <li>每个PDF处理多达500个标签</li>
          <li>批量转换多个文件</li>
          <li>导出为PNG和JPEG格式</li>
        </ul>
        ${ctaButton('升级到Pro', pricingUrl)}
      `,
    },
    B: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">You're Doing Great!</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hey ${data.displayName}, we're impressed! You've already converted ${data.pdfCount || 'several'} PDFs with ZPLPDF.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Ready to take it to the next level? With ZPLPDF Pro, you get higher limits, batch processing,
          and image export capabilities.
        </p>
        ${ctaButton('Go Pro', pricingUrl)}
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">¡Lo Estás Haciendo Genial!</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${data.displayName}, ¡estamos impresionados! Ya has convertido ${data.pdfCount || 'varios'} PDFs con ZPLPDF.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          ¿Listo para llevarlo al siguiente nivel? Con ZPLPDF Pro, obtienes límites más altos, procesamiento por lotes
          y capacidades de exportación de imágenes.
        </p>
        ${ctaButton('Ir a Pro', pricingUrl)}
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">你做得很棒！</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          嗨 ${data.displayName}，我们印象深刻！您已经用ZPLPDF转换了 ${data.pdfCount || '多个'} 个PDF。
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          准备好更上一层楼了吗？使用ZPLPDF Pro，您可以获得更高的限制、批量处理和图像导出功能。
        </p>
        ${ctaButton('升级Pro', pricingUrl)}
      `,
    },
  };

  return content[variant][lang];
}

// Miss you email templates
function getMissYouContent(variant: AbVariant, lang: EmailLanguage, data: TemplateData): string {
  const appUrl = 'https://zplpdf.com';

  const content = {
    A: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">We Miss You!</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${data.displayName}, it's been a week since you signed up for ZPLPDF, but we haven't seen you around.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          We're here whenever you need to convert ZPL files. Just paste your code and get your PDF instantly –
          no complicated setup required.
        </p>
        ${ctaButton('Come Back & Convert', appUrl)}
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">¡Te Extrañamos!</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${data.displayName}, ha pasado una semana desde que te registraste en ZPLPDF, pero no te hemos visto por aquí.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Estamos aquí cuando necesites convertir archivos ZPL. Solo pega tu código y obtén tu PDF al instante –
          no se requiere configuración complicada.
        </p>
        ${ctaButton('Regresa y Convierte', appUrl)}
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">我们想念你！</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          嗨 ${data.displayName}，自从您注册ZPLPDF以来已经一周了，但我们还没有看到您。
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          我们随时在这里等您需要转换ZPL文件。只需粘贴您的代码，立即获取您的PDF - 无需复杂的设置。
        </p>
        ${ctaButton('回来转换吧', appUrl)}
      `,
    },
    B: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Still Struggling with ZPL?</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${data.displayName}, we know ZPL can be tricky. That's exactly why we built ZPLPDF – to make your life easier.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Whatever challenge you're facing with ZPL files, we're here to help. Give us another try – you might be
          surprised how easy it can be.
        </p>
        ${ctaButton('Give It Another Try', appUrl)}
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">¿Aún Tienes Problemas con ZPL?</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${data.displayName}, sabemos que ZPL puede ser complicado. Por eso exactamente creamos ZPLPDF – para hacerte la vida más fácil.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Cualquier desafío que enfrentes con archivos ZPL, estamos aquí para ayudar. Danos otra oportunidad – podrías
          sorprenderte de lo fácil que puede ser.
        </p>
        ${ctaButton('Inténtalo de Nuevo', appUrl)}
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">还在为ZPL烦恼吗？</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          嗨 ${data.displayName}，我们知道ZPL可能很棘手。这正是我们创建ZPLPDF的原因 - 让您的生活更轻松。
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          无论您在ZPL文件方面遇到什么挑战，我们都在这里帮助您。再试一次 - 您可能会惊讶于它有多简单。
        </p>
        ${ctaButton('再试一次', appUrl)}
      `,
    },
  };

  return content[variant][lang];
}

// Text version of emails (stripped HTML)
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Get email template for a specific type, variant, and language
 */
export function getEmailTemplate(
  emailType: EmailType,
  variant: AbVariant,
  language: EmailLanguage,
  data: TemplateData,
): EmailContent {
  const subject = SUBJECTS[emailType][variant][language];

  let content: string;

  switch (emailType) {
    case 'welcome':
      content = getWelcomeContent(variant, language, data);
      break;
    case 'tutorial':
      content = getTutorialContent(variant, language, data);
      break;
    case 'help':
      content = getHelpContent(variant, language, data);
      break;
    case 'success_story':
      content = getSuccessStoryContent(variant, language, data);
      break;
    case 'miss_you':
      content = getMissYouContent(variant, language, data);
      break;
    default:
      throw new Error(`Unknown email type: ${emailType}`);
  }

  const html = baseTemplate(content, language);
  const text = stripHtml(content);

  return { subject, html, text };
}
