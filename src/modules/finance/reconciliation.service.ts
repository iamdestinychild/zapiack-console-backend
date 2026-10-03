import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, ReconciliationStatus } from '../../generated/admin/client';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { ZapiackPrismaService } from '../../common/prisma/zapiack-prisma.service';
import { lagosDateOnly, lagosDayBounds } from '../../common/time/lagos';
import { NotificationsGateway } from '../inbox/notifications.gateway';
import type { AdminConfig } from '../../common/config/configuration';

/**
 * Checks the cash rollup against the transactions it was built from, once a day.
 * Anything past 1% raises an alert rather than sitting in a dashboard nobody reads.
 *
 * The provider-invoice check the PRD describes is not implemented: it compares
 * recorded provider cost against the price book, and the product schema records no
 * provider cost. It returns as soon as cost is stored per send.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);
  private readonly thresholdPct: number;

  constructor(
    private readonly admin: AdminPrismaService,
    private readonly zapiack: ZapiackPrismaService,
    private readonly notifications: NotificationsGateway,
    config: ConfigService<{ admin: AdminConfig }, true>,
  ) {
    this.thresholdPct = config.get('admin', {
      infer: true,
    }).limits.reconciliationVariancePct;
  }

  async runForDay(day: Date) {
    const result = await this.reconcileCash(day);
    return { day: lagosDateOnly(day), results: [result] };
  }

  /**
   * Successful transactions for the day against what the cash rollup recorded. This
   * catches a rollup that ran against a partial window, or a transaction backdated
   * after the fact.
   */
  private async reconcileCash(day: Date) {
    const { start, end } = lagosDayBounds(day);

    const [settlement] = await this.zapiack.read.$queryRaw<{ total: string }[]>`
      SELECT COALESCE(SUM("amount"), 0)::text AS total
      FROM "transactions"
      WHERE "status" = 'SUCCESS'
        AND "createdAt" >= ${start} AND "createdAt" < ${end}
    `;

    const rollup = await this.admin.cashRollup.findUnique({
      where: { date: lagosDateOnly(day) },
    });

    const expected = Number(settlement?.total ?? 0);
    const actual = Number(rollup?.collectedNgn ?? 0);

    return this.record(day, 'PAYSTACK_SETTLEMENT', expected, actual, {
      note: 'Successful transactions against the cash rollup for the same Lagos day',
    });
  }

  private async record(
    day: Date,
    kind: 'PAYSTACK_SETTLEMENT' | 'PROVIDER_INVOICE',
    expected: number,
    actual: number,
    detail: Record<string, unknown>,
  ) {
    const variancePct =
      expected === 0
        ? actual === 0
          ? 0
          : 100
        : ((actual - expected) / expected) * 100;
    const breached = Math.abs(variancePct) > this.thresholdPct;
    const date = lagosDateOnly(day);

    const data = {
      status: breached
        ? ReconciliationStatus.VARIANCE
        : ReconciliationStatus.OK,
      expectedNgn: expected.toFixed(4),
      actualNgn: actual.toFixed(4),
      variancePct: variancePct.toFixed(6),
      detail: detail as Prisma.InputJsonValue,
    };

    const run = await this.admin.reconciliationRun.upsert({
      where: { date_kind: { date, kind } },
      create: { date, kind, ...data },
      update: data,
    });

    if (breached) {
      this.logger.warn(
        `${kind} variance ${variancePct.toFixed(2)}% on ${date.toISOString().slice(0, 10)}`,
      );
      await this.notifications.broadcastToPermission('finance.read', {
        type: 'reconciliation.variance',
        severity: 'HIGH',
        title: `${kind.replace('_', ' ').toLowerCase()} variance of ${variancePct.toFixed(2)}%`,
        body: `Expected ₦${expected.toFixed(2)}, rollups show ₦${actual.toFixed(2)}`,
        link: `/finance/reconciliation?date=${date.toISOString().slice(0, 10)}`,
      });
    }

    return run;
  }

  async list(from: Date, to: Date) {
    const data = await this.admin.reconciliationRun.findMany({
      where: { date: { gte: lagosDateOnly(from), lte: lagosDateOnly(to) } },
      orderBy: [{ date: 'desc' }, { kind: 'asc' }],
    });
    // The whole range is returned at once; the envelope keeps every list route the
    // same shape for callers.
    return { data, hasMore: false, nextCursor: null };
  }
}
