import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { FirestoreService } from '../cache/firestore.service.js';
import { FeatureFlagsService } from '../product-observability/feature-flags.service.js';
import { PublicApiCrypto, hash } from './public-api.crypto.js';
import { CallbackTransport } from './callback-transport.service.js';
import { API_SCOPES } from './public-api.types.js';
import type { ApiPrincipal, ApiScope } from './public-api.types.js';
@Injectable()
export class ApiCredentialsService {
  constructor(
    private readonly store: FirestoreService,
    private readonly flags: FeatureFlagsService,
    private readonly crypto: PublicApiCrypto,
    private readonly transport: CallbackTransport,
  ) {}
  async createKey(accountId: string, input: unknown) {
    const value = input as { scopes: ApiScope[] };
    if (
      !value ||
      Object.keys(value).some((k) => k !== 'scopes') ||
      !Array.isArray(value.scopes) ||
      !value.scopes.length ||
      value.scopes.length > 2 ||
      new Set(value.scopes).size !== value.scopes.length ||
      !value.scopes.every((s) => API_SCOPES.includes(s))
    )
      throw new BadRequestException('Invalid scopes');
    await this.flags.assertFeatureAvailable(accountId, 'self_service_api');
    const id = randomUUID(),
      secret = randomBytes(32).toString('base64url');
    const row = {
      id,
      accountId,
      scopes: value.scopes,
      secretHash: hash(secret),
      prefix: `zpk_${id.slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      revokedAt: null,
      lastUsedAt: null,
    };
    await this.createLimited(accountId, 'keys', 10, 'api_credentials', id, row);
    const { secretHash: _hash, ...safe } = row;
    return { ...safe, token: `zpk_${id}.${secret}` };
  }
  private async createLimited(
    accountId: string,
    kind: 'keys' | 'callbacks',
    limit: number,
    collection: string,
    id: string,
    row: object,
  ) {
    const db = this.store.getClient();
    await db.runTransaction(async (tx) => {
      if (
        (await tx.get(db.collection('deleted_accounts').doc(accountId))).exists
      )
        throw new GoneException('Account unavailable');
      const counter = db.collection('api_account_limits').doc(hash(accountId));
      const prior = await tx.get(counter);
      const count = prior.get(kind) ?? 0;
      if (count >= limit)
        throw new ForbiddenException('Account credential limit reached');
      tx.set(counter, { accountId, [kind]: count + 1 }, { merge: true });
      tx.create(db.collection(collection).doc(id), row);
    });
  }
  async authenticate(token: string): Promise<ApiPrincipal> {
    const match = /^zpk_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(
      token ?? '',
    );
    if (!match) throw new UnauthorizedException('Invalid API key');
    const ref = this.store
      .getClient()
      .collection('api_credentials')
      .doc(match[1]);
    const row = (await ref.get()).data();
    const expected = row?.secretHash;
    const actual = hash(match[2]);
    if (
      !row ||
      row.revokedAt ||
      typeof expected !== 'string' ||
      expected.length !== actual.length ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
    )
      throw new UnauthorizedException('Invalid API key');
    await this.flags.account(row.accountId);
    await ref.update({ lastUsedAt: new Date().toISOString() });
    return {
      accountId: row.accountId,
      credentialId: match[1],
      scopes: row.scopes,
    };
  }
  async list(accountId: string, kind: 'keys' | 'callbacks') {
    const collection =
      kind === 'keys' ? 'api_credentials' : 'api_callback_endpoints';
    const rows = await this.store
      .getClient()
      .collection(collection)
      .where('accountId', '==', accountId)
      .limit(100)
      .get();
    return {
      items: rows.docs.map((doc) => {
        const {
          secretHash: _hash,
          secret: _secret,
          accountId: _account,
          ...safe
        } = doc.data();
        return safe;
      }),
    };
  }
  async revoke(accountId: string, id: string, kind: 'keys' | 'callbacks') {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new NotFoundException();
    const db = this.store.getClient();
    const ref = db
      .collection(
        kind === 'keys' ? 'api_credentials' : 'api_callback_endpoints',
      )
      .doc(id);
    await db.runTransaction(async (tx) => {
      const row = (await tx.get(ref)).data();
      const counter = db.collection('api_account_limits').doc(hash(accountId));
      const counts = await tx.get(counter);
      if (!row || row.accountId !== accountId) throw new NotFoundException();
      if (row.revokedAt) return;
      tx.update(ref, { revokedAt: new Date().toISOString() });
      tx.set(
        counter,
        { accountId, [kind]: Math.max(0, (counts.get(kind) ?? 1) - 1) },
        { merge: true },
      );
    });
    return { revoked: true };
  }
  async createCallback(accountId: string, input: unknown) {
    const value = input as { url: string };
    if (
      !value ||
      Object.keys(value).some((k) => k !== 'url') ||
      typeof value.url !== 'string'
    )
      throw new BadRequestException('Invalid callback');
    await this.flags.assertFeatureAvailable(accountId, 'self_service_api');
    await this.transport.resolve(value.url);
    const id = randomUUID(),
      secret = randomBytes(32).toString('hex');
    const row = {
      id,
      accountId,
      url: value.url,
      secret: this.crypto.seal(secret, `${accountId}:${id}`),
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    await this.createLimited(
      accountId,
      'callbacks',
      5,
      'api_callback_endpoints',
      id,
      row,
    );
    const { secret: _secret, ...safe } = row;
    return { ...safe, signingSecret: secret };
  }
  async callback(accountId: string, id: string, allowRevoked = false) {
    const row = (
      await this.store
        .getClient()
        .collection('api_callback_endpoints')
        .doc(id)
        .get()
    ).data();
    if (!row || row.accountId !== accountId || (row.revokedAt && !allowRevoked))
      throw new NotFoundException('Callback unavailable');
    return row;
  }
}
