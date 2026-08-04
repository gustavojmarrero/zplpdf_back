import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EmailService } from './email.service';
import { FirestoreService } from '../cache/firestore.service';
import { PeriodCalculatorService } from '../../common/services/period-calculator.service';
import { User, PlanType } from '../../common/interfaces/user.interface';

describe('EmailService.triggerBlockedEmail', () => {
  let service: EmailService;
  let firestore: {
    getUserById: jest.Mock;
    getOrCreateUsageWithPeriod: jest.Mock;
    getOrCreateUsage: jest.Mock;
  };
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
    periodCalculator = module.get<PeriodCalculatorService>(
      PeriodCalculatorService,
    );
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

/**
 * `skipped` reportaba siempre 0 en los schedule* de onboarding: el filtrado
 * ocurre dentro de getUsersEligibleForEmail, que descartaba candidatos en
 * silencio y devolvía solo los elegibles (issue #60). Sin ese dato no se puede
 * distinguir "no había candidatos" de "todos ya habían recibido el email".
 */
describe('EmailService — métricas de skipped en schedule*Emails', () => {
  let service: EmailService;
  let firestore: {
    getUsersEligibleForEmail: jest.Mock;
    createEmailQueue: jest.Mock;
  };

  function eligible(count: number, prefix = 'u') {
    return Array.from({ length: count }, (_, i) => ({
      userId: `${prefix}${i}`,
      userEmail: `${prefix}${i}@ejemplo.com`,
      displayName: `User ${i}`,
      language: 'es',
      pdfCount: 0,
      createdAt: new Date(2026, 0, 1),
    }));
  }

  beforeEach(async () => {
    firestore = {
      getUsersEligibleForEmail: jest.fn(),
      createEmailQueue: jest.fn().mockResolvedValue('queue-id'),
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
  });

  it('reporta los candidatos descartados por haber recibido ya el email', async () => {
    // 8 candidatos: 3 elegibles, 5 ya lo recibieron.
    firestore.getUsersEligibleForEmail.mockResolvedValue({
      users: eligible(3),
      skipped: { alreadyReceived: 5, pdfCountOutOfRange: 0 },
    });

    const result = await service.scheduleTutorialEmails();

    expect(result.scheduled).toBe(3);
    expect(result.skipped).toBe(5);
    expect(firestore.createEmailQueue).toHaveBeenCalledTimes(3);
  });

  it('suma los descartes de todos los motivos', async () => {
    firestore.getUsersEligibleForEmail.mockResolvedValue({
      users: eligible(2),
      skipped: { alreadyReceived: 4, pdfCountOutOfRange: 6 },
    });

    const result = await service.scheduleHelpEmails();

    expect(result.scheduled).toBe(2);
    expect(result.skipped).toBe(10);
  });

  it('distingue "sin candidatos" de "todos ya lo recibieron"', async () => {
    // Ambos casos programan 0 emails; solo `skipped` los diferencia.
    firestore.getUsersEligibleForEmail.mockResolvedValue({
      users: [],
      skipped: { alreadyReceived: 0, pdfCountOutOfRange: 0 },
    });
    const sinCandidatos = await service.scheduleTutorialEmails();

    firestore.getUsersEligibleForEmail.mockResolvedValue({
      users: [],
      skipped: { alreadyReceived: 12, pdfCountOutOfRange: 0 },
    });
    const yaRecibido = await service.scheduleTutorialEmails();

    expect(sinCandidatos.scheduled).toBe(0);
    expect(yaRecibido.scheduled).toBe(0);
    expect(sinCandidatos.skipped).toBe(0);
    expect(yaRecibido.skipped).toBe(12);
  });

  it('en day 7 NO cuenta pdfCountOutOfRange: las dos consultas parten el mismo cohorte', async () => {
    // success_story pide pdfCount>=1 y miss_you pide 0, así que cada usuario
    // del cohorte cae fuera de rango en la consulta que no le toca. Contarlo
    // marcaría como descartado a quien SÍ recibió email en la otra rama.
    firestore.getUsersEligibleForEmail
      .mockResolvedValueOnce({
        users: eligible(4, 'activo'),
        skipped: { alreadyReceived: 1, pdfCountOutOfRange: 6 },
      })
      .mockResolvedValueOnce({
        users: eligible(6, 'inactivo'),
        skipped: { alreadyReceived: 2, pdfCountOutOfRange: 4 },
      });

    const result = await service.scheduleDay7Emails();

    expect(result.scheduled).toBe(10);
    // Solo 1 + 2, nunca los 10 de pdfCountOutOfRange.
    expect(result.skipped).toBe(3);
  });

  it('devuelve skipped 0 sin consultar nada si el servicio está deshabilitado', async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailService,
        PeriodCalculatorService,
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: FirestoreService, useValue: firestore },
      ],
    }).compile();
    const disabled = module.get<EmailService>(EmailService);

    const result = await disabled.scheduleTutorialEmails();

    expect(result).toMatchObject({ scheduled: 0, skipped: 0 });
    expect(firestore.getUsersEligibleForEmail).not.toHaveBeenCalled();
  });
});

