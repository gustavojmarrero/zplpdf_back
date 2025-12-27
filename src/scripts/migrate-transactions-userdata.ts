/**
 * Script de migración: Completa userEmail y plan en transacciones históricas
 *
 * Ejecutar con:
 * npx tsx src/scripts/migrate-transactions-userdata.ts
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import Stripe from 'stripe';
import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';

if (!process.env.STRIPE_SECRET_KEY) {
  console.error('STRIPE_SECRET_KEY no encontrada en .env');
  process.exit(1);
}

if (!process.env.FIREBASE_CREDENTIALS) {
  console.error('FIREBASE_CREDENTIALS no encontrada en .env');
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

async function migrateUserData() {
  console.log('Iniciando migración de userEmail/plan en transacciones...\n');

  // 1. Buscar transacciones sin userEmail o con userEmail vacío
  const snapshot = await db.collection('stripe_transactions').get();

  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  console.log(`Encontradas ${snapshot.size} transacciones totales\n`);

  for (const doc of snapshot.docs) {
    const tx = doc.data();

    // Verificar si necesita actualización
    const needsEmail = !tx.userEmail || tx.userEmail === '';
    const needsPlan = !tx.plan;

    if (!needsEmail && !needsPlan) {
      totalSkipped++;
      continue;
    }

    console.log(`Procesando ${doc.id}...`);

    const updates: Record<string, unknown> = {};
    let stripeCustomerId = tx.stripeCustomerId;

    // Si no hay stripeCustomerId, intentar obtenerlo del PaymentIntent en Stripe
    if (!stripeCustomerId && doc.id.startsWith('pi_')) {
      try {
        const pi = await stripe.paymentIntents.retrieve(doc.id);
        if (pi.customer) {
          stripeCustomerId = pi.customer as string;
          updates.stripeCustomerId = stripeCustomerId;
          console.log(`  stripeCustomerId desde PI: ${stripeCustomerId}`);
        }
      } catch (e) {
        console.log(`  No se pudo obtener PaymentIntent ${doc.id}`);
      }
    }

    // Intentar obtener datos del usuario en Firestore primero
    if (tx.userId) {
      try {
        const userDoc = await db.collection('users').doc(tx.userId).get();
        if (userDoc.exists) {
          const userData = userDoc.data();
          if (needsEmail && userData?.email) {
            updates.userEmail = userData.email;
            console.log(`  userEmail desde users: ${userData.email}`);
          }
          if (needsPlan) {
            updates.plan = userData?.plan === 'enterprise' ? 'enterprise' : 'pro';
            console.log(`  plan desde users: ${updates.plan}`);
          }
        }
      } catch (e) {
        console.log(`  No se pudo obtener usuario ${tx.userId}`);
      }
    }

    // Si aún falta email, intentar desde Stripe customer
    if (needsEmail && !updates.userEmail && stripeCustomerId) {
      try {
        const customer = await stripe.customers.retrieve(stripeCustomerId);
        if (customer && !customer.deleted && 'email' in customer && customer.email) {
          updates.userEmail = customer.email;
          console.log(`  userEmail desde Stripe: ${customer.email}`);
        }
      } catch (e) {
        console.log(`  No se pudo obtener customer de Stripe ${stripeCustomerId}`);
      }
    }

    // Si aún falta plan, inferir del tipo de transacción (todas son Pro)
    if (needsPlan && !updates.plan) {
      updates.plan = 'pro';
      console.log(`  plan inferido: pro`);
    }

    // Si aún falta email, usar Unknown
    if (needsEmail && !updates.userEmail) {
      updates.userEmail = 'Unknown';
      console.log(`  userEmail fallback: Unknown`);
    }

    // Aplicar actualizaciones si hay alguna
    if (Object.keys(updates).length > 0) {
      try {
        await doc.ref.update(updates);
        console.log(`  Actualizado con: ${JSON.stringify(updates)}`);
        totalUpdated++;
      } catch (e) {
        console.log(`  Error al actualizar: ${e}`);
        totalErrors++;
      }
    } else {
      console.log(`  No hay datos para actualizar`);
      totalSkipped++;
    }
  }

  console.log('\nMigración completada!');
  console.log(`  Actualizadas: ${totalUpdated}`);
  console.log(`  Saltadas (ya completas): ${totalSkipped}`);
  console.log(`  Errores: ${totalErrors}`);
}

migrateUserData()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error en migración:', error);
    process.exit(1);
  });
