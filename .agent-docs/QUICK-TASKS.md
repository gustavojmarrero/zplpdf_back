# Quick Task Reference

## Add a New CRUD Endpoint

### 1. Create DTO Files

```bash
# Create directory structure
mkdir -p src/modules/[name]/dto
```

Create request DTO:
```typescript
// src/modules/[name]/dto/create-[name].dto.ts
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateResourceDto {
  @ApiProperty({ description: 'Name of the resource' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ description: 'Optional description' })
  @IsOptional()
  @IsString()
  description?: string;
}
```

### 2. Create Service

```typescript
// src/modules/[name]/[name].service.ts
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { FirestoreService } from '../cache/firestore.service.js';
import { CreateResourceDto } from './dto/create-[name].dto.js';

@Injectable()
export class ResourceService {
  private readonly logger = new Logger(ResourceService.name);

  constructor(private readonly firestoreService: FirestoreService) {}

  async create(dto: CreateResourceDto) {
    // Implementation
  }

  async findOne(id: string) {
    const resource = await this.firestoreService.getResourceById(id);
    if (!resource) {
      throw new NotFoundException(`Resource ${id} not found`);
    }
    return resource;
  }

  async findAll() {
    return this.firestoreService.getAllResources();
  }
}
```

### 3. Create Controller

```typescript
// src/modules/[name]/[name].controller.ts
import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { ResourceService } from './[name].service.js';
import { CreateResourceDto } from './dto/create-[name].dto.js';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';

@ApiTags('[name]')
@Controller('[name]')
export class ResourceController {
  constructor(private readonly service: ResourceService) {}

  @Get()
  @ApiOperation({ summary: 'List all resources' })
  findAll() {
    return this.service.findAll();
  }

  @Post()
  @UseGuards(FirebaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new resource' })
  create(@Body() dto: CreateResourceDto) {
    return this.service.create(dto);
  }
}
```

### 4. Create Module

```typescript
// src/modules/[name]/[name].module.ts
import { Module } from '@nestjs/common';
import { ResourceController } from './[name].controller.js';
import { ResourceService } from './[name].service.js';
import { CacheModule } from '../cache/cache.module.js';

@Module({
  imports: [CacheModule],
  controllers: [ResourceController],
  providers: [ResourceService],
  exports: [ResourceService],
})
export class ResourceModule {}
```

### 5. Register in AppModule

```typescript
// src/app.module.ts
import { ResourceModule } from './modules/[name]/[name].module.js';

@Module({
  imports: [
    // ... existing modules
    ResourceModule,
  ],
})
export class AppModule {}
```

---

## Add a Database Query

### 1. Add Method to FirestoreService

```typescript
// src/modules/cache/firestore.service.ts

// For simple document retrieval
async getResourceById(id: string): Promise<Resource | null> {
  const doc = await this.firestore
    .collection('resources')
    .doc(id)
    .get();

  return doc.exists ? (doc.data() as Resource) : null;
}

// For filtered queries
async getResourcesByType(type: string, limit = 50): Promise<Resource[]> {
  const snapshot = await this.firestore
    .collection('resources')
    .where('type', '==', type)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();

  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Resource));
}
```

### 2. Call from Service

```typescript
// src/modules/[domain]/[domain].service.ts
async getByType(type: string) {
  return this.firestoreService.getResourcesByType(type);
}
```

---

## Add Authentication to Endpoint

### User Authentication

```typescript
import { UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { FirebaseUser } from '../../common/decorators/current-user.decorator.js';

@Get('protected')
@UseGuards(FirebaseAuthGuard)
@ApiBearerAuth()
async protectedRoute(@CurrentUser() user: FirebaseUser) {
  // user.uid, user.email, user.name available
  return { userId: user.uid };
}
```

### Admin-Only Authentication

```typescript
import { AdminAuthGuard } from '../../common/guards/admin-auth.guard.js';
import { AdminUser } from '../../common/decorators/admin-user.decorator.js';
import type { AdminUserData } from '../../common/decorators/admin-user.decorator.js';

@Get('admin-only')
@UseGuards(AdminAuthGuard)
@ApiBearerAuth()
async adminRoute(@AdminUser() admin: AdminUserData) {
  // admin.email, admin.uid available
  return { admin: admin.email };
}
```

