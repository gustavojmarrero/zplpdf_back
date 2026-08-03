import type {
  EmailType,
  AbVariant,
  EmailLanguage,
  EmailContent,
} from '../interfaces/email.interface.js';

interface TemplateData {
  displayName: string;
  email: string;
  pdfCount?: number;
  // Limit email fields
  pdfsUsed?: number;
  limit?: number;
  periodEnd?: Date;
  discountCode?: string;
  projectedDaysToLimit?: number;
  avgPdfsPerDay?: number;
  // PRO Retention fields
  daysInactive?: number;
  lastActivityAt?: Date;
  pdfsThisMonth?: number;
  labelsThisMonth?: number;
  monthsAsPro?: number;
  // FREE Reactivation fields
  daysSinceRegistration?: number;
  pdfsAvailable?: number;
  labelCount?: number;
  // Payment notification fields
  attemptCount?: number;
  nextRetryDate?: string;
  previousPlan?: string;
  reason?: string;
}

// Subject lines for each email type and variant
const SUBJECTS: Record<
  EmailType,
  Record<AbVariant, Record<EmailLanguage, string>>
> = {
  welcome: {
    A: {
      en: 'Welcome to ZPLPDF!',
      es: '¡Bienvenido a ZPLPDF!',
      zh: '欢迎使用ZPLPDF！',
      pt: 'Bem-vindo ao ZPLPDF!',
    },
    B: {
      en: 'Your ZPL journey starts now',
      es: 'Tu viaje ZPL comienza ahora',
      zh: '您的ZPL之旅现在开始',
      pt: 'Sua jornada ZPL começa agora',
    },
  },
  tutorial: {
    A: {
      en: 'Quick Tutorial: Convert your first ZPL',
      es: 'Tutorial rápido: Convierte tu primer ZPL',
      zh: '快速教程：转换您的第一个ZPL',
      pt: 'Tutorial rápido: Converta seu primeiro ZPL',
    },
    B: {
      en: 'See ZPL to PDF in action',
      es: 'Ve ZPL a PDF en acción',
      zh: '查看ZPL转PDF的实际操作',
      pt: 'Veja ZPL para PDF em ação',
    },
  },
  help: {
    A: {
      en: 'Need help with ZPLPDF?',
      es: '¿Necesitas ayuda con ZPLPDF?',
      zh: '需要ZPLPDF的帮助吗？',
      pt: 'Precisa de ajuda com o ZPLPDF?',
    },
    B: {
      en: "We noticed you haven't converted yet",
      es: 'Notamos que aún no has convertido',
      zh: '我们注意到您还没有转换',
      pt: 'Notamos que você ainda não converteu',
    },
  },
  success_story: {
    A: {
      en: 'How businesses use ZPLPDF',
      es: 'Cómo las empresas usan ZPLPDF',
      zh: '企业如何使用ZPLPDF',
      pt: 'Como as empresas usam o ZPLPDF',
    },
    B: {
      en: "You're doing great!",
      es: '¡Lo estás haciendo genial!',
      zh: '你做得很棒！',
      pt: 'Você está indo muito bem!',
    },
  },
  miss_you: {
    A: {
      en: 'We miss you at ZPLPDF',
      es: 'Te extrañamos en ZPLPDF',
      zh: '我们在ZPLPDF想念你',
      pt: 'Sentimos sua falta no ZPLPDF',
    },
    B: {
      en: 'Still struggling with ZPL?',
      es: '¿Aún tienes problemas con ZPL?',
      zh: '还在为ZPL烦恼吗？',
      pt: 'Ainda com dificuldades com ZPL?',
    },
  },
  // Conversion emails
  limit_80_percent: {
    A: {
      en: "⚠️ You've used 80% of your monthly PDFs",
      es: '⚠️ Has usado el 80% de tus PDFs mensuales',
      zh: '⚠️ 您已使用本月PDF配额的80%',
      pt: '⚠️ Você usou 80% dos seus PDFs mensais',
    },
    B: {
      en: '📊 Your monthly quota is almost full',
      es: '📊 Tu cuota mensual está casi llena',
      zh: '📊 您的月度配额即将用完',
      pt: '📊 Sua cota mensal está quase cheia',
    },
  },
  limit_100_percent: {
    A: {
      en: "🚨 You've reached your monthly limit - Get 20% OFF",
      es: '🚨 Has alcanzado tu límite mensual - Obtén 20% OFF',
      zh: '🚨 您已达到月度限制 - 享受8折优惠',
      pt: '🚨 Você atingiu seu limite mensal - Ganhe 20% OFF',
    },
    B: {
      en: 'Your quota is exhausted - Upgrade now!',
      es: 'Tu cuota está agotada - ¡Actualiza ahora!',
      zh: '您的配额已用完 - 立即升级！',
      pt: 'Sua cota esgotou - Atualize agora!',
    },
  },
  conversion_blocked: {
    A: {
      en: 'Unlock your access now - 20% OFF',
      es: 'Desbloquea tu acceso ahora - 20% OFF',
      zh: '立即解锁您的访问权限 - 8折优惠',
      pt: 'Desbloqueie seu acesso agora - 20% OFF',
    },
    B: {
      en: 'Continue working with ZPLPDF Pro',
      es: 'Continúa trabajando con ZPLPDF Pro',
      zh: '继续使用ZPLPDF Pro',
      pt: 'Continue trabalhando com ZPLPDF Pro',
    },
  },
  high_usage: {
    A: {
      en: '🚀 Your business is growing fast!',
      es: '🚀 ¡Tu negocio está creciendo rápido!',
      zh: '🚀 您的业务正在快速增长！',
      pt: '🚀 Seu negócio está crescendo rápido!',
    },
    B: {
      en: "Projection: You'll run out of quota soon",
      es: 'Proyección: Agotarás tu cuota pronto',
      zh: '预测：您的配额即将用完',
      pt: 'Projeção: Você esgotará sua cota em breve',
    },
  },
  // PRO Retention emails
  pro_inactive_7_days: {
    A: {
      en: '👋 {name}, your PRO account misses you',
      es: '👋 {name}, tu cuenta PRO te extraña',
      zh: '👋 {name}，您的PRO账户想念您',
      pt: '👋 {name}, sua conta PRO sente sua falta',
    },
    B: {
      en: 'Your PRO benefits are waiting for you',
      es: 'Tus beneficios PRO te están esperando',
      zh: '您的PRO权益正在等您',
      pt: 'Seus benefícios PRO estão esperando por você',
    },
  },
  pro_inactive_14_days: {
    A: {
      en: '{name}, can we help you? 🤝',
      es: '{name}, ¿podemos ayudarte? 🤝',
      zh: '{name}，我们能帮到您吗？🤝',
      pt: '{name}, podemos ajudá-lo? 🤝',
    },
    B: {
      en: "We'd love to hear from you",
      es: 'Nos encantaría saber de ti',
      zh: '我们很想听听您的意见',
      pt: 'Adoraríamos ouvir você',
    },
  },
  pro_inactive_30_days: {
    A: {
      en: '{name}, we want to hear from you',
      es: '{name}, queremos saber de ti',
      zh: '{name}，我们想了解您的情况',
      pt: '{name}, queremos ouvir você',
    },
    B: {
      en: 'Your feedback matters to us',
      es: 'Tu opinión es importante para nosotros',
      zh: '您的反馈对我们很重要',
      pt: 'Sua opinião é importante para nós',
    },
  },
  pro_power_user: {
    A: {
      en: '🌟 {name}, you are amazing!',
      es: '🌟 {name}, ¡eres increíble!',
      zh: '🌟 {name}，您太棒了！',
      pt: '🌟 {name}, você é incrível!',
    },
    B: {
      en: 'Thank you for being a power user',
      es: 'Gracias por ser un power user',
      zh: '感谢您成为超级用户',
      pt: 'Obrigado por ser um power user',
    },
  },
  // FREE Reactivation emails
  free_never_used_7d: {
    A: {
      en: '{name}, your ZPLPDF account is waiting',
      es: '{name}, tu cuenta ZPLPDF te espera',
      zh: '{name}，您的ZPLPDF账户在等您',
      pt: '{name}, sua conta ZPLPDF está esperando',
    },
    B: {
      en: '🏷️ Create your first label in 30 seconds',
      es: '🏷️ Crea tu primera etiqueta en 30 segundos',
      zh: '🏷️ 30秒内创建您的第一个标签',
      pt: '🏷️ Crie sua primeira etiqueta em 30 segundos',
    },
  },
  free_never_used_14d: {
    A: {
      en: '⏰ {name}, last call',
      es: '⏰ {name}, última llamada',
      zh: '⏰ {name}，最后提醒',
      pt: '⏰ {name}, última chamada',
    },
    B: {
      en: 'Need help getting started?',
      es: '¿Necesitas ayuda para empezar?',
      zh: '需要帮助开始吗？',
      pt: 'Precisa de ajuda para começar?',
    },
  },
  free_tried_abandoned: {
    A: {
      en: '{name}, we saw you started creating labels...',
      es: '{name}, vimos que empezaste a crear etiquetas...',
      zh: '{name}，我们看到您开始创建标签了...',
      pt: '{name}, vimos que você começou a criar etiquetas...',
    },
    B: {
      en: 'How was your experience?',
      es: '¿Cómo fue tu experiencia?',
      zh: '您的体验如何？',
      pt: 'Como foi sua experiência?',
    },
  },
  free_dormant_30d: {
    A: {
      en: '{name}, did you find what you were looking for?',
      es: '{name}, ¿encontraste lo que buscabas?',
      zh: '{name}，您找到需要的了吗？',
      pt: '{name}, você encontrou o que procurava?',
    },
    B: {
      en: "We'd love your feedback",
      es: 'Nos encantaría saber tu opinión',
      zh: '我们很想听听您的反馈',
      pt: 'Adoraríamos seu feedback',
    },
  },
  free_abandoned_60d: {
    A: {
      en: '💔 {name}, we miss you',
      es: '💔 {name}, te extrañamos',
      zh: '💔 {name}，我们想念您',
      pt: '💔 {name}, sentimos sua falta',
    },
    B: {
      en: 'A lot has changed at ZPLPDF',
      es: 'Mucho ha cambiado en ZPLPDF',
      zh: 'ZPLPDF有很多变化',
      pt: 'Muita coisa mudou no ZPLPDF',
    },
  },
  payment_failed: {
    A: {
      en: '⚠️ Payment failed - Action required',
      es: '⚠️ Pago fallido - Acción requerida',
      zh: '⚠️ 付款失败 - 需要采取行动',
      pt: '⚠️ Pagamento falhou - Ação necessária',
    },
    B: {
      en: 'Your ZPLPDF subscription needs attention',
      es: 'Tu suscripción a ZPLPDF necesita atención',
      zh: '您的ZPLPDF订阅需要关注',
      pt: 'Sua assinatura ZPLPDF precisa de atenção',
    },
  },
  subscription_downgraded: {
    A: {
      en: '📋 Your ZPLPDF plan has changed',
      es: '📋 Tu plan de ZPLPDF ha cambiado',
      zh: '📋 您的ZPLPDF计划已更改',
      pt: '📋 Seu plano ZPLPDF foi alterado',
    },
    B: {
      en: 'Important update about your ZPLPDF account',
      es: 'Actualización importante sobre tu cuenta ZPLPDF',
      zh: '关于您ZPLPDF账户的重要更新',
      pt: 'Atualização importante sobre sua conta ZPLPDF',
    },
  },
};

