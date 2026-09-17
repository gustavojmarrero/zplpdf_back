import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { FirestoreService } from '../cache/firestore.service.js';
import { StorageService } from '../storage/storage.service.js';
import { UsersService } from '../users/users.service.js';
import { FeatureFlagsService } from '../product-observability/feature-flags.service.js';
import { ProductObservabilityService } from '../product-observability/product-observability.service.js';
import { DurableOperationRepository } from '../../common/services/durable-operation.repository.js';
import { preparePdf, PdfRecipe } from './pdf-layout.js';
@Injectable()
export class PdfPreparationService {
  constructor(
    private readonly firestore: FirestoreService,
    private readonly storage: StorageService,
    private readonly users: UsersService,
    private readonly flags: FeatureFlagsService,
    private readonly events: ProductObservabilityService,
  ) {}
  async export(
    accountId: string,
    operationId: string,
    input: Buffer,
    recipe: PdfRecipe,
    source: 'api' | 'folder' = 'api',
  ) {
    const feature = await this.flags.assertFeatureAvailable(
      accountId,
      'pdf_preparation',
    );
    if (!isUUID(operationId, '4'))
      throw new BadRequestException('INVALID_OPERATION_ID');
    const fingerprint = createHash('sha256')
      .update(input)
      .update(JSON.stringify(recipe))
      .digest('hex');
    const db = this.firestore.getClient();
    const prior = (
      await db.collection('durable_operations').doc(operationId).get()
    ).data();
    if (
      prior &&
      (prior.userId !== accountId || prior.fingerprint !== fingerprint)
    )
      throw new BadRequestException('OPERATION_PAYLOAD_CONFLICT');
    if (prior?.status === 'completed')
      return this.status(accountId, operationId);
    // Parsing and validation happens before reserving quota; no durable success yet.
    const result = await preparePdf(input, recipe);
    const permission = await this.users.checkCanConvert(
      accountId,
      result.labelCount,
      prior?.reserved ? 1 : 0,
    );
    if (!permission.allowed) throw new ForbiddenException(permission.errorCode);
    const user = await this.users.getUserById(accountId);
    if (!user) throw new GoneException('Account unavailable');
    const sourcePath = `debug-zpl/${accountId}/pdf/${operationId}.pdf`;
    const outputPath = `debug-zpl/${accountId}/pdf/${operationId}-prepared.pdf`;
    const repository = new DurableOperationRepository(db);
    const claim = await repository.claim({
      operationId,
      userId: accountId,
      fingerprint,
      period: permission.periodInfo,
      maxPdfs: this.users.getEffectivePlanLimits(user).maxPdfsPerMonth,
      labelCount: result.labelCount,
      userPlan: this.users.getEffectivePlan(user),
      labelSize: recipe.paper,
      outputFormat: 'pdf',
      sourcePath,
      kind: 'pdf',
      recovery: { recipe, source },
    });
    if (claim.completed) return this.status(accountId, operationId);
    try {
      await this.storage.saveFile(sourcePath, input, 'application/pdf');
      await this.storage.saveFile(outputPath, result.buffer, 'application/pdf');
      const url = await this.storage.generateSignedUrlForPath(
        outputPath,
        'prepared-labels.pdf',
        15,
      );
      await repository.finish(
        operationId,
        claim.token,
        { url, filename: 'prepared-labels.pdf', storagePath: outputPath },
        async (tx) => {
          await this.events.recordServerEvent(
            {
              eventId: randomUUID(),
              schemaVersion: 1,
              eventName: 'pdf_preparation_export_succeeded',
              accountId,
              featureId: 'pdf_preparation',
              featureVersion: feature.featureVersion,
              operationId,
              occurredAt: new Date().toISOString(),
              source,
              jobId: operationId,
              labelCount: result.labelCount,
            },
            tx,
          );
        },
      );
      this.users.invalidateHistoryScanCache(accountId);
      return this.status(accountId, operationId);
    } catch (error) {
      await repository.fail(operationId, claim.token);
      if (await this.firestore.isAccountDeletionMarked(accountId)) {
        await this.storage.deleteFile(sourcePath);
        await this.storage.deleteFile(outputPath);
      }
      throw error;
    }
  }
  async recover() {
    const db = this.firestore.getClient();
    const rows = await db
      .collection('durable_operations')
      .where('leaseUntil', '>', 0)
      .where('leaseUntil', '<=', Date.now())
      .limit(50)
      .get();
    let recovered = 0,
      failed = 0;
    for (const doc of rows.docs) {
      const row = doc.data();
      if (row.kind !== 'pdf' || row.status !== 'processing') continue;
      try {
        const input = await this.storage.readFile(row.sourcePath);
        if (!input || !row.recovery?.recipe)
          throw new Error('SOURCE_UNAVAILABLE');
        await this.export(
          row.userId,
          doc.id,
          input,
          row.recovery.recipe,
          row.recovery.source === 'folder' ? 'folder' : 'api',
        );
        recovered++;
      } catch {
        await new DurableOperationRepository(db).fail(doc.id, row.token);
        failed++;
      }
    }
    return { scanned: rows.size, recovered, failed };
  }
  async status(accountId: string, operationId: string) {
    if (!isUUID(operationId, '4')) throw new NotFoundException();
    if (await this.firestore.isAccountDeletionMarked(accountId))
      throw new GoneException();
    const row = (
      await this.firestore
        .getClient()
        .collection('durable_operations')
        .doc(operationId)
        .get()
    ).data();
    if (!row || row.userId !== accountId || row.kind !== 'pdf')
      throw new NotFoundException();
    if (row.expiresAt.toMillis() <= Date.now())
      throw new GoneException('PDF_EXPIRED');
    return {
      operationId,
      status: row.status,
      labelCount: row.labelCount,
      paper: row.labelSize,
      expiresAt: row.expiresAt.toDate().toISOString(),
      downloadUrl:
        row.status === 'completed'
          ? await this.storage.generateSignedUrlForPath(
              row.storagePath,
              'prepared-labels.pdf',
              15,
            )
          : null,
    };
  }
}
