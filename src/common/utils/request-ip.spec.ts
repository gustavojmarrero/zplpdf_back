import { getClientDeclaredIp, getTrustedHopIp } from './request-ip.js';

const req = (xff?: string | string[], remoteAddress = '10.0.0.1') => ({
  headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  socket: { remoteAddress },
});

describe('request-ip', () => {
  describe('getTrustedHopIp', () => {
    it('devuelve la IP que añade la infraestructura al final del XFF', () => {
      // Cloud Run añade el peer real detrás de lo que mandara el cliente.
      expect(getTrustedHopIp(req('203.0.113.9, 198.51.100.7'))).toBe(
        '198.51.100.7',
      );
    });

    it('ignora lo que el cliente se invente delante', () => {
      const falsificado = getTrustedHopIp(
        req('1.1.1.1, 2.2.2.2, 3.3.3.3, 198.51.100.7'),
      );
      const otroIntento = getTrustedHopIp(req('9.9.9.9, 198.51.100.7'));

      // Da igual la cadena falsa: el tope agregado sigue cayendo en el mismo
      // contador, que es justo lo que impide estrenar cuota por peticion.
      expect(falsificado).toBe('198.51.100.7');
      expect(otroIntento).toBe('198.51.100.7');
    });

    it('cae al socket cuando no hay XFF (desarrollo local)', () => {
      expect(getTrustedHopIp(req(undefined, '::1'))).toBe('::1');
      expect(getTrustedHopIp(req('', '::1'))).toBe('::1');
    });

    it('tolera el header repetido', () => {
      expect(getTrustedHopIp(req(['1.1.1.1', '198.51.100.7']))).toBe(
        '198.51.100.7',
      );
    });
  });

  describe('getClientDeclaredIp', () => {
    it('devuelve la IP del visitante que reenvía el frontend', () => {
      expect(getClientDeclaredIp(req('203.0.113.9, 198.51.100.7'))).toBe(
        '203.0.113.9',
      );
    });

    it('cae al socket cuando no hay XFF', () => {
      expect(getClientDeclaredIp(req(undefined, '::1'))).toBe('::1');
    });
  });
});
