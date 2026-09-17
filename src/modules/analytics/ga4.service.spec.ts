import { ConfigService } from '@nestjs/config';
import { GA4Service, TrackPurchaseParams } from './ga4.service.js';

describe('GA4 privacy boundary', () => {
  const originalFetch = global.fetch;
  let service: GA4Service;
  let send: jest.Mock;
  const purchase: TrackPurchaseParams = {
    userId: 'private-firebase-uid',
    transactionId: 'in_confirmed',
    planId: 'plan_pro',
    planName: 'private free text',
    price: 10,
  };
  beforeEach(() => {
    send = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = send;
    service = new GA4Service(
      new ConfigService({
        GA4_MEASUREMENT_ID: 'G-test',
        GA4_API_SECRET: 'secret',
      }),
    );
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });
  it('skips legacy callers without analytics consent and a real client ID', async () => {
    expect(await service.trackPurchase(purchase)).toBe(false);
    expect(
      await service.trackPurchase({
        ...purchase,
        analytics: { consent: 'granted', clientId: purchase.userId },
      }),
    ).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
  it('exports only bounded purchase fields, never internal identity or free text', async () => {
    expect(
      await service.trackPurchase({
        ...purchase,
        analytics: { consent: 'granted', clientId: '123.456', sessionId: 123 },
      }),
    ).toBe(true);
    const body = send.mock.calls[0][1].body;
    expect(body).not.toContain(purchase.userId);
    expect(body).not.toContain(purchase.planName);
    expect(JSON.parse(body)).toMatchObject({
      client_id: '123.456',
      events: [
        {
          name: 'purchase',
          params: { transaction_id: 'in_confirmed', session_id: 123 },
        },
      ],
    });
  });
  it('never exports email or last activity dates', async () => {
    await service.trackInactivity({
      userId: purchase.userId,
      userEmail: 'private@example.com',
      daysInactive: 7,
      userPlan: 'pro',
      lastActivityAt: new Date(),
      analytics: { consent: 'granted', clientId: '123.456' },
    });
    expect(send.mock.calls[0][1].body).not.toMatch(/private|last_activity/);
  });
  it.each([0, -1, NaN, Infinity])(
    'rejects non-positive or invalid revenue %s',
    async (price) => {
      expect(
        await service.trackPurchase({
          ...purchase,
          price,
          analytics: { consent: 'granted', clientId: '123.456' },
        }),
      ).toBe(false);
      expect(send).not.toHaveBeenCalled();
    },
  );
  it('does not fail billing on transport failures', async () => {
    send.mockRejectedValue(new Error('secret URL'));
    expect(
      await service.trackPurchase({
        ...purchase,
        analytics: { consent: 'granted', clientId: '123.456' },
      }),
    ).toBe(false);
  });
});
