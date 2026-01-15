# Code Patterns Reference

## Database Query Patterns (Firestore)

All database operations go through `src/modules/cache/firestore.service.ts`.

### Get Document by ID
```typescript
// Location: src/modules/cache/firestore.service.ts
async getUserById(userId: string): Promise<User | null> {
  const doc = await this.firestore
    .collection(this.usersCollection)
    .doc(userId)
    .get();

  if (!doc.exists) {
    return null;
  }

  return doc.data() as User;
}
```

### Save/Update Document (Merge)
```typescript
// Location: src/modules/cache/firestore.service.ts
async saveConversionStatus(jobId: string, status: ConversionStatus): Promise<void> {
  await this.firestore
    .collection(this.collectionName)
    .doc(jobId)
    .set(status, { merge: true });
}
```

### Create New Document
```typescript
// Location: src/modules/cache/firestore.service.ts
async createUser(user: User): Promise<void> {
  await this.firestore
    .collection(this.usersCollection)
    .doc(user.id)
    .set(user);
}
```

### Update Specific Fields
```typescript
// Location: src/modules/cache/firestore.service.ts
async updateUser(userId: string, updates: Partial<User>): Promise<void> {
  await this.firestore
    .collection(this.usersCollection)
    .doc(userId)
    .update({
      ...updates,
      updatedAt: new Date(),
    });
}
```

### Query with Filters
```typescript
// Location: src/modules/cache/firestore.service.ts
async getErrorLogs(filters: ErrorFilters): Promise<PaginatedErrors> {
  let query = this.firestore.collection('error_logs')
    .orderBy('createdAt', 'desc');

  if (filters.severity) {
    query = query.where('severity', '==', filters.severity);
  }
  if (filters.startDate) {
    query = query.where('createdAt', '>=', filters.startDate);
  }

  const snapshot = await query.limit(filters.limit || 50).get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}
```

### Increment Counter (Atomic)
```typescript
// Location: src/modules/cache/firestore.service.ts
import { FieldValue } from '@google-cloud/firestore';

async incrementUsage(userId: string, pdfs: number, labels: number): Promise<void> {
  await this.firestore
    .collection(this.usageCollection)
    .doc(userId)
    .update({
      pdfCount: FieldValue.increment(pdfs),
      labelCount: FieldValue.increment(labels),
    });
}
```

## API Controller Patterns

### Standard CRUD Controller
```typescript
// Location: src/modules/[domain]/[domain].controller.ts
@ApiTags('resource')
@Controller('resource')
export class ResourceController {
  constructor(private readonly service: ResourceService) {}

  @Get()
  findAll(@Query() query: FilterDto) {
    return this.service.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateDto) {
    return this.service.create(dto);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
```

### Protected Endpoint (User Auth)
```typescript
// Location: src/modules/users/users.controller.ts:92
@Get('me')
@UseGuards(FirebaseAuthGuard)
@ApiBearerAuth()
getUserProfile(@CurrentUser() user: FirebaseUser) {
  return this.usersService.getUserProfile(user.uid);
}
```

### Admin-Only Endpoint
```typescript
// Location: src/modules/admin/admin.controller.ts:98
@Get('metrics')
@UseGuards(AdminAuthGuard)
@ApiBearerAuth()
async getMetrics(@AdminUser() admin: AdminUserData) {
  this.logger.log(`Admin ${admin.email} requesting metrics`);
  return this.adminService.getDashboardMetrics();
}
```

### File Upload Endpoint
```typescript
// Location: src/modules/zpl/zpl.controller.ts:61
@Post('convert')
@UseGuards(FirebaseAuthGuard)
@UseInterceptors(FileInterceptor('file'))
@ApiConsumes('multipart/form-data')
async convertZpl(
  @CurrentUser() user: FirebaseUser,
  @Body() dto: ConvertZplDto,
  @UploadedFile(
    new ParseFilePipe({
      validators: [new MaxFileSizeValidator({ maxSize: 1024 * 1024 })],
      fileIsRequired: false,
    }),
  ) file?: Express.Multer.File,
) {
  const content = file ? file.buffer.toString('utf-8') : dto.zplContent;
  // Process content...
}
```

### Cron-Protected Endpoint
```typescript
// Location: src/modules/cron/cron.controller.ts:21
@Post('reset-usage')
@UseGuards(CronAuthGuard)
@HttpCode(HttpStatus.OK)
async resetUsage() {
  return this.cronService.resetMonthlyUsage();
}
```

## Service Patterns

### Basic Injectable Service
```typescript
// Location: src/modules/[domain]/[domain].service.ts
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class ResourceService {
  private readonly logger = new Logger(ResourceService.name);

  constructor(
    private readonly firestoreService: FirestoreService,
  ) {}

  async findOne(id: string): Promise<Resource | null> {
    return this.firestoreService.getResourceById(id);
  }
}
```