/**
 * schedulePowerUserEmails era el único schedule* sin deduplicación: sus
 * candidatos vienen de getPowerUsersWithPeriod, un método de reporting (top 10%
 * por uso) que no consulta envíos previos ni filtra por plan. Con el cron
 * mensual activo, cada ejecución reencolaba el mismo email a los mismos
 * usuarios de pago (issue #62).
 */
describe('EmailService.schedulePowerUserEmails', () => {
  let service: EmailService;
  let firestore: {
    isTemplateEnabled: jest.Mock;
    hasUserReceivedEmailInPeriod: jest.Mock;
    createEmailQueue: jest.Mock;
  };

  const periodStart = new Date(2026, 6, 15);

  function powerUser(id: string, plan: PlanType = 'pro') {
    return {
      userId: id,
      userEmail: `${id}@ejemplo.com`,
      displayName: `User ${id}`,
      language: 'es' as const,
      pdfsThisMonth: 120,
      labelsThisMonth: 3400,
      monthsAsPro: 5,
      plan,
      periodStart,
    };
  }

  function mockPowerUsers(users: ReturnType<typeof powerUser>[]) {
    jest.spyOn(service, 'getPowerUsersWithPeriod').mockResolvedValue({
      users,
      summary: {
        total: users.length,
        topPerformers: users.length,
        avgMonthlyPdfs: 120,
        byPlan: { free: 0, lite: 0, pro: users.length, promax: 0 },
      },
      pagination: { page: 1, limit: 50, total: users.length, totalPages: 1 },
    } as never);
  }

  beforeEach(async () => {
    firestore = {
      isTemplateEnabled: jest.fn().mockResolvedValue(true),
      hasUserReceivedEmailInPeriod: jest.fn().mockResolvedValue(false),
      createEmailQueue: jest.fn().mockResolvedValue('queue-id'),
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
  });

  it('no reencola a quien ya recibió el email en su período de facturación', async () => {
    // 5 power users, 3 ya lo recibieron en este período.
    mockPowerUsers(['a', 'b', 'c', 'd', 'e'].map((id) => powerUser(id)));
    firestore.hasUserReceivedEmailInPeriod.mockImplementation(
      (userId: string) => Promise.resolve(['a', 'b', 'c'].includes(userId)),
    );

    const result = await service.schedulePowerUserEmails();

    expect(result.scheduled).toBe(2);
    expect(result.skipped).toBe(3);
    expect(firestore.createEmailQueue).toHaveBeenCalledTimes(2);
  });

  it('deduplica por período usando el periodStart del propio usuario', async () => {
    mockPowerUsers([powerUser('a')]);

    await service.schedulePowerUserEmails();

    // Períodos individuales por aniversario de suscripción, no mes calendario.
    expect(firestore.hasUserReceivedEmailInPeriod).toHaveBeenCalledWith(
      'a',
      'pro_power_user',
      periodStart,
    );
  });

  it('es idempotente: la segunda ejecución no crea duplicados', async () => {
    mockPowerUsers([powerUser('a'), powerUser('b')]);
    const encolados = new Set<string>();
    firestore.hasUserReceivedEmailInPeriod.mockImplementation(
      (userId: string) => Promise.resolve(encolados.has(userId)),
    );
    firestore.createEmailQueue.mockImplementation(
      ({ userId }: { userId: string }) => {
        encolados.add(userId);
        return Promise.resolve('queue-id');
      },
    );

    const primera = await service.schedulePowerUserEmails();
    const segunda = await service.schedulePowerUserEmails();

    expect(primera.scheduled).toBe(2);
    expect(segunda.scheduled).toBe(0);
    expect(segunda.skipped).toBe(2);
    expect(firestore.createEmailQueue).toHaveBeenCalledTimes(2);
  });

  it('no envía el email de PRO a usuarios free ni lite colados en el top 10%', async () => {
    // El percentil se calcula sobre todos los usuarios con uso, así que un free
    // puede entrar en el top 10% y recibir un email que le agradece ser PRO.
    mockPowerUsers([
      powerUser('gratis', 'free'),
      powerUser('basico', 'lite'),
      powerUser('pagado', 'pro'),
      powerUser('maximo', 'promax'),
      powerUser('empresa', 'enterprise'),
    ]);

    const result = await service.schedulePowerUserEmails();

    expect(result.scheduled).toBe(3);
    expect(result.skipped).toBe(2);
    const destinatarios = firestore.createEmailQueue.mock.calls.map(
      ([{ userId }]) => userId,
    );
    expect(destinatarios).toEqual(['pagado', 'maximo', 'empresa']);
  });

  it('no consulta candidatos si el template está deshabilitado', async () => {
    firestore.isTemplateEnabled.mockResolvedValue(false);
    const spy = jest.spyOn(service, 'getPowerUsersWithPeriod');

    const result = await service.schedulePowerUserEmails();

    expect(result).toMatchObject({ scheduled: 0, skipped: 0 });
    expect(spy).not.toHaveBeenCalled();
    expect(firestore.createEmailQueue).not.toHaveBeenCalled();
  });
});
