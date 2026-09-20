import { Injectable } from '@nestjs/common';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import {
  eachLagosDay,
  lagosDateOnly,
  resolveRange,
} from '../../common/time/lagos';
import type { FinanceQueryDto } from './dto/finance.dto';

const D = (v: unknown) => Number(v ?? 0);

/**
 * Every figure here comes from the rollups, in NGN and Africa/Lagos days.
 *
 *   Gross profit = recognised revenue − provider cost − payment processing fees
 *
 * Recognised revenue counts credits when they are consumed, not when they are bought,
 * which is why the cash view is reported beside it rather than instead of it.
 */
@Injectable()
export class FinanceService {
  constructor(private readonly admin: AdminPrismaService) {}

  private groupClause(dto: FinanceQueryDto) {
    const dims: (
      'channel' | 'accountId' | 'country' | 'provider' | 'planId'
    )[] = [];
    if (dto.groupBy?.includes('channel')) dims.push('channel');
    if (dto.groupBy?.includes('account')) dims.push('accountId');
    if (dto.groupBy?.includes('country')) dims.push('country');
    if (dto.groupBy?.includes('provider')) dims.push('provider');
    if (dto.groupBy?.includes('plan')) dims.push('planId');
    return dims;
  }

  /** Recognised revenue, provider cost and gross profit across the chosen dimensions. */
  async profit(dto: FinanceQueryDto) {
    const { start, end } = resolveRange(dto.from, dto.to, 30);
    const dims = this.groupClause(dto);

    const where = {
      // hour -1 is the finalised daily row; using it avoids double counting the hourly ones.
      hour: -1,
      date: { gte: lagosDateOnly(start), lte: lagosDateOnly(end) },
      ...(dto.channel ? { channel: dto.channel } : {}),
      ...(dto.accountId ? { accountId: dto.accountId } : {}),
      ...(dto.country ? { country: dto.country } : {}),
      ...(dto.provider ? { provider: dto.provider } : {}),
    };

    const [rows, subs, cash] = await Promise.all([
      this.admin.usageRollup.groupBy({
        by: dims.length ? dims : ['channel'],
        where,
        _sum: {
          revenueNgn: true,
          costNgn: true,
          attempted: true,
          succeeded: true,
          failed: true,
          units: true,
        },
      }),
      this.admin.financeSnapshot.aggregate({
        where: { date: { gte: lagosDateOnly(start), lte: lagosDateOnly(end) } },
        _sum: { subscriptionRevenueNgn: true },
      }),
      this.admin.cashRollup.aggregate({
        where: { date: { gte: lagosDateOnly(start), lte: lagosDateOnly(end) } },
        _sum: { feesNgn: true, collectedNgn: true, refundedNgn: true },
      }),
    ]);

    const usageRevenue = rows.reduce((acc, r) => acc + D(r._sum.revenueNgn), 0);
    const providerCost = rows.reduce((acc, r) => acc + D(r._sum.costNgn), 0);
    const subscriptionRevenue = D(subs._sum.subscriptionRevenueNgn);
    const paymentFees = D(cash._sum.feesNgn);

    const recognisedRevenue = usageRevenue + subscriptionRevenue;
    const grossProfit = recognisedRevenue - providerCost - paymentFees;

    return {
      range: { from: start, to: end },
      totals: {
        recognisedRevenueNgn: round(recognisedRevenue),
        usageRevenueNgn: round(usageRevenue),
        subscriptionRevenueNgn: round(subscriptionRevenue),
        providerCostNgn: round(providerCost),
        paymentFeesNgn: round(paymentFees),
        grossProfitNgn: round(grossProfit),
        grossMargin: recognisedRevenue
          ? round(grossProfit / recognisedRevenue, 4)
          : null,
      },
      breakdown: rows.map((row) => {
        const revenue = D(row._sum.revenueNgn);
        const cost = D(row._sum.costNgn);
        return {
          ...Object.fromEntries(
            dims.map((d) => [d, (row as Record<string, unknown>)[d]]),
          ),
          ...(dims.length
            ? {}
            : { channel: (row as { channel: string }).channel }),
          revenueNgn: round(revenue),
          providerCostNgn: round(cost),
          // Payment fees are a collection-level cost and cannot be split per channel
          // honestly, so the breakdown shows contribution before fees.
          contributionNgn: round(revenue - cost),
          margin: revenue ? round((revenue - cost) / revenue, 4) : null,
          attempted: row._sum.attempted ?? 0n,
          succeeded: row._sum.succeeded ?? 0n,
          failed: row._sum.failed ?? 0n,
        };
      }),
    };
  }

