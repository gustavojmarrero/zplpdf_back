import {
  BadRequestException,
  ConflictException,
  GoneException,
  NotFoundException,
  Injectable,
} from '@nestjs/common';
import { FieldValue } from '@google-cloud/firestore';
import { createHmac, randomUUID } from 'node:crypto';
import { FirestoreService } from '../cache/firestore.service.js';
import { ApiCredentialsService } from './api-credentials.service.js';
import { PublicApiCrypto } from './public-api.crypto.js';
import { CallbackTransport } from './callback-transport.service.js';
export function callbackSignature(
  secret: string,
  timestamp: string,
  body: string,
) {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}
@Injectable()
export class ApiCallbacksService {
  constructor(
    private readonly store: FirestoreService,
    private readonly credentials: ApiCredentialsService,
    private readonly crypto: PublicApiCrypto,
    private readonly transport: CallbackTransport,
  ) {}
  async deliveries(accountId: string, callbackId: string) {
    await this.credentials.callback(accountId, callbackId, true);
    const rows = await this.store
      .getClient()
      .collection('api_callback_deliveries')
      .where('callbackId', '==', callbackId)
      .limit(100)
      .get();
    return {
      items: rows.docs.map((doc) => {
        const row = doc.data();
        return {
          id: doc.id,
          jobId: row.jobId,
          state: row.state,
          attempts: row.attempts,
          lastErrorCode: row.lastErrorCode ?? null,
          createdAt: row.createdAt,
          deliveredAt: row.deliveredAt ?? null,
        };
      }),
    };
  }
  async retryDeadDelivery(
    accountId: string,
    callbackId: string,
    deliveryId: string,
  ) {
    await this.credentials.callback(accountId, callbackId);
    if (!/^[0-9a-f-]{36}$/.test(deliveryId)) throw new NotFoundException();
    const db = this.store.getClient();
    return db.runTransaction(async (tx) => {
      const ref = db.collection('api_callback_deliveries').doc(deliveryId);
      const row = (await tx.get(ref)).data();
      const deleted = await tx.get(
        db.collection('deleted_accounts').doc(accountId),
      );
      const endpoint = (
        await tx.get(db.collection('api_callback_endpoints').doc(callbackId))
      ).data();
      if (!endpoint || endpoint.accountId !== accountId || endpoint.revokedAt)
        throw new NotFoundException('Callback unavailable');
      if (deleted.exists) throw new GoneException('Account unavailable');
      if (!row || row.accountId !== accountId || row.callbackId !== callbackId)
        throw new NotFoundException();
      if (row.state !== 'dead')
        throw new ConflictException('Only dead deliveries can retry');
      if (row.expiresAt.toMillis() <= Date.now())
        throw new GoneException('Delivery expired');
      tx.update(ref, {
        state: 'pending',
        attempts: 0,
        availableAt: new Date().toISOString(),
        token: FieldValue.delete(),
        lastErrorCode: FieldValue.delete(),
      });
      return { id: deliveryId, state: 'pending' };
    });
  }
  async dispatchCallbacks(limit = 20) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new BadRequestException('Invalid worker limit');
    const db = this.store.getClient();
    const due = await db
      .collection('api_callback_deliveries')
      .where('availableAt', '<=', new Date().toISOString())
      .orderBy('availableAt')
      .limit(limit)
      .get();
    let delivered = 0;
    for (const entry of due.docs) {
      const token = randomUUID();
      const row: any = await db.runTransaction(async (tx) => {
        const current = (await tx.get(entry.ref)).data();
        if (
          !current ||
          !['pending', 'leased'].includes(current.state) ||
          current.availableAt > new Date().toISOString()
        )
          return null;
        if (
          current.attempts >= 8 ||
          current.expiresAt.toMillis() <= Date.now()
        ) {
          tx.update(entry.ref, {
            state: 'dead',
            availableAt: FieldValue.delete(),
            lastErrorCode: 'DELIVERY_EXHAUSTED',
          });
          return null;
        }
        tx.update(entry.ref, {
          state: 'leased',
          token,
          attempts: current.attempts + 1,
          availableAt: new Date(Date.now() + 30000).toISOString(),
        });
        return { ...current, attempts: current.attempts + 1 };
      });
      if (!row) continue;
      let success = false;
      try {
        if (await this.store.isAccountDeletionMarked(row.accountId))
          throw new Error('ACCOUNT_UNAVAILABLE');
        const endpoint = await this.credentials.callback(
          row.accountId,
          row.callbackId,
        );
        const secret = this.crypto.open(
          endpoint.secret,
          `${row.accountId}:${row.callbackId}`,
        );
        const timestamp = String(Math.floor(Date.now() / 1000));
        const body = JSON.stringify(row.payload);
        await this.transport.send(endpoint.url, body, {
          'X-ZPLPDF-Event-Id': entry.id,
          'X-ZPLPDF-Timestamp': timestamp,
          'X-ZPLPDF-Signature': callbackSignature(secret, timestamp, body),
        });
        success = true;
      } catch {
        /* Persist codes only, never transport messages or secrets. */
      }
      const ack = await db.runTransaction(async (tx) => {
        const current = (await tx.get(entry.ref)).data();
        if (
          !current ||
          current.state !== 'leased' ||
          current.token !== token ||
          current.availableAt <= new Date().toISOString()
        )
          return false;
        const dead = current.attempts >= 8;
        tx.update(entry.ref, {
          state: success ? 'delivered' : dead ? 'dead' : 'pending',
          token: FieldValue.delete(),
          availableAt:
            success || dead
              ? FieldValue.delete()
              : new Date(
                  Date.now() + Math.min(3600000, 1000 * 2 ** current.attempts),
                ).toISOString(),
          ...(success
            ? {
                deliveredAt: new Date().toISOString(),
                lastErrorCode: FieldValue.delete(),
              }
            : { lastErrorCode: 'CALLBACK_DELIVERY_FAILED' }),
        });
        return true;
      });
      if (ack && success) delivered++;
    }
    return { scanned: due.size, delivered };
  }
}
