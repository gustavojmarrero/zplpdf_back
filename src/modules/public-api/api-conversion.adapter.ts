import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ZplService } from '../zpl/zpl.service.js';
import { ZplValidatorService } from '../zpl/validation/zpl-validator.service.js';
import { FirestoreService } from '../cache/firestore.service.js';
import type { ApiConversionPort } from './public-api.types.js';
@Injectable()
export class ApiConversionAdapter implements ApiConversionPort {
  constructor(
    private readonly zpl: ZplService,
    private readonly validator: ZplValidatorService,
    private readonly store: FirestoreService,
  ) {}
  async run(input: {
    operationId: string;
    accountId: string;
    zplContent: string;
    labelSize: string;
  }) {
    const validation = await this.validator.validate(input.zplContent, {
      language: 'en',
    });
    if (!validation.isValid) throw new BadRequestException('INVALID_ZPL');
    return this.zpl.runDurableConversion({
      operationId: input.operationId,
      userId: input.accountId,
      zplContent: input.zplContent,
      labelSize: input.labelSize,
    });
  }
  async result(jobId: string, accountId: string) {
    const row = (
      await this.store
        .getClient()
        .collection('durable_operations')
        .doc(jobId)
        .get()
    ).data();
    if (
      !row ||
      row.userId !== accountId ||
      row.status !== 'completed' ||
      !row.storagePath
    )
      throw new NotFoundException('Result unavailable');
    return {
      url: await this.zpl.generateSignedUrl(row.storagePath, `${jobId}.pdf`),
      filename: `${jobId}.pdf`,
    };
  }
}
