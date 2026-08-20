import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { FirestoreService } from '../cache/firestore.service.js';
import { FirebaseAdminService } from '../auth/firebase-admin.service.js';
import { StorageService } from '../storage/storage.service.js';
import { ErrorCodes } from '../../common/constants/error-codes.js';
import { extractStoragePathFromSignedUrl } from '../../common/utils/storage-url.util.js';
import type { User } from '../../common/interfaces/user.interface.js';
import {
  DeleteAccountResponseDto,
  DeletedSubscriptionDto,
  RETENTION_REASON_FISCAL,
} from './dto/delete-account.dto.js';

/**
 * Pasos de la baja que pueden fallar por separado. Son códigos estables: el
 * frontend los enumera en `data.failedSteps` de `ACCOUNT_DELETION_PARTIAL` y los
 * traduce por su cuenta.
 */
export type AccountDeletionStep =
  | 'conversions'
  | 'storedFiles'
  | 'usage'
  | 'taxProfile'
  | 'retainedRecords'
  | 'account'
  | 'auth';

/** Registros de historial que se leen y borran por vuelta. */
const HISTORY_DELETION_PAGE_SIZE = 500;

/**
 * Tope de vueltas al borrar el historial, como salvaguarda ante un bucle que no
 * avance. Con el tamaño de página son 20.000 conversiones, muy por encima de lo
 * que acumula la cuenta más activa.
 */
const MAX_HISTORY_DELETION_PAGES = 40;

/** Páginas de facturas que se recorren al contar lo que se conserva. */
const MAX_INVOICE_PAGES = 10;

const INVOICE_PAGE_SIZE = 100;

/**
 * Baja de cuenta: cancela la suscripción, borra los datos del usuario y
 * anonimiza lo que no se puede borrar.
 *
 * ## Orden de las operaciones
 *
 * La suscripción se cancela **primero** y todo lo demás va después. Si Stripe
 * rechaza la cancelación, la petición termina en `SUBSCRIPTION_CANCEL_FAILED`
 * sin haber tocado un solo dato: la cuenta sigue entera y el usuario puede
 * reintentar. Al revés —borrar y luego intentar cancelar— dejaría un contrato
 * cobrando a alguien que ya no tiene cuenta con la que cancelarlo.
 *
 * Dentro del borrado, el documento de `users` y la cuenta de Firebase Auth van
 * los **últimos**, porque son los que hacen que la cuenta exista: mientras estén
 * ahí, el usuario puede autenticarse y repetir la baja para terminar lo que
 * quedara a medias.
 *
 * ## Lo que no se borra
 *
 * Los CFDI timbrados y las facturas de Stripe se conservan cinco años por
 * obligación fiscal (México). No se borran: se **desvinculan** del usuario —el
 * `userId` del CFDI pasa a un marcador, y el customer de Stripe pierde nombre y
 * email—, de modo que el comprobante sobrevive sin identificar a nadie. La
 * respuesta lo declara en `retained`, para que el diálogo de confirmación del
 * frontend pueda enumerar exactamente qué se pierde y qué se queda.
 */
