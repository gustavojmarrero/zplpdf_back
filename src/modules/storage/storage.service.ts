import { Injectable, Logger } from '@nestjs/common';
import { Storage } from '@google-cloud/storage';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { Inject } from '@nestjs/common';

export interface PublicFileWriteOptions {
  cacheControl?: string;
  /** Escribe solo si el objeto sigue en esta generación (CAS de GCS). */
  ifGenerationMatch?: number | string;
}

export interface PublicFileWriteResult {
  url: string;
  /** Generación resultante, para condicionar escrituras posteriores. */
  generation?: string;
}

@Injectable()
export class StorageService {
  private storage: Storage;
  private readonly logger = new Logger(StorageService.name);
  private readonly bucketName: string;
  /**
   * Bucket de solo lectura pública. Los avatares se sirven por URL estable —se
   * guardan en el perfil y en el claim `picture` del token—, así que no pueden
   * ser URLs firmadas: caducarían y la foto dejaría de cargar. El bucket
   * principal no vale porque ahí viven los PDF y los ZPL de los usuarios, que
   * solo se entregan firmados.
   */
  private readonly publicBucketName: string;

  constructor(
    private configService: ConfigService,
    @Inject('GOOGLE_AUTH_OPTIONS') private googleAuthOptions: any,
  ) {
    // Mismo fallback que ZplService, AdminService y app.config: sin él, este
    // servicio resolvía `undefined` y leía de un bucket distinto al que escribe
    // quien guarda los archivos. Un ZPL guardado por ZplService no se podría
    // recuperar, y el fallo sería un 500 opaco en `.bucket(undefined)`.
    this.bucketName =
      this.configService.get<string>('GCP_STORAGE_BUCKET') ||
      'zplpdf-app-files';
    this.publicBucketName =
      this.configService.get<string>('GCP_PUBLIC_BUCKET') ||
      'zplpdf-public-assets';
    this.storage = new Storage(this.googleAuthOptions);
  }

  generateZplHash(zplContent: string, labelSize: string): string {
    return crypto
      .createHash('md5')
      .update(`${zplContent}_${labelSize}`)
      .digest('hex');
  }

  async pdfExists(zplHash: string): Promise<boolean> {
    try {
      const [exists] = await this.storage
        .bucket(this.bucketName)
        .file(`zpl-pdfs/${zplHash}.pdf`)
        .exists();

      return exists;
    } catch (error) {
      this.logger.error(`Error al verificar archivo: ${error.message}`);
      return false;
    }
  }