### Cron Job Authentication

```typescript
import { CronAuthGuard } from '../../common/guards/cron-auth.guard.js';

@Post('cron/task')
@UseGuards(CronAuthGuard)
async cronTask() {
  // Protected by X-Cron-Secret header
  return { executed: true };
}
```

---

## Add a Scheduled Task (Cron Job)

### 1. Add Endpoint to CronController

```typescript
// src/modules/cron/cron.controller.ts
@Post('my-task')
@UseGuards(CronAuthGuard)
@HttpCode(HttpStatus.OK)
@ApiOperation({ summary: 'My scheduled task' })
async myTask() {
  return this.cronService.executeMyTask();
}
```

### 2. Add Method to CronService

```typescript
// src/modules/cron/cron.service.ts
async executeMyTask(): Promise<{ success: boolean; message: string }> {
  this.logger.log('Starting my task...');

  try {
    // Task logic here
    return { success: true, message: 'Task completed' };
  } catch (error) {
    this.logger.error(`Task failed: ${error.message}`);
    return { success: false, message: error.message };
  }
}
```

### 3. Configure Cloud Scheduler

Create a Cloud Scheduler job that POSTs to `/api/cron/my-task` with header:
```
X-Cron-Secret: <CRON_SECRET_KEY value>
```

---

## Add Error Logging

### From Service/Controller

```typescript
import { ErrorCodes } from '../../common/constants/error-codes.js';

// In service
async someOperation() {
  try {
    // Operation
  } catch (error) {
    await this.firestoreService.logError({
      type: 'operation_error',
      code: ErrorCodes.CONVERSION_FAILED,
      message: error.message,
      severity: 'error',
      source: 'backend',
      context: { additionalInfo: 'value' },
    });
    throw error;
  }
}
```

### From Frontend (via API)

POST to `/api/errors`:
```json
{
  "type": "frontend_error",
  "code": "UPLOAD_FAILED",
  "message": "File upload failed",
  "severity": "error",
  "source": "frontend",
  "url": "/convert",
  "userAgent": "Mozilla/5.0..."
}
```

---

## Add a New Plan Feature Check

### 1. Update Plan Limits Interface

```typescript
// src/common/interfaces/user.interface.ts
export interface PlanLimits {
  maxLabelsPerPdf: number;
  maxPdfsPerMonth: number;
  canDownloadImages: boolean;
  newFeatureEnabled: boolean;  // Add new field
}

export const DEFAULT_PLAN_LIMITS: Record<PlanType, PlanLimits> = {
  free: { ..., newFeatureEnabled: false },
  pro: { ..., newFeatureEnabled: true },
  promax: { ..., newFeatureEnabled: true },
  enterprise: { ..., newFeatureEnabled: true },
};
```

### 2. Check in Service

```typescript
// src/modules/users/users.service.ts
async checkCanUseFeature(userId: string): Promise<boolean> {
  const user = await this.firestoreService.getUserById(userId);
  if (!user) return false;

  // Admin bypass
  if (user.role === 'admin' && !this.isSimulationActive(user)) {
    return true;
  }

  const limits = this.getEffectivePlanLimits(user);
  return limits.newFeatureEnabled;
}
```

---

## Add Stripe Webhook Handler

### 1. Add Handler in WebhooksService

```typescript
// src/modules/webhooks/webhooks.service.ts
async handleStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'customer.subscription.created':
      await this.handleSubscriptionCreated(event.data.object);
      break;
    case 'your.new.event':
      await this.handleYourNewEvent(event.data.object);
      break;
    // ... other events
  }
}

private async handleYourNewEvent(data: any): Promise<void> {
  this.logger.log('Handling your new event');
  // Implementation
}
```

---

## Run Development Server

```bash
# Start backend (port 8080)
cd /Users/gustavomarrero/Documents/node/zplpdf
PORT=8080 npm run start:dev

# In another terminal, start frontend (port 3000)
cd /Users/gustavomarrero/Documents/Next/zplpdf
npm run dev
```

Access points:
- Backend API: http://localhost:8080/api
- Swagger Docs: http://localhost:8080/docs
- Frontend: http://localhost:3000

---

## Deploy to Production