@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);
  private readonly stripe: Stripe | null = null;

  constructor(
    private readonly firestoreService: FirestoreService,
    private readonly firebaseAdminService: FirebaseAdminService,
    private readonly storageService: StorageService,
    private readonly configService: ConfigService,
  ) {
    const stripeSecretKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (stripeSecretKey) {
      this.stripe = new Stripe(stripeSecretKey);
    }
  }

  async deleteAccount(userId: string): Promise<DeleteAccountResponseDto> {
    const user = await this.firestoreService.getUserById(userId);

    if (!user) {
      throw new HttpException(
        {
          error: ErrorCodes.USER_NOT_FOUND,
          message: 'User not found',
        },
        HttpStatus.NOT_FOUND,
      );
    }

    // Se cuenta antes de cancelar y de anonimizar: después, el customer de
    // Stripe ya no lleva los datos con los que se listan sus facturas.
    const invoicesInStripe = await this.countStripeInvoices(user);

    const subscription = await this.cancelSubscription(user);

    const failedSteps: AccountDeletionStep[] = [];
    const failed = (step: AccountDeletionStep, error: unknown): void => {
      failedSteps.push(step);
      this.logger.error(
        `Baja de cuenta ${userId}: falló el paso "${step}" — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    };

    let conversions = 0;
    let storedFiles = 0;
    let taxProfile = false;
    let retainedRecords = 0;

    try {
      const purged = await this.purgeConversions(userId);
      conversions = purged.conversions;
      storedFiles = purged.storedFiles;
      if (purged.incomplete) {
        failed('conversions', new Error('quedaron registros sin borrar'));
      }
      if (purged.storageFailed) {
        failed('storedFiles', new Error('quedaron archivos sin borrar'));
      }
    } catch (error) {
      failed('conversions', error);
    }

    try {
      storedFiles += await this.storageService.deleteByPrefix(
        `debug-zpl/${userId}/`,
      );
      await this.firestoreService.deleteZplDebugFilesByUserId(userId);
    } catch (error) {
      failed('storedFiles', error);
    }

    try {
      await this.firestoreService.deleteUsageByUserId(userId);
    } catch (error) {
      failed('usage', error);
    }

    try {
      taxProfile = await this.firestoreService.deleteTaxProfile(userId);
    } catch (error) {
      failed('taxProfile', error);
    }

    try {
      retainedRecords = await this.firestoreService.anonymizeUserCfdis(userId);
      await this.anonymizeStripeCustomer(user);
    } catch (error) {
      failed('retainedRecords', error);
    }

    // La cola de emails no es un dato del usuario, pero seguir escribiéndole
    // después de darse de baja sí sería un problema. Un fallo aquí no ensucia
    // el resultado: los envíos comprueban de nuevo que el usuario exista.
    try {
      await this.firestoreService.cancelPendingEmails(userId);
    } catch (error) {
      this.logger.warn(
        `Baja de cuenta ${userId}: no se pudieron cancelar los emails pendientes — ${error.message}`,
      );
    }

    let accountDeleted = false;

    try {
      await this.firestoreService.deleteUser(userId);
      accountDeleted = true;
    } catch (error) {
      failed('account', error);
    }

    if (accountDeleted) {
      try {
        await this.firebaseAdminService.deleteUser(userId);
      } catch (error) {
        // Con la cuenta de Auth viva el usuario puede volver a entrar, y su
        // perfil se recrearía al sincronizar: decir que la cuenta ya no existe
        // sería falso.
        accountDeleted = false;
        failed('auth', error);
      }
    } else {
      // El perfil sigue en Firestore: borrar aquí la cuenta de Auth dejaría un
      // documento huérfano y al usuario sin forma de autenticarse para
      // reintentar la baja.
      this.logger.warn(
        `Baja de cuenta ${userId}: no se borra la cuenta de Firebase Auth porque el ` +
          'perfil no llegó a borrarse; sin ella el usuario no podría reintentar',
      );
    }

    const deleted = {
      conversions,
      storedFiles,
      taxProfile,
      subscription,
    };

    const retained = {
      // Si Stripe no respondió al conteo, los CFDI anonimizados son la cota
      // fiable que sí tenemos: mejor un número comprobado que uno inventado.
      invoices: invoicesInStripe ?? retainedRecords,
      reason: RETENTION_REASON_FISCAL,
    };

    if (failedSteps.length > 0) {
      throw new HttpException(
        {
          error: ErrorCodes.ACCOUNT_DELETION_PARTIAL,
          message:
            'The subscription was cancelled but the account was not fully deleted',
          data: {
            // `accountDeleted: false` es la diferencia entre "quedaron restos" y
            // "tu cuenta sigue existiendo". El frontend no puede afirmar lo
            // segundo sin este dato.
            accountDeleted,
            failedSteps,
            deleted,
            retained,
          },
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    this.logger.log(
      `Cuenta ${userId} dada de baja: ${conversions} conversiones, ` +
        `${storedFiles} archivos, ${retained.invoices} facturas conservadas`,
    );

    return { deleted, retained };
  }

  /**
   * Cancela la suscripción de Stripe si sigue viva.
   *
   * **Cancelación inmediata, no al final del periodo.** La cuenta desaparece en
   * esta misma petición: dejar el contrato corriendo hasta el corte dejaría una
   * suscripción cuyo titular ya no puede entrar al producto ni gestionarla, y
   * sus webhooks llegarían sin usuario al que aplicarlos.
   *
   * **Una factura abierta no se anula.** A diferencia del flujo de impago, aquí
   * la deuda corresponde a servicio ya prestado y puede estar timbrada; se queda
   * en Stripe, que es exactamente lo que declara el bloque `retained`.
   *
   * Si Stripe rechaza la operación se lanza `SUBSCRIPTION_CANCEL_FAILED` y no se
   * borra nada.
   */
  private async cancelSubscription(
    user: User,
  ): Promise<DeletedSubscriptionDto> {
    if (!user.stripeSubscriptionId) {
      return { cancelled: false, plan: null, effectiveAt: null };
    }

    if (!this.stripe) {
      // Con una suscripción registrada y sin cliente de Stripe no hay forma de
      // comprobar ni de cancelar: borrar la cuenta la dejaría cobrando.
      throw this.subscriptionCancelFailed(user, 'stripe_not_configured');
    }

    try {
      const current = await this.stripe.subscriptions.retrieve(
        user.stripeSubscriptionId,
      );

      if (current.status === 'canceled') {
        this.logger.log(
          `Baja de cuenta ${user.id}: la suscripción ${current.id} ya estaba cancelada`,
        );
        return { cancelled: false, plan: user.plan ?? null, effectiveAt: null };
      }

      const cancelled = await this.stripe.subscriptions.cancel(
        user.stripeSubscriptionId,
      );

      const canceledAt = cancelled.canceled_at
        ? new Date(cancelled.canceled_at * 1000)
        : new Date();

      return {
        cancelled: true,
        plan: user.plan ?? null,
        effectiveAt: canceledAt.toISOString(),
      };
    } catch (error) {
      this.logger.error(
        `Baja de cuenta ${user.id}: Stripe rechazó cancelar ${user.stripeSubscriptionId} — ${error.message}`,
      );
      throw this.subscriptionCancelFailed(user, error?.code ?? 'stripe_error');
    }
  }

  private subscriptionCancelFailed(user: User, reason: string): HttpException {
    return new HttpException(
      {
        error: ErrorCodes.SUBSCRIPTION_CANCEL_FAILED,
        message: 'The subscription could not be cancelled; nothing was deleted',
        data: {
          plan: user.plan ?? null,
          subscriptionId: user.stripeSubscriptionId,
          // Código de Stripe, no frase: el frontend decide si ofrece reintentar
          // o mandar al portal de facturación.
          reason,
        },
      },
      HttpStatus.CONFLICT,
    );
  }

  /**
   * Borra el historial del usuario y, con cada registro, el archivo que aún
   * cuelgue de su URL firmada.
   *
   * Se va por páginas y se borra cada una antes de leer la siguiente, así que el
   * bucle avanza aunque el usuario tenga decenas de miles de conversiones. Un
   * archivo que ya no está en el bucket no cuenta ni como borrado ni como fallo:
   * los PDF tienen su propio ciclo de vida y los antiguos ya no existen.
   */
  private async purgeConversions(userId: string): Promise<{
    conversions: number;
    storedFiles: number;
    storageFailed: boolean;
    incomplete: boolean;
  }> {
    let conversions = 0;
    let storedFiles = 0;
    let storageFailed = false;
    let incomplete = false;

    for (let page = 0; page < MAX_HISTORY_DELETION_PAGES; page++) {
      const records = await this.firestoreService.scanUserConversionHistory(
        userId,
        HISTORY_DELETION_PAGE_SIZE,
      );

      if (records.length === 0) {
        return { conversions, storedFiles, storageFailed, incomplete };
      }

      for (const record of records) {
        const path = extractStoragePathFromSignedUrl(record.fileUrl);
        if (!path) continue;

        try {
          if (await this.storageService.deleteFile(path)) {
            storedFiles++;
          }
        } catch (error) {
          // Un objeto que no se deja borrar no puede impedir que se borre la
          // fila: se anota y la respuesta lo declara como baja parcial.
          storageFailed = true;
          this.logger.warn(
            `Baja de cuenta ${userId}: no se pudo borrar ${path} — ${error.message}`,
          );
        }
      }

      conversions += await this.firestoreService.deleteConversionHistoryByIds(
        records.map((record) => record.id),
      );

      if (records.length < HISTORY_DELETION_PAGE_SIZE) {
        return { conversions, storedFiles, storageFailed, incomplete };
      }
    }

    incomplete = true;
    this.logger.error(
      `Baja de cuenta ${userId}: se agotaron las ${MAX_HISTORY_DELETION_PAGES} páginas ` +
        'de borrado del historial y aún quedan registros',
    );

    return { conversions, storedFiles, storageFailed, incomplete };
  }

  /**
   * Cuenta las facturas que quedarán en Stripe, o `null` si no se pudo saber.
   *
   * `null` y `0` no significan lo mismo: cero es "no hay ninguna factura" y hay
   * que poder decirlo; `null` es "Stripe no contestó", y ahí quien llama usa el
   * número de CFDI anonimizados en vez de afirmar algo que no comprobó.
   */
  private async countStripeInvoices(user: User): Promise<number | null> {
    if (!user.stripeCustomerId) {
      return 0;
    }

    if (!this.stripe) {
      return null;
    }

    try {
      let count = 0;
      let startingAfter: string | undefined;

      for (let page = 0; page < MAX_INVOICE_PAGES; page++) {
        const invoices = await this.stripe.invoices.list({
          customer: user.stripeCustomerId,
          limit: INVOICE_PAGE_SIZE,
          ...(startingAfter && { starting_after: startingAfter }),
        });

        count += invoices.data.length;

        if (!invoices.has_more || invoices.data.length === 0) {
          return count;
        }

        startingAfter = invoices.data[invoices.data.length - 1].id;
      }

      this.logger.warn(
        `Baja de cuenta ${user.id}: el conteo de facturas se detuvo en ${count} ` +
          `(tope de ${MAX_INVOICE_PAGES} páginas)`,
      );
      return count;
    } catch (error) {
      this.logger.warn(
        `Baja de cuenta ${user.id}: no se pudieron contar las facturas de Stripe — ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Quita del customer de Stripe los datos que identifican a la persona.
   *
   * El customer no se borra: es el nexo de las facturas que hay que conservar
   * cinco años. Lo que se va es lo personal —nombre, email, descripción y la
   * metadata que hubiéramos guardado—; los importes, fechas y PDF de cada
   * factura siguen en Stripe, con la copia del email que ya llevaba impresa cada
   * comprobante emitido.
   */
  private async anonymizeStripeCustomer(user: User): Promise<void> {
    if (!user.stripeCustomerId || !this.stripe) {
      return;
    }

    const customer = await this.stripe.customers.retrieve(
      user.stripeCustomerId,
    );

    if ((customer as Stripe.DeletedCustomer).deleted) {
      return;
    }

    // Stripe fusiona la metadata que se envía con la que ya había; para quitar
    // una clave hay que mandarla vacía, así que se enumeran las existentes.
    const clearedMetadata: Record<string, string> = {};
    for (const key of Object.keys(
      (customer as Stripe.Customer).metadata ?? {},
    )) {
      clearedMetadata[key] = '';
    }

    await this.stripe.customers.update(user.stripeCustomerId, {
      name: 'Deleted account',
      email: '',
      description: 'Account deleted at the user request',
      metadata: {
        ...clearedMetadata,
        account_deleted: 'true',
        account_deleted_at: new Date().toISOString(),
      },
    });

    this.logger.log(
      `Baja de cuenta ${user.id}: customer ${user.stripeCustomerId} anonimizado en Stripe`,
    );
  }
}
