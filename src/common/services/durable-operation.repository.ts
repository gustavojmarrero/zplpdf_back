import { getDateStringInTimezone } from '../../utils/timezone.util.js';
import type { PlanType } from '../interfaces/user.interface.js';
import {
  ConflictException,
  ForbiddenException,
  GoneException,
} from '@nestjs/common';
import {
  Firestore,
  FieldValue,
  Timestamp,
  Transaction,
} from '@google-cloud/firestore';
import { randomUUID } from 'node:crypto';
export interface DurableOperationInput {
  operationId: string;
  kind?: 'zpl' | 'pdf';
  recovery?: Record<string, unknown>;
  userId: string;
  fingerprint: string;
  period: { periodId: string; periodStart: Date; periodEnd: Date };
  maxPdfs: number;
  userPlan?: PlanType;
  labelCount: number;
  labelSize: string;
  outputFormat: 'pdf' | 'png' | 'jpeg';
  sourcePath: string;
  originalFilename?: string;
}
/** Shared transactional boundary for repeatable rendering and exactly-once quota/history. */
export class DurableOperationRepository {
  constructor(private readonly db: Firestore) {}
  async claim(input: DurableOperationInput) {
    const ref = this.db.collection('durable_operations').doc(input.operationId);
    return this.db.runTransaction(async (tx) => {
      const [prior, deleted, user] = await Promise.all([
        tx.get(ref),
        tx.get(this.db.collection('deleted_accounts').doc(input.userId)),
        tx.get(this.db.collection('users').doc(input.userId)),
      ]);
      if (deleted.exists || !user.exists)
        throw new GoneException('Account unavailable');
      const row = prior.data();
      if (
        row &&
        (row.userId !== input.userId || row.fingerprint !== input.fingerprint)
      )
        throw new ConflictException('OPERATION_PAYLOAD_CONFLICT');
      if (row?.expiresAt?.toMillis() <= Date.now())
        throw new GoneException('OPERATION_EXPIRED');
      if (row?.status === 'completed')
        return { completed: true, token: null, period: row.period };
      if (row?.leaseUntil > Date.now())
        throw new ConflictException('OPERATION_IN_PROGRESS');
      if ((row?.attempts ?? 0) >= 8)
        throw new ConflictException('OPERATION_ATTEMPTS_EXHAUSTED');
      const period = row?.reserved ? row.period : input.period;
      const usageRef = this.db.collection('usage').doc(period.periodId);
      const usage = (await tx.get(usageRef)).data();
      if (
        !row?.reserved &&
        (usage?.pdfCount ?? 0) + (usage?.reservedPdfCount ?? 0) >= input.maxPdfs
      )
        throw new ForbiddenException('MONTHLY_LIMIT_EXCEEDED');
      const token = randomUUID();
      if (!row?.reserved)
        tx.set(
          usageRef,
          {
            odId: period.periodId,
            userId: input.userId,
            periodStart: period.periodStart,
            periodEnd: period.periodEnd,
            reservedPdfCount: FieldValue.increment(1),
          },
          { merge: true },
        );
      tx.set(
        ref,
        {
          ...input,
          kind: input.kind ?? 'zpl',
          userPlan: input.userPlan ?? 'free',
          recovery: input.recovery ?? null,
          originalFilename: input.originalFilename ?? null,
          period,
          token,
          status: 'processing',
          reserved: true,
          leaseUntil: Date.now() + 10 * 60000,
          attempts: (row?.attempts ?? 0) + 1,
          expiresAt:
            row?.expiresAt ?? Timestamp.fromMillis(Date.now() + 15 * 86400000),
          createdAt: row?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        { merge: true },
      );
      return { completed: false, token, period };
    });
  }
  async renew(operationId: string, token: string) {
    const ref = this.db.collection('durable_operations').doc(operationId);
    await this.db.runTransaction(async (tx) => {
      const row = (await tx.get(ref)).data();
      if (
        !row ||
        row.token !== token ||
        row.status !== 'processing' ||
        row.leaseUntil <= Date.now()
      )
        throw new ConflictException('OPERATION_LEASE_LOST');
      tx.update(ref, { leaseUntil: Date.now() + 10 * 60000 });
    });
  }
  async finish(
    operationId: string,
    token: string,
    result: { url: string; filename: string; storagePath: string },
    beforeCommit?: (transaction: Transaction) => Promise<void>,
  ) {
    const ref = this.db.collection('durable_operations').doc(operationId);
    return this.db.runTransaction(async (tx) => {
      const row = (await tx.get(ref)).data();
      if (
        !row ||
        row.token !== token ||
        row.status !== 'processing' ||
        row.leaseUntil <= Date.now()
      )
        throw new ConflictException('OPERATION_LEASE_LOST');
      const deleted = await tx.get(
        this.db.collection('deleted_accounts').doc(row.userId),
      );
      if (deleted.exists) throw new GoneException('Account unavailable');
      if (beforeCommit) await beforeCommit(tx);
      tx.set(
        this.db.collection('usage').doc(row.period.periodId),
        {
          pdfCount: FieldValue.increment(1),
          labelCount: FieldValue.increment(row.labelCount),
          reservedPdfCount: FieldValue.increment(-1),
        },
        { merge: true },
      );
      tx.set(
        this.db
          .collection('conversion_history')
          .doc(`operation_${operationId}`),
        {
          userId: row.userId,
          jobId: operationId,
          labelCount: row.labelCount,
          labelSize: row.labelSize,
          status: 'completed',
          outputFormat: row.outputFormat,
          fileUrl: result.url,
          createdAt: new Date(),
        },
      );
      tx.set(this.db.collection('zpl-conversions').doc(operationId), {
        userId: row.userId,
        status: 'completed',
        progress: 100,
        resultUrl: result.url,
        filename: result.filename,
        labelSize: row.labelSize,
        outputFormat: row.outputFormat,
        createdAt: row.createdAt,
        updatedAt: new Date().toISOString(),
      });
      tx.update(ref, {
        status: 'completed',
        reserved: false,
        leaseUntil: 0,
        storagePath: result.storagePath,
        completedAt: new Date().toISOString(),
      });
      const date = getDateStringInTimezone(new Date());
      const plans = Object.fromEntries(
        ['free', 'lite', 'pro', 'promax', 'enterprise'].map((plan) => [
          plan,
          {
            pdfs: FieldValue.increment(plan === row.userPlan ? 1 : 0),
            labels: FieldValue.increment(
              plan === row.userPlan ? row.labelCount : 0,
            ),
          },
        ]),
      );
      tx.set(
        this.db.collection('daily_stats').doc(date),
        {
          date,
          totalConversions: FieldValue.increment(1),
          totalLabels: FieldValue.increment(row.labelCount),
          totalPdfs: FieldValue.increment(1),
          activeUserIds: FieldValue.arrayUnion(row.userId),
          successCount: FieldValue.increment(1),
          failureCount: FieldValue.increment(0),
          errorCount: FieldValue.increment(0),
          conversionsByPlan: plans,
        },
        { merge: true },
      );
      tx.set(
        this.db.collection('global_totals').doc('totals'),
        {
          pdfsTotal: FieldValue.increment(1),
          labelsTotal: FieldValue.increment(row.labelCount),
          lastUpdated: new Date(),
        },
        { merge: true },
      );
      tx.update(this.db.collection('users').doc(row.userId), {
        lastActivityAt: new Date(),
      });
    });
  }
  async fail(operationId: string, token: string) {
    const ref = this.db.collection('durable_operations').doc(operationId);
    await this.db.runTransaction(async (tx) => {
      const row = (await tx.get(ref)).data();
      if (!row || row.token !== token || row.status !== 'processing') return;
      const deleted = await tx.get(
        this.db.collection('deleted_accounts').doc(row.userId),
      );
      if (row.reserved && !deleted.exists)
        tx.set(
          this.db.collection('usage').doc(row.period.periodId),
          { reservedPdfCount: FieldValue.increment(-1) },
          { merge: true },
        );
      tx.update(ref, {
        status: 'failed',
        reserved: false,
        leaseUntil: 0,
        errorCode: 'RENDER_FAILED',
      });
    });
  }
}