// Base HTML template with consistent styling
function baseTemplate(content: string, language: EmailLanguage): string {
  const footer = {
    en: 'You received this email because you signed up for ZPLPDF. If you no longer wish to receive these emails, you can unsubscribe at any time.',
    es: 'Recibiste este correo porque te registraste en ZPLPDF. Si ya no deseas recibir estos correos, puedes darte de baja en cualquier momento.',
    zh: '您收到此邮件是因为您注册了ZPLPDF。如果您不希望收到这些邮件，可以随时取消订阅。',
    pt: 'Você recebeu este e-mail porque se cadastrou no ZPLPDF. Se não deseja mais receber estes e-mails, pode cancelar a inscrição a qualquer momento.',
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
function getWelcomeContent(
  variant: AbVariant,
  lang: EmailLanguage,
  data: TemplateData,
): string {
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
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Olá ${data.displayName}!</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Bem-vindo ao ZPLPDF! Estamos muito felizes em tê-lo conosco.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          O ZPLPDF é a forma mais fácil de converter seus arquivos ZPL para PDF. Seja trabalhando com etiquetas de envio,
          códigos de barras ou qualquer conteúdo ZPL, nós temos você coberto.
        </p>
        <p style="margin: 0 0 24px; color: #374151; font-size: 16px; line-height: 1.6;">
          Pronto para começar? Clique no botão abaixo para converter seu primeiro arquivo ZPL:
        </p>
        ${ctaButton('Começar a Converter', appUrl)}
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
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Sua jornada ZPL começa!</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Olá ${data.displayName}, obrigado por se juntar ao ZPLPDF!
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Agora você tem acesso ao conversor de ZPL para PDF mais rápido da web. Sem instalações, sem configurações
          complicadas – apenas cole seu código ZPL e obtenha seu PDF em segundos.
        </p>
        ${ctaButton('Experimente Agora', appUrl)}
      `,
    },
  };

  return content[variant][lang];
}

// Tutorial email templates
function getTutorialContent(
  variant: AbVariant,
  lang: EmailLanguage,
  data: TemplateData,
): string {
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
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Tutorial Rápido</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Olá ${data.displayName}, notamos que você ainda não experimentou converter um arquivo ZPL. Aqui está um guia rápido para começar:
        </p>
        <ol style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>Cole seu código ZPL no editor</li>
          <li>Selecione o tamanho da etiqueta (4x6, 4x4, etc.)</li>
          <li>Clique em "Converter" e baixe seu PDF</li>
        </ol>
        <p style="margin: 0 0 24px; color: #374151; font-size: 16px; line-height: 1.6;">
          É simples assim! Experimente agora:
        </p>
        ${ctaButton('Converta Seu Primeiro ZPL', appUrl)}
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
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Veja o ZPLPDF em Ação</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Olá ${data.displayName}! Quer ver como é fácil converter ZPL para PDF?
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Basta colar seu código ZPL e ver a mágica acontecer. Nosso conversor lida com etiquetas de envio,
          códigos de barras e layouts complexos com facilidade.
        </p>
        ${ctaButton('Veja a Mágica', appUrl)}
      `,
    },
  };

  return content[variant][lang];
}

// Help email templates
function getHelpContent(
  variant: AbVariant,
  lang: EmailLanguage,
  data: TemplateData,
): string {
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
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Precisa de Ajuda?</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${data.displayName}, notamos que voce ainda nao converteu nenhum arquivo ZPL. Podemos ajudar com algo?
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Perguntas comuns com as quais podemos ajudar:
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>Como formatar o codigo ZPL corretamente</li>
          <li>Escolher o tamanho de etiqueta correto</li>
          <li>Lidar com multiplas etiquetas em um arquivo</li>
        </ul>
        ${ctaButton('Ver Documentacao', docsUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          Ou simplesmente responda este email - ficaremos felizes em ajudar!
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
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Tendo Problemas?</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${data.displayName}, notamos que voce se cadastrou mas ainda nao converteu nenhum arquivo. Nao se preocupe - estamos aqui para ajudar!
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Comecar e facil. Basta colar seu codigo ZPL e clicar em converter. Se tiver algum problema,
          nossa documentacao tem respostas para as perguntas mais comuns.
        </p>
        ${ctaButton('Comecar', appUrl)}
      `,
    },
  };

  return content[variant][lang];
}

// Success story email templates
function getSuccessStoryContent(
  variant: AbVariant,
  lang: EmailLanguage,
  data: TemplateData,
): string {
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
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Como Empresas Usam o ZPLPDF</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${data.displayName}, otimo trabalho com suas conversoes! Voce ja converteu ${data.pdfCount || 'varios'} PDFs.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Voce sabia que empresas usam o ZPLPDF Pro para:
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>Converter ate 500 PDFs por mes</li>
          <li>Processar ate 500 etiquetas por PDF</li>
          <li>Converter multiplos arquivos de uma vez</li>
          <li>Exportar para formatos PNG e JPEG</li>
        </ul>
        ${ctaButton('Atualizar para PRO', pricingUrl)}
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
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Voce Esta Mandando Bem!</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${data.displayName}, estamos impressionados! Voce ja converteu ${data.pdfCount || 'varios'} PDFs com o ZPLPDF.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Pronto para levar ao proximo nivel? Com o ZPLPDF Pro, voce obtem limites maiores, processamento em lote
          e recursos de exportacao de imagens.
        </p>
        ${ctaButton('Ir para Pro', pricingUrl)}
      `,
    },
  };

  return content[variant][lang];
}

// Miss you email templates
function getMissYouContent(
  variant: AbVariant,
  lang: EmailLanguage,
  data: TemplateData,
): string {
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
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Sentimos Sua Falta!</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${data.displayName}, ja faz uma semana desde que voce se cadastrou no ZPLPDF, mas ainda nao vimos voce por aqui.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Estamos aqui sempre que voce precisar converter arquivos ZPL. Basta colar seu codigo e obter seu PDF instantaneamente -
          nenhuma configuracao complicada necessaria.
        </p>
        ${ctaButton('Volte e Converta', appUrl)}
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
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Ainda com Dificuldades com ZPL?</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${data.displayName}, sabemos que ZPL pode ser complicado. E exatamente por isso que criamos o ZPLPDF - para facilitar sua vida.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Qualquer desafio que voce enfrente com arquivos ZPL, estamos aqui para ajudar. De outra chance - voce pode se surpreender com o quao facil pode ser.
        </p>
        ${ctaButton('Tente Novamente', appUrl)}
      `,
    },
  };

  return content[variant][lang];
}

// ============== Conversion Email Templates ==============

// Progress bar component for limit emails
function progressBar(used: number, limit: number): string {
  const percentage = Math.min((used / limit) * 100, 100);
  const usedWidth = Math.round(percentage);
  const isUrgent = percentage >= 100;
  const barColor = isUrgent
    ? '#dc2626'
    : percentage >= 80
      ? '#f59e0b'
      : '#2563eb';

  return `
    <table role="presentation" style="width: 100%; margin: 16px 0; border-collapse: collapse;">
      <tr>
        <td style="padding: 0;">
          <div style="background-color: #e5e7eb; border-radius: 9999px; overflow: hidden; height: 24px;">
            <div style="background-color: ${barColor}; width: ${usedWidth}%; height: 100%; border-radius: 9999px;"></div>
          </div>
        </td>
      </tr>
      <tr>
        <td style="padding: 8px 0 0; text-align: center;">
          <span style="color: ${barColor}; font-weight: 600; font-size: 18px;">${used}</span>
          <span style="color: #6b7280; font-size: 14px;"> / ${limit} PDFs</span>
        </td>
      </tr>
    </table>
  `;
}

// Limit 80% email templates
function getLimit80Content(
  variant: AbVariant,
  lang: EmailLanguage,
  data: TemplateData,
): string {
  const pricingUrl = 'https://zplpdf.com/pricing';
  const used = data.pdfsUsed || 0;
  const limit = data.limit || 25;

  const content = {
    A: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Hi ${data.displayName}!</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          You've used <strong>80%</strong> of your monthly PDF quota. Here's your current usage:
        </p>
        ${progressBar(used, limit)}
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          To keep converting without interruption, consider upgrading to ZPLPDF Pro:
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li><strong>500 PDFs/month</strong> instead of 25</li>
          <li><strong>500 labels/PDF</strong> instead of 100</li>
          <li>Batch processing & image export</li>
        </ul>
        ${ctaButton('View Plans', pricingUrl)}
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">¡Hola ${data.displayName}!</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Has usado el <strong>80%</strong> de tu cuota mensual de PDFs. Aquí está tu uso actual:
        </p>
        ${progressBar(used, limit)}
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Para seguir convirtiendo sin interrupciones, considera actualizar a ZPLPDF Pro:
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li><strong>500 PDFs/mes</strong> en lugar de 25</li>
          <li><strong>500 etiquetas/PDF</strong> en lugar de 100</li>
          <li>Procesamiento por lotes y exportación de imágenes</li>
        </ul>
        ${ctaButton('Ver Planes', pricingUrl)}
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">您好 ${data.displayName}！</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          您已使用本月PDF配额的<strong>80%</strong>。以下是您的当前使用情况：
        </p>
        ${progressBar(used, limit)}
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          要继续不间断地转换，请考虑升级到ZPLPDF Pro：
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li><strong>每月500个PDF</strong>而不是25个</li>
          <li><strong>每个PDF 500个标签</strong>而不是100个</li>
          <li>批量处理和图像导出</li>
        </ul>
        ${ctaButton('查看计划', pricingUrl)}
      `,
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Oi ${data.displayName}!</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Voce usou <strong>80%</strong> da sua cota mensal de PDFs. Aqui esta seu uso atual:
        </p>
        ${progressBar(used, limit)}
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Para continuar convertendo sem interrupcao, considere atualizar para o ZPLPDF Pro:
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li><strong>500 PDFs/mes</strong> em vez de 25</li>
          <li><strong>500 etiquetas/PDF</strong> em vez de 100</li>
          <li>Processamento em lote e exportacao de imagens</li>
        </ul>
        ${ctaButton('Ver Planos', pricingUrl)}
      `,
    },
    B: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Your quota is almost full</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${data.displayName}, you're doing great with ZPLPDF! You've already used ${used} of your ${limit} monthly PDFs.
        </p>
        ${progressBar(used, limit)}
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Upgrade now to Pro and get 20x more PDFs per month, plus batch processing and image export.
        </p>
        ${ctaButton('Upgrade to Pro', pricingUrl)}
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Tu cuota está casi llena</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${data.displayName}, ¡lo estás haciendo genial con ZPLPDF! Ya has usado ${used} de tus ${limit} PDFs mensuales.
        </p>
        ${progressBar(used, limit)}
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Actualiza ahora a Pro y obtén 20 veces más PDFs por mes, además de procesamiento por lotes y exportación de imágenes.
        </p>
        ${ctaButton('Actualizar a Pro', pricingUrl)}
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">您的配额即将用完</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          您好 ${data.displayName}，您在ZPLPDF上做得很好！您已经使用了${limit}个月度PDF中的${used}个。
        </p>
        ${progressBar(used, limit)}
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          立即升级到Pro，每月获得20倍更多的PDF，以及批量处理和图像导出功能。
        </p>
        ${ctaButton('升级到Pro', pricingUrl)}
      `,
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Sua cota esta quase cheia</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${data.displayName}, voce esta mandando bem com o ZPLPDF! Voce ja usou ${used} dos seus ${limit} PDFs mensais.
        </p>
        ${progressBar(used, limit)}
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Atualize agora para Pro e ganhe 20x mais PDFs por mes, alem de processamento em lote e exportacao de imagens.
        </p>
        ${ctaButton('Atualizar para PRO', pricingUrl)}
      `,
    },
  };

  return content[variant][lang];
}

// Limit 100% email templates
function getLimit100Content(
  variant: AbVariant,
  lang: EmailLanguage,
  data: TemplateData,
): string {
  const checkoutUrl = `https://zplpdf.com/pricing?code=${data.discountCode || 'UPGRADE20'}`;
  const used = data.pdfsUsed || 0;
  const limit = data.limit || 25;

  const content = {
    A: {
      en: `
        <h2 style="margin: 0 0 16px; color: #dc2626; font-size: 24px;">🚨 Monthly Limit Reached</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${data.displayName}, you've reached your monthly limit of ${limit} PDFs.
        </p>
        ${progressBar(used, limit)}
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>Good news!</strong> Use code <span style="background-color: #fef3c7; padding: 4px 8px; border-radius: 4px; font-weight: 700; color: #92400e;">${data.discountCode || 'UPGRADE20'}</span> to get <strong>20% OFF</strong> your first month of Pro.
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
        ${ctaButton('Get 20% OFF Now', checkoutUrl)}
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #dc2626; font-size: 24px;">🚨 Límite Mensual Alcanzado</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${data.displayName}, has alcanzado tu límite mensual de ${limit} PDFs.
        </p>
        ${progressBar(used, limit)}
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>¡Buenas noticias!</strong> Usa el código <span style="background-color: #fef3c7; padding: 4px 8px; border-radius: 4px; font-weight: 700; color: #92400e;">${data.discountCode || 'UPGRADE20'}</span> para obtener <strong>20% OFF</strong> en tu primer mes de Pro.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Con Pro, obtendrás:
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>500 PDFs/mes (20 veces más)</li>
          <li>500 etiquetas por PDF (5 veces más)</li>
          <li>Procesamiento por lotes</li>
          <li>Exportación de imágenes (PNG/JPEG)</li>
        </ul>
        ${ctaButton('Obtén 20% OFF Ahora', checkoutUrl)}
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #dc2626; font-size: 24px;">🚨 已达月度限制</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          您好 ${data.displayName}，您已达到每月${limit}个PDF的限制。
        </p>
        ${progressBar(used, limit)}
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>好消息！</strong>使用代码 <span style="background-color: #fef3c7; padding: 4px 8px; border-radius: 4px; font-weight: 700; color: #92400e;">${data.discountCode || 'UPGRADE20'}</span> 获得Pro首月<strong>8折优惠</strong>。
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          使用Pro，您将获得：
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>每月500个PDF（20倍）</li>
          <li>每个PDF 500个标签（5倍）</li>
          <li>批量处理</li>
          <li>图像导出（PNG/JPEG）</li>
        </ul>
        ${ctaButton('立即享受8折', checkoutUrl)}
      `,
      pt: `
        <h2 style="margin: 0 0 16px; color: #dc2626; font-size: 24px;">🚨 Limite Mensal Atingido</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${data.displayName}, voce atingiu seu limite mensal de ${limit} PDFs.
        </p>
        ${progressBar(used, limit)}
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>Boas noticias!</strong> Use o codigo <span style="background-color: #fef3c7; padding: 4px 8px; border-radius: 4px; font-weight: 700; color: #92400e;">${data.discountCode || 'UPGRADE20'}</span> para obter <strong>20% OFF</strong> no seu primeiro mes de Pro.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Com o Pro, voce tera:
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>500 PDFs/mes (20x mais)</li>
          <li>500 etiquetas por PDF (5x mais)</li>
          <li>Processamento em lote</li>
          <li>Exportacao de imagens (PNG/JPEG)</li>
        </ul>
        ${ctaButton('Ganhe 20% OFF Agora', checkoutUrl)}
      `,
    },
    B: {
      en: `
        <h2 style="margin: 0 0 16px; color: #dc2626; font-size: 24px;">Your quota is exhausted</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${data.displayName}, you've used all ${limit} PDFs for this month.
        </p>
        ${progressBar(used, limit)}
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Don't wait until next month! Upgrade now and continue working immediately.
        </p>
        ${ctaButton('Upgrade Now', checkoutUrl)}
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #dc2626; font-size: 24px;">Tu cuota está agotada</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${data.displayName}, has usado todos los ${limit} PDFs de este mes.
        </p>
        ${progressBar(used, limit)}
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          ¡No esperes hasta el próximo mes! Actualiza ahora y continúa trabajando inmediatamente.
        </p>
        ${ctaButton('Actualizar Ahora', checkoutUrl)}
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #dc2626; font-size: 24px;">您的配额已用完</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          您好 ${data.displayName}，您已使用完本月的全部${limit}个PDF。
        </p>
        ${progressBar(used, limit)}
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          不要等到下个月！立即升级，继续工作。
        </p>
        ${ctaButton('立即升级', checkoutUrl)}
      `,
      pt: `
        <h2 style="margin: 0 0 16px; color: #dc2626; font-size: 24px;">Sua cota esta esgotada</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${data.displayName}, voce usou todos os ${limit} PDFs deste mes.
        </p>
        ${progressBar(used, limit)}
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Nao espere ate o proximo mes! Atualize agora e continue trabalhando imediatamente.
        </p>
        ${ctaButton('Atualizar Agora', checkoutUrl)}
      `,
    },
  };

  return content[variant][lang];
}

