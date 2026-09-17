import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Timestamp } from '@google-cloud/firestore';
import { randomUUID } from 'node:crypto';
import { catchError } from 'rxjs/operators';
import { FirestoreService } from '../cache/firestore.service.js';
import { FeatureFlagsService } from './feature-flags.service.js';

const QUOTA_CODES = new Set([
  'MONTHLY_LIMIT_EXCEEDED',
  'LABEL_LIMIT_EXCEEDED',
  'BATCH_LIMIT_EXCEEDED',
]);
export function classifyOperationalError(error: unknown) {
  const statusCode = error instanceof HttpException ? error.getStatus() : 500;
  const response = error instanceof HttpException ? error.getResponse() : null;
  const values =
    typeof response === 'object' && response !== null
      ? [(response as any).error, (response as any).message]
      : [response];
  const quota = values.find((v) => typeof v === 'string' && QUOTA_CODES.has(v));
  return {
    kind: quota ? 'quota_rejected' : 'http_error',
    code: quota ?? (statusCode >= 500 ? 'SERVER_FAILURE' : 'REQUEST_REJECTED'),
    statusCode,
  };
}
export function signalFeature(path: string): string | null {
  const routes: [RegExp, string][] = [
    [/^\/(?:api\/)?(?:workflows)(?:\/|$)/, 'packing_workflow'],
    [
      /^\/(?:api\/)?(?:label-templates|template-runs)(?:\/|$)/,
      'data_templates',
    ],
    [/^\/(?:api\/)?v1\/jobs(?:\/|$)/, 'self_service_api'],
    [/^\/(?:api\/)?pdf-preparation(?:\/|$)/, 'pdf_preparation'],
    [/^\/(?:api\/)?integrations\/drive(?:\/|$)/, 'folder_automation'],
    [/^\/(?:api\/)?(?:direct-print|print)(?:\/|$)/, 'direct_print'],
    [/^\/(?:api\/)?template-regression(?:\/|$)/, 'template_regression'],
    [/^\/(?:api\/)?zpl\/(?:convert|batch)(?:\/|$)/, 'legacy_conversion'],
  ];
  return routes.find(([pattern]) => pattern.test(path))?.[1] ?? null;
}
@Injectable()
export class OperationalSignalsService {
  private readonly logger = new Logger(OperationalSignalsService.name);
  constructor(
    private readonly store: FirestoreService,
    private readonly flags: FeatureFlagsService,
    private readonly config: ConfigService,
  ) {}
  async record(accountId: string, featureId: string, error: unknown) {
    const signal = classifyOperationalError(error);
    try {
      const account = await this.flags.account(accountId);
      const db = this.store.getClient();
      const now = new Date();
      const environment =
        this.config.get<string>('PRODUCT_ENVIRONMENT') ??
        this.config.get<string>('NODE_ENV') ??
        'development';
      const row = {
        id: randomUUID(),
        accountId,
        featureId,
        ...signal,
        environment,
        isSynthetic: account.isSynthetic,
        occurredAt: now.toISOString(),
        expiresAt: Timestamp.fromMillis(now.getTime() + 90 * 86400000),
      };
      await db.runTransaction(async (tx) => {
        const [deleted, user] = await Promise.all([
          tx.get(db.doc(`deleted_accounts/${accountId}`)),
          tx.get(db.doc(`users/${accountId}`)),
        ]);
        if (deleted.exists || !user.exists) return;
        tx.create(db.doc(`growth_operational_signals/${row.id}`), row);
      });
    } catch {
      // Preserve the original business failure, never include payload/provider details.
      this.logger.warn('OPERATIONAL_SIGNAL_PERSIST_FAILED');
    }
  }
}
@Injectable()
export class OperationalSignalsInterceptor implements NestInterceptor {
  constructor(private readonly signals: OperationalSignalsService) {}
  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest();
    const accountId =
      req.user?.uid ?? req.apiPrincipal?.accountId ?? req.apiKey?.accountId;
    const featureId = signalFeature(req.path ?? '');
    if (!accountId || !featureId) return next.handle();
    return next.handle().pipe(
      catchError(async (error) => {
        await this.signals.record(accountId, featureId, error);
        throw error;
      }),
    );
  }
}
