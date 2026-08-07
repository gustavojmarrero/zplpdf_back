import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { EmailService } from './email.service.js';
import { FirestoreService } from '../cache/firestore.service.js';
import { PeriodCalculatorService } from '../../common/services/period-calculator.service.js';
import { User, PlanType } from '../../common/interfaces/user.interface.js';

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

  /**
   * Mockea la cohorte SIN paginar, que es lo que el scheduler debe consumir.
   * Si el scheduler volviera a pedir una página, este mock se lo daría entero
   * y el test no lo notaría — por eso hay además un caso que comprueba que no
   * pasa por el método paginado.
   */
  function mockCohort(users: ReturnType<typeof powerUser>[]) {
    return jest
      .spyOn(
        service as unknown as {
          getPowerUserCohort: (p: number) => Promise<unknown>;
        },
        'getPowerUserCohort',
      )
      .mockResolvedValue({
        users,
        summary: {
          total: users.length,
          topPerformers: Math.min(10, users.length),
          avgMonthlyPdfs: 120,
          byPlan: { free: 0, lite: 0, pro: users.length, promax: 0 },
        },
      });
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
    mockCohort(['a', 'b', 'c', 'd', 'e'].map((id) => powerUser(id)));
    firestore.hasUserReceivedEmailInPeriod.mockImplementation(
      (userId: string) => Promise.resolve(['a', 'b', 'c'].includes(userId)),
    );

    const result = await service.schedulePowerUserEmails();

    expect(result.scheduled).toBe(2);
    expect(result.skipped).toBe(3);
    expect(firestore.createEmailQueue).toHaveBeenCalledTimes(2);
  });

  it('deduplica por período usando el periodStart del propio usuario', async () => {
    mockCohort([powerUser('a')]);

    await service.schedulePowerUserEmails();

    // Períodos individuales por aniversario de suscripción, no mes calendario.
    expect(firestore.hasUserReceivedEmailInPeriod).toHaveBeenCalledWith(
      'a',
      'pro_power_user',
      periodStart,
    );
  });

  it('es idempotente: la segunda ejecución no crea duplicados', async () => {
    mockCohort([powerUser('a'), powerUser('b')]);
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
    mockCohort([
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

  it('los free/lite no consumen cupo: los de pago que quedan detrás sí reciben', async () => {
    // Cohorte de 70 con 30 free/lite por delante. Con cualquier truncamiento
    // previo al filtro, esos 30 descartados se llevarían por delante a otros
    // tantos de pago que nunca se llegarían a examinar.
    const cohorte = [
      ...Array.from({ length: 15 }, (_, i) => powerUser(`free${i}`, 'free')),
      ...Array.from({ length: 15 }, (_, i) => powerUser(`lite${i}`, 'lite')),
      ...Array.from({ length: 40 }, (_, i) => powerUser(`pro${i}`, 'pro')),
    ];
    mockCohort(cohorte);

    const result = await service.schedulePowerUserEmails();

    expect(result.scheduled).toBe(40);
    expect(result.skipped).toBe(30);
  });

  it('consume la cohorte sin paginar, por grande que sea', async () => {
    // Los empates en pdfsThisMonth pueden ensanchar la cohorte mucho más allá
    // del 10% nominal, así que no puede haber ningún techo intermedio: aquí los
    // 1200 primeros son descartables y los elegibles están al final.
    const paginado = jest.spyOn(service, 'getPowerUsersWithPeriod');
    mockCohort([
      ...Array.from({ length: 1200 }, (_, i) => powerUser(`free${i}`, 'free')),
      ...Array.from({ length: 5 }, (_, i) => powerUser(`pro${i}`, 'pro')),
    ]);

    const result = await service.schedulePowerUserEmails();

    expect(result.scheduled).toBe(5);
    expect(result.skipped).toBe(1200);
    // Si volviera a pasar por el método paginado, habría un techo de nuevo.
    expect(paginado).not.toHaveBeenCalled();
  });

  it('corta en el tope de envíos por ejecución sin truncar en silencio', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    mockCohort(
      Array.from({ length: 80 }, (_, i) => powerUser(`pro${i}`, 'pro')),
    );

    const result = await service.schedulePowerUserEmails();

    expect(result.scheduled).toBe(50);
    expect(firestore.createEmailQueue).toHaveBeenCalledTimes(50);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('tope de 50'));
  });

  it('el endpoint de admin sigue paginando la misma cohorte', async () => {
    // El scheduler dejó de paginar, pero el dashboard no: extraer el helper no
    // puede haberle cambiado el contrato.
    mockCohort(
      Array.from({ length: 120 }, (_, i) => powerUser(`pro${i}`, 'pro')),
    );

    const pagina2 = await service.getPowerUsersWithPeriod({
      page: 2,
      limit: 50,
    });

    expect(pagina2.users).toHaveLength(50);
    expect(pagina2.users[0].userId).toBe('pro50');
    expect(pagina2.pagination).toMatchObject({
      page: 2,
      limit: 50,
      total: 120,
      totalPages: 3,
    });
  });
});

