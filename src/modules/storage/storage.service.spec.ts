// Evitar la conexión real a Google Cloud Storage al construir el servicio.
jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: jest.fn() })),
}));

import { StorageService } from './storage.service.js';

/**
 * El bucket lo resuelven tres servicios por separado (ZplService, AdminService
 * y este) leyendo la misma variable. Los otros dos caen en `zplpdf-app-files`
 * cuando falta; si este no lo hiciera, el lector iría a un bucket distinto del
 * que escribe el escritor y un ZPL guardado no se podría recuperar — con un 500
 * opaco en `.bucket(undefined)`, no con un error que explique nada.
 */
describe('StorageService — resolución del bucket', () => {
  function buildService(bucket?: string) {
    const configService: any = { get: jest.fn().mockReturnValue(bucket) };
    return new StorageService(configService, {}) as any;
  }

  it('usa el bucket configurado', () => {
    expect(buildService('mi-bucket').bucketName).toBe('mi-bucket');
  });

  it('cae en el mismo fallback que ZplService cuando falta la variable', () => {
    expect(buildService(undefined).bucketName).toBe('zplpdf-app-files');
  });
});
