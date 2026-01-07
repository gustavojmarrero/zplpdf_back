/**
 * Script de migración: Sincroniza períodos de facturación de Stripe a Firestore
 *
 * Para cada usuario Pro/Promax con stripeSubscriptionId:
 * 1. Obtiene current_period_start y current_period_end de Stripe
 * 2. Guarda subscriptionPeriodStart y subscriptionPeriodEnd en Firestore
 *
 * Esto elimina la necesidad de llamar a Stripe en tiempo real para
 * calcular períodos de facturación.
 *
 * Ejecutar con:
 * STRIPE_SECRET_KEY=sk_live_xxx npx tsx src/scripts/migrate-subscription-periods.ts
 *
 * O para dry-run (sin guardar):
 * STRIPE_SECRET_KEY=sk_live_xxx npx tsx src/scripts/migrate-subscription-periods.ts --dry-run
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import * as fs from 'fs';
import * as path from 'path';
import Stripe from 'stripe';
import admin from 'firebase-admin';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const isDryRun = process.argv.includes('--dry-run');

if (!process.env.STRIPE_SECRET_KEY) {
  console.error('❌ STRIPE_SECRET_KEY no encontrada en .env');
  console.error('   Ejecuta con: STRIPE_SECRET_KEY=sk_live_xxx npx tsx src/scripts/migrate-subscription-periods.ts');
  process.exit(1);
}

// Verificar que es una key de live mode
if (!process.env.STRIPE_SECRET_KEY.startsWith('sk_live_') && !process.env.STRIPE_SECRET_KEY.startsWith('rk_live_')) {
  console.error('⚠️  Advertencia: La STRIPE_SECRET_KEY no parece ser de live mode');
  console.error('   Las suscripciones en Firestore son de producción');
}

const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!credentialsPath) {
  console.error('❌ GOOGLE_APPLICATION_CREDENTIALS no encontrada');
  process.exit(1);
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2025-11-17.clover',
});

// Inicializar Firebase Admin
const absolutePath = path.resolve(credentialsPath);
const credentialsContent = fs.readFileSync(absolutePath, 'utf-8');
const credentials = JSON.parse(credentialsContent);
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
  stripeSubscriptionId?: string;
  subscriptionPeriodStart?: Date;
  subscriptionPeriodEnd?: Date;
}

interface SubscriptionPeriod {
  start: Date;
  end: Date;
}

async function getSubscriptionPeriod(subscriptionId: string): Promise<SubscriptionPeriod | null> {
  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId) as Stripe.Subscription;

    const periodStart = (subscription as { current_period_start?: number }).current_period_start;
    const periodEnd = (subscription as { current_period_end?: number }).current_period_end;

    if (!periodStart || !periodEnd) {
      return null;
    }

    return {
      start: new Date(periodStart * 1000),
      end: new Date(periodEnd * 1000),
    };
  } catch (error) {
    const err = error as Error;
    // Manejar suscripciones no encontradas (pueden haber sido canceladas)
    if (err.message.includes('No such subscription')) {
      return null;
    }
    throw error;
  }
}

async function migrateSubscriptionPeriods() {
  console.log('🚀 Iniciando migración de períodos de suscripción desde Stripe...');
  console.log(`   Modo: ${isDryRun ? 'DRY-RUN (sin guardar)' : 'REAL (guardando en Firestore)'}\n`);

  // Obtener usuarios Pro y Promax con stripeSubscriptionId
  const proSnapshot = await db.collection('users').where('plan', '==', 'pro').get();
  const promaxSnapshot = await db.collection('users').where('plan', '==', 'promax').get();

  const allDocs = [...proSnapshot.docs, ...promaxSnapshot.docs];
  console.log(`📊 Total usuarios Pro/Promax: ${allDocs.length}\n`);

  let updated = 0;
  let skipped = 0;
  let noSubscription = 0;
  let alreadyHasPeriod = 0;
  let errors = 0;

  for (const doc of allDocs) {
    const user = { id: doc.id, ...doc.data() } as UserData;

    // Si no tiene stripeSubscriptionId, saltar
    if (!user.stripeSubscriptionId) {
      console.log(`  ⚠️  ${user.email} - Sin stripeSubscriptionId`);
      noSubscription++;
      continue;
    }

    // Si ya tiene fechas de período, verificar si son válidas
    if (user.subscriptionPeriodStart && user.subscriptionPeriodEnd) {
      console.log(`  ⏭️  ${user.email} - Ya tiene período configurado`);
      alreadyHasPeriod++;
      continue;
    }

    try {
      // Obtener el período de la suscripción desde Stripe
      const period = await getSubscriptionPeriod(user.stripeSubscriptionId);

      if (!period) {
        console.log(`  ⚠️  ${user.email} - Suscripción no encontrada en Stripe (${user.stripeSubscriptionId})`);
        skipped++;
        continue;
      }

      if (!isDryRun) {
        // Actualizar el usuario en Firestore
        await db.collection('users').doc(user.id).update({
          subscriptionPeriodStart: Timestamp.fromDate(period.start),
          subscriptionPeriodEnd: Timestamp.fromDate(period.end),
          updatedAt: Timestamp.now(),
        });
      }

      console.log(
        `  ✅ ${user.email} | ${period.start.toISOString().split('T')[0]} → ${period.end.toISOString().split('T')[0]}${isDryRun ? ' (dry-run)' : ''}`,
      );
      updated++;
    } catch (error) {
      console.error(`  ❌ ${user.email} - Error:`, (error as Error).message);
      errors++;
    }

    // Pequeña pausa para no saturar la API de Stripe
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.log('\n✨ Migración completada!');
  console.log(`   ✅ Actualizados: ${updated}`);
  console.log(`   ⏭️  Ya tenían período: ${alreadyHasPeriod}`);
  console.log(`   ⚠️  Sin stripeSubscriptionId: ${noSubscription}`);
  console.log(`   ⚠️  Suscripción no encontrada: ${skipped}`);
  console.log(`   ❌ Errores: ${errors}`);

  if (isDryRun) {
    console.log('\n💡 Ejecuta sin --dry-run para aplicar los cambios');
  }
}

migrateSubscriptionPeriods()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Error en migración:', error);
    process.exit(1);
  });
