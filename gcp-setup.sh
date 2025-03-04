#!/bin/bash

# Script para configurar Google Cloud para el despliegue

# Verificar si gcloud está instalado
if ! command -v gcloud &> /dev/null; then
    echo "Error: gcloud CLI no está instalado. Por favor, instálalo primero."
    exit 1
fi

# Autenticar con Google Cloud
echo "Autenticando con Google Cloud..."
gcloud auth login

# Configurar el proyecto
echo "Configurando el proyecto..."
gcloud config set project intranet-guatever

# Habilitar los servicios necesarios
echo "Habilitando servicios necesarios..."
gcloud services enable cloudbuild.googleapis.com
gcloud services enable run.googleapis.com
gcloud services enable firestore.googleapis.com
gcloud services enable storage.googleapis.com
gcloud services enable cloudtasks.googleapis.com

# Crear un bucket de Storage si no existe
echo "Verificando bucket de Storage..."
if ! gsutil ls gs://intranet-guatever-files &> /dev/null; then
    echo "Creando bucket de Storage..."
    gsutil mb -l us-central1 gs://intranet-guatever-files
    gsutil iam ch allUsers:objectViewer gs://intranet-guatever-files
fi

# Crear una cola de Cloud Tasks si no existe
echo "Configurando Cloud Tasks..."
gcloud tasks queues create zpl-conversion-queue \
    --location=us-central1 \
    2>/dev/null || echo "La cola ya existe o hubo un error al crearla"

echo "Configuración completada. Ya puedes desplegar la aplicación con:"
echo "npm run deploy:build"
echo "npm run deploy:run" 