  async savePdf(pdfBuffer: Buffer, zplHash: string): Promise<string> {
    const file = this.storage
      .bucket(this.bucketName)
      .file(`zpl-pdfs/${zplHash}.pdf`);

    await file.save(pdfBuffer, {
      metadata: {
        contentType: 'application/pdf',
        cacheControl: 'public, max-age=86400',
      },
    });

    // Generar URL firmada válida por 7 días
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });

    return url;
  }

  async getSignedUrl(zplHash: string): Promise<string> {
    const file = this.storage
      .bucket(this.bucketName)
      .file(`zpl-pdfs/${zplHash}.pdf`);

    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });

    return url;
  }

  /**
   * Guarda un archivo en una ruta arbitraria del bucket.
   *
   * Sin URL firmada de vuelta: los CFDI se conservan cinco años y su descarga se
   * autoriza por usuario en cada petición, así que la URL se genera al leer y no
   * al guardar.
   */
  async saveFile(
    filePath: string,
    content: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.storage
      .bucket(this.bucketName)
      .file(filePath)
      .save(content, { metadata: { contentType } });
  }

  /**
   * Lee un archivo de texto del bucket.
   *
   * Devuelve `null` cuando el objeto ya no existe (404 de GCS) en vez de
   * lanzar: los archivos con ciclo de vida — el ZPL original de una conversión
   * caduca a los 15 días — desaparecen por diseño, y quien llama traduce esa
   * ausencia a un 410, no a un 500.
   *
   * @param filePath Path del archivo en el bucket (ej: debug-zpl/uid/2026-08-08/job.zpl)
   */
  async readTextFile(filePath: string): Promise<string | null> {
    try {
      const [contents] = await this.storage
        .bucket(this.bucketName)
        .file(filePath)
        .download();

      return contents.toString('utf-8');
    } catch (error) {
      if (error?.code === 404) {
        return null;
      }
      this.logger.error(
        `Error al leer el archivo ${filePath}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Borra un objeto del bucket.
   *
   * Devuelve `false` si el objeto ya no estaba (404 de GCS) en vez de lanzar: al
   * dar de baja una cuenta se recorren registros de conversiones antiguas cuyo
   * PDF pudo caducar hace meses, y esa ausencia es el estado deseado, no un
   * fallo que deba abortar el borrado.
   */
  async deleteFile(filePath: string): Promise<boolean> {
    try {
      await this.storage.bucket(this.bucketName).file(filePath).delete();
      return true;
    } catch (error) {
      if (error?.code === 404) {
        return false;
      }
      this.logger.error(
        `Error al borrar el archivo ${filePath}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Borra todos los objetos que cuelgan de un prefijo y devuelve cuántos había.
   *
   * `deleteFiles` no informa de cuántos borró, así que se listan antes: la baja
   * de cuenta tiene que poder decirle al usuario cuántos archivos suyos se
   * eliminaron, y un número inventado sería peor que no darlo.
   *
   * El prefijo debe terminar en `/`: sin la barra, `debug-zpl/uid1` también
   * casaría con `debug-zpl/uid10/...` y se llevaría por delante los archivos de
   * otro usuario.
   */
  async deleteByPrefix(prefix: string): Promise<number> {
    if (!prefix.endsWith('/')) {
      throw new Error(`El prefijo de borrado debe terminar en "/": ${prefix}`);
    }

    const [files] = await this.storage
      .bucket(this.bucketName)
      .getFiles({ prefix });

    if (files.length === 0) {
      return 0;
    }

    await this.storage
      .bucket(this.bucketName)
      .deleteFiles({ prefix, force: true });

    return files.length;
  }

  /**
   * Genera una URL firmada para cualquier archivo en el bucket
   * @param filePath Path del archivo en el bucket (ej: label-xxx.pdf)
   * @param downloadFilename Nombre del archivo para descarga (opcional)
   * @param expirationMinutes Tiempo de expiración en minutos (default: 15)
   * @returns URL firmada
   */
  async generateSignedUrlForPath(
    filePath: string,
    downloadFilename?: string,
    expirationMinutes: number = 15,
  ): Promise<string> {
    const file = this.storage.bucket(this.bucketName).file(filePath);

    const options: any = {
      version: 'v4',
      action: 'read',
      expires: Date.now() + expirationMinutes * 60 * 1000,
    };

    // Si se proporciona nombre de descarga, añadir responseDisposition
    if (downloadFilename) {
      options.responseDisposition = `attachment; filename="${downloadFilename}"`;
    }

    const [url] = await file.getSignedUrl(options);

    return url;
  }

  /** URL pública (sin firmar) de un objeto del bucket público. */
  getPublicFileUrl(filePath: string): string {
    return `https://storage.googleapis.com/${this.publicBucketName}/${filePath}`;
  }

  /**
   * Guarda un archivo en el bucket de lectura pública.
   *
   * Sobrescribe el objeto si ya existe: los avatares usan una ruta fija por
   * usuario para no acumular huérfanos, y quien llama añade una versión en la
   * query para invalidar la caché.
   *
   * Devuelve también la generación escrita, que es lo que permite condicionar
   * una escritura posterior a que nadie haya sustituido el objeto entretanto
   * (`ifGenerationMatch`): sin esa precondición, una compensación tardía podría
   * pisar una foto más reciente ya confirmada.
   */
  async savePublicFile(
    filePath: string,
    content: Buffer,
    contentType: string,
    options: PublicFileWriteOptions = {},
  ): Promise<PublicFileWriteResult> {
    const file = this.storage.bucket(this.publicBucketName).file(filePath);

    await file.save(content, {
      metadata: {
        contentType,
        cacheControl: options.cacheControl ?? 'public, max-age=86400',
      },
      ...(options.ifGenerationMatch !== undefined
        ? { preconditionOpts: { ifGenerationMatch: options.ifGenerationMatch } }
        : {}),
    });

    return {
      url: this.getPublicFileUrl(filePath),
      generation: file.metadata?.generation?.toString(),
    };
  }

  /**
   * Lee un archivo del bucket público, o `null` si ya no está.
   *
   * Sirve para conservar los bytes de un objeto que se va a sobrescribir y poder
   * devolverlos si el resto de la operación no llega a confirmarse.
   */
  async readPublicFile(filePath: string): Promise<Buffer | null> {
    try {
      const [contents] = await this.storage
        .bucket(this.publicBucketName)
        .file(filePath)
        .download();

      return contents;
    } catch (error) {
      if (error?.code === 404) {
        return null;
      }
      this.logger.error(
        `Error al leer el archivo público ${filePath}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Borra un archivo del bucket público.
   *
   * El 404 no es un error: quitar una foto que ya no está en Storage —porque
   * nunca se subió o porque se borró antes— debe dejar el perfil limpio igual.
   *
   * Con `ifGenerationMatch` el borrado solo ocurre si el objeto sigue siendo el
   * que vio quien llama; si otro lo sustituyó, GCS responde 412 y aquí se trata
   * como el 404: no hay nada que borrar que sea nuestro.
   */
  async deletePublicFile(
    filePath: string,
    options: { ifGenerationMatch?: number | string } = {},
  ): Promise<void> {
    try {
      await this.storage
        .bucket(this.publicBucketName)
        .file(filePath)
        // La precondición no está en el tipo de `DeleteFileOptions`, pero la
        // librería la reenvía como query param y GCS la aplica.
        .delete(options as any);
    } catch (error) {
      if (error?.code === 412) {
        this.logger.warn(
          `No se borró ${filePath}: otra escritura más reciente lo sustituyó`,
        );
        return;
      }
      if (error?.code === 404) {
        return;
      }
      this.logger.error(
        `Error al borrar el archivo público ${filePath}: ${error.message}`,
      );
      throw error;
    }
  }
}
