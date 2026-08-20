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
      metadata: { generation: '17' },
      save: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      download: jest.fn().mockResolvedValue([Buffer.from('imagen')]),
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

    const { url, generation } = await service.savePublicFile(
      'users/uid-1/avatar.webp',
      Buffer.from('imagen'),
      'image/webp',
    );

    expect(bucket).toHaveBeenCalledWith('zplpdf-public-assets');
    expect(url).toBe(
      'https://storage.googleapis.com/zplpdf-public-assets/users/uid-1/avatar.webp',
    );
    // La generación es lo que permite condicionar una compensación posterior.
    expect(generation).toBe('17');
    expect(file.save).toHaveBeenCalledWith(Buffer.from('imagen'), {
      metadata: {
        contentType: 'image/webp',
        cacheControl: 'public, max-age=86400',
      },
    });
  });

  it('devuelve null al leer un objeto que ya no está', async () => {
    // Quien llama usa esa ausencia para saber que no hay bytes que restaurar; un
    // throw convertiría la primera subida de un usuario en un 500.
    const { service, file } = buildService();
    file.download.mockRejectedValue(
      Object.assign(new Error('No such object'), { code: 404 }),
    );

    await expect(
      service.readPublicFile('users/uid-1/avatar.webp'),
    ).resolves.toBeNull();
  });

  it('devuelve los bytes del objeto público', async () => {
    const { service } = buildService();

    await expect(
      service.readPublicFile('users/uid-1/avatar.webp'),
    ).resolves.toEqual(Buffer.from('imagen'));
  });

  it('condiciona la escritura a la generación cuando se le pide', async () => {
    const { service, file } = buildService();

    await service.savePublicFile(
      'users/uid-1/avatar.webp',
      Buffer.from('imagen'),
      'image/webp',
      { ifGenerationMatch: '17' },
    );

    expect(file.save.mock.calls[0][1]).toMatchObject({
      preconditionOpts: { ifGenerationMatch: '17' },
    });
  });

  it('trata el 412 al borrar como éxito: el objeto ya no es el nuestro', async () => {
    const { service, file } = buildService();
    file.delete.mockRejectedValue(
      Object.assign(new Error('generation mismatch'), { code: 412 }),
    );

    await expect(
      service.deletePublicFile('users/uid-1/avatar.webp', {
        ifGenerationMatch: '17',
      }),
    ).resolves.toBeUndefined();
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

/**
 * El borrado por prefijo lo estrena la baja de cuenta (issue #99), que lo llama
 * con `debug-zpl/<uid>/`. Sin la barra final, el prefijo de `uid1` casaría
 * también con `uid10` y se llevaría por delante los archivos de otro usuario.
 */
describe('StorageService — borrado', () => {
  function buildService(files: Array<{ name: string }> = []) {
    const deleteFiles = jest.fn().mockResolvedValue(undefined);
    const getFiles = jest.fn().mockResolvedValue([files]);
    const deleteFile = jest.fn().mockResolvedValue(undefined);
    const bucket = jest.fn().mockReturnValue({
      getFiles,
      deleteFiles,
      file: jest.fn().mockReturnValue({ delete: deleteFile }),
    });

    const service: any = new StorageService(
      { get: jest.fn().mockReturnValue('mi-bucket') } as any,
      {},
    );
    service.storage = { bucket };

    return { service, getFiles, deleteFiles, deleteFile };
  }

  it('rechaza un prefijo sin barra final en vez de borrar de más', async () => {
    const { service, deleteFiles } = buildService();

    await expect(service.deleteByPrefix('debug-zpl/uid1')).rejects.toThrow(
      /debe terminar en/,
    );
    expect(deleteFiles).not.toHaveBeenCalled();
  });

  it('devuelve cuántos objetos había bajo el prefijo', async () => {
    const { service, deleteFiles } = buildService([
      { name: 'debug-zpl/uid1/a.zpl' },
      { name: 'debug-zpl/uid1/b.zpl' },
    ]);

    await expect(service.deleteByPrefix('debug-zpl/uid1/')).resolves.toBe(2);
    expect(deleteFiles).toHaveBeenCalledWith({
      prefix: 'debug-zpl/uid1/',
      force: true,
    });
  });

  it('no llama al borrado si no hay nada bajo el prefijo', async () => {
    const { service, deleteFiles } = buildService([]);

    await expect(service.deleteByPrefix('debug-zpl/uid1/')).resolves.toBe(0);
    expect(deleteFiles).not.toHaveBeenCalled();
  });

  it('trata como no borrado el objeto que ya no existía', async () => {
    const { service } = buildService();
    service.storage.bucket().file = jest.fn().mockReturnValue({
      delete: jest.fn().mockRejectedValue({ code: 404 }),
    });

    await expect(service.deleteFile('label-viejo.pdf')).resolves.toBe(false);
  });

  it('relanza cualquier otro error de borrado', async () => {
    const { service } = buildService();
    service.storage.bucket().file = jest.fn().mockReturnValue({
      delete: jest.fn().mockRejectedValue({ code: 403, message: 'denegado' }),
    });

    await expect(service.deleteFile('label.pdf')).rejects.toMatchObject({
      code: 403,
    });
  });
});
