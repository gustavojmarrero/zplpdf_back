import { OAuth2Client } from 'google-auth-library';
import { ConfigService } from '@nestjs/config';
import { ExecutionContext } from '@nestjs/common';
import { GrowthSchedulerGuard } from './growth-scheduler.guard.js';
describe('application scheduler OIDC authorization', () => {
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization: 'Bearer token' } }),
    }),
  } as ExecutionContext;
  afterEach(() => jest.restoreAllMocks());
  const guard = () =>
    new GrowthSchedulerGuard(
      new ConfigService({
        GROWTH_SCHEDULER_AUDIENCE: 'https://service.example',
        GROWTH_SCHEDULER_SERVICE_ACCOUNT:
          'scheduler@project.iam.gserviceaccount.com',
      }),
    );
  it('requires a verified token for the exact service account and audience', async () => {
    const verify = jest
      .spyOn(OAuth2Client.prototype, 'verifyIdToken')
      .mockResolvedValue({
        getPayload: () => ({
          email: 'scheduler@project.iam.gserviceaccount.com',
          email_verified: true,
          sub: '123',
        }),
      } as never);
    expect(await guard().canActivate(context)).toBe(true);
    expect(verify).toHaveBeenCalledWith({
      idToken: 'token',
      audience: 'https://service.example',
    });
  });
  it.each([
    {
      email: 'other@project.iam.gserviceaccount.com',
      email_verified: true,
      sub: '123',
    },
    {
      email: 'scheduler@project.iam.gserviceaccount.com',
      email_verified: false,
      sub: '123',
    },
  ])('rejects a valid token for the wrong principal %j', async (claims) => {
    jest
      .spyOn(OAuth2Client.prototype, 'verifyIdToken')
      .mockResolvedValue({ getPayload: () => claims } as never);
    await expect(guard().canActivate(context)).rejects.toThrow(
      'Invalid scheduler identity',
    );
  });
  it('fails closed when configuration is absent', async () => {
    await expect(
      new GrowthSchedulerGuard(new ConfigService()).canActivate(context),
    ).rejects.toThrow('Scheduler authentication required');
  });
});
