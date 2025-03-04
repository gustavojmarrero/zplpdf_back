# ZPLPDF Application

Aplicación para convertir archivos ZPL a PDF utilizando Google Cloud Run.

## Estructura del Proyecto

```
src/
├── main.ts                     # Punto de entrada
├── app.module.ts               # Módulo principal
├── modules/
│   ├── zpl/                    # Módulo de conversión ZPL
│   │   ├── zpl.controller.ts   # Endpoints de la API
│   │   ├── zpl.service.ts      # Lógica de conversión
│   │   ├── dto/                # Data transfer objects
│   │   └── interfaces/         # Interfaces y tipos
│   ├── queue/                  # Módulo de gestión de colas
│   │   ├── cloud-tasks.service.ts
│   ├── storage/                # Módulo de almacenamiento
│   │   ├── storage.service.ts  # Gestión de archivos en Cloud Storage
│   ├── cache/                  # Módulo de caché
│   │   ├── firestore.service.ts # Manejo de caché en Firestore
│   └── health/                 # Endpoints de salud
├── config/                     # Configuración global
└── utils/                      # Utilidades
```

## Requisitos

- Node.js (v14 o superior)
- npm o yarn
- Cuenta de Google Cloud Platform
- gcloud CLI instalado y configurado

## Configuración del Proyecto en Google Cloud

```bash
# Crear proyecto en Google Cloud
gcloud projects create zplpdf-app --name="ZPLPDF Application"

# Habilitar servicios necesarios
gcloud services enable cloudbuild.googleapis.com
gcloud services enable run.googleapis.com
gcloud services enable firestore.googleapis.com
gcloud services enable storage.googleapis.com
gcloud services enable cloudtasks.googleapis.com
```

## Instalación y Desarrollo Local

1. Clonar el repositorio
2. Instalar dependencias:

```bash
npm install
```

3. Copiar el archivo `.env.example` a `.env` y configurar las variables de entorno:

```bash
cp .env.example .env
```

4. Iniciar el servidor en modo desarrollo:

```bash
npm run start:dev
```

## Despliegue en Google Cloud Run

```bash
# Construir la imagen
gcloud builds submit --tag gcr.io/zplpdf-app/zplpdf-service

# Desplegar el servicio
gcloud run deploy zplpdf-service \
  --image gcr.io/zplpdf-app/zplpdf-service \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --update-env-vars GCP_PROJECT_ID=zplpdf-app,GCP_LOCATION=us-central1
```

## Endpoints de la API

- `POST /api/zpl/convert`: Iniciar conversión de ZPL a PDF
- `GET /api/zpl/status/:jobId`: Verificar estado de conversión
- `GET /api/zpl/download/:jobId`: Descargar PDF convertido
- `GET /api/docs`: Documentación Swagger de la API

## Licencia

MIT
