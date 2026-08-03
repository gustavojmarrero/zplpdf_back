/**
 * Script de migración: Actualiza el país de usuarios Pro desde Stripe
 *
 * Obtiene el país de la tarjeta (payment_method.card.country) de Stripe
 * y actualiza los usuarios que tienen countrySource='ip' o sin country.
 *
 * Ejecutar con:
 * npx tsx src/scripts/migrate-user-country-from-stripe.ts
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
  apiVersion: '2025-11-17.clover',
});

// Inicializar Firebase Admin
const credentials = JSON.parse(process.env.FIREBASE_CREDENTIALS);
if (admin.apps.length === 0) {
  admin.initializeApp({
    credential: admin.credential.cert(credentials),
  });
}

const db = getFirestore();

interface UserData {
  id: string;
  email: string;
  plan: string;
  country?: string;
  countrySource?: string;
  stripeSubscriptionId?: string;
  stripeCustomerId?: string;
}

async function getCardCountryFromSubscription(
  subscriptionId: string,
): Promise<string | null> {
  try {
    // Obtener la suscripción
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['default_payment_method'],
    });

    // Intentar obtener el país del default_payment_method
    const pm = subscription.default_payment_method;
    if (pm && typeof pm === 'object' && pm.card?.country) {
      return pm.card.country;
    }

    // Si no hay default_payment_method, intentar con el customer
    if (subscription.customer) {
      const customerId =
        typeof subscription.customer === 'string'
          ? subscription.customer
          : subscription.customer.id;

      const customer = await stripe.customers.retrieve(customerId, {
        expand: ['invoice_settings.default_payment_method'],
      });

      if (customer && !customer.deleted) {
        const defaultPm = (customer as Stripe.Customer).invoice_settings
          ?.default_payment_method;
        if (
          defaultPm &&
          typeof defaultPm === 'object' &&
          defaultPm.card?.country
        ) {
          return defaultPm.card.country;
        }
      }
    }

    return null;
  } catch (error) {
    console.log(
      `  ⚠️  Error obteniendo suscripción ${subscriptionId}:`,
      (error as Error).message,
    );
    return null;
  }
}

async function migrateUserCountries() {
  console.log(
    '🚀 Iniciando migración de países de usuarios Pro desde Stripe...\n',
  );

  // Obtener usuarios Pro con countrySource='ip' o sin country
  const usersSnapshot = await db
    .collection('users')
    .where('plan', '==', 'pro')
    .get();

  console.log(`📊 Total usuarios Pro: ${usersSnapshot.size}\n`);

  let updated = 0;
  let skipped = 0;
  let noStripeData = 0;
  let alreadyStripe = 0;

  for (const doc of usersSnapshot.docs) {
    const user = { id: doc.id, ...doc.data() } as UserData;

    // Si ya tiene countrySource='stripe', saltar
    if (user.countrySource === 'stripe') {
      console.log(
        `  ⏭️  ${user.email} ya tiene countrySource='stripe' (${user.country})`,
      );
      alreadyStripe++;
      continue;
    }

    // Si no tiene stripeSubscriptionId, no podemos obtener el país
    if (!user.stripeSubscriptionId) {
      console.log(`  ⚠️  ${user.email} no tiene stripeSubscriptionId`);
      noStripeData++;
      continue;
    }

    // Obtener el país de la tarjeta desde Stripe
    const cardCountry = await getCardCountryFromSubscription(
      user.stripeSubscriptionId,
    );

    if (!cardCountry) {
      console.log(`  ⚠️  ${user.email} - No se pudo obtener país de Stripe`);
      skipped++;
      continue;
    }

    // Actualizar el usuario
    await db.collection('users').doc(user.id).update({
      country: cardCountry,
      countrySource: 'stripe',
      countryDetectedAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });

    const previousCountry = user.country || 'ninguno';
    const previousSource = user.countrySource || 'ninguno';
    console.log(
      `  ✅ ${user.email} | ${previousCountry} (${previousSource}) → ${cardCountry} (stripe)`,
    );
    updated++;
  }

  console.log('\n✨ Migración completada!');
  console.log(`   ✅ Actualizados: ${updated}`);
  console.log(`   ⏭️  Ya tenían stripe: ${alreadyStripe}`);
  console.log(`   ⚠️  Sin datos de Stripe: ${noStripeData}`);
  console.log(`   ❌ No se pudo obtener país: ${skipped}`);
}

migrateUserCountries()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Error en migración:', error);
    process.exit(1);
  });