// Conversion blocked email templates
function getBlockedContent(
  variant: AbVariant,
  lang: EmailLanguage,
  data: TemplateData,
): string {
  const checkoutUrl = `https://zplpdf.com/pricing?code=${data.discountCode || 'UPGRADE20'}`;

  const content = {
    A: {
      en: `
        <h2 style="margin: 0 0 16px; color: #dc2626; font-size: 24px;">Unlock Your Access Now</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${data.displayName}, we noticed you just tried to convert a ZPL file but you've reached your monthly limit.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>Upgrade now and continue working immediately.</strong> Use code <span style="background-color: #fef3c7; padding: 4px 8px; border-radius: 4px; font-weight: 700; color: #92400e;">${data.discountCode || 'UPGRADE20'}</span> for 20% OFF your first month.
        </p>
        ${ctaButton('Unlock Access - 20% OFF', checkoutUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          Your new limits will apply immediately after upgrading.
        </p>
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #dc2626; font-size: 24px;">Desbloquea Tu Acceso Ahora</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${data.displayName}, notamos que acabas de intentar convertir un archivo ZPL pero has alcanzado tu límite mensual.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>Actualiza ahora y continúa trabajando inmediatamente.</strong> Usa el código <span style="background-color: #fef3c7; padding: 4px 8px; border-radius: 4px; font-weight: 700; color: #92400e;">${data.discountCode || 'UPGRADE20'}</span> para 20% OFF en tu primer mes.
        </p>
        ${ctaButton('Desbloquear - 20% OFF', checkoutUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          Tus nuevos límites se aplicarán inmediatamente después de actualizar.
        </p>
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #dc2626; font-size: 24px;">立即解锁您的访问权限</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          您好 ${data.displayName}，我们注意到您刚刚尝试转换ZPL文件，但您已达到月度限制。
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>立即升级，继续工作。</strong>使用代码 <span style="background-color: #fef3c7; padding: 4px 8px; border-radius: 4px; font-weight: 700; color: #92400e;">${data.discountCode || 'UPGRADE20'}</span> 享受首月8折优惠。
        </p>
        ${ctaButton('解锁 - 8折优惠', checkoutUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          升级后，新限制将立即生效。
        </p>
      `,
      pt: `
        <h2 style="margin: 0 0 16px; color: #dc2626; font-size: 24px;">Desbloqueie Seu Acesso Agora</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${data.displayName}, notamos que voce acabou de tentar converter um arquivo ZPL mas atingiu seu limite mensal.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>Atualize agora e continue trabalhando imediatamente.</strong> Use o codigo <span style="background-color: #fef3c7; padding: 4px 8px; border-radius: 4px; font-weight: 700; color: #92400e;">${data.discountCode || 'UPGRADE20'}</span> para 20% OFF no seu primeiro mes.
        </p>
        ${ctaButton('Desbloquear - 20% OFF', checkoutUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          Seus novos limites serao aplicados imediatamente apos a atualizacao.
        </p>
      `,
    },
    B: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Continue with ZPLPDF Pro</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${data.displayName}, you've been busy! You've used all your free conversions for this month.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          With ZPLPDF Pro, you'll never be blocked again. Get 500 PDFs/month, batch processing, and more.
        </p>
        ${ctaButton('Continue with Pro', checkoutUrl)}
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Continúa con ZPLPDF Pro</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${data.displayName}, ¡has estado ocupado! Has usado todas tus conversiones gratuitas de este mes.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Con ZPLPDF Pro, nunca serás bloqueado de nuevo. Obtén 500 PDFs/mes, procesamiento por lotes y más.
        </p>
        ${ctaButton('Continuar con Pro', checkoutUrl)}
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">继续使用ZPLPDF Pro</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          您好 ${data.displayName}，您一直很忙！您已经用完了本月所有的免费转换次数。
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          使用ZPLPDF Pro，您将永远不会被阻止。每月获得500个PDF，批量处理等功能。
        </p>
        ${ctaButton('继续使用Pro', checkoutUrl)}
      `,
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Continue com ZPLPDF Pro</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${data.displayName}, voce tem estado ocupado! Voce usou todas as suas conversoes gratuitas deste mes.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Com o ZPLPDF Pro, voce nunca sera bloqueado novamente. Obtenha 500 PDFs/mes, processamento em lote e mais.
        </p>
        ${ctaButton('Continuar com Pro', checkoutUrl)}
      `,
    },
  };

  return content[variant][lang];
}

