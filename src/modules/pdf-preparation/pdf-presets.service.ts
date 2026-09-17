import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { FieldValue, Transaction } from '@google-cloud/firestore';
import { createHash } from 'node:crypto';
import { FirestoreService } from '../cache/firestore.service.js';
import { FeatureFlagsService } from '../product-observability/feature-flags.service.js';
import type { PdfRecipe } from './pdf-layout.js';

function object(
  value: unknown,
  keys: string[],
): asserts value is Record<string, any> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    throw new BadRequestException('PDF_PRESET_INVALID');
}
function id(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new BadRequestException('PDF_PRESET_ID_INVALID');
}
function content(body: Record<string, any>): {
  name: string;
  recipe: PdfRecipe;
  hash: string;
} {
  if (
    typeof body.name !== 'string' ||
    !body.name.trim() ||
    body.name.trim().length > 120
  )
    throw new BadRequestException('PDF_PRESET_NAME_INVALID');
  const r = body.recipe;
  object(r, [
    'selections',
    'paper',
    'columns',
    'rows',
    'marginPt',
    'gapPt',
    'scale',
  ]);
  if (
    !['4x6', 'a4', 'letter'].includes(r.paper) ||
    !['fit', 'actual'].includes(r.scale) ||
    ![r.rows, r.columns].every(
      (n) => Number.isInteger(n) && n >= 1 && n <= 4,
    ) ||
    ![r.marginPt, r.gapPt].every(
      (n) => Number.isFinite(n) && n >= 0 && n <= 72,
    ) ||
    !Array.isArray(r.selections) ||
    !r.selections.length ||
    r.selections.length > 500
  )
    throw new BadRequestException('PDF_RECIPE_INVALID');
  const selections = r.selections.map((s) => {
    object(s, ['page', 'rotation', 'crop']);
    if (
      !Number.isInteger(s.page) ||
      s.page < 0 ||
      s.page >= 500 ||
      ![0, 90, 180, 270].includes(s.rotation)
    )
      throw new BadRequestException('PDF_PAGE_OR_ROTATION_INVALID');
    const result: any = { page: s.page, rotation: s.rotation };
    if (s.crop !== undefined) {
      object(s.crop, ['x', 'y', 'width', 'height']);
      const c = s.crop;
      if (
        ![c.x, c.y, c.width, c.height].every(Number.isFinite) ||
        c.width <= 0 ||
        c.height <= 0
      )
        throw new BadRequestException('PDF_CROP_OUTSIDE_PAGE');
      result.crop = { x: c.x, y: c.y, width: c.width, height: c.height };
    }
    return result;
  });
  const name = body.name.trim();
  const recipe: PdfRecipe = {
    paper: r.paper,
    columns: r.columns,
    rows: r.rows,
    marginPt: r.marginPt,
    gapPt: r.gapPt,
    scale: r.scale,
    selections,
  };
  return {
    name,
    recipe,
    hash: createHash('sha256')
      .update(JSON.stringify({ name, recipe }))
      .digest('hex'),
  };
}
@Injectable()
export class PdfPresetsService {
  constructor(
    private readonly store: FirestoreService,
    private readonly flags: FeatureFlagsService,
  ) {}
  private get db() {
    return this.store.getClient();
  }
  private ref(presetId: string) {
    return this.db.collection('pdf_output_presets').doc(presetId);
  }
  private versionRef(presetId: string, version: number) {
    return this.db
      .collection('pdf_output_preset_versions')
      .doc(`${presetId}_${version}`);
  }
  private async alive(tx: Transaction, uid: string) {
    const [deleted, user] = await Promise.all([
      tx.get(this.db.doc(`deleted_accounts/${uid}`)),
      tx.get(this.db.doc(`users/${uid}`)),
    ]);
    if (deleted.exists || !user.exists)
      throw new GoneException('Account unavailable');
  }
  private view(row: any) {
    return {
      id: row.id,
      name: row.name,
      version: row.version,
      recipe: row.recipe,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
  async list(uid: string) {
    await this.flags.assertFeatureAvailable(uid, 'pdf_preparation');
    const rows = await this.db
      .collection('pdf_output_presets')
      .where('accountId', '==', uid)
      .where('status', '==', 'active')
      .limit(50)
      .get();
    return {
      schemaVersion: 1,
      presets: rows.docs
        .map((d) => this.view(d.data()))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    };
  }
  async create(uid: string, body: unknown) {
    await this.flags.assertFeatureAvailable(uid, 'pdf_preparation');
    object(body, ['id', 'name', 'recipe']);
    id(body.id);
    const data = content(body);
    const result = await this.db.runTransaction(async (tx) => {
      const ref = this.ref(body.id),
        versionRef = this.versionRef(body.id, 1),
        limitRef = this.db.doc(`pdf_preset_limits/${uid}`);
      const [prior, first, limits] = await Promise.all([
        tx.get(ref),
        tx.get(versionRef),
        tx.get(limitRef),
      ]);
      await this.alive(tx, uid);
      if (prior.exists) {
        if (prior.get('accountId') !== uid)
          throw new NotFoundException('PDF_PRESET_NOT_FOUND');
        if (!first.exists || first.get('hash') !== data.hash)
          throw new ConflictException('PDF_PRESET_INPUT_CONFLICT');
        return first.data();
      }
      if ((limits.get('activeCount') ?? 0) >= 50)
        throw new ConflictException('PDF_PRESET_LIMIT');
      const now = new Date().toISOString();
      const row = {
        id: body.id,
        accountId: uid,
        ...data,
        version: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };
      tx.create(ref, row);
      tx.create(versionRef, row);
      tx.set(
        limitRef,
        { accountId: uid, activeCount: FieldValue.increment(1) },
        { merge: true },
      );
      return row;
    });
    return { schemaVersion: 1, preset: this.view(result) };
  }
  async versions(uid: string, presetId: string) {
    await this.flags.assertFeatureAvailable(uid, 'pdf_preparation');
    id(presetId);
    const current = await this.ref(presetId).get();
    if (!current.exists || current.get('accountId') !== uid)
      throw new NotFoundException('PDF_PRESET_NOT_FOUND');
    const rows = await this.db
      .collection('pdf_output_preset_versions')
      .where('accountId', '==', uid)
      .where('id', '==', presetId)
      .orderBy('version', 'desc')
      .limit(200)
      .get();
    return {
      schemaVersion: 1,
      versions: rows.docs.map((d) => this.view(d.data())),
    };
  }
  async update(uid: string, presetId: string, body: unknown) {
    await this.flags.assertFeatureAvailable(uid, 'pdf_preparation');
    id(presetId);
    object(body, ['expectedVersion', 'name', 'recipe']);
    const data = content(body);
    if (
      !Number.isInteger(body.expectedVersion) ||
      body.expectedVersion < 1 ||
      body.expectedVersion >= 200
    )
      throw new BadRequestException('PDF_PRESET_VERSION_INVALID');
    const result = await this.db.runTransaction(async (tx) => {
      const ref = this.ref(presetId),
        nextRef = this.versionRef(presetId, body.expectedVersion + 1);
      const [current, replay] = await Promise.all([
        tx.get(ref),
        tx.get(nextRef),
      ]);
      await this.alive(tx, uid);
      if (!current.exists || current.get('accountId') !== uid)
        throw new NotFoundException('PDF_PRESET_NOT_FOUND');
      if (replay.exists && replay.get('hash') === data.hash)
        return replay.data();
      if (
        current.get('version') !== body.expectedVersion ||
        current.get('status') !== 'active'
      )
        throw new ConflictException('PDF_PRESET_VERSION_CONFLICT');
      const row = {
        ...current.data(),
        ...data,
        version: body.expectedVersion + 1,
        updatedAt: new Date().toISOString(),
      };
      tx.create(nextRef, row);
      tx.set(ref, row);
      return row;
    });
    return { schemaVersion: 1, preset: this.view(result) };
  }
  async archive(uid: string, presetId: string, body: unknown) {
    await this.flags.assertFeatureAvailable(uid, 'pdf_preparation');
    id(presetId);
    object(body, ['expectedVersion']);
    if (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 1)
      throw new BadRequestException('PDF_PRESET_VERSION_INVALID');
    const row = await this.db.runTransaction(async (tx) => {
      const ref = this.ref(presetId),
        snap = await tx.get(ref);
      await this.alive(tx, uid);
      if (!snap.exists || snap.get('accountId') !== uid)
        throw new NotFoundException('PDF_PRESET_NOT_FOUND');
      if (snap.get('version') !== body.expectedVersion)
        throw new ConflictException('PDF_PRESET_VERSION_CONFLICT');
      if (snap.get('status') === 'archived') return snap.data();
      const next = {
        ...snap.data(),
        status: 'archived',
        updatedAt: new Date().toISOString(),
      };
      tx.set(ref, next);
      tx.set(
        this.db.doc(`pdf_preset_limits/${uid}`),
        { accountId: uid, activeCount: FieldValue.increment(-1) },
        { merge: true },
      );
      return next;
    });
    return { schemaVersion: 1, preset: this.view(row) };
  }
}
