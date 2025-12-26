/**
 * Script de migración: Carga transacciones históricas de Stripe a Firestore
 *
 * Ejecutar con:
 * npx tsx src/scripts/migrate-stripe-transactions.ts
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import Stripe from 'stripe';
import admin from 'firebase-admin';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

if (!process.env.STRIPE_SECRET_KEY) {
  console.error('❌ STRIPE_SECRET_KEY no encontrada en .env');
  process.exit(1);
}

if (!process.env.FIREBASE_CREDENTIALS) {
  console.error('❌ FIREBASE_CREDENTIALS no encontrada en .env');
  process.exit(1);
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2025-04-30.basil',
});

// Inicializar Firebase Admin
const credentials = JSON.parse(process.env.FIREBASE_CREDENTIALS);
if (admin.apps.length === 0) {
  admin.initializeApp({
    credential: admin.credential.cert(credentials),
  });
}

const db = getFirestore();

interface StripeTransaction {
  id: string;
  stripeCustomerId: string;
  userId?: string;
  amount: number;
  amountMxn: number;
  currency: string;
  status: string;
  type: string;
  billingCountry?: string;
  createdAt: Date;
}

async function getExchangeRate(): Promise<number> {
  // Obtener tipo de cambio actual o usar uno por defecto
  try {
    const doc = await db.collection('exchange_rates').doc('USD_MXN').get();
    if (doc.exists) {
      return doc.data()?.rate || 20;
    }
  } catch (e) {
    console.log('Using default exchange rate');
  }
  return 20; // Default rate
}

async function migrateTransactions() {
  console.log('🚀 Iniciando migración de transacciones de Stripe...\n');

  const exchangeRate = await getExchangeRate();
  console.log(`📊 Tipo de cambio USD/MXN: ${exchangeRate}\n`);

  let hasMore = true;
  let startingAfter: string | undefined;
  let totalMigrated = 0;
  let totalSkipped = 0;

  while (hasMore) {
    // Obtener payment intents de Stripe
    const paymentIntents = await stripe.paymentIntents.list({
      limit: 100,
      starting_after: startingAfter,
    });

    console.log(`📦 Procesando ${paymentIntents.data.length} payment intents...`);

    for (const pi of paymentIntents.data) {
      // Solo procesar pagos exitosos
      if (pi.status !== 'succeeded') {
        totalSkipped++;
        continue;
      }

      // Solo transacciones de ZPLPDF: $10 USD (1000 cents) o $199 MXN (19900 cents)
      const isZplpdfTransaction =
        (pi.currency === 'usd' && pi.amount === 1000) ||
        (pi.currency === 'mxn' && pi.amount === 19900);

      if (!isZplpdfTransaction) {
        console.log(`  ⏭️  ${pi.id} no es ZPLPDF (${pi.currency.toUpperCase()} ${pi.amount / 100})`);
        totalSkipped++;
        continue;
      }

      // Verificar si ya existe - si existe pero no tiene billingCountry, actualizar
      const existingDoc = await db.collection('stripe_transactions').doc(pi.id).get();
      if (existingDoc.exists) {
        const existingData = existingDoc.data();
        if (existingData?.billingCountry) {
          console.log(`  ⏭️  ${pi.id} ya existe con país, saltando...`);
          totalSkipped++;
          continue;
        }
        // Si no tiene país, continuar para actualizar
        console.log(`  🔄 ${pi.id} existe sin país, actualizando...`);
      }

      // Obtener país del payment method (card.country)
      let billingCountry: string | undefined;
      let userId: string | undefined;

      // Obtener del payment method
      if (pi.payment_method) {
        try {
          const pm = await stripe.paymentMethods.retrieve(pi.payment_method as string);
          billingCountry = pm.card?.country || undefined;
        } catch (e) {
          // Ignorar error, intentar con charge
        }
      }

      // Si no hay país del PM, intentar del charge
      if (!billingCountry && pi.latest_charge) {
        try {
          const charge = await stripe.charges.retrieve(pi.latest_charge as string);
          billingCountry =
            charge.billing_details?.address?.country ||
            (charge.payment_method_details as any)?.card?.country ||
            undefined;
        } catch (e) {
          // Ignorar error
        }
      }

      // Buscar usuario por stripeCustomerId
      if (pi.customer) {
        try {
          const userSnapshot = await db
            .collection('users')
            .where('stripeCustomerId', '==', pi.customer)
            .limit(1)
            .get();

          if (!userSnapshot.empty) {
            userId = userSnapshot.docs[0].id;
            // Si no tenemos país del charge, usar el del usuario
            if (!billingCountry) {
              const userData = userSnapshot.docs[0].data();
              billingCountry = userData.country || undefined;
            }
          }
        } catch (e) {
          console.log(`  ⚠️  No se pudo buscar usuario para ${pi.customer}`);
        }
      }

      // Si no hay país, inferir por moneda
      if (!billingCountry) {
        billingCountry = pi.currency === 'mxn' ? 'MX' : undefined;
      }

      // Calcular amount en MXN
      const amountInUnits = pi.amount / 100;
      const amountMxn = pi.currency === 'mxn' ? amountInUnits : amountInUnits * exchangeRate;

      const transaction: StripeTransaction = {
        id: pi.id,
        stripeCustomerId: (pi.customer as string) || '',
        userId,
        amount: pi.amount,
        amountMxn,
        currency: pi.currency,
        status: pi.status,
        type: 'payment',
        billingCountry,
        createdAt: new Date(pi.created * 1000),
      };

      // Guardar en Firestore - filtrar undefined
      const docData: Record<string, any> = {
        id: transaction.id,
        stripeCustomerId: transaction.stripeCustomerId,
        amount: transaction.amount,
        amountMxn: transaction.amountMxn,
        currency: transaction.currency,
        status: transaction.status,
        type: transaction.type,
        createdAt: Timestamp.fromDate(transaction.createdAt),
      };

      if (transaction.userId) docData.userId = transaction.userId;
      if (transaction.billingCountry) docData.billingCountry = transaction.billingCountry;

      await db.collection('stripe_transactions').doc(pi.id).set(docData);

      console.log(
        `  ✅ ${pi.id} | ${pi.currency.toUpperCase()} ${amountInUnits} | País: ${billingCountry || 'unknown'}`,
      );
      totalMigrated++;
    }

    hasMore = paymentIntents.has_more;
    if (hasMore && paymentIntents.data.length > 0) {
      startingAfter = paymentIntents.data[paymentIntents.data.length - 1].id;
    }
  }

  console.log('\n✨ Migración completada!');
  console.log(`   📊 Transacciones migradas: ${totalMigrated}`);
  console.log(`   ⏭️  Transacciones saltadas: ${totalSkipped}`);
}

migrateTransactions()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Error en migración:', error);
    process.exit(1);
  });
