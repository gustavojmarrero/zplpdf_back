import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  // Configurar headers de seguridad con Helmet
  app.use(helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        scriptSrc: ["'self'"],
      },
    },
  }));

  // Configurar límite de payload (reducido a 5MB por seguridad)
  app.useBodyParser('json', { limit: '5mb' });
  app.useBodyParser('urlencoded', { limit: '5mb', extended: true });
  app.useBodyParser('text', { limit: '5mb' });

  // Configurar CORS - solo HTTPS en producción
  const isProduction = process.env.NODE_ENV === 'production';
  app.enableCors({
    origin: isProduction
      ? [
          'https://www.zplpdf.com',
          'https://zplpdf.com',
          'https://zplpdf-gustavojmarreros-projects.vercel.app',
        ]
      : [
          'http://localhost:8080',
          'http://localhost:3000',
          'https://www.zplpdf.com',
          'https://zplpdf.com',
        ],
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
    credentials: true,
  });

  // Configurar el prefijo global de la API
  app.setGlobalPrefix('api');

  // Habilitar validacion de DTO
  app.useGlobalPipes(new ValidationPipe({ transform: true }));

  // Registrar interceptor global para X-Request-Id
  app.useGlobalInterceptors(new RequestIdInterceptor());

  // Registrar filtro global de excepciones para respuestas estandarizadas
  app.useGlobalFilters(new HttpExceptionFilter());

  // Configurar Swagger
  const config = new DocumentBuilder()
    .setTitle('ZPLPDF API')
    .setDescription('API para conversion de ZPL a PDF con modelo de suscripcion')
    .setVersion('2.0')
    .addTag('zpl', 'ZPL to PDF conversion endpoints')
    .addTag('users', 'User management endpoints')
    .addTag('payments', 'Payment and subscription endpoints')
    .addTag('contact', 'Contact form endpoints')
    .addTag('cron', 'Cron job endpoints')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Firebase Auth ID Token',
      },
      'Firebase',
    )
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  // Iniciar el servidor
  await app.listen(process.env.PORT || 3000);
  console.log(`Aplicacion corriendo en: ${await app.getUrl()}`);
}
bootstrap();
