import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EmailService } from './email.service';
import { FirestoreService } from '../cache/firestore.service';
import { PeriodCalculatorService } from '../../common/services/period-calculator.service';
import { User } from '../../common/interfaces/user.interface';

describe('EmailService.triggerBlockedEmail', () => {
  let service: EmailService;
  let firestore: { getUserById: jest.Mock; getOrCreateUsageWithPeriod: jest.Mock; getOrCreateUsage: jest.Mock };
  let periodCalculator: PeriodCalculatorService;

  const baseUser: User = {
    id: 'user-free-mid-month',
    email: 'free@example.com',
    displayName: 'Free User',
    emailVerified: true,
    plan: 'free',
    role: 'user',
    country: 'MX',
    // Registrado a mitad de mes: el período corre por aniversario, no mes calendario.
    createdAt: new Date(2026, 0, 17),
  } as User;

  beforeEach(async () => {
    firestore = {
      getUserById: jest.fn(),
      getOrCreateUsageWithPeriod: jest.fn(),
      // Método legacy: NO debe invocarse desde el flujo de límites.
      getOrCreateUsage: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailService,
        PeriodCalculatorService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'RESEND_API_KEY' ? 'test-key' : undefined,
          },
        },
        { provide: FirestoreService, useValue: firestore },
      ],
    }).compile();

    service = module.get<EmailService>(EmailService);
    periodCalculator = module.get<PeriodCalculatorService>(PeriodCalculatorService);
  });

  function mockUsage(user: User, pdfCount: number) {
    const period = periodCalculator.calculateCurrentPeriod(user);
    firestore.getUserById.mockResolvedValue(user);
    firestore.getOrCreateUsageWithPeriod.mockResolvedValue({
      odId: period.periodId,
      pdfCount,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
    });
    return period;
  }

  it('encola conversion_blocked para un usuario Free que alcanzó su límite real de 10', async () => {
    // Regresión del bug: el fallback hardcodeado `|| 25` dejaba a los usuarios Free
    // (límite real 10) sin email de bloqueo, porque 10 < 25.
    mockUsage(baseUser, 10);
    const queueSpy = jest
      .spyOn(service, 'queueLimitEmail')
      .mockResolvedValue('queued-id');

    const result = await service.triggerBlockedEmail(baseUser.id);

    expect(result).toBe('queued-id');
    expect(queueSpy).toHaveBeenCalledWith(
      baseUser.id,
      'conversion_blocked',
      expect.objectContaining({ pdfsUsed: 10, limit: 10 }),
    );
  });

  it('usa el período por aniversario (getOrCreateUsageWithPeriod), no el legacy', async () => {
    const period = mockUsage(baseUser, 10);
    jest.spyOn(service, 'queueLimitEmail').mockResolvedValue('queued-id');

    await service.triggerBlockedEmail(baseUser.id);

    // El email lee el MISMO período que usa el bloqueo de conversiones.
    expect(firestore.getOrCreateUsageWithPeriod).toHaveBeenCalledWith(
      baseUser.id,
      expect.objectContaining({ periodId: period.periodId }),
    );
    expect(firestore.getOrCreateUsage).not.toHaveBeenCalled();
  });

  it('no encola si el usuario Free aún no alcanzó el límite (9/10)', async () => {
    mockUsage(baseUser, 9);
    const queueSpy = jest.spyOn(service, 'queueLimitEmail');

    const result = await service.triggerBlockedEmail(baseUser.id);

    expect(result).toBeNull();
    expect(queueSpy).not.toHaveBeenCalled();
  });

  it('respeta el límite real de Lite (25) sin el hardcode previo', async () => {
    const liteUser = { ...baseUser, plan: 'lite' } as User;
    mockUsage(liteUser, 25);
    const queueSpy = jest
      .spyOn(service, 'queueLimitEmail')
      .mockResolvedValue('queued-id');

    const result = await service.triggerBlockedEmail(liteUser.id);

    expect(result).toBe('queued-id');
    expect(queueSpy).toHaveBeenCalledWith(
      liteUser.id,
      'conversion_blocked',
      expect.objectContaining({ pdfsUsed: 25, limit: 25 }),
    );
  });
});
