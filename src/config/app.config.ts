export default () => ({
  port: parseInt(process.env.PORT, 10) || 8080,
  gcpProjectId: process.env.GCP_PROJECT_ID,
  gcpLocation: process.env.GCP_LOCATION || 'us-central1',
  gcpQueueName: process.env.GCP_QUEUE_NAME || 'zpl-conversion-queue',
  gcpServiceAccountEmail: process.env.GCP_SERVICE_ACCOUNT_EMAIL,
  gcpStorageBucket: process.env.GCP_STORAGE_BUCKET || 'zplpdf-app-files',
  serviceUrl: process.env.SERVICE_URL || 'https://zplpdf-app-service-url.a.run.app',
});