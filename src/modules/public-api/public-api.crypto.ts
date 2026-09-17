import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import type { SealedSecret } from './public-api.types.js';
export const hash = (...values: string[]) =>
  createHash('sha256').update(JSON.stringify(values)).digest('hex');
@Injectable()
export class PublicApiCrypto {
  constructor(private readonly config: ConfigService) {}
  private key() {
    const raw = this.config.get<string>('PUBLIC_API_ENCRYPTION_KEY');
    const key = raw ? Buffer.from(raw, 'base64') : Buffer.alloc(0);
    if (key.length !== 32 || key.toString('base64') !== raw)
      throw new ServiceUnavailableException(
        'PUBLIC_API_ENCRYPTION_KEY required',
      );
    return key;
  }
  seal(value: string, context: string): SealedSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);
    return {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }
  open(value: SealedSecret, context: string) {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key(),
      Buffer.from(value.iv, 'base64'),
    );
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}