  /** Daily series with gaps filled, so a quiet day shows as zero rather than vanishing. */
  async revenueTimeseries(dto: FinanceQueryDto) {
    const { start, end } = resolveRange(dto.from, dto.to, 30);

    const [usage, cash, snapshots] = await Promise.all([
      this.admin.usageRollup.groupBy({
        by: ['date'],
        where: {
          hour: -1,
          date: { gte: lagosDateOnly(start), lte: lagosDateOnly(end) },
          ...(dto.channel ? { channel: dto.channel } : {}),
        },
        _sum: { revenueNgn: true, costNgn: true },
      }),
      this.admin.cashRollup.findMany({
        where: { date: { gte: lagosDateOnly(start), lte: lagosDateOnly(end) } },
      }),
      this.admin.financeSnapshot.findMany({
        where: { date: { gte: lagosDateOnly(start), lte: lagosDateOnly(end) } },
      }),
    ]);

    const usageByDate = new Map(usage.map((u) => [u.date.toISOString(), u]));
    const cashByDate = new Map(cash.map((c) => [c.date.toISOString(), c]));
    const snapByDate = new Map(snapshots.map((s) => [s.date.toISOString(), s]));

    return {
      range: { from: start, to: end },
      series: eachLagosDay(start, end).map((date) => {
        const key = date.toISOString();
        const u = usageByDate.get(key);
        const c = cashByDate.get(key);
        const s = snapByDate.get(key);

        const revenue = D(u?._sum.revenueNgn) + D(s?.subscriptionRevenueNgn);
        const cost = D(u?._sum.costNgn);
        const fees = D(c?.feesNgn);

        return {
          date,
          recognisedRevenueNgn: round(revenue),
          providerCostNgn: round(cost),
          paymentFeesNgn: round(fees),
          grossProfitNgn: round(revenue - cost - fees),
          cashCollectedNgn: round(D(c?.collectedNgn) - D(c?.refundedNgn)),
          creditLiabilityNgn: round(D(s?.creditLiabilityNgn)),
          mrrNgn: round(D(s?.mrrNgn)),
        };
      }),
    };
  }

  /**
   * The cash view. Deliberately separate from recognised revenue: prepaid credits are
   * a liability on the day they are bought, not earnings.
   */
  async cash(dto: FinanceQueryDto) {
    const { start, end } = resolveRange(dto.from, dto.to, 30);
    const [agg, latest] = await Promise.all([
      this.admin.cashRollup.aggregate({
        where: { date: { gte: lagosDateOnly(start), lte: lagosDateOnly(end) } },
        _sum: {
          collectedNgn: true,
          refundedNgn: true,
          feesNgn: true,
          paymentCount: true,
          failedCount: true,
        },
      }),
      this.admin.financeSnapshot.findFirst({
        where: { date: { lte: lagosDateOnly(end) } },
        orderBy: { date: 'desc' },
      }),
    ]);

    const collected = D(agg._sum.collectedNgn);
    const refunded = D(agg._sum.refundedNgn);

    return {
      range: { from: start, to: end },
      cashCollectedNgn: round(collected - refunded),
      grossCollectedNgn: round(collected),
      refundedNgn: round(refunded),
      paymentFeesNgn: round(D(agg._sum.feesNgn)),
      successfulPayments: agg._sum.paymentCount ?? 0,
      failedPayments: agg._sum.failedCount ?? 0,
      /** Unspent balances at period end — money we hold but have not earned. */
      creditLiabilityNgn: round(D(latest?.creditLiabilityNgn)),
    };
  }

  /** ARPA and revenue churn, which both need the period before the one asked for. */
  async cohortMetrics(dto: FinanceQueryDto) {
    const { start, end } = resolveRange(dto.from, dto.to, 30);
    const spanMs = end.getTime() - start.getTime();
    const priorStart = new Date(start.getTime() - spanMs);

    const [current, prior] = await Promise.all([
      this.admin.usageRollup.groupBy({
        by: ['accountId'],
        where: {
          hour: -1,
          date: { gte: lagosDateOnly(start), lte: lagosDateOnly(end) },
        },
        _sum: { revenueNgn: true },
      }),
      this.admin.usageRollup.groupBy({
        by: ['accountId'],
        where: {
          hour: -1,
          date: { gte: lagosDateOnly(priorStart), lt: lagosDateOnly(start) },
        },
        _sum: { revenueNgn: true },
      }),
    ]);

    const currentByAccount = new Map(
      current.map((r) => [r.accountId, D(r._sum.revenueNgn)]),
    );
    const priorRevenue = prior.reduce(
      (acc, r) => acc + D(r._sum.revenueNgn),
      0,
    );
    const currentRevenue = current.reduce(
      (acc, r) => acc + D(r._sum.revenueNgn),
      0,
    );

    // Churned revenue: accounts that earned last period and nothing this period.
    const churnedRevenue = prior
      .filter((r) => !currentByAccount.has(r.accountId))
      .reduce((acc, r) => acc + D(r._sum.revenueNgn), 0);

    return {
      range: { from: start, to: end },
      activeAccounts: current.length,
      arpaNgn: current.length ? round(currentRevenue / current.length) : 0,
      revenueChurn: priorRevenue
        ? round(churnedRevenue / priorRevenue, 4)
        : null,
      churnedRevenueNgn: round(churnedRevenue),
      priorPeriod: {
        from: priorStart,
        to: start,
        revenueNgn: round(priorRevenue),
      },
    };
  }
}

function round(value: number, dp = 2): number {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}
