import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // Configurar el prefijo global de la API
  app.setGlobalPrefix('api');
  
  // Habilitar validación de DTO
  app.useGlobalPipes(new ValidationPipe({ transform: true }));
  
  // Configurar Swagger
  const config = new DocumentBuilder()
    .setTitle('ZPLPDF API')
    .setDescription('API para conversión de ZPL a PDF')
    .setVersion('1.0')
    .addTag('zpl')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);
  
  // Iniciar el servidor
  await app.listen(process.env.PORT || 3000);
  console.log(`Aplicación corriendo en: ${await app.getUrl()}`);
}
bootstrap();