### Service with Plan Limits Check
```typescript
// Location: src/modules/users/users.service.ts:317
async checkCanConvert(userId: string, labelCount: number): Promise<CheckCanConvertResult> {
  const user = await this.firestoreService.getUserById(userId);

  if (!user) {
    return { allowed: false, error: 'User not found', errorCode: 'USER_NOT_FOUND' };
  }

  // Admin bypass
  if (user.role === 'admin' && !this.isSimulationActive(user)) {
    return { allowed: true };
  }

  // Check limits
  const limits = this.getEffectivePlanLimits(user);
  if (labelCount > limits.maxLabelsPerPdf) {
    return {
      allowed: false,
      error: `Your plan allows ${limits.maxLabelsPerPdf} labels per PDF`,
      errorCode: 'LABEL_LIMIT_EXCEEDED',
      data: { requested: labelCount, allowed: limits.maxLabelsPerPdf },
    };
  }

  return { allowed: true };
}
```

### Fire-and-Forget Pattern
```typescript
// Location: src/modules/users/users.service.ts:431
// Update stats without waiting (non-blocking)
this.firestoreService
  .incrementDailyStats(userId, plan, 1, labelCount, status)
  .catch((err) => this.logger.error(`Failed to update daily stats: ${err.message}`));
```

## Module Pattern

```typescript
// Location: src/modules/[domain]/[domain].module.ts
import { Module } from '@nestjs/common';

@Module({
  imports: [
    CacheModule,      // For FirestoreService
    AuthModule,       // For FirebaseAdminService
  ],
  controllers: [ResourceController],
  providers: [ResourceService],
  exports: [ResourceService],
})
export class ResourceModule {}
```

## Error Handling Patterns

### Standard HTTP Exception
```typescript
// Location: src/modules/zpl/zpl.controller.ts:177
import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCodes } from '../../common/constants/error-codes.js';

throw new HttpException(
  {
    error: ErrorCodes.INVALID_ZPL,
    message: 'ZPL content has syntax errors',
    data: {
      errors: validation.errors.slice(0, 5),
      summary: validation.summary,
    },
  },
  HttpStatus.BAD_REQUEST,
);
```

### Forbidden Exception
```typescript
// Location: src/modules/users/users.service.ts:161
import { ForbiddenException } from '@nestjs/common';

if (!user) {
  throw new ForbiddenException('User not found');
}
```

## DTO Pattern with Validation

```typescript
// Location: src/modules/[domain]/dto/create-[domain].dto.ts
import { IsString, IsOptional, IsEnum, IsNotEmpty } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateResourceDto {
  @ApiProperty({ description: 'Resource name' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ description: 'Optional description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: ['active', 'inactive'], default: 'active' })
  @IsEnum(['active', 'inactive'])
  status: string = 'active';
}
```

## Swagger Documentation Pattern

```typescript
// Location: src/modules/[domain]/[domain].controller.ts
@ApiOperation({
  summary: 'Short description',
  description: 'Detailed description of what this endpoint does.',
})
@ApiResponse({
  status: HttpStatus.OK,
  description: 'Success response description',
  schema: {
    properties: {
      id: { type: 'string', example: 'abc123' },
      name: { type: 'string', example: 'Example' },
    },
  },
})
@ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Resource not found' })
```

## Rate Limiting Pattern (Bottleneck)

```typescript
// Location: src/modules/zpl/zpl.service.ts
import Bottleneck from 'bottleneck';

export class ZplService {
  private limiter: Bottleneck;

  constructor() {
    this.limiter = new Bottleneck({
      maxConcurrent: 3,
      minTime: 1000, // 1 request per second
    });
  }

  async callLabelaryApi(zpl: string): Promise<Buffer> {
    return this.limiter.schedule(() => this.makeApiCall(zpl));
  }
}
```

## Cloud Storage Pattern

```typescript
// Location: src/modules/storage/storage.service.ts
async uploadFile(buffer: Buffer, filename: string): Promise<string> {
  const bucket = this.storage.bucket(this.bucketName);
  const file = bucket.file(filename);

  await file.save(buffer, {
    contentType: 'application/pdf',
    resumable: false,
  });

  const [signedUrl] = await file.getSignedUrl({
    action: 'read',
    expires: Date.now() + 60 * 60 * 1000, // 1 hour
  });

  return signedUrl;
}
```

## Circular Dependency Resolution

```typescript
// Location: src/modules/users/users.service.ts:35
import { Inject, forwardRef } from '@nestjs/common';

@Injectable()
export class UsersService {
  constructor(
    @Inject(forwardRef(() => EmailService))
    private readonly emailService: EmailService,
  ) {}
}
```