```bash
# Build Docker image
npm run deploy:build

# Deploy to Cloud Run
npm run deploy:run
```

---

## Create Firestore Index

When you see: "The query requires an index"

```bash
# Via gcloud CLI
gcloud firestore indexes composite create \
  --project=intranet-guatever \
  --collection-group=COLLECTION_NAME \
  --field-config=field-path=FIELD1,order=ascending \
  --field-config=field-path=FIELD2,order=descending
```

Or click the link in the error message to create via Firebase Console.

---

## Impersonar Usuario para Pruebas

Permite iniciar sesión como cualquier usuario registrado para probar la aplicación desde su perspectiva.

### Paso 1: Obtener el UID del Usuario

Desde Firebase Console:
1. Ir a https://console.firebase.google.com/project/intranet-guatever/authentication/users
2. Buscar el usuario por email
3. Copiar su **UID**

O consultar Firestore:
```bash
# Buscar usuario en la colección 'users'
```

### Paso 2: Generar Custom Token

Ejecutar desde el directorio del backend:

```bash
node --experimental-vm-modules -e "
import admin from 'firebase-admin';
import { readFileSync } from 'fs';

const creds = JSON.parse(readFileSync('./firebase-credentials.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(creds) });

const uid = 'UID_DEL_USUARIO_AQUI';
const token = await admin.auth().createCustomToken(uid);
console.log('Custom Token:');
console.log(token);
"
```

**Nota:** El token expira en 1 hora.

### Paso 3: Usar el Token en el Frontend

#### Opción A: Desde la Consola del Navegador (DevTools)

1. Abrir http://localhost:3000
2. Abrir DevTools (F12) → Console
3. Ejecutar:

```javascript
(async () => {
  const chunk = window.webpackChunk_N_E;
  let firebaseAuth = null;
  let firebaseApp = null;

  chunk.push([['temp_' + Date.now()], {}, (require) => {
    try {
      firebaseAuth = require("(app-pages-browser)/./node_modules/@firebase/auth/dist/esm/index.js");
      firebaseApp = require("(app-pages-browser)/./node_modules/@firebase/app/dist/esm/index.esm.js");
    } catch (e) {}
  }]);

  if (firebaseAuth && firebaseApp) {
    const app = firebaseApp.getApps()[0] || firebaseApp.getApp();
    const auth = firebaseAuth.getAuth(app);
    const token = 'PEGAR_TOKEN_AQUI';
    const result = await firebaseAuth.signInWithCustomToken(auth, token);
    console.log('Logged in as:', result.user.uid);
    location.reload();
  }
})();
```

4. La página se recargará con el nuevo usuario

#### Opción B: Usando Claude in Chrome (MCP)

Si tienes el MCP de Chrome configurado, Claude puede ejecutar el proceso automáticamente:

1. Proporcionar el UID del usuario
2. Claude genera el token y lo inyecta en el navegador
3. Se recarga la página automáticamente

### Ejemplo Completo

```bash
# 1. Generar token para usuario específico
node --experimental-vm-modules -e "
import admin from 'firebase-admin';
import { readFileSync } from 'fs';

const creds = JSON.parse(readFileSync('./firebase-credentials.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(creds) });

const uid = 'iitZttsKz8YHLRejioeIn9E8AT42';  // UID de Pablo
const token = await admin.auth().createCustomToken(uid);
console.log(token);
"
```

### Volver a tu Usuario Original

Simplemente cierra sesión desde la UI o ejecuta:

```javascript
(async () => {
  const chunk = window.webpackChunk_N_E;
  let firebaseAuth, firebaseApp;

  chunk.push([['temp'], {}, (require) => {
    firebaseAuth = require("(app-pages-browser)/./node_modules/@firebase/auth/dist/esm/index.js");
    firebaseApp = require("(app-pages-browser)/./node_modules/@firebase/app/dist/esm/index.esm.js");
  }]);

  const app = firebaseApp.getApps()[0];
  const auth = firebaseAuth.getAuth(app);
  await firebaseAuth.signOut(auth);
  location.reload();
})();
```

### Notas de Seguridad

- Solo usar en ambiente de **desarrollo local**
- El archivo `firebase-credentials.json` contiene credenciales sensibles
- Nunca commitear tokens generados
- Los tokens expiran en 1 hora
