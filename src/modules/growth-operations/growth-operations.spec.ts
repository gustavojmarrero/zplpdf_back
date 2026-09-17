import { randomUUID } from 'node:crypto';
import { Timestamp } from '@google-cloud/firestore';
import { GrowthOperationsController } from './growth-operations.module.js';
import { MemoryDb } from '../folder-automation/testing/memory-db.js';

describe('admin growth incidents', () => {
  let db: MemoryDb;
  let controller: GrowthOperationsController;
  let callbacks: { retryDeadDelivery: jest.Mock };
  beforeEach(() => {
    db = new MemoryDb();
    callbacks = {
      retryDeadDelivery: jest.fn().mockResolvedValue({ state: 'pending' }),
    };
    controller = new GrowthOperationsController(
      { getClient: () => db } as any,
      callbacks as any,
    );
  });
  it('requeues product events with the same identity and rejects missing or deleted source data', async () => {
    const key = 'a'.repeat(64);
    const expiresAt = Timestamp.fromMillis(Date.now() + 60000);
    const event = { accountId: 'owner', eventId: randomUUID(), expiresAt };
    db.rows.set(`product_events/${key}`, event);
    const dead = {
      state: 'dead',
      accountId: 'owner',
      eventKey: key,
      attempts: 8,
      expiresAt,
    };
    db.rows.set(`event_outbox/${key}`, { ...dead });
    await controller.retry('product_events', key);
    expect(db.rows.get(`event_outbox/${key}`)).toMatchObject({
      state: 'pending',
      eventKey: key,
      manualRetries: 1,
    });
    expect(db.rows.get(`product_events/${key}`)).toEqual(event);
    db.rows.set(`event_outbox/${key}`, { ...dead });
    db.rows.set('deleted_accounts/owner', {
      deletedAt: new Date().toISOString(),
    });
    await expect(controller.retry('product_events', key)).rejects.toThrow(
      'INCIDENT_NOT_RETRYABLE',
    );
    db.rows.delete('deleted_accounts/owner');
    db.rows.delete(`product_events/${key}`);
    await expect(controller.retry('product_events', key)).rejects.toThrow(
      'INCIDENT_NOT_RETRYABLE',
    );
    await expect(
      controller.retry('product_events', randomUUID()),
    ).rejects.toThrow('INVALID_INCIDENT_ID');
  });
  it('bounds the result and omits secrets, identities and arbitrary diagnostics', async () => {
    for (let i = 0; i < 51; i++)
      db.rows.set(`drive_revocations/${randomUUID()}`, {
        status: 'failed',
        accountId: 'private-account',
        secret: 'private-token',
        errorCode: 'person@example.com',
        createdAt: 'person@example.com',
        attempts: 8,
      });
    const result = await controller.list('drive_revocations');
    expect(result.truncated).toBe(true);
    expect(result.items).toHaveLength(50);
    expect(result.items[0]).toMatchObject({
      errorCode: null,
      createdAt: null,
      attempts: 8,
    });
    expect(JSON.stringify(result)).not.toMatch(/private-|example.com/);
    await expect(controller.list('__proto__')).rejects.toThrow(
      'UNKNOWN_INCIDENT_QUEUE',
    );
  });
  it('requeues revocation after account deletion without issuing a provider request', async () => {
    const id = randomUUID();
    db.rows.set('deleted_accounts/deleted', {
      deletedAt: new Date().toISOString(),
    });
    db.rows.set(`drive_revocations/${id}`, {
      status: 'failed',
      accountId: 'deleted',
      secret: 'encrypted',
      attempts: 8,
    });
    await expect(
      controller.retry('drive_revocations', id),
    ).resolves.toMatchObject({ id, status: 'queued' });
    expect(db.rows.get(`drive_revocations/${id}`)).toMatchObject({
      status: 'queued',
      attempts: 0,
      secret: 'encrypted',
    });
    await expect(controller.retry('drive_revocations', id)).rejects.toThrow(
      'REVOCATION_NOT_RETRYABLE',
    );
    expect(callbacks.retryDeadDelivery).not.toHaveBeenCalled();
  });
  it('uses the stored callback owner and preserves domain retry validation', async () => {
    const id = randomUUID();
    db.rows.set(`api_callback_deliveries/${id}`, {
      accountId: 'owner',
      callbackId: 'callback',
      state: 'dead',
    });
    await controller.retry('api_callbacks', id);
    expect(callbacks.retryDeadDelivery).toHaveBeenCalledWith(
      'owner',
      'callback',
      id,
    );
    callbacks.retryDeadDelivery.mockRejectedValueOnce(
      new Error('Delivery expired'),
    );
    await expect(controller.retry('api_callbacks', id)).rejects.toThrow(
      'Delivery expired',
    );
    await expect(
      controller.retry('api_callbacks', '../secret'),
    ).rejects.toThrow('INVALID_INCIDENT_ID');
    await expect(
      controller.retry('api_callbacks', randomUUID()),
    ).rejects.toThrow('INCIDENT_NOT_FOUND');
  });
});