// High usage email templates
function getHighUsageContent(
  variant: AbVariant,
  lang: EmailLanguage,
  data: TemplateData,
): string {
  const pricingUrl = 'https://zplpdf.com/pricing';
  const avgPerDay = data.avgPdfsPerDay || 3;
  const daysToLimit = data.projectedDaysToLimit || 5;
  const used = data.pdfsUsed || 0;
  const limit = data.limit || 25;

  const content = {
    A: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">🚀 Your business is growing!</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${data.displayName}, we noticed you've been converting about <strong>${avgPerDay} PDFs per day</strong> recently. That's great!
        </p>
        ${progressBar(used, limit)}
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          At this rate, you'll reach your monthly limit in about <strong>${daysToLimit} days</strong>.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Upgrade to Pro now to avoid interruptions:
        </p>
        <table role="presentation" style="width: 100%; margin: 16px 0; border-collapse: collapse; border: 1px solid #e5e7eb; border-radius: 8px;">
          <tr style="background-color: #f9fafb;">
            <th style="padding: 12px; text-align: left; border-bottom: 1px solid #e5e7eb;"></th>
            <th style="padding: 12px; text-align: center; border-bottom: 1px solid #e5e7eb; color: #6b7280;">Free</th>
            <th style="padding: 12px; text-align: center; border-bottom: 1px solid #e5e7eb; color: #2563eb; font-weight: 700;">Pro</th>
          </tr>
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">PDFs/month</td>
            <td style="padding: 12px; text-align: center; border-bottom: 1px solid #e5e7eb;">25</td>
            <td style="padding: 12px; text-align: center; border-bottom: 1px solid #e5e7eb; font-weight: 600;">500</td>
          </tr>
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">Labels/PDF</td>
            <td style="padding: 12px; text-align: center; border-bottom: 1px solid #e5e7eb;">100</td>
            <td style="padding: 12px; text-align: center; border-bottom: 1px solid #e5e7eb; font-weight: 600;">500</td>
          </tr>
          <tr>
            <td style="padding: 12px;">Batch & Image Export</td>
            <td style="padding: 12px; text-align: center;">❌</td>
            <td style="padding: 12px; text-align: center;">✅</td>
          </tr>
        </table>
        ${ctaButton('Upgrade to Pro', pricingUrl)}
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">🚀 ¡Tu negocio está creciendo!</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${data.displayName}, notamos que has estado convirtiendo aproximadamente <strong>${avgPerDay} PDFs por día</strong> recientemente. ¡Eso es genial!
        </p>
        ${progressBar(used, limit)}
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          A este ritmo, alcanzarás tu límite mensual en aproximadamente <strong>${daysToLimit} días</strong>.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Actualiza a Pro ahora para evitar interrupciones:
        </p>
        <table role="presentation" style="width: 100%; margin: 16px 0; border-collapse: collapse; border: 1px solid #e5e7eb; border-radius: 8px;">
          <tr style="background-color: #f9fafb;">
            <th style="padding: 12px; text-align: left; border-bottom: 1px solid #e5e7eb;"></th>
            <th style="padding: 12px; text-align: center; border-bottom: 1px solid #e5e7eb; color: #6b7280;">Gratis</th>
            <th style="padding: 12px; text-align: center; border-bottom: 1px solid #e5e7eb; color: #2563eb; font-weight: 700;">Pro</th>
          </tr>
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">PDFs/mes</td>
            <td style="padding: 12px; text-align: center; border-bottom: 1px solid #e5e7eb;">25</td>
            <td style="padding: 12px; text-align: center; border-bottom: 1px solid #e5e7eb; font-weight: 600;">500</td>
          </tr>
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">Etiquetas/PDF</td>
            <td style="padding: 12px; text-align: center; border-bottom: 1px solid #e5e7eb;">100</td>
            <td style="padding: 12px; text-align: center; border-bottom: 1px solid #e5e7eb; font-weight: 600;">500</td>
          </tr>
          <tr>
            <td style="padding: 12px;">Lotes y Export Imágenes</td>
            <td style="padding: 12px; text-align: center;">❌</td>
            <td style="padding: 12px; text-align: center;">✅</td>
          </tr>
        </table>
        ${ctaButton('Actualizar a Pro', pricingUrl)}
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">🚀 您的业务正在增长！</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          您好 ${data.displayName}，我们注意到您最近每天大约转换 <strong>${avgPerDay} 个PDF</strong>。太棒了！
        </p>
        ${progressBar(used, limit)}
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          按照这个速度，您将在大约 <strong>${daysToLimit} 天</strong>内达到月度限制。
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          立即升级到Pro以避免中断：
        </p>
        <table role="presentation" style="width: 100%; margin: 16px 0; border-collapse: collapse; border: 1px solid #e5e7eb; border-radius: 8px;">
          <tr style="background-color: #f9fafb;">
            <th style="padding: 12px; text-align: left; border-bottom: 1px solid #e5e7eb;"></th>
            <th style="padding: 12px; text-align: center; border-bottom: 1px solid #e5e7eb; color: #6b7280;">免费</th>
            <th style="padding: 12px; text-align: center; border-bottom: 1px solid #e5e7eb; color: #2563eb; font-weight: 700;">Pro</th>
          </tr>
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">PDF/月</td>
            <td style="padding: 12px; text-align: center; border-bottom: 1px solid #e5e7eb;">25</td>
            <td style="padding: 12px; text-align: center; border-bottom: 1px solid #e5e7eb; font-weight: 600;">500</td>
          </tr>
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">标签/PDF</td>
            <td style="padding: 12px; text-align: center; border-bottom: 1px solid #e5e7eb;">100</td>
            <td style="padding: 12px; text-align: center; border-bottom: 1px solid #e5e7eb; font-weight: 600;">500</td>
          </tr>
          <tr>
            <td style="padding: 12px;">批量和图像导出</td>
            <td style="padding: 12px; text-align: center;">❌</td>
            <td style="padding: 12px; text-align: center;">✅</td>
          </tr>
        </table>
        ${ctaButton('升级到Pro', pricingUrl)}
      `,
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">🚀 Seu negocio esta crescendo!</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${data.displayName}, notamos que voce tem convertido cerca de <strong>${avgPerDay} PDFs por dia</strong> recentemente. Isso e otimo!
        </p>
        ${progressBar(used, limit)}
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Nesse ritmo, voce atingira seu limite mensal em cerca de <strong>${daysToLimit} dias</strong>.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Atualize para Pro agora para evitar interrupcoes:
        </p>
        <table role="presentation" style="width: 100%; margin: 16px 0; border-collapse: collapse; border: 1px solid #e5e7eb; border-radius: 8px;">
          <tr style="background-color: #f9fafb;">
            <th style="padding: 12px; text-align: left; border-bottom: 1px solid #e5e7eb;"></th>
            <th style="padding: 12px; text-align: center; border-bottom: 1px solid #e5e7eb; color: #6b7280;">Gratis</th>
            <th style="padding: 12px; text-align: center; border-bottom: 1px solid #e5e7eb; color: #2563eb; font-weight: 700;">Pro</th>
          </tr>
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">PDFs/mes</td>
            <td style="padding: 12px; text-align: center; border-bottom: 1px solid #e5e7eb;">25</td>
            <td style="padding: 12px; text-align: center; border-bottom: 1px solid #e5e7eb; font-weight: 600;">500</td>
          </tr>
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">Etiquetas/PDF</td>
            <td style="padding: 12px; text-align: center; border-bottom: 1px solid #e5e7eb;">100</td>
            <td style="padding: 12px; text-align: center; border-bottom: 1px solid #e5e7eb; font-weight: 600;">500</td>
          </tr>
          <tr>
            <td style="padding: 12px;">Lote e Export Imagens</td>
            <td style="padding: 12px; text-align: center;">❌</td>
            <td style="padding: 12px; text-align: center;">✅</td>
          </tr>
        </table>
        ${ctaButton('Atualizar para PRO', pricingUrl)}
      `,
    },
    B: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Projection: Limit in ${daysToLimit} days</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${data.displayName}, based on your usage pattern (${avgPerDay} PDFs/day), you'll hit your monthly limit in about ${daysToLimit} days.
        </p>
        ${progressBar(used, limit)}
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Upgrade now to ensure uninterrupted service for your business.
        </p>
        ${ctaButton('Upgrade to Pro', pricingUrl)}
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Proyección: Límite en ${daysToLimit} días</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${data.displayName}, según tu patrón de uso (${avgPerDay} PDFs/día), alcanzarás tu límite mensual en aproximadamente ${daysToLimit} días.
        </p>
        ${progressBar(used, limit)}
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Actualiza ahora para asegurar un servicio ininterrumpido para tu negocio.
        </p>
        ${ctaButton('Actualizar a Pro', pricingUrl)}
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">预测：${daysToLimit}天后达到限制</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          您好 ${data.displayName}，根据您的使用模式（每天${avgPerDay}个PDF），您将在大约${daysToLimit}天后达到月度限制。
        </p>
        ${progressBar(used, limit)}
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          立即升级，确保您的业务不间断服务。
        </p>
        ${ctaButton('升级到Pro', pricingUrl)}
      `,
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Projecao: Limite em ${daysToLimit} dias</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${data.displayName}, com base no seu padrao de uso (${avgPerDay} PDFs/dia), voce atingira seu limite mensal em cerca de ${daysToLimit} dias.
        </p>
        ${progressBar(used, limit)}
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Atualize agora para garantir servico ininterrupto para seu negocio.
        </p>
        ${ctaButton('Atualizar para PRO', pricingUrl)}
      `,
    },
  };

  return content[variant][lang];
}

// ============== PRO Retention Email Templates ==============

// PRO Inactive 7 days email templates
function getProInactive7DaysContent(
  variant: AbVariant,
  lang: EmailLanguage,
  data: TemplateData,
): string {
  const appUrl = 'https://zplpdf.com';
  const name = data.displayName || 'there';

  const content = {
    A: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">👋 We Miss You!</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${name}, it's been a week since your last conversion on ZPLPDF. Your PRO account is ready and waiting!
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          As a PRO user, you have access to:
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>500 PDFs per month</li>
          <li>500 labels per PDF</li>
          <li>Batch processing</li>
          <li>Image export (PNG/JPEG)</li>
        </ul>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Don't let your benefits go unused!
        </p>
        ${ctaButton('Start Converting', appUrl)}
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">👋 ¡Te Extrañamos!</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${name}, ha pasado una semana desde tu última conversión en ZPLPDF. ¡Tu cuenta PRO está lista y esperándote!
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Como usuario PRO, tienes acceso a:
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>500 PDFs por mes</li>
          <li>500 etiquetas por PDF</li>
          <li>Procesamiento por lotes</li>
          <li>Exportación de imágenes (PNG/JPEG)</li>
        </ul>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          ¡No dejes que tus beneficios queden sin usar!
        </p>
        ${ctaButton('Comenzar a Convertir', appUrl)}
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">👋 我们想念您！</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          您好 ${name}，距离您上次在ZPLPDF转换已经一周了。您的PRO账户已准备就绪，等待您的使用！
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          作为PRO用户，您可以享受：
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>每月500个PDF</li>
          <li>每个PDF 500个标签</li>
          <li>批量处理</li>
          <li>图像导出（PNG/JPEG）</li>
        </ul>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          不要让您的权益闲置！
        </p>
        ${ctaButton('开始转换', appUrl)}
      `,
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">👋 Sentimos Sua Falta!</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${name}, ja faz uma semana desde sua ultima conversao no ZPLPDF. Sua conta PRO esta pronta e esperando!
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Como usuario PRO, voce tem acesso a:
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>500 PDFs por mes</li>
          <li>500 etiquetas por PDF</li>
          <li>Processamento em lote</li>
          <li>Exportacao de imagens (PNG/JPEG)</li>
        </ul>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Nao deixe seus beneficios sem usar!
        </p>
        ${ctaButton('Comecar a Converter', appUrl)}
      `,
    },
    B: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Your PRO Benefits Await</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${name}, your ZPLPDF PRO account has been quiet for a week. Is everything okay?
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          If you're having any issues or need help, we're here for you. Just reply to this email.
        </p>
        ${ctaButton('Go to ZPLPDF', appUrl)}
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Tus Beneficios PRO Te Esperan</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${name}, tu cuenta ZPLPDF PRO ha estado inactiva por una semana. ¿Está todo bien?
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Si tienes algún problema o necesitas ayuda, estamos aquí para ti. Simplemente responde a este correo.
        </p>
        ${ctaButton('Ir a ZPLPDF', appUrl)}
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">您的PRO权益在等您</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          您好 ${name}，您的ZPLPDF PRO账户已经一周没有活动了。一切都还好吗？
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          如果您有任何问题或需要帮助，我们随时为您服务。只需回复此邮件即可。
        </p>
        ${ctaButton('前往ZPLPDF', appUrl)}
      `,
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Seus Beneficios PRO Te Esperam</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${name}, sua conta ZPLPDF PRO esta quieta ha uma semana. Esta tudo bem?
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Se voce tiver algum problema ou precisar de ajuda, estamos aqui para voce. Basta responder a este email.
        </p>
        ${ctaButton('Ir para ZPLPDF', appUrl)}
      `,
    },
  };

  return content[variant][lang];
}

