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
    ])('clasifica %s como ACCESS_DENIED', (code) => {
      expect(getErrorTypeFromCode(code)).toBe('ACCESS_DENIED');
    });
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
