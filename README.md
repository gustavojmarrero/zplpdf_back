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
- `POST /api/zpl/count-labels`: Analiza un archivo ZPL y cuenta el número de etiquetas
- `GET /api/docs`: Documentación Swagger de la API

### Detalles de los Endpoints

#### POST /api/zpl/count-labels

Analiza un archivo ZPL y devuelve el conteo de etiquetas únicas y totales.

**Request:**
```http
POST /api/zpl/count-labels
Content-Type: multipart/form-data

file: [archivo ZPL]
# o
zplContent: "^XA...^XZ"
```

**Response:**
```json
{
  "success": true,
  "message": "Conteo de etiquetas realizado exitosamente",
  "data": {
    "totalUniqueLabels": 10,  // Número de etiquetas únicas sin contar copias
    "totalLabels": 25         // Total de etiquetas incluyendo copias (^PQ)
  }
}
```

**Notas:**
- Acepta tanto archivo como contenido ZPL en texto plano
- Tamaño máximo de archivo: 1MB
- Considera el comando ^PQ para el conteo de copias
- Cada bloque ZPL debe estar delimitado por ^XA y ^XZ

#### POST /api/zpl/preview

Genera una previsualización de las etiquetas ZPL como imágenes PNG y devuelve la cantidad de copias de cada una.

**Request:**
```http
POST /api/zpl/preview
Content-Type: application/json

{
  "zplContent": "^XA...^XZ",
  "labelSize": "2x1" // Opciones: "2x1", "2x4", "4x2", "4x6"
}
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "img": "data:image/png;base64,...", // Imagen en base64
      "qty": 5                            // Cantidad de copias (^PQ)
    },
    {
      "img": "data:image/png;base64,...",
      "qty": 3
    }
  ]
}
```

**Notas:**
- Genera una previsualización PNG para cada etiqueta única
- Procesa hasta 50 etiquetas únicas por solicitud
- Respeta el comando ^PQ para mostrar la cantidad de copias
- Las imágenes se devuelven en formato base64
- Soporta los siguientes tamaños de etiqueta: 2x1, 2x4, 4x2, 4x6
- Utiliza una resolución de impresora de 8dpmm (203dpi)

## Licencia

MIT