/**
 * Último de los cinco `schedule*Emails` en poblar `skipped` (issue #60). El
 * filtrado vive en `getUsersWithHighUsage`, así que aquí solo se comprueba que
 * el conteo llegue intacto al resultado del cron; el reordenamiento de filtros
 * que lo hace posible se cubre en firestore.service.spec.ts.
 */
describe('EmailService.scheduleHighUsageEmails', () => {
  let service: EmailService;
  let firestore: {
    isTemplateEnabled: jest.Mock;
    getUsersWithHighUsage: jest.Mock;
    createEmailQueue: jest.Mock;
  };

  function highUsageUser(id: string) {
    return {
      userId: id,
      userEmail: `${id}@ejemplo.com`,
      displayName: `User ${id}`,
      language: 'es',
      avgPdfsPerDay: 3,
      pdfsUsed: 6,
      limit: 10,
      projectedDaysToLimit: 2,
      periodEnd: new Date(2026, 8, 1),
    };
  }

  beforeEach(async () => {
    firestore = {
      isTemplateEnabled: jest.fn().mockResolvedValue(true),
      getUsersWithHighUsage: jest.fn(),
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

  it('reporta los candidatos de uso alto que ya habían recibido el email', async () => {
    // 7 con uso alto, 4 ya avisados este período.
    firestore.getUsersWithHighUsage.mockResolvedValue({
      users: ['a', 'b', 'c'].map(highUsageUser),
      skipped: { alreadyReceived: 4 },
    });

    const result = await service.scheduleHighUsageEmails();

    expect(result.scheduled).toBe(3);
    expect(result.skipped).toBe(4);
    expect(firestore.createEmailQueue).toHaveBeenCalledTimes(3);
  });

  it('distingue "nadie con uso alto" de "todos ya avisados"', async () => {
    // Los dos casos programan 0 emails; antes se reportaban idénticos.
    firestore.getUsersWithHighUsage.mockResolvedValue({
      users: [],
      skipped: { alreadyReceived: 0 },
    });
    const sinCandidatos = await service.scheduleHighUsageEmails();

    firestore.getUsersWithHighUsage.mockResolvedValue({
      users: [],
      skipped: { alreadyReceived: 9 },
    });
    const yaAvisados = await service.scheduleHighUsageEmails();

    expect(sinCandidatos).toMatchObject({ scheduled: 0, skipped: 0 });
    expect(yaAvisados).toMatchObject({ scheduled: 0, skipped: 9 });
  });

  it('no consulta candidatos si el template está deshabilitado', async () => {
    firestore.isTemplateEnabled.mockResolvedValue(false);

    const result = await service.scheduleHighUsageEmails();

    expect(result).toMatchObject({ scheduled: 0, skipped: 0 });
    expect(firestore.getUsersWithHighUsage).not.toHaveBeenCalled();
  });
});
