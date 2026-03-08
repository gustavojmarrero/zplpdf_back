/**
 * Script to generate static font preview PNGs for all 16 ZPL fonts.
 * Uploads to GCS at font-previews/font-{code}.png with public access.
 *
 * Run with: npx ts-node -r tsconfig-paths/register src/scripts/generate-font-previews.ts
 */

import { Storage } from '@google-cloud/storage';
import axios from 'axios';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config({ path: ['.env.local', '.env'] });

// Try to load credentials from file if env var not set
const credentialsPath = path.join(process.cwd(), 'firebase-credentials.json');
if (!process.env.GOOGLE_CREDENTIALS && fs.existsSync(credentialsPath)) {
  process.env.GOOGLE_CREDENTIALS = fs.readFileSync(credentialsPath, 'utf8');
}

const ZPL_FONTS = ['0', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'P', 'Q', 'R', 'S', 'T', 'U', 'V'] as const;

const LABEL_SIZE = '4x6';
const SAMPLE_TEXT = 'ABCDabcd 12345';
const GCS_BUCKET_OVERRIDE = 'zplpdf-public-assets';
const GCS_FOLDER = 'font-previews';
const RATE_LIMIT_DELAY_MS = 1100;

function buildZpl(fontCode: string): string {
  return `^XA^A${fontCode}N,50,50^FO20,20^FD${SAMPLE_TEXT}^FS^XZ`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('Starting font preview generation...\n');

  // Initialize GCS
  const bucketName = process.env.GCP_STORAGE_BUCKET;
  if (!bucketName) {
    console.error('Error: GCP_STORAGE_BUCKET environment variable is required');
    process.exit(1);
  }

  let credentials: any = null;
  const googleCredentials = process.env.GOOGLE_CREDENTIALS;

  if (googleCredentials) {
    try {
      credentials = JSON.parse(googleCredentials);
      if (credentials.private_key) {
        credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
      }
      console.log(`Using GCP project: ${credentials.project_id}`);
    } catch (error) {
      console.error('Error parsing GOOGLE_CREDENTIALS:', error);
      process.exit(1);
    }
  }

  const storageOptions: any = {};
  if (credentials) {
    storageOptions.credentials = credentials;
    storageOptions.projectId = credentials.project_id;
  }

  const storage = new Storage(storageOptions);
  const targetBucket = GCS_BUCKET_OVERRIDE || bucketName;
  const bucket = storage.bucket(targetBucket);

  console.log(`Bucket: ${targetBucket}`);
  console.log(`Fonts to process: ${ZPL_FONTS.length}`);
  console.log(`Label size: ${LABEL_SIZE}`);
  console.log('');

  const results: { font: string; url: string; status: string }[] = [];

  for (const fontCode of ZPL_FONTS) {
    const zpl = buildZpl(fontCode);
    const fileName = `${GCS_FOLDER}/font-${fontCode}.png`;

    try {
      console.log(`Processing font ${fontCode}...`);

      // Call Labelary API for PNG
      const url = `http://api.labelary.com/v1/printers/8dpmm/labels/${LABEL_SIZE}/0/`;
      const response = await axios.post(url, zpl, {
        headers: {
          Accept: 'image/png',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        responseType: 'arraybuffer',
        timeout: 30000,
      });

      const pngBuffer = Buffer.from(response.data);

      // Upload to GCS (bucket-level access controls public visibility)
      const file = bucket.file(fileName);
      await file.save(pngBuffer, {
        metadata: {
          contentType: 'image/png',
          cacheControl: 'public, max-age=31536000',
        },
      });

      const publicUrl = `https://storage.googleapis.com/${targetBucket}/${fileName}`;
      results.push({ font: fontCode, url: publicUrl, status: 'OK' });
      console.log(`  -> ${publicUrl}`);
    } catch (error: any) {
      const errorMsg = error.response?.status
        ? `HTTP ${error.response.status}`
        : error.message;
      results.push({ font: fontCode, url: '', status: `ERROR: ${errorMsg}` });
      console.error(`  -> Error: ${errorMsg}`);
    }

    // Rate limit delay between calls
    if (fontCode !== ZPL_FONTS[ZPL_FONTS.length - 1]) {
      await sleep(RATE_LIMIT_DELAY_MS);
    }
  }

  // Summary
  console.log('\n========== Generation Complete ==========');
  const successful = results.filter((r) => r.status === 'OK');
  const failed = results.filter((r) => r.status !== 'OK');
  console.log(`Successful: ${successful.length}/${ZPL_FONTS.length}`);

  if (failed.length > 0) {
    console.log('\nFailed:');
    failed.forEach((r) => console.log(`  Font ${r.font}: ${r.status}`));
  }

  console.log('\nGenerated URLs:');
  successful.forEach((r) => console.log(`  font-${r.font}: ${r.url}`));
  console.log('==========================================\n');
}

main().catch((error) => {
  console.error('Generation failed:', error);
  process.exit(1);
});