// PRO Inactive 14 days email templates
function getProInactive14DaysContent(
  variant: AbVariant,
  lang: EmailLanguage,
  data: TemplateData,
): string {
  const supportEmail = 'support@zplpdf.com';
  const name = data.displayName || 'there';

  const content = {
    A: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">🤝 Can We Help?</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${name}, we noticed you haven't used ZPLPDF in the past 2 weeks. We'd love to know how we can help.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>Are you experiencing any of these?</strong>
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>Technical issues with conversions?</li>
          <li>Need help with a specific ZPL format?</li>
          <li>Looking for a feature we don't have?</li>
          <li>Business needs changed?</li>
        </ul>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Reply to this email and let us know. We're here to help!
        </p>
        ${ctaButton('Contact Support', 'mailto:' + supportEmail)}
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">🤝 ¿Podemos Ayudarte?</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${name}, notamos que no has usado ZPLPDF en las últimas 2 semanas. Nos encantaría saber cómo podemos ayudarte.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>¿Estás experimentando alguno de estos problemas?</strong>
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>¿Problemas técnicos con las conversiones?</li>
          <li>¿Necesitas ayuda con un formato ZPL específico?</li>
          <li>¿Buscas una función que no tenemos?</li>
          <li>¿Cambiaron tus necesidades de negocio?</li>
        </ul>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Responde a este correo y cuéntanos. ¡Estamos aquí para ayudarte!
        </p>
        ${ctaButton('Contactar Soporte', 'mailto:' + supportEmail)}
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">🤝 我们能帮到您吗？</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          您好 ${name}，我们注意到您在过去2周内没有使用ZPLPDF。我们很想知道如何能帮助您。
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>您是否遇到以下问题？</strong>
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>转换时遇到技术问题？</li>
          <li>需要帮助处理特定的ZPL格式？</li>
          <li>在寻找我们没有的功能？</li>
          <li>业务需求发生了变化？</li>
        </ul>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          回复此邮件告诉我们。我们随时为您服务！
        </p>
        ${ctaButton('联系支持', 'mailto:' + supportEmail)}
      `,
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">🤝 Podemos Ajudar?</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${name}, notamos que voce nao usou o ZPLPDF nas ultimas 2 semanas. Gostavamos de saber como podemos ajudar.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>Voce esta enfrentando algum desses problemas?</strong>
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>Problemas tecnicos com conversoes?</li>
          <li>Precisa de ajuda com um formato ZPL especifico?</li>
          <li>Procurando uma funcionalidade que nao temos?</li>
          <li>Suas necessidades de negocio mudaram?</li>
        </ul>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Responda a este email e conte-nos. Estamos aqui para ajudar!
        </p>
        ${ctaButton('Contatar Suporte', 'mailto:' + supportEmail)}
      `,
    },
    B: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">We'd Love Your Feedback</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${name}, your opinion matters to us. As a PRO user, your feedback helps us improve ZPLPDF for everyone.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Would you mind taking a minute to tell us about your experience? Just reply to this email with any thoughts.
        </p>
        ${ctaButton('Share Feedback', 'mailto:' + supportEmail + '?subject=ZPLPDF Feedback')}
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Nos Encantaría Tu Opinión</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${name}, tu opinión es importante para nosotros. Como usuario PRO, tus comentarios nos ayudan a mejorar ZPLPDF para todos.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          ¿Te importaría tomarte un minuto para contarnos sobre tu experiencia? Solo responde a este correo con cualquier comentario.
        </p>
        ${ctaButton('Compartir Opinión', 'mailto:' + supportEmail + '?subject=ZPLPDF Feedback')}
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">期待您的反馈</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          您好 ${name}，您的意见对我们很重要。作为PRO用户，您的反馈帮助我们为所有人改进ZPLPDF。
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          您介意花一分钟告诉我们您的体验吗？只需回复此邮件分享您的想法。
        </p>
        ${ctaButton('分享反馈', 'mailto:' + supportEmail + '?subject=ZPLPDF Feedback')}
      `,
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Adorariamos Sua Opiniao</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${name}, sua opiniao e importante para nos. Como usuario PRO, seu feedback nos ajuda a melhorar o ZPLPDF para todos.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Voce se importaria de tirar um minuto para nos contar sobre sua experiencia? Basta responder a este email com qualquer comentario.
        </p>
        ${ctaButton('Compartilhar Feedback', 'mailto:' + supportEmail + '?subject=ZPLPDF Feedback')}
      `,
    },
  };

  return content[variant][lang];
}

// PRO Inactive 30 days email templates
function getProInactive30DaysContent(
  variant: AbVariant,
  lang: EmailLanguage,
  data: TemplateData,
): string {
  const supportEmail = 'support@zplpdf.com';
  const name = data.displayName || 'there';

  const content = {
    A: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">We Want to Hear From You</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${name}, it's been a month since your last activity on ZPLPDF. We genuinely want to know how things are going.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Your feedback is invaluable to us. If there's something we could do better or a reason ZPLPDF isn't meeting your needs, please let us know.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Simply reply to this email - we read and respond to every message.
        </p>
        ${ctaButton('Send Us a Message', 'mailto:' + supportEmail + '?subject=Feedback from PRO User')}
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Queremos Saber de Ti</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${name}, ha pasado un mes desde tu última actividad en ZPLPDF. Genuinamente queremos saber cómo van las cosas.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Tu retroalimentación es invaluable para nosotros. Si hay algo que podríamos hacer mejor o una razón por la que ZPLPDF no está cumpliendo tus necesidades, por favor cuéntanos.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Simplemente responde a este correo - leemos y respondemos cada mensaje.
        </p>
        ${ctaButton('Envíanos un Mensaje', 'mailto:' + supportEmail + '?subject=Feedback de Usuario PRO')}
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">我们想了解您的情况</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          您好 ${name}，距离您上次在ZPLPDF的活动已经一个月了。我们真诚地想知道您的情况如何。
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          您的反馈对我们来说非常宝贵。如果有什么我们可以做得更好的地方，或者ZPLPDF没有满足您需求的原因，请告诉我们。
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          只需回复此邮件 - 我们会阅读并回复每一条消息。
        </p>
        ${ctaButton('给我们留言', 'mailto:' + supportEmail + '?subject=PRO用户反馈')}
      `,
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Queremos Ouvir Voce</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${name}, ja faz um mes desde sua ultima atividade no ZPLPDF. Queremos genuinamente saber como as coisas estao indo.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Seu feedback e inestimavel para nos. Se houver algo que possamos fazer melhor ou uma razao pela qual o ZPLPDF nao esta atendendo suas necessidades, por favor nos avise.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Basta responder a este email - lemos e respondemos cada mensagem.
        </p>
        ${ctaButton('Envie-nos uma Mensagem', 'mailto:' + supportEmail + '?subject=Feedback de Usuario PRO')}
      `,
    },
    B: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Your Feedback Matters</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${name}, we noticed you haven't been using ZPLPDF lately. We'd appreciate hearing from you.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Whether it's a suggestion, a concern, or just to say hi - we're listening.
        </p>
        ${ctaButton('Share Your Thoughts', 'mailto:' + supportEmail)}
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Tu Opinión es Importante</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${name}, notamos que no has estado usando ZPLPDF últimamente. Apreciaríamos saber de ti.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Ya sea una sugerencia, una inquietud, o solo para saludar - estamos escuchando.
        </p>
        ${ctaButton('Comparte tus Pensamientos', 'mailto:' + supportEmail)}
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">您的反馈很重要</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          您好 ${name}，我们注意到您最近没有使用ZPLPDF。我们希望能收到您的消息。
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          无论是建议、问题还是打个招呼 - 我们都在倾听。
        </p>
        ${ctaButton('分享您的想法', 'mailto:' + supportEmail)}
      `,
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Seu Feedback Importa</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${name}, notamos que voce nao tem usado o ZPLPDF ultimamente. Gostariamos de ouvir voce.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Seja uma sugestao, uma preocupacao ou apenas para dizer oi - estamos ouvindo.
        </p>
        ${ctaButton('Compartilhe Seus Pensamentos', 'mailto:' + supportEmail)}
      `,
    },
  };

  return content[variant][lang];
}

