/**
 * Migration script: añade el enlace de baja al pie de las plantillas de
 * Firestore que ya prometen «puedes darte de baja en cualquier momento» sin
 * enlazar nada (ver issue zplpdf_back#116).
 *
 * Recorre `email_templates`, y en cada variante A/B y cada idioma (en, es,
 * zh, pt) busca la frase de baja original (la que sembró
 * `templates/email-templates.ts`, `baseTemplate()`) y la sustituye por la
 * misma frase con el enlace real vía el placeholder `{unsubscribeUrl}`, que
 * `EmailService.sendEmail` resuelve al enviar. Un cuerpo que ya tenga el
 * placeholder, o que no contenga la frase original (fue editado a mano desde
 * el panel de admin), se deja igual y se reporta aparte para revisión manual.
 *
 * Solo toca plantillas cuyo `templateKey` esté clasificado en una categoría
 * de notificación (ver `email-categories.ts`): un tipo sin categoría no se
 * puede desactivar desde Ajustes, así que el enlace de baja no aplica y el
 * documento se salta entero, tenga o no la frase.
 *
 * Cada documento se lee y se escribe dentro de una única transacción de
 * Firestore (lectura + `update` del contenido + entrada en
 * `email_template_versions`, replicando los mismos campos que
 * `FirestoreService.updateEmailTemplate`), para que una edición concurrente
 * desde el panel de admin no se pierda y quede historial para poder revertir.
 *
 * Uso:
 *   npx tsx src/scripts/migrate-unsubscribe-footer.ts             # dry-run (default)
 *   npx tsx src/scripts/migrate-unsubscribe-footer.ts --dry-run   # dry-run explícito
 *   npx tsx src/scripts/migrate-unsubscribe-footer.ts --execute   # aplica los cambios
 */

import admin from 'firebase-admin';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { getEmailNotificationCategory } from '../modules/email/email-categories.js';

dotenv.config();

const execute = process.argv.includes('--execute');

const EMAIL_TEMPLATES_COLLECTION = 'email_templates';
const TEMPLATE_VERSIONS_COLLECTION = 'email_template_versions';
const SCRIPT_ACTOR = 'migrate-unsubscribe-footer-script';
const VARIANTS = ['A', 'B'] as const;
const LANGUAGES = ['en', 'es', 'zh', 'pt'] as const;
type Language = (typeof LANGUAGES)[number];

/** Frase original, tal como la sembró `templates/email-templates.ts` (`baseTemplate`). */
const OLD_FOOTER_TEXT: Record<Language, string> = {
  en: 'You received this email because you signed up for ZPLPDF. If you no longer wish to receive these emails, you can unsubscribe at any time.',
  es: 'Recibiste este correo porque te registraste en ZPLPDF. Si ya no deseas recibir estos correos, puedes darte de baja en cualquier momento.',
  zh: '您收到此邮件是因为您注册了ZPLPDF。如果您不希望收到这些邮件，可以随时取消订阅。',
  pt: 'Você recebeu este e-mail porque se cadastrou no ZPLPDF. Se não deseja mais receber estes e-mails, pode cancelar a inscrição a qualquer momento.',
};

/** Misma frase, con la promesa ahora enlazada al placeholder que resuelve EmailService. */
const NEW_FOOTER_TEXT: Record<Language, string> = {
  en: 'You received this email because you signed up for ZPLPDF. If you no longer wish to receive these emails, you can <a href="{unsubscribeUrl}" style="color: #6b7280;">unsubscribe at any time</a>.',
  es: 'Recibiste este correo porque te registraste en ZPLPDF. Si ya no deseas recibir estos correos, puedes <a href="{unsubscribeUrl}" style="color: #6b7280;">darte de baja en cualquier momento</a>.',
  zh: '您收到此邮件是因为您注册了ZPLPDF。如果您不希望收到这些邮件，可以随时<a href="{unsubscribeUrl}" style="color: #6b7280;">取消订阅</a>。',
  pt: 'Você recebeu este e-mail porque se cadastrou no ZPLPDF. Se não deseja mais receber estes e-mails, pode <a href="{unsubscribeUrl}" style="color: #6b7280;">cancelar a inscrição a qualquer momento</a>.',
};

type TxOutcome =
  | { status: 'missing' }
  | { status: 'stale'; name: string }
  | { status: 'updated'; name: string };

interface PlannedChange {
  docId: string;
  templateKey: string;
  variant: (typeof VARIANTS)[number];
  language: Language;
}

type SkipReason =
  | 'already-has-placeholder'
  | 'phrase-not-found'
  | 'missing-content'
  | 'no-notification-category';

