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
  | 'batches'
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
 * obligación fiscal (México), y los registros contables locales
 * (`stripe_transactions`, `subscription_events`) sostienen las métricas de
 * ingresos y churn. No se borran: se **desvinculan** del usuario —`userId` pasa
 * a un marcador, `userEmail` se vacía y el customer de Stripe pierde nombre,
 * email y metadata—, de modo que el registro sobrevive sin identificar a nadie. La
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

    // Desde este punto ninguna conversión, batch ni petición nueva puede volver
    // a escribir datos del UID. La marca se conserva tras el éxito para cubrir
    // tokens de Firebase todavía válidos y se retira si la identidad sobrevive.
    await this.firestoreService.markAccountDeletion(userId);

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

    // Las conversiones batch no pasan por `conversion_history` con su archivo:
    // el ZIP vive en `batches/<batchId>/` y el documento de `zpl-batches` lleva
    // userId, los nombres de los ficheros subidos y una `downloadUrl` que el
    // endpoint de estado sigue sirviendo. Sin este paso, la baja dejaría
    // descargables los archivos de una cuenta que ya no existe.
    try {
      // Los ZIP primero y el documento después: el `batchId` es la única pista
      // para encontrar `batches/<batchId>/`, así que borrar el documento antes
      // y fallar luego en Storage dejaría los archivos huérfanos e ilocalizables
      // para un reintento.
      const batchIds = await this.firestoreService.getBatchIdsByUserId(userId);
      const purgedBatchIds: string[] = [];

      for (const batchId of batchIds) {
        storedFiles += await this.storageService.deleteByPrefix(
          `batches/${batchId}/`,
        );
        purgedBatchIds.push(batchId);
      }

      await this.firestoreService.deleteBatchJobsByIds(purgedBatchIds);
      await this.firestoreService.deleteConversionStatusesByUserId(userId);
    } catch (error) {
      failed('batches', error);
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

    // Los envíos pendientes se cancelan antes de anonimizar la cola: al revés,
    // el barrido de cancelación ya no encontraría sus documentos por `userId`.
    try {
      await this.firestoreService.cancelPendingEmails(userId);
    } catch (error) {
      this.logger.warn(
        `Baja de cuenta ${userId}: no se pudieron cancelar los emails pendientes — ${error.message}`,
      );
    }

    try {
      retainedRecords = await this.firestoreService.anonymizeUserCfdis(userId);
      await this.firestoreService.anonymizeUserFinancialRecords(userId);
      await this.firestoreService.anonymizeUserActivityRecords(userId);
      await this.anonymizeStripeCustomer(user);
    } catch (error) {
      failed('retainedRecords', error);
    }

    let accountDeleted = false;

    // La identidad se borra solo si no quedó nada pendiente. Con datos o
    // archivos del usuario aún sin tocar, borrar el perfil y la cuenta de Auth
    // dejaría a esos restos sin dueño y al usuario sin forma de autenticarse
    // para reintentar la baja: el 500 con `failedSteps` es preferible a una
    // cuenta medio borrada que nadie puede terminar de borrar.
    if (failedSteps.length > 0) {
      this.logger.error(
        `Baja de cuenta ${userId}: no se borra la identidad porque quedaron pasos ` +
          `pendientes (${failedSteps.join(', ')}); el usuario conserva el acceso ` +
          'para reintentar',
      );
    } else {
      try {
        await this.firestoreService.deleteUser(userId);
        accountDeleted = true;
      } catch (error) {
        failed('account', error);
      }
    }

    if (accountDeleted) {
      // Segundo pase, idempotente y normalmente vacío. La cancelación de la
      // suscripción dispara `customer.subscription.deleted`, cuyo manejador
      // puede escribir un `subscription_event` con el email del titular mientras
      // esta baja avanza. En cuanto el documento de `users` desaparece, ese
      // manejador sale sin escribir —busca al usuario por customer y no lo
      // encuentra—, así que barrer aquí cierra la ventana en la que el webhook
      // pudo colarse entre la anonimización y el borrado.
      //
      // Va ANTES de borrar Firebase Auth: si falla, el usuario conserva las
      // credenciales con las que reintentar la baja y terminar la limpieza.
      try {
        await this.firestoreService.anonymizeUserFinancialRecords(userId);
        await this.firestoreService.anonymizeUserActivityRecords(userId);
      } catch (error) {
        failed('retainedRecords', error);
        accountDeleted = false;
      }
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
      // Una baja parcial conserva Firebase Auth para que el titular pueda
      // reintentar. La lápida también debe desaparecer: de lo contrario el
      // guard rechazaría ese reintento y la cuenta quedaría inutilizable.
      try {
        await this.firestoreService.clearAccountDeletionMark(userId);
      } catch (error) {
        this.logger.error(
          `Baja de cuenta ${userId}: no se pudo retirar la marca para reintentar — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        if (!failedSteps.includes('account')) {
          failedSteps.push('account');
        }
      }

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
    if (!user.stripeSubscriptionId && !user.stripeCustomerId) {
      return { cancelled: false, plan: null, effectiveAt: null };
    }

    if (!this.stripe) {
      // Con rastro de Stripe y sin cliente no hay forma de comprobar ni de
      // cancelar: borrar la cuenta podría dejarla cobrando.
      throw this.subscriptionCancelFailed(user, 'stripe_not_configured');
    }

    let subscriptionIds: string[];

    try {
      subscriptionIds = await this.resolveLiveSubscriptionIds(user);
    } catch (error) {
      this.logger.error(
        `Baja de cuenta ${user.id}: no se pudieron resolver las suscripciones — ${error.message}`,
      );
      throw this.subscriptionCancelFailed(user, error?.code ?? 'stripe_error');
    }

    if (subscriptionIds.length === 0) {
      return {
        cancelled: false,
        plan: user.stripeSubscriptionId ? (user.plan ?? null) : null,
        effectiveAt: null,
      };
    }

    let canceledAt: Date | null = null;
    const cancelledIds: string[] = [];

    for (const subscriptionId of subscriptionIds) {
      try {
        const cancelled =
          await this.stripe.subscriptions.cancel(subscriptionId);

        cancelledIds.push(subscriptionId);
        canceledAt = cancelled.canceled_at
          ? new Date(cancelled.canceled_at * 1000)
          : new Date();
      } catch (error) {
        this.logger.error(
          `Baja de cuenta ${user.id}: Stripe rechazó cancelar ${subscriptionId} — ${error.message}`,
        );
        // Lo ya cancelado no se deshace, así que la respuesta lo dice: decirle
        // "no se ha tocado nada" a quien acaba de perder una suscripción sería
        // un estado financiero falso, aunque no se haya borrado ningún dato.
        throw this.subscriptionCancelFailed(
          user,
          error?.code ?? 'stripe_error',
          {
            cancelledSubscriptions: cancelledIds,
            pendingSubscriptions: subscriptionIds.filter(
              (id) => !cancelledIds.includes(id),
            ),
          },
        );
      }
    }

    return {
      cancelled: true,
      plan: user.plan ?? null,
      effectiveAt: (canceledAt ?? new Date()).toISOString(),
    };
  }

  /**
   * Suscripciones vivas del usuario, mirando al customer y no solo al id que
   * tengamos guardado.
   *
   * `stripeSubscriptionId` puede faltar o estar desfasado —un checkout cuyo
   * webhook no llegó, una suscripción duplicada—, y fiarse solo de él dejaría un
   * contrato cobrando a una cuenta que acabamos de borrar. El propio flujo de
   * alta ya consulta por `stripeCustomerId` por este mismo motivo.
   *
   * Se devuelven sin duplicar y solo las que no están canceladas: cancelar una
   * ya cancelada no aporta nada y Stripe lo rechaza.
   */
  private async resolveLiveSubscriptionIds(user: User): Promise<string[]> {
    const ids = new Set<string>();

    if (user.stripeSubscriptionId) {
      try {
        const current = await this.stripe.subscriptions.retrieve(
          user.stripeSubscriptionId,
        );

        if (current.status === 'canceled') {
          this.logger.log(
            `Baja de cuenta ${user.id}: la suscripción ${current.id} ya estaba cancelada`,
          );
        } else {
          ids.add(current.id);
        }
      } catch (error) {
        // Un id guardado que Stripe ya no conoce es basura de un checkout que
        // no cuajó, no un motivo para dejar a alguien sin poder darse de baja:
        // se sigue con las suscripciones reales del customer. Cualquier otro
        // fallo sí aborta, porque entonces no sabemos qué hay vivo.
        if (error?.code !== 'resource_missing') {
          throw error;
        }

        this.logger.warn(
          `Baja de cuenta ${user.id}: la suscripción ${user.stripeSubscriptionId} ` +
            'ya no existe en Stripe; se comprueban las del customer',
        );
      }
    }

    if (user.stripeCustomerId) {
      const subscriptions = await this.stripe.subscriptions.list({
        customer: user.stripeCustomerId,
        status: 'all',
        limit: 100,
      });

      for (const subscription of subscriptions.data) {
        if (subscription.status !== 'canceled') {
          ids.add(subscription.id);
        }
      }
    }

    return [...ids];
  }

  private subscriptionCancelFailed(
    user: User,
    reason: string,
    partial?: {
      cancelledSubscriptions: string[];
      pendingSubscriptions: string[];
    },
  ): HttpException {
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
          // Presentes solo cuando el customer tenía varias suscripciones y unas
          // se cancelaron antes del rechazo: ningún dato se ha borrado, pero
          // esas ya no vuelven.
          ...(partial ?? {}),
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

      const deletableIds: string[] = [];

      for (const record of records) {
        const path = extractStoragePathFromSignedUrl(record.fileUrl);

        if (!path) {
          deletableIds.push(record.id);
          continue;
        }

        try {
          if (await this.storageService.deleteFile(path)) {
            storedFiles++;
          }
          deletableIds.push(record.id);
        } catch (error) {
          // La fila se queda: su `fileUrl` es la única pista para volver a
          // intentar borrar el objeto. Borrarla ahora dejaría el archivo en el
          // bucket y sin nada que lo señale.
          storageFailed = true;
          this.logger.warn(
            `Baja de cuenta ${userId}: no se pudo borrar ${path}; se conserva la ` +
              `fila ${record.id} para poder reintentarlo — ${error.message}`,
          );
        }
      }

      conversions +=
        await this.firestoreService.deleteConversionHistoryByIds(deletableIds);

      // Sin ninguna fila borrada, la siguiente lectura devolvería las mismas y
      // el bucle daría vueltas hasta agotar el tope de páginas.
      if (
        deletableIds.length === 0 ||
        records.length < HISTORY_DELETION_PAGE_SIZE
      ) {
        return { conversions, storedFiles, storageFailed, incomplete };
      }
    }

    // Agotar las páginas no significa que quede algo: una cuenta con un múltiplo
    // exacto del tamaño de página se borra entera en la última vuelta. Sin esta
    // lectura, esa baja devolvería un 500 y conservaría la identidad sin motivo.
    const remaining = await this.firestoreService.scanUserConversionHistory(
      userId,
      1,
    );
    incomplete = remaining.length > 0;

    if (incomplete) {
      this.logger.error(
        `Baja de cuenta ${userId}: se agotaron las ${MAX_HISTORY_DELETION_PAGES} páginas ` +
          'de borrado del historial y aún quedan registros',
      );
    }

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
    if (!user.stripeCustomerId) {
      return;
    }

    if (!this.stripe) {
      // Sin cliente de Stripe el customer se queda con nombre, email y
      // metadata. Devolver 200 aquí afirmaría que solo sobreviven comprobantes
      // anonimizados, que es exactamente lo contrario de lo que pasó.
      throw new Error(
        'stripe_not_configured: no se puede anonimizar el customer de Stripe',
      );
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
      phone: '',
      // El perfil fiscal propaga el domicilio al customer
      // (`BillingService.syncTaxProfileToStripe`): vaciarlo es tan necesario
      // como el email, es la dirección de una persona.
      address: null,
      description: 'Account deleted at the user request',
      metadata: {
        ...clearedMetadata,
        account_deleted: 'true',
        account_deleted_at: new Date().toISOString(),
      },
    });

    // El RFC/VAT vive en objetos aparte del customer, así que el update anterior
    // no lo toca. Las facturas ya emitidas conservan su copia impresa —eso es lo
    // retenido—, pero el identificador fiscal reutilizable no puede quedarse
    // colgando de un customer sin titular.
    await this.deleteCustomerTaxIds(user.stripeCustomerId);

    this.logger.log(
      `Baja de cuenta ${user.id}: customer ${user.stripeCustomerId} anonimizado en Stripe`,
    );
  }

  /** Borra los tax IDs (RFC, VAT) asociados al customer. */
  private async deleteCustomerTaxIds(customerId: string): Promise<void> {
    const taxIds = await this.stripe.customers.listTaxIds(customerId, {
      limit: 100,
    });

    for (const taxId of taxIds.data) {
      await this.stripe.customers.deleteTaxId(customerId, taxId.id);
    }
  }
}
