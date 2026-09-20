import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, ReconciliationStatus } from '../../generated/admin/client';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { ZapiackPrismaService } from '../../common/prisma/zapiack-prisma.service';
import { lagosDateOnly, lagosDayBounds } from '../../common/time/lagos';
import { NotificationsGateway } from '../inbox/notifications.gateway';
import type { AdminConfig } from '../../common/config/configuration';

/**
 * Checks the rollups against the outside world once a day: Paystack settlements on
 * the cash side, provider invoices on the cost side. Anything past 1% raises an alert
 * rather than quietly sitting in a dashboard nobody reads.
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
    const results = await Promise.all([
      this.reconcilePaystack(day),
      this.reconcileProviderCosts(day),
    ]);
    return { day: lagosDateOnly(day), results };
  }

  /** Settled Paystack payments for the day against what the cash rollup recorded. */
  private async reconcilePaystack(day: Date) {
    const { start, end } = lagosDayBounds(day);

    const [settlement] = await this.zapiack.read.$queryRaw<{ total: string }[]>`
      SELECT COALESCE(SUM("amountNgn" - "feeNgn" - "refundedNgn"), 0)::text AS total
      FROM "payments"
      WHERE "status" = 'SUCCESS'
        AND "settledAt" >= ${start} AND "settledAt" < ${end}
    `;

    const rollup = await this.admin.cashRollup.findUnique({
      where: { date: lagosDateOnly(day) },
    });

    const expected = Number(settlement?.total ?? 0);
    const actual =
      Number(rollup?.collectedNgn ?? 0) -
      Number(rollup?.feesNgn ?? 0) -
      Number(rollup?.refundedNgn ?? 0);

    return this.record(day, 'PAYSTACK_SETTLEMENT', expected, actual, {
      note: 'Settled Paystack net against the cash rollup for the same Lagos day',
    });
  }

  /**
   * Provider cost stored on usage rows against the cost the price book says applied.
   * A gap means either a missing cost at send time or a stale provider cost table,
   * both of which silently distort profit.
   */
  private async reconcileProviderCosts(day: Date) {
    const date = lagosDateOnly(day);

    const rollups = await this.admin.usageRollup.groupBy({
      by: ['channel', 'provider'],
      where: { date, hour: -1 },
      _sum: { costNgn: true, units: true },
    });

    const costs = await this.admin.providerCost.findMany({
      where: {
        effectiveFrom: { lte: day },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: day } }],
        country: null,
        network: null,
      },
    });

    let expected = 0;
    let actual = 0;
    const detail: Record<string, unknown>[] = [];

    for (const row of rollups) {
      const units = Number(row._sum.units ?? 0);
      const recorded = Number(row._sum.costNgn ?? 0);
      const book = costs.find(
        (c) => c.channel === row.channel && c.provider === row.provider,
      );
      const modelled = book ? units * Number(book.unitCostNgn) : recorded;

      expected += modelled;
      actual += recorded;

      if (
        book &&
        modelled > 0 &&
        Math.abs(modelled - recorded) / modelled > this.thresholdPct / 100
      ) {
        detail.push({
          channel: row.channel,
          provider: row.provider,
          units,
          recordedNgn: recorded,
          modelledNgn: modelled,
        });
      }
      if (!book) {
        detail.push({
          channel: row.channel,
          provider: row.provider,
          issue: 'no provider cost on file for this channel and provider',
        });
      }
    }

    return this.record(day, 'PROVIDER_INVOICE', expected, actual, {
      lines: detail,
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

  list(from: Date, to: Date) {
    return this.admin.reconciliationRun.findMany({
      where: { date: { gte: lagosDateOnly(from), lte: lagosDateOnly(to) } },
      orderBy: [{ date: 'desc' }, { kind: 'asc' }],
    });
  }
}
