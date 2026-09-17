import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FirestoreService } from '../cache/firestore.service.js';
import { StorageService } from '../storage/storage.service.js';
import { PDFDocument } from 'pdf-lib';
import { createHash } from 'node:crypto';
@Injectable()
export class OwnedPdfService {
  constructor(
    private readonly store: FirestoreService,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
  ) {}
  async load(accountId: string, conversionId: string) {
    const row = (
      await this.store
        .getClient()
        .collection('durable_operations')
        .doc(conversionId)
        .get()
    ).data();
    let path: string;
    if (
      row?.userId === accountId &&
      row.status === 'completed' &&
      row.outputFormat === 'pdf'
    )
      path = row.storagePath;
    if (!path) {
      const legacy = await this.store.getConversionStatus(conversionId);
      if (
        legacy?.userId !== accountId ||
        legacy.status !== 'completed' ||
        legacy.outputFormat !== 'pdf' ||
        !legacy.resultUrl
      )
        throw new NotFoundException('Owned PDF unavailable');
      const url = new URL(legacy.resultUrl);
      const bucket =
        this.config.get<string>('GCP_STORAGE_BUCKET') || 'zplpdf-app-files';
      if (
        url.protocol !== 'https:' ||
        url.hostname !== 'storage.googleapis.com' ||
        !url.pathname.startsWith(`/${bucket}/`)
      )
        throw new NotFoundException('Owned PDF unavailable');
      path = decodeURIComponent(url.pathname.slice(bucket.length + 2));
    }
    return { path, ...(await this.read(path)) };
  }
  async read(path: string) {
    const pdf = await this.storage.readFile(path, 10 * 1024 * 1024);
    if (!pdf) throw new NotFoundException('PDF expired');
    if (pdf.subarray(0, 5).toString() !== '%PDF-')
      throw new BadRequestException('PDF required');
    const document = await PDFDocument.load(pdf);
    const pages = document.getPageCount();
    if (pages < 1 || pages > 500)
      throw new BadRequestException('PDF page limit');
    return {
      pdf,
      pages,
      checksum: createHash('sha256').update(pdf).digest('hex'),
    };
  }
}
