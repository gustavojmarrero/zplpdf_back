import { ErrorCodes, getErrorTypeFromCode } from './error-codes.js';

describe('getErrorTypeFromCode', () => {
  describe('códigos de cuota → LIMIT_EXCEEDED', () => {
    it.each([
      ErrorCodes.LABEL_LIMIT_EXCEEDED,
      ErrorCodes.MONTHLY_LIMIT_EXCEEDED,
      ErrorCodes.BATCH_LIMIT_EXCEEDED,
    ])('clasifica %s como LIMIT_EXCEEDED', (code) => {
      expect(getErrorTypeFromCode(code)).toBe('LIMIT_EXCEEDED');
    });
  });

  describe('códigos de acceso/onboarding → ACCESS_DENIED', () => {
    it.each([
      'EMAIL_NOT_VERIFIED',
      'BLOCKED_EMAIL_DOMAIN',
      ErrorCodes.ACCESS_DENIED,
      ErrorCodes.USER_NOT_FOUND,
      ErrorCodes.BATCH_NOT_ALLOWED,
    ])('clasifica %s como ACCESS_DENIED', (code) => {
      expect(getErrorTypeFromCode(code)).toBe('ACCESS_DENIED');
    });
  });

  it('separa el batch bloqueado por plan del batch que excede la cuota', () => {
    // BATCH_NOT_ALLOWED es fricción de acceso (el plan no incluye la feature);
    // BATCH_LIMIT_EXCEEDED es presión de cuota (agotó lo que sí tiene).
    expect(getErrorTypeFromCode(ErrorCodes.BATCH_NOT_ALLOWED)).toBe(
      'ACCESS_DENIED',
    );
    expect(getErrorTypeFromCode(ErrorCodes.BATCH_LIMIT_EXCEEDED)).toBe(
      'LIMIT_EXCEEDED',
    );
  });

  it('separa email sin verificar de la presión de cuota (regresión)', () => {
    // Antes ambos caían bajo LIMIT_EXCEEDED, ocultando la fricción de onboarding.
    expect(getErrorTypeFromCode('EMAIL_NOT_VERIFIED')).not.toBe(
      getErrorTypeFromCode(ErrorCodes.MONTHLY_LIMIT_EXCEEDED),
    );
  });

  it('usa LIMIT_EXCEEDED como fallback conservador para códigos desconocidos', () => {
    expect(getErrorTypeFromCode('SOMETHING_UNEXPECTED')).toBe('LIMIT_EXCEEDED');
  });
});