// PRO Power User email templates
function getProPowerUserContent(
  variant: AbVariant,
  lang: EmailLanguage,
  data: TemplateData,
): string {
  const testimonialUrl =
    'mailto:testimonials@zplpdf.com?subject=I want to share my ZPLPDF story';
  const name = data.displayName || 'there';
  const pdfsThisMonth = data.pdfsThisMonth || 50;

  const content = {
    A: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">🌟 You Are Amazing!</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${name}, wow! You've converted <strong>${pdfsThisMonth} PDFs</strong> this month. You're one of our power users!
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          We're thrilled that ZPLPDF is helping your business. Would you be willing to share your experience with others?
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          A short testimonial from you would mean the world to us and help other businesses discover ZPLPDF.
        </p>
        ${ctaButton('Share Your Story', testimonialUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          Thank you for being an amazing customer! 🙏
        </p>
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">🌟 ¡Eres Increíble!</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${name}, ¡wow! Has convertido <strong>${pdfsThisMonth} PDFs</strong> este mes. ¡Eres uno de nuestros power users!
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Estamos encantados de que ZPLPDF esté ayudando a tu negocio. ¿Estarías dispuesto a compartir tu experiencia con otros?
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Un breve testimonio tuyo significaría mucho para nosotros y ayudaría a otros negocios a descubrir ZPLPDF.
        </p>
        ${ctaButton('Comparte Tu Historia', testimonialUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          ¡Gracias por ser un cliente increíble! 🙏
        </p>
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">🌟 您太棒了！</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          您好 ${name}，哇！您本月已转换了 <strong>${pdfsThisMonth} 个PDF</strong>。您是我们的超级用户之一！
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          我们很高兴ZPLPDF能够帮助您的业务。您愿意与他人分享您的经验吗？
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          您的简短推荐对我们意义重大，并能帮助其他企业发现ZPLPDF。
        </p>
        ${ctaButton('分享您的故事', testimonialUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          感谢您成为我们出色的客户！🙏
        </p>
      `,
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">🌟 Voce E Incrivel!</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${name}, uau! Voce converteu <strong>${pdfsThisMonth} PDFs</strong> este mes. Voce e um dos nossos power users!
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Estamos muito felizes que o ZPLPDF esta ajudando seu negocio. Voce estaria disposto a compartilhar sua experiencia com outros?
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Um breve depoimento seu significaria muito para nos e ajudaria outras empresas a descobrir o ZPLPDF.
        </p>
        ${ctaButton('Compartilhe Sua Historia', testimonialUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          Obrigado por ser um cliente incrivel! 🙏
        </p>
      `,
    },
    B: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Thank You, Power User!</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${name}, with ${pdfsThisMonth} PDFs converted this month, you're clearly getting value from ZPLPDF. That makes us happy!
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          We'd love to feature your business on our website. Interested in being a ZPLPDF success story?
        </p>
        ${ctaButton('Tell Us About Your Business', testimonialUrl)}
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">¡Gracias, Power User!</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${name}, con ${pdfsThisMonth} PDFs convertidos este mes, claramente estás obteniendo valor de ZPLPDF. ¡Eso nos hace felices!
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Nos encantaría presentar tu negocio en nuestro sitio web. ¿Te interesa ser una historia de éxito de ZPLPDF?
        </p>
        ${ctaButton('Cuéntanos Sobre Tu Negocio', testimonialUrl)}
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">感谢您，超级用户！</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          您好 ${name}，本月转换了${pdfsThisMonth}个PDF，您显然从ZPLPDF中获得了价值。这让我们很高兴！
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          我们很想在网站上展示您的业务。有兴趣成为ZPLPDF的成功案例吗？
        </p>
        ${ctaButton('告诉我们您的业务', testimonialUrl)}
      `,
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Obrigado, Power User!</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${name}, com ${pdfsThisMonth} PDFs convertidos este mes, voce claramente esta obtendo valor do ZPLPDF. Isso nos deixa felizes!
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Adorariamos apresentar seu negocio em nosso site. Interessado em ser uma historia de sucesso do ZPLPDF?
        </p>
        ${ctaButton('Conte-nos Sobre Seu Negocio', testimonialUrl)}
      `,
    },
  };

  return content[variant][lang];
}

// ============== FREE Reactivation Email Content ==============

function getFreeNeverUsed7dContent(
  variant: AbVariant,
  lang: EmailLanguage,
  data: TemplateData,
): string {
  const appUrl = 'https://www.zplpdf.com';
  const examplesUrl = 'https://www.zplpdf.com/examples';
  const name =
    data.displayName ||
    (lang === 'es' ? 'Hola' : lang === 'zh' ? '您好' : 'there');

  const content = {
    A: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Your Account Is Ready!</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${name}, you signed up for ZPLPDF a week ago but haven't created your first label yet.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          🎯 <strong>Did you know you can create professional labels in 30 seconds?</strong>
        </p>
        ${ctaButton('CREATE MY FIRST LABEL →', appUrl)}
        <p style="margin: 24px 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Don't have ZPL code? No problem. We have examples ready to try:
        </p>
        ${ctaButton('SEE LABEL EXAMPLES →', examplesUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          Your free plan includes 25 PDFs per month. Use them!
        </p>
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">¡Tu Cuenta Está Lista!</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${name}, te registraste en ZPLPDF hace una semana pero aún no has creado tu primera etiqueta.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          🎯 <strong>¿Sabías que puedes crear etiquetas profesionales en 30 segundos?</strong>
        </p>
        ${ctaButton('CREAR MI PRIMERA ETIQUETA →', appUrl)}
        <p style="margin: 24px 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          ¿No tienes código ZPL? No hay problema. Tenemos ejemplos listos para probar:
        </p>
        ${ctaButton('VER EJEMPLOS DE ETIQUETAS →', examplesUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          Tu plan gratuito incluye 25 PDFs al mes. ¡Úsalos!
        </p>
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">您的账户已准备就绪！</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          ${name}，您一周前注册了ZPLPDF，但还没有创建第一个标签。
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          🎯 <strong>您知道可以在30秒内创建专业标签吗？</strong>
        </p>
        ${ctaButton('创建我的第一个标签 →', appUrl)}
        <p style="margin: 24px 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          没有ZPL代码？没问题。我们有现成的示例供您尝试：
        </p>
        ${ctaButton('查看标签示例 →', examplesUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          您的免费计划每月包含25个PDF。使用它们吧！
        </p>
      `,
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Sua Conta Esta Pronta!</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${name}, voce se cadastrou no ZPLPDF ha uma semana mas ainda nao criou sua primeira etiqueta.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          🎯 <strong>Voce sabia que pode criar etiquetas profissionais em 30 segundos?</strong>
        </p>
        ${ctaButton('CRIAR MINHA PRIMEIRA ETIQUETA →', appUrl)}
        <p style="margin: 24px 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Nao tem codigo ZPL? Sem problema. Temos exemplos prontos para experimentar:
        </p>
        ${ctaButton('VER EXEMPLOS DE ETIQUETAS →', examplesUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          Seu plano gratuito inclui 25 PDFs por mes. Use-os!
        </p>
      `,
    },
    B: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">🏷️ 30 Seconds to Your First Label</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${name}, creating labels with ZPLPDF is super easy:
        </p>
        <ol style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>Paste your ZPL code</li>
          <li>Click Convert</li>
          <li>Download your PDF</li>
        </ol>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          That's it! No software to install, no complicated setup.
        </p>
        ${ctaButton('TRY IT NOW →', appUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          Need examples? <a href="${examplesUrl}" style="color: #2563eb;">Check our sample labels</a>
        </p>
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">🏷️ 30 Segundos para Tu Primera Etiqueta</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${name}, crear etiquetas con ZPLPDF es súper fácil:
        </p>
        <ol style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>Pega tu código ZPL</li>
          <li>Haz clic en Convertir</li>
          <li>Descarga tu PDF</li>
        </ol>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          ¡Eso es todo! Sin software que instalar, sin configuración complicada.
        </p>
        ${ctaButton('PRUÉBALO AHORA →', appUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          ¿Necesitas ejemplos? <a href="${examplesUrl}" style="color: #2563eb;">Mira nuestras etiquetas de muestra</a>
        </p>
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">🏷️ 30秒创建您的第一个标签</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          ${name}，使用ZPLPDF创建标签非常简单：
        </p>
        <ol style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>粘贴您的ZPL代码</li>
          <li>点击转换</li>
          <li>下载您的PDF</li>
        </ol>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          就是这样！无需安装软件，无需复杂设置。
        </p>
        ${ctaButton('立即试用 →', appUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          需要示例？<a href="${examplesUrl}" style="color: #2563eb;">查看我们的示例标签</a>
        </p>
      `,
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">🏷️ 30 Segundos para Sua Primeira Etiqueta</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${name}, criar etiquetas com ZPLPDF e super facil:
        </p>
        <ol style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>Cole seu codigo ZPL</li>
          <li>Clique em Converter</li>
          <li>Baixe seu PDF</li>
        </ol>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          E so isso! Sem software para instalar, sem configuracao complicada.
        </p>
        ${ctaButton('EXPERIMENTE AGORA →', appUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          Precisa de exemplos? <a href="${examplesUrl}" style="color: #2563eb;">Veja nossas etiquetas de exemplo</a>
        </p>
      `,
    },
  };

  return content[variant][lang];
}

function getFreeNeverUsed14dContent(
  variant: AbVariant,
  lang: EmailLanguage,
  data: TemplateData,
): string {
  const appUrl = 'https://www.zplpdf.com';
  const faqUrl = 'https://www.zplpdf.com/faq';
  const examplesUrl = 'https://www.zplpdf.com/examples';
  const name =
    data.displayName ||
    (lang === 'es' ? 'Hola' : lang === 'zh' ? '您好' : 'there');

  const content = {
    A: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">⏰ Last Call</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${name}, it's been 2 weeks since you signed up and you haven't tried ZPLPDF yet.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>Is something holding you back?</strong>
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>Don't have ZPL code? → <a href="${examplesUrl}" style="color: #2563eb;">See examples</a></li>
          <li>Have questions? → <a href="${faqUrl}" style="color: #2563eb;">Check FAQ</a></li>
          <li>Need help? → Reply to this email</li>
        </ul>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Your free account is still active. If you don't use it, we'll keep it for you in case you change your mind.
        </p>
        ${ctaButton('TRY ZPLPDF NOW →', appUrl)}
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">⏰ Última Llamada</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${name}, han pasado 2 semanas desde que te registraste y aún no has probado ZPLPDF.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>¿Hay algo que te está frenando?</strong>
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>¿No tienes código ZPL? → <a href="${examplesUrl}" style="color: #2563eb;">Ver ejemplos</a></li>
          <li>¿Tienes dudas? → <a href="${faqUrl}" style="color: #2563eb;">Ver FAQ</a></li>
          <li>¿Necesitas ayuda? → Responde este email</li>
        </ul>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Tu cuenta gratuita sigue activa. Si no la usas, la mantendremos por si cambias de opinión.
        </p>
        ${ctaButton('PROBAR ZPLPDF AHORA →', appUrl)}
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">⏰ 最后提醒</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          ${name}，您注册已经两周了，但还没有尝试过ZPLPDF。
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>有什么阻碍您吗？</strong>
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>没有ZPL代码？→ <a href="${examplesUrl}" style="color: #2563eb;">查看示例</a></li>
          <li>有问题？→ <a href="${faqUrl}" style="color: #2563eb;">查看常见问题</a></li>
          <li>需要帮助？→ 回复此邮件</li>
        </ul>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          您的免费账户仍然有效。如果您不使用，我们会保留它以备您改变主意。
        </p>
        ${ctaButton('立即试用ZPLPDF →', appUrl)}
      `,
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">⏰ Ultima Chamada</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${name}, ja fazem 2 semanas desde que voce se cadastrou e ainda nao experimentou o ZPLPDF.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>Algo esta te impedindo?</strong>
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>Nao tem codigo ZPL? → <a href="${examplesUrl}" style="color: #2563eb;">Ver exemplos</a></li>
          <li>Tem duvidas? → <a href="${faqUrl}" style="color: #2563eb;">Ver FAQ</a></li>
          <li>Precisa de ajuda? → Responda este email</li>
        </ul>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Sua conta gratuita ainda esta ativa. Se voce nao usa-la, vamos mante-la caso mude de ideia.
        </p>
        ${ctaButton('EXPERIMENTAR ZPLPDF AGORA →', appUrl)}
      `,
    },
    B: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Need Help Getting Started?</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${name}, we noticed you haven't created your first label yet. That's okay!
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Many users find it helpful to start with our sample ZPL codes. You can copy-paste them directly and see how easy it is.
        </p>
        ${ctaButton('VIEW SAMPLE LABELS →', examplesUrl)}
        <p style="margin: 24px 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Or if you prefer, just reply to this email and tell us what you need. We're here to help!
        </p>
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">¿Necesitas Ayuda para Empezar?</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${name}, notamos que aún no has creado tu primera etiqueta. ¡Está bien!
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Muchos usuarios encuentran útil empezar con nuestros códigos ZPL de ejemplo. Puedes copiar y pegar directamente y ver lo fácil que es.
        </p>
        ${ctaButton('VER ETIQUETAS DE EJEMPLO →', examplesUrl)}
        <p style="margin: 24px 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          O si prefieres, simplemente responde este email y cuéntanos qué necesitas. ¡Estamos aquí para ayudarte!
        </p>
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">需要帮助开始吗？</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          ${name}，我们注意到您还没有创建第一个标签。没关系！
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          许多用户发现从我们的示例ZPL代码开始很有帮助。您可以直接复制粘贴，看看它有多简单。
        </p>
        ${ctaButton('查看示例标签 →', examplesUrl)}
        <p style="margin: 24px 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          或者如果您愿意，只需回复此邮件告诉我们您需要什么。我们随时为您提供帮助！
        </p>
      `,
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Precisa de Ajuda para Comecar?</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${name}, notamos que voce ainda nao criou sua primeira etiqueta. Tudo bem!
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Muitos usuarios acham util comecar com nossos codigos ZPL de exemplo. Voce pode copiar e colar diretamente e ver como e facil.
        </p>
        ${ctaButton('VER ETIQUETAS DE EXEMPLO →', examplesUrl)}
        <p style="margin: 24px 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Ou se preferir, basta responder a este email e nos dizer o que voce precisa. Estamos aqui para ajudar!
        </p>
      `,
    },
  };

  return content[variant][lang];
}

function getFreeTriedAbandonedContent(
  variant: AbVariant,
  lang: EmailLanguage,
  data: TemplateData,
): string {
  const appUrl = 'https://www.zplpdf.com';
  const name =
    data.displayName ||
    (lang === 'es' ? 'Hola' : lang === 'zh' ? '您好' : 'there');
  const pdfCount = data.pdfCount || 1;
  const pdfsAvailable = data.pdfsAvailable || 25 - pdfCount;

  const content = {
    A: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">We Saw You Started...</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${name}, a few days ago you created ${pdfCount} label${pdfCount > 1 ? 's' : ''} on ZPLPDF.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>Did everything go well?</strong>
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          If there was any issue or you have suggestions, we'd love to hear from you. Just reply to this email.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          By the way, you still have <strong>${pdfsAvailable} free PDFs</strong> available this month.
        </p>
        ${ctaButton('CONTINUE CREATING LABELS →', appUrl)}
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Vimos que Empezaste...</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${name}, hace unos días creaste ${pdfCount} etiqueta${pdfCount > 1 ? 's' : ''} en ZPLPDF.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>¿Todo salió bien?</strong>
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Si hubo algún problema o tienes sugerencias, nos encantaría saberlo. Simplemente responde a este email.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Por cierto, aún tienes <strong>${pdfsAvailable} PDFs gratuitos</strong> disponibles este mes.
        </p>
        ${ctaButton('CONTINUAR CREANDO ETIQUETAS →', appUrl)}
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">我们看到您开始了...</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          ${name}，几天前您在ZPLPDF上创建了${pdfCount}个标签。
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>一切顺利吗？</strong>
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          如果有任何问题或建议，我们很想听听。只需回复此邮件即可。
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          顺便说一下，您本月还有 <strong>${pdfsAvailable}个免费PDF</strong> 可用。
        </p>
        ${ctaButton('继续创建标签 →', appUrl)}
      `,
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Vimos Que Voce Comecou...</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${name}, ha alguns dias voce criou ${pdfCount} etiqueta${pdfCount > 1 ? 's' : ''} no ZPLPDF.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>Tudo correu bem?</strong>
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Se houve algum problema ou voce tem sugestoes, adorariamos saber. Basta responder a este email.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          A proposito, voce ainda tem <strong>${pdfsAvailable} PDFs gratuitos</strong> disponiveis este mes.
        </p>
        ${ctaButton('CONTINUAR CRIANDO ETIQUETAS →', appUrl)}
      `,
    },
    B: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">How Was Your Experience?</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${name}, you created ${pdfCount} label${pdfCount > 1 ? 's' : ''} with us recently. We'd love to know how it went!
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Was there anything that could have been better? Your feedback helps us improve.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Just reply to this email with your thoughts. We read every response!
        </p>
        ${ctaButton('CREATE MORE LABELS →', appUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          You have ${pdfsAvailable} free PDFs remaining this month.
        </p>
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">¿Cómo Fue Tu Experiencia?</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${name}, creaste ${pdfCount} etiqueta${pdfCount > 1 ? 's' : ''} con nosotros recientemente. ¡Nos encantaría saber cómo te fue!
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          ¿Hubo algo que podría haber sido mejor? Tu feedback nos ayuda a mejorar.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Simplemente responde a este email con tus comentarios. ¡Leemos cada respuesta!
        </p>
        ${ctaButton('CREAR MÁS ETIQUETAS →', appUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          Te quedan ${pdfsAvailable} PDFs gratuitos este mes.
        </p>
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">您的体验如何？</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          ${name}，您最近用我们的服务创建了${pdfCount}个标签。我们很想知道进展如何！
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          有什么可以改进的吗？您的反馈帮助我们进步。
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          只需回复此邮件告诉我们您的想法。我们会阅读每一条回复！
        </p>
        ${ctaButton('创建更多标签 →', appUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          您本月还剩${pdfsAvailable}个免费PDF。
        </p>
      `,
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Como Foi Sua Experiencia?</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${name}, voce criou ${pdfCount} etiqueta${pdfCount > 1 ? 's' : ''} conosco recentemente. Adorariamos saber como foi!
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Houve algo que poderia ter sido melhor? Seu feedback nos ajuda a melhorar.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Basta responder a este email com seus comentarios. Lemos cada resposta!
        </p>
        ${ctaButton('CRIAR MAIS ETIQUETAS →', appUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          Voce ainda tem ${pdfsAvailable} PDFs gratuitos restantes este mes.
        </p>
      `,
    },
  };

  return content[variant][lang];
}

function getFreeDormant30dContent(
  variant: AbVariant,
  lang: EmailLanguage,
  data: TemplateData,
): string {
  const surveyUrl = 'https://forms.gle/zplpdf-feedback';
  const appUrl = 'https://www.zplpdf.com';
  const name =
    data.displayName ||
    (lang === 'es' ? 'Hola' : lang === 'zh' ? '您好' : 'there');
  const pdfsAvailable = data.pdfsAvailable || 25;

  const content = {
    A: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Did You Find What You Were Looking For?</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${name}, it's been a month since your last visit to ZPLPDF.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>We want to improve. Could you tell us what happened?</strong>
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>I found another solution</li>
          <li>It was too complicated</li>
          <li>I don't have ZPL code regularly</li>
          <li>Other reason</li>
        </ul>
        ${ctaButton('ANSWER SURVEY (30 sec) →', surveyUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          If you decide to come back, your account is still active with ${pdfsAvailable} free PDFs.
        </p>
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">¿Encontraste Lo Que Buscabas?</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${name}, ha pasado un mes desde tu última visita a ZPLPDF.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>Queremos mejorar. ¿Podrías contarnos qué pasó?</strong>
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>Encontré otra solución</li>
          <li>Era muy complicado</li>
          <li>No tengo código ZPL regularmente</li>
          <li>Otro motivo</li>
        </ul>
        ${ctaButton('RESPONDER ENCUESTA (30 seg) →', surveyUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          Si decides volver, tu cuenta sigue activa con ${pdfsAvailable} PDFs gratuitos.
        </p>
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">您找到需要的了吗？</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          ${name}，距离您上次访问ZPLPDF已经一个月了。
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>我们想要改进。您能告诉我们发生了什么吗？</strong>
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>我找到了其他解决方案</li>
          <li>太复杂了</li>
          <li>我不经常有ZPL代码</li>
          <li>其他原因</li>
        </ul>
        ${ctaButton('回答调查（30秒）→', surveyUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          如果您决定回来，您的账户仍然有效，有${pdfsAvailable}个免费PDF可用。
        </p>
      `,
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Voce Encontrou o Que Procurava?</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${name}, ja faz um mes desde sua ultima visita ao ZPLPDF.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>Queremos melhorar. Poderia nos contar o que aconteceu?</strong>
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>Encontrei outra solucao</li>
          <li>Era muito complicado</li>
          <li>Nao tenho codigo ZPL regularmente</li>
          <li>Outro motivo</li>
        </ul>
        ${ctaButton('RESPONDER PESQUISA (30 seg) →', surveyUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          Se decidir voltar, sua conta ainda esta ativa com ${pdfsAvailable} PDFs gratuitos.
        </p>
      `,
    },
    B: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">We'd Love Your Feedback</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${name}, we noticed you haven't been around in a while.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Your opinion matters to us. If you have a minute, we'd appreciate hearing what we could do better.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Just reply to this email - we read every response and use the feedback to improve.
        </p>
        ${ctaButton('VISIT ZPLPDF →', appUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          Your account remains active with ${pdfsAvailable} free PDFs.
        </p>
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Nos Encantaría Tu Opinión</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${name}, notamos que no has estado por aquí en un tiempo.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Tu opinión es importante para nosotros. Si tienes un minuto, apreciaríamos saber qué podríamos hacer mejor.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Simplemente responde a este email - leemos cada respuesta y usamos el feedback para mejorar.
        </p>
        ${ctaButton('VISITAR ZPLPDF →', appUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          Tu cuenta permanece activa con ${pdfsAvailable} PDFs gratuitos.
        </p>
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">我们很想听听您的反馈</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          ${name}，我们注意到您已经有一段时间没来了。
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          您的意见对我们很重要。如果您有一分钟时间，我们很想听听我们可以做得更好的地方。
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          只需回复此邮件 - 我们会阅读每一条回复并利用反馈来改进。
        </p>
        ${ctaButton('访问ZPLPDF →', appUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          您的账户仍然有效，有${pdfsAvailable}个免费PDF可用。
        </p>
      `,
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Adorariamos Sua Opiniao</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${name}, notamos que voce nao aparece ha um tempo.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Sua opiniao e importante para nos. Se voce tiver um minuto, gostariamos de saber o que poderiamos fazer melhor.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Basta responder a este email - lemos cada resposta e usamos o feedback para melhorar.
        </p>
        ${ctaButton('VISITAR ZPLPDF →', appUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          Sua conta permanece ativa com ${pdfsAvailable} PDFs gratuitos.
        </p>
      `,
    },
  };

  return content[variant][lang];
}

function getFreeAbandoned60dContent(
  variant: AbVariant,
  lang: EmailLanguage,
  data: TemplateData,
): string {
  const appUrl = 'https://www.zplpdf.com';
  const name =
    data.displayName ||
    (lang === 'es' ? 'Hola' : lang === 'zh' ? '您好' : 'there');

  const content = {
    A: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">💔 We Miss You</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${name}, it's been a while since we've seen you.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          A lot has improved at ZPLPDF since your last visit:
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>✨ New, faster interface</li>
          <li>🔧 Better ZPL command support</li>
          <li>📱 Works better on mobile</li>
        </ul>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>Give us a second chance?</strong>
        </p>
        ${ctaButton('TRY ZPLPDF AGAIN →', appUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          If you no longer need the service, we understand. Your account will remain active in case you change your mind.
        </p>
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">💔 Te Extrañamos</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${name}, ha pasado tiempo desde que nos visitaste.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hemos mejorado mucho desde tu última visita:
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>✨ Nueva interfaz más rápida</li>
          <li>🔧 Mejor soporte para comandos ZPL</li>
          <li>📱 Funciona mejor en móviles</li>
        </ul>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>¿Una segunda oportunidad?</strong>
        </p>
        ${ctaButton('VOLVER A PROBAR ZPLPDF →', appUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          Si ya no necesitas el servicio, lo entendemos. Tu cuenta permanecerá activa por si cambias de opinión.
        </p>
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">💔 我们想念您</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          ${name}，好久没见到您了。
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          自您上次访问以来，ZPLPDF有了很多改进：
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>✨ 全新更快的界面</li>
          <li>🔧 更好的ZPL命令支持</li>
          <li>📱 移动端体验更佳</li>
        </ul>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>给我们第二次机会？</strong>
        </p>
        ${ctaButton('再次尝试ZPLPDF →', appUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          如果您不再需要这项服务，我们理解。您的账户将保持活跃，以备您改变主意。
        </p>
      `,
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">💔 Sentimos Sua Falta</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${name}, ja faz um tempo desde que nos vimos.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Muita coisa melhorou no ZPLPDF desde sua ultima visita:
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>✨ Nova interface mais rapida</li>
          <li>🔧 Melhor suporte a comandos ZPL</li>
          <li>📱 Funciona melhor em dispositivos moveis</li>
        </ul>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>Nos de uma segunda chance?</strong>
        </p>
        ${ctaButton('EXPERIMENTAR ZPLPDF NOVAMENTE →', appUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          Se voce nao precisar mais do servico, entendemos. Sua conta permanecera ativa caso mude de ideia.
        </p>
      `,
    },
    B: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">A Lot Has Changed at ZPLPDF</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${name}, we've been busy making ZPLPDF better since you last visited.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Our users asked, and we delivered:
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>Faster conversions</li>
          <li>Better label previews</li>
          <li>Improved mobile experience</li>
          <li>More ZPL commands supported</li>
        </ul>
        ${ctaButton("SEE WHAT'S NEW →", appUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          Your account is waiting for you.
        </p>
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Mucho Ha Cambiado en ZPLPDF</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${name}, hemos estado ocupados mejorando ZPLPDF desde tu última visita.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Nuestros usuarios pidieron, y lo cumplimos:
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>Conversiones más rápidas</li>
          <li>Mejores previsualizaciones de etiquetas</li>
          <li>Experiencia móvil mejorada</li>
          <li>Más comandos ZPL soportados</li>
        </ul>
        ${ctaButton('VER LAS NOVEDADES →', appUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          Tu cuenta te está esperando.
        </p>
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">ZPLPDF有很多变化</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          ${name}，自您上次访问以来，我们一直在忙着改进ZPLPDF。
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          用户提出要求，我们做到了：
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>更快的转换速度</li>
          <li>更好的标签预览</li>
          <li>改进的移动端体验</li>
          <li>支持更多ZPL命令</li>
        </ul>
        ${ctaButton('查看新功能 →', appUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          您的账户在等待您。
        </p>
      `,
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Muita Coisa Mudou no ZPLPDF</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${name}, estivemos ocupados melhorando o ZPLPDF desde sua ultima visita.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Nossos usuarios pediram, e nos entregamos:
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>Conversoes mais rapidas</li>
          <li>Melhores previas de etiquetas</li>
          <li>Experiencia mobile aprimorada</li>
          <li>Mais comandos ZPL suportados</li>
        </ul>
        ${ctaButton('VER AS NOVIDADES →', appUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          Sua conta esta esperando por voce.
        </p>
      `,
    },
  };

  return content[variant][lang];
}

// ============== Payment Notification Emails ==============

function getPaymentFailedContent(
  variant: AbVariant,
  lang: EmailLanguage,
  data: TemplateData,
): string {
  const portalUrl = 'https://www.zplpdf.com/dashboard/billing';
  const name =
    data.displayName ||
    (lang === 'es' ? 'Hola' : lang === 'zh' ? '您好' : 'there');
  const attemptCount = data.attemptCount || 1;
  const nextRetryDate = data.nextRetryDate || '';

  const content = {
    A: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">⚠️ Payment Failed - Action Required</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${name}, we were unable to process your payment for your ZPLPDF subscription.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          This is payment attempt <strong>${attemptCount}</strong>. ${nextRetryDate ? `We'll try again on <strong>${nextRetryDate}</strong>.` : ''}
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          To avoid losing your PRO features, please update your payment method:
        </p>
        ${ctaButton('UPDATE PAYMENT METHOD →', portalUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          If you believe this is an error or need assistance, please reply to this email.
        </p>
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">⚠️ Pago Fallido - Acción Requerida</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${name}, no pudimos procesar tu pago para tu suscripción de ZPLPDF.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Este es el intento de pago <strong>${attemptCount}</strong>. ${nextRetryDate ? `Intentaremos de nuevo el <strong>${nextRetryDate}</strong>.` : ''}
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Para evitar perder tus funciones PRO, por favor actualiza tu método de pago:
        </p>
        ${ctaButton('ACTUALIZAR MÉTODO DE PAGO →', portalUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          Si crees que esto es un error o necesitas ayuda, responde a este correo.
        </p>
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">⚠️ 付款失败 - 需要采取行动</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          ${name}，我们无法处理您的ZPLPDF订阅付款。
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          这是第 <strong>${attemptCount}</strong> 次付款尝试。${nextRetryDate ? `我们将在 <strong>${nextRetryDate}</strong> 再次尝试。` : ''}
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          为避免失去您的PRO功能，请更新您的付款方式：
        </p>
        ${ctaButton('更新付款方式 →', portalUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          如果您认为这是一个错误或需要帮助，请回复此邮件。
        </p>
      `,
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">⚠️ Pagamento Falhou - Ação Necessária</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${name}, não conseguimos processar seu pagamento para sua assinatura ZPLPDF.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Esta é a tentativa de pagamento <strong>${attemptCount}</strong>. ${nextRetryDate ? `Tentaremos novamente em <strong>${nextRetryDate}</strong>.` : ''}
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Para evitar perder seus recursos PRO, por favor atualize seu método de pagamento:
        </p>
        ${ctaButton('ATUALIZAR MÉTODO DE PAGAMENTO →', portalUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          Se você acredita que isso é um erro ou precisa de ajuda, responda a este e-mail.
        </p>
      `,
    },
    B: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Your ZPLPDF Subscription Needs Attention</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${name}, there was an issue with your recent payment.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>What happened?</strong> Your payment couldn't be processed (attempt ${attemptCount}).
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>What's next?</strong> Update your payment details to keep your PRO features active.
        </p>
        ${ctaButton('FIX PAYMENT →', portalUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          Questions? Just reply to this email - we're here to help.
        </p>
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Tu Suscripción ZPLPDF Necesita Atención</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${name}, hubo un problema con tu pago reciente.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>¿Qué pasó?</strong> Tu pago no pudo ser procesado (intento ${attemptCount}).
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>¿Qué sigue?</strong> Actualiza tus datos de pago para mantener tus funciones PRO activas.
        </p>
        ${ctaButton('CORREGIR PAGO →', portalUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          ¿Preguntas? Solo responde a este correo - estamos aquí para ayudarte.
        </p>
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">您的ZPLPDF订阅需要关注</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          ${name}，您最近的付款出现了问题。
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>发生了什么？</strong> 您的付款无法处理（第${attemptCount}次尝试）。
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>下一步是什么？</strong> 更新您的付款信息以保持PRO功能活跃。
        </p>
        ${ctaButton('修复付款 →', portalUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          有问题？只需回复此邮件 - 我们随时为您提供帮助。
        </p>
      `,
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Sua Assinatura ZPLPDF Precisa de Atenção</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${name}, houve um problema com seu pagamento recente.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>O que aconteceu?</strong> Seu pagamento não pôde ser processado (tentativa ${attemptCount}).
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>Próximo passo?</strong> Atualize seus dados de pagamento para manter seus recursos PRO ativos.
        </p>
        ${ctaButton('CORRIGIR PAGAMENTO →', portalUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          Dúvidas? Apenas responda a este e-mail - estamos aqui para ajudar.
        </p>
      `,
    },
  };

  return content[variant][lang];
}

function getSubscriptionDowngradedContent(
  variant: AbVariant,
  lang: EmailLanguage,
  data: TemplateData,
): string {
  const pricingUrl = 'https://www.zplpdf.com/pricing';
  const name =
    data.displayName ||
    (lang === 'es' ? 'Hola' : lang === 'zh' ? '您好' : 'there');
  const previousPlan = data.previousPlan || 'PRO';
  const reason = data.reason || 'canceled';

  const reasonText = {
    canceled: {
      en: 'Your subscription was canceled',
      es: 'Tu suscripción fue cancelada',
      zh: '您的订阅已取消',
      pt: 'Sua assinatura foi cancelada',
    },
    unpaid: {
      en: 'Your subscription payment could not be processed',
      es: 'No se pudo procesar el pago de tu suscripción',
      zh: '您的订阅付款无法处理',
      pt: 'O pagamento da sua assinatura não pôde ser processado',
    },
    past_due: {
      en: 'Your subscription payment is overdue',
      es: 'El pago de tu suscripción está vencido',
      zh: '您的订阅付款已逾期',
      pt: 'O pagamento da sua assinatura está atrasado',
    },
  };

  const reasonMessage =
    reasonText[reason as keyof typeof reasonText] || reasonText.canceled;

  const content = {
    A: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">📋 Your ZPLPDF Plan Has Changed</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${name}, ${reasonMessage.en.toLowerCase()}.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Your account has been changed from <strong>${previousPlan}</strong> to the <strong>FREE</strong> plan.
        </p>
        <p style="margin: 0 0 8px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>Your new limits:</strong>
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>100 labels per PDF</li>
          <li>25 PDFs per month</li>
          <li>No image export</li>
          <li>No batch processing</li>
        </ul>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          You can upgrade again anytime to restore your previous features:
        </p>
        ${ctaButton('VIEW PLANS →', pricingUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          Your conversion history and account data are safe. You can access them anytime.
        </p>
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">📋 Tu Plan ZPLPDF Ha Cambiado</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${name}, ${reasonMessage.es.toLowerCase()}.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Tu cuenta ha sido cambiada de <strong>${previousPlan}</strong> al plan <strong>GRATUITO</strong>.
        </p>
        <p style="margin: 0 0 8px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>Tus nuevos límites:</strong>
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>100 etiquetas por PDF</li>
          <li>25 PDFs por mes</li>
          <li>Sin exportación de imágenes</li>
          <li>Sin procesamiento por lotes</li>
        </ul>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Puedes volver a actualizar en cualquier momento para restaurar tus funciones anteriores:
        </p>
        ${ctaButton('VER PLANES →', pricingUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          Tu historial de conversiones y datos de cuenta están seguros. Puedes acceder a ellos en cualquier momento.
        </p>
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">📋 您的ZPLPDF计划已更改</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          ${name}，${reasonMessage.zh}。
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          您的账户已从 <strong>${previousPlan}</strong> 更改为 <strong>免费</strong> 计划。
        </p>
        <p style="margin: 0 0 8px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>您的新限制：</strong>
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>每个PDF 100个标签</li>
          <li>每月25个PDF</li>
          <li>无图像导出</li>
          <li>无批量处理</li>
        </ul>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          您可以随时再次升级以恢复您以前的功能：
        </p>
        ${ctaButton('查看计划 →', pricingUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          您的转换历史和账户数据是安全的。您可以随时访问它们。
        </p>
      `,
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">📋 Seu Plano ZPLPDF Mudou</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${name}, ${reasonMessage.pt.toLowerCase()}.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Sua conta foi alterada de <strong>${previousPlan}</strong> para o plano <strong>GRATUITO</strong>.
        </p>
        <p style="margin: 0 0 8px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>Seus novos limites:</strong>
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; color: #374151; font-size: 16px; line-height: 1.8;">
          <li>100 etiquetas por PDF</li>
          <li>25 PDFs por mês</li>
          <li>Sem exportação de imagens</li>
          <li>Sem processamento em lote</li>
        </ul>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Você pode fazer upgrade novamente a qualquer momento para restaurar seus recursos anteriores:
        </p>
        ${ctaButton('VER PLANOS →', pricingUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          Seu histórico de conversões e dados da conta estão seguros. Você pode acessá-los a qualquer momento.
        </p>
      `,
    },
    B: {
      en: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Important Update About Your ZPLPDF Account</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hi ${name}, we wanted to let you know about a change to your account.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Your ${previousPlan} subscription has ended, and your account is now on the FREE plan.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>Good news:</strong> You can still use ZPLPDF with the free plan limits. And when you're ready to upgrade again, all your data will be waiting.
        </p>
        ${ctaButton('SUBSCRIBE AGAIN →', pricingUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          Need help? Reply to this email anytime.
        </p>
      `,
      es: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Actualización Importante Sobre Tu Cuenta ZPLPDF</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Hola ${name}, queríamos informarte sobre un cambio en tu cuenta.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Tu suscripción ${previousPlan} ha terminado, y tu cuenta ahora está en el plan GRATUITO.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>Buenas noticias:</strong> Aún puedes usar ZPLPDF con los límites del plan gratuito. Y cuando estés listo para actualizar de nuevo, todos tus datos estarán esperándote.
        </p>
        ${ctaButton('SUSCRIBIRSE DE NUEVO →', pricingUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          ¿Necesitas ayuda? Responde a este correo cuando quieras.
        </p>
      `,
      zh: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">关于您ZPLPDF账户的重要更新</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          ${name}，我们想通知您账户的一个变更。
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          您的${previousPlan}订阅已结束，您的账户现在是免费计划。
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>好消息：</strong> 您仍然可以在免费计划限制内使用ZPLPDF。当您准备再次升级时，所有数据都将等待着您。
        </p>
        ${ctaButton('再次订阅 →', pricingUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          需要帮助？随时回复此邮件。
        </p>
      `,
      pt: `
        <h2 style="margin: 0 0 16px; color: #111827; font-size: 24px;">Atualização Importante Sobre Sua Conta ZPLPDF</h2>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Oi ${name}, queríamos informá-lo sobre uma mudança em sua conta.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          Sua assinatura ${previousPlan} terminou, e sua conta agora está no plano GRATUITO.
        </p>
        <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
          <strong>Boas notícias:</strong> Você ainda pode usar o ZPLPDF com os limites do plano gratuito. E quando estiver pronto para fazer upgrade novamente, todos os seus dados estarão esperando.
        </p>
        ${ctaButton('ASSINAR NOVAMENTE →', pricingUrl)}
        <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px;">
          Precisa de ajuda? Responda a este e-mail quando quiser.
        </p>
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
    // Onboarding emails
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
    // Conversion emails
    case 'limit_80_percent':
      content = getLimit80Content(variant, language, data);
      break;
    case 'limit_100_percent':
      content = getLimit100Content(variant, language, data);
      break;
    case 'conversion_blocked':
      content = getBlockedContent(variant, language, data);
      break;
    case 'high_usage':
      content = getHighUsageContent(variant, language, data);
      break;
    // PRO Retention emails
    case 'pro_inactive_7_days':
      content = getProInactive7DaysContent(variant, language, data);
      break;
    case 'pro_inactive_14_days':
      content = getProInactive14DaysContent(variant, language, data);
      break;
    case 'pro_inactive_30_days':
      content = getProInactive30DaysContent(variant, language, data);
      break;
    case 'pro_power_user':
      content = getProPowerUserContent(variant, language, data);
      break;
    // FREE Reactivation emails
    case 'free_never_used_7d':
      content = getFreeNeverUsed7dContent(variant, language, data);
      break;
    case 'free_never_used_14d':
      content = getFreeNeverUsed14dContent(variant, language, data);
      break;
    case 'free_tried_abandoned':
      content = getFreeTriedAbandonedContent(variant, language, data);
      break;
    case 'free_dormant_30d':
      content = getFreeDormant30dContent(variant, language, data);
      break;
    case 'free_abandoned_60d':
      content = getFreeAbandoned60dContent(variant, language, data);
      break;
    // Payment notification emails
    case 'payment_failed':
      content = getPaymentFailedContent(variant, language, data);
      break;
    case 'subscription_downgraded':
      content = getSubscriptionDowngradedContent(variant, language, data);
      break;
    default:
      throw new Error(`Unknown email type: ${emailType}`);
  }

  const html = baseTemplate(content, language);
  const text = stripHtml(content);

  return { subject, html, text };
}
