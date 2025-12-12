import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  // Configurar CORS
  app.enableCors({
    origin: [
      'http://localhost:8080',
      'http://localhost:3000',
      'https://zplpdf-gustavojmarreros-projects.vercel.ap',
      'https://www.zplpdf.com',
      'http://www.zplpdf.com',
    ],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  // Configurar el prefijo global de la API
  app.setGlobalPrefix('api');

  // Habilitar validacion de DTO
  app.useGlobalPipes(new ValidationPipe({ transform: true }));

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
