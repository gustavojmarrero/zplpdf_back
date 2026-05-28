export interface PeriodInfo {
  periodStart: Date;
  periodEnd: Date;
  periodId: string;
}

export interface UserForPeriod {
  id: string;
  plan: 'free' | 'lite' | 'pro' | 'promax' | 'enterprise';
  createdAt: Date;
  subscriptionPeriodStart?: Date;
  subscriptionPeriodEnd?: Date;
}

export function generatePeriodId(userId: string, periodStart: Date): string {
  const year = periodStart.getFullYear();
  const month = String(periodStart.getMonth() + 1).padStart(2, '0');
  const day = String(periodStart.getDate()).padStart(2, '0');
  return `${userId}_${year}${month}${day}`;
}

export function calculateFreePeriod(userId: string, createdAt: Date, now: Date = new Date()): PeriodInfo {
  const registrationDay = createdAt.getDate();

  let periodStart = new Date(now.getFullYear(), now.getMonth(), registrationDay);
  if (periodStart > now) {
    periodStart.setMonth(periodStart.getMonth() - 1);
  }

  const periodEnd = new Date(periodStart);
  periodEnd.setMonth(periodEnd.getMonth() + 1);
  periodEnd.setMilliseconds(periodEnd.getMilliseconds() - 1);

  return {
    periodStart,
    periodEnd,
    periodId: generatePeriodId(userId, periodStart),
  };
}

export function calculateCurrentPeriod(user: UserForPeriod, now: Date = new Date()): PeriodInfo {
  if (user.plan === 'free') {
    return calculateFreePeriod(user.id, user.createdAt, now);
  }

  if (user.subscriptionPeriodStart && user.subscriptionPeriodEnd) {
    const periodStart = user.subscriptionPeriodStart instanceof Date
      ? user.subscriptionPeriodStart
      : new Date(user.subscriptionPeriodStart);
    const periodEnd = user.subscriptionPeriodEnd instanceof Date
      ? user.subscriptionPeriodEnd
      : new Date(user.subscriptionPeriodEnd);

    return {
      periodStart,
      periodEnd,
      periodId: generatePeriodId(user.id, periodStart),
    };
  }

  return calculateFreePeriod(user.id, user.createdAt, now);
}
