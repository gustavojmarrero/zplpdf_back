import { Injectable } from '@nestjs/common';
import axios from 'axios';
export class PrintProviderError extends Error {
  constructor(readonly status?: number) {
    super('PRINT_PROVIDER_REQUEST_FAILED');
  }
}
@Injectable()
export class PrintNodeProvider {
  private async request(
    key: string,
    path: string,
    method = 'GET',
    data?: unknown,
    headers: Record<string, string> = {},
  ) {
    try {
      return (
        await axios.request({
          url: `https://api.printnode.com${path}`,
          method,
          data,
          auth: { username: key, password: '' },
          headers,
          timeout: 15000,
          maxRedirects: 0,
          proxy: false,
          maxContentLength: 1024 * 1024,
          maxBodyLength: 16 * 1024 * 1024,
        })
      ).data;
    } catch (error) {
      throw new PrintProviderError(error?.response?.status);
    }
  }
  async printers(key: string) {
    const result = await this.request(key, '/printers?limit=100');
    if (!Array.isArray(result)) throw new PrintProviderError();
    return result;
  }
  async printer(key: string, id: number) {
    const result = await this.request(key, `/printers/${id}`);
    if (!Array.isArray(result) || result.length !== 1 || result[0].id !== id)
      throw new PrintProviderError(404);
    return result[0];
  }
  async submit(
    key: string,
    printerId: number,
    pdf: Buffer,
    operationId: string,
  ) {
    const id = await this.request(
      key,
      '/printjobs',
      'POST',
      {
        printerId,
        title: `ZPLPDF ${operationId}`,
        contentType: 'pdf_base64',
        content: pdf.toString('base64'),
        source: 'ZPLPDF',
        expireAfter: 600,
        qty: 1,
      },
      { 'X-Idempotency-Key': operationId },
    );
    if (!Number.isSafeInteger(id) || id < 1) throw new PrintProviderError();
    return id as number;
  }
  async states(key: string, id: number) {
    const value = await this.request(key, `/printjobs/${id}/states`);
    if (!Array.isArray(value) || !Array.isArray(value[0]))
      throw new PrintProviderError();
    return value[0].filter((row) => row.printJobId === id);
  }
}
