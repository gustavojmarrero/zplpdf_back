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

/**
 * Los avatares no pueden servirse con URL firmada: la URL se guarda en el perfil
 * y en el claim `picture` del token, así que caducaría y la foto dejaría de
 * cargar. Van a un bucket aparte, de lectura pública, porque el principal
 * guarda los PDF y los ZPL de los usuarios.
 */
describe('StorageService — bucket público', () => {
  function buildService(config: Record<string, string | undefined> = {}) {
    const file = {
      save: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    const bucket = jest.fn().mockReturnValue({ file: () => file });
    const configService: any = {
      get: jest.fn((key: string) => config[key]),
    };

    const service = new StorageService(configService, {}) as any;
    service.storage = { bucket };

    return { service, bucket, file };
  }

  it('usa el bucket público configurado y, si falta, el de assets', () => {
    expect(
      buildService({ GCP_PUBLIC_BUCKET: 'otro-bucket' }).service
        .publicBucketName,
    ).toBe('otro-bucket');
    expect(buildService().service.publicBucketName).toBe(
      'zplpdf-public-assets',
    );
  });

  it('guarda en el bucket público y devuelve la URL sin firmar', async () => {
    const { service, bucket, file } = buildService();

    const url = await service.savePublicFile(
      'users/uid-1/avatar.webp',
      Buffer.from('imagen'),
      'image/webp',
    );

    expect(bucket).toHaveBeenCalledWith('zplpdf-public-assets');
    expect(url).toBe(
      'https://storage.googleapis.com/zplpdf-public-assets/users/uid-1/avatar.webp',
    );
    expect(file.save).toHaveBeenCalledWith(Buffer.from('imagen'), {
      metadata: {
        contentType: 'image/webp',
        cacheControl: 'public, max-age=86400',
      },
    });
  });

  it('trata el 404 al borrar como éxito', async () => {
    // Quitar una foto que ya no está en Storage tiene que dejar el perfil
    // limpio igual; convertirlo en 500 dejaría al usuario sin poder borrarla.
    const { service, file } = buildService();
    file.delete.mockRejectedValue(
      Object.assign(new Error('No such object'), {
        code: 404,
      }),
    );

    await expect(
      service.deletePublicFile('users/uid-1/avatar.webp'),
    ).resolves.toBeUndefined();
  });

  it('propaga cualquier otro error al borrar', async () => {
    const { service, file } = buildService();
    file.delete.mockRejectedValue(
      Object.assign(new Error('permiso denegado'), { code: 403 }),
    );

    await expect(
      service.deletePublicFile('users/uid-1/avatar.webp'),
    ).rejects.toThrow('permiso denegado');
  });
});