interface SkippedEntry {
  docId: string;
  templateKey: string;
  variant: (typeof VARIANTS)[number];
  language: Language;
  reason: SkipReason;
}

function initFirebase(): admin.firestore.Firestore {
  const credentialsPath = path.join(process.cwd(), 'firebase-credentials.json');
  if (!process.env.FIREBASE_CREDENTIALS && fs.existsSync(credentialsPath)) {
    process.env.FIREBASE_CREDENTIALS = fs.readFileSync(credentialsPath, 'utf8');
  }

  const raw =
    process.env.FIREBASE_CREDENTIALS || process.env.GOOGLE_CREDENTIALS;
  if (!raw) {
    console.error(
      'Error: no se encontraron credenciales de Firebase (FIREBASE_CREDENTIALS / GOOGLE_CREDENTIALS / firebase-credentials.json)',
    );
    process.exit(1);
  }

  const parsed = JSON.parse(raw);
  if (parsed.private_key) {
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
  }

  admin.initializeApp({
    credential: admin.credential.cert(parsed),
    projectId: process.env.FIREBASE_PROJECT_ID || parsed.project_id,
  });

  return admin.firestore();
}

async function main(): Promise<void> {
  console.log(
    `Mode: ${execute ? 'EXECUTE (escribirá en Firestore)' : 'DRY-RUN (solo lista los cambios)'}`,
  );

  const db = initFirebase();
  const snap = await db.collection(EMAIL_TEMPLATES_COLLECTION).get();
  console.log(`Plantillas encontradas: ${snap.size}\n`);

  const planned: PlannedChange[] = [];
  const skipped: SkippedEntry[] = [];

  for (const doc of snap.docs) {
    const data = doc.data();
    const templateKey = data.templateKey || doc.id;
    const category = getEmailNotificationCategory(templateKey);

    for (const variant of VARIANTS) {
      for (const language of LANGUAGES) {
        const body = data.content?.[variant]?.[language]?.body;

        if (typeof body !== 'string') {
          // pt es opcional en LanguageContent; no todas las plantillas lo tienen.
          if (language !== 'pt') {
            skipped.push({
              docId: doc.id,
              templateKey,
              variant,
              language,
              reason: 'missing-content',
            });
          }
          continue;
        }

        if (!category) {
          skipped.push({
            docId: doc.id,
            templateKey,
            variant,
            language,
            reason: 'no-notification-category',
          });
          continue;
        }

        if (body.includes('{unsubscribeUrl}')) {
          skipped.push({
            docId: doc.id,
            templateKey,
            variant,
            language,
            reason: 'already-has-placeholder',
          });
          continue;
        }

        if (!body.includes(OLD_FOOTER_TEXT[language])) {
          skipped.push({
            docId: doc.id,
            templateKey,
            variant,
            language,
            reason: 'phrase-not-found',
          });
          continue;
        }

        planned.push({ docId: doc.id, templateKey, variant, language });
      }
    }
  }

  console.log(`=== Cambios planeados: ${planned.length} ===`);
  for (const change of planned) {
    console.log(
      `  ${change.templateKey} (${change.docId}) [${change.variant}/${change.language}]`,
    );
  }

  console.log(`\n=== Omitidos: ${skipped.length} ===`);
  const byReason = skipped.reduce<Record<string, number>>((acc, s) => {
    acc[s.reason] = (acc[s.reason] || 0) + 1;
    return acc;
  }, {});
  for (const [reason, count] of Object.entries(byReason)) {
    console.log(`  ${reason}: ${count}`);
  }

  const needsReview = skipped.filter((s) => s.reason === 'phrase-not-found');
  if (needsReview.length > 0) {
    console.log('\n--- phrase-not-found (revisar a mano) ---');
    for (const s of needsReview) {
      console.log(
        `  ${s.templateKey} (${s.docId}) [${s.variant}/${s.language}]`,
      );
    }
  }

  const noCategory = skipped.filter(
    (s) => s.reason === 'no-notification-category',
  );
  if (noCategory.length > 0) {
    console.log(
      '\n--- no-notification-category (sin categoría en email-categories.ts, no se tocan) ---',
    );
    const byTemplate = new Set(
      noCategory.map((s) => `${s.templateKey} (${s.docId})`),
    );
    for (const label of byTemplate) {
      console.log(`  ${label}`);
    }
  }

  if (!execute) {
    console.log('\nDry-run listo. Re-ejecuta con --execute para aplicar.');
    process.exit(0);
  }

  if (planned.length === 0) {
    console.log('\nNada que aplicar.');
    process.exit(0);
  }

  console.log(`\nAplicando ${planned.length} cambios...`);

  // Se agrupa por doc: cada documento se reescribe entero en una única
  // transacción (lectura + escritura + versión de historial), y varias
  // entradas de `planned` pueden apuntar al mismo doc (varias variantes o
  // idiomas de la misma plantilla).
  const byDoc = new Map<string, PlannedChange[]>();
  for (const change of planned) {
    const list = byDoc.get(change.docId) || [];
    list.push(change);
    byDoc.set(change.docId, list);
  }

  let updatedDocs = 0;
  let skippedDocs = 0;
  const failedDocs: string[] = [];
  for (const [docId, changes] of byDoc) {
    const docRef = db.collection(EMAIL_TEMPLATES_COLLECTION).doc(docId);

    // Cada documento va aislado: un fallo en uno no puede dejar la migración a
    // medias sin terminar el resto ni ocultar cuáles fallaron.
    let outcome: TxOutcome;
    try {
      outcome = await db.runTransaction(async (tx): Promise<TxOutcome> => {
        // Lectura y escritura dentro de la MISMA transacción: si un admin
        // guarda la plantilla desde el panel entre el get() y el update(), esta
        // transacción reintenta sobre los datos frescos en vez de pisar su
        // edición.
        const docSnap = await tx.get(docRef);
        const data = docSnap.data();
        if (!data) return { status: 'missing' };

        // El plan se hizo en el escaneo inicial y puede estar obsoleto: un admin
        // puede haber editado o borrado una variante o un idioma desde entonces,
        // y Firestore solo reintenta por cambios POSTERIORES a este tx.get. Por
        // eso cada cambio se revalida contra los datos frescos: si la ruta ya no
        // existe, la frase antigua ya no está o el placeholder ya se puso, ese
        // cambio se descarta en lugar de lanzar o de reemplazar en falso.
        const content = data.content;
        let applied = 0;
        for (const change of changes) {
          const langContent = content?.[change.variant]?.[change.language];
          const oldBody = langContent?.body;
          if (
            typeof oldBody !== 'string' ||
            oldBody.includes('{unsubscribeUrl}') ||
            !oldBody.includes(OLD_FOOTER_TEXT[change.language])
          ) {
            continue;
          }
          langContent.body = oldBody.replace(
            OLD_FOOTER_TEXT[change.language],
            NEW_FOOTER_TEXT[change.language],
          );
          applied++;
        }

        // Nada que cambiar con los datos actuales: sin escritura y sin subir la
        // versión, para no registrar en el historial una migración que no hubo.
        if (applied === 0)
          return { status: 'stale', name: data.templateKey || docId };

        const now = new Date();
        const newVersion = (data.version || 1) + 1;

        tx.update(docRef, {
          content,
          updatedAt: now,
          updatedBy: SCRIPT_ACTOR,
          version: newVersion,
        });

        // Misma forma que FirestoreService.updateEmailTemplate (ver
        // src/modules/cache/firestore.service.ts, updateEmailTemplate): así el
        // panel de admin puede listar y revertir esta migración como cualquier
        // otro cambio de plantilla.
        const versionRef = db.collection(TEMPLATE_VERSIONS_COLLECTION).doc();
        tx.set(versionRef, {
          templateId: docId,
          version: newVersion,
          content,
          triggerDays: data.triggerDays,
          enabled: data.enabled,
          createdAt: now,
          createdBy: SCRIPT_ACTOR,
          changeDescription:
            'Migración automática (issue zplpdf_back#116): enlaza el placeholder ' +
            '{unsubscribeUrl} en el pie de baja existente de la plantilla.',
        });

        return { status: 'updated', name: data.templateKey || docId };
      });
    } catch (error) {
      failedDocs.push(docId);
      console.error(`  ❌ ${docId}: ${(error as Error).message}`);
      continue;
    }

    if (outcome.status === 'missing') {
      skippedDocs++;
      console.log(`  ⚠️  ${docId} ya no existe, se omite`);
    } else if (outcome.status === 'stale') {
      skippedDocs++;
      console.log(
        `  ⚠️  ${outcome.name} cambió desde el escaneo y ya no necesita el cambio, se omite`,
      );
    } else {
      updatedDocs++;
      console.log(`  ✅ ${outcome.name}`);
    }
  }

  console.log(
    `\nHecho. Actualizados: ${updatedDocs}. Omitidos: ${skippedDocs}. Fallidos: ${failedDocs.length}.`,
  );
  if (failedDocs.length > 0) {
    console.error(
      `Documentos fallidos (reejecuta el script para reintentarlos): ${failedDocs.join(', ')}`,
    );
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Migración fallida:', err);
  process.exit(1);
});
