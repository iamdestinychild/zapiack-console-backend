import { Injectable } from '@nestjs/common';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import {
  eachLagosDay,
  lagosDateOnly,
  nowLagos,
  resolveRange,
} from '../../common/time/lagos';
import type { DateRangeDto } from '../../common/dto/common.dto';

const D = (v: unknown) => Number(v ?? 0);

/** The landing screen: the handful of numbers that say whether today is normal. */
@Injectable()
export class OverviewService {
  constructor(private readonly admin: AdminPrismaService) {}

  async kpis(dto: DateRangeDto) {
    const { start, end } = resolveRange(dto.from, dto.to, 30);
    const spanDays = Math.max(
      1,
      Math.round((end.getTime() - start.getTime()) / (24 * 3600_000)),
    );
    const priorStart = new Date(start.getTime() - spanDays * 24 * 3600_000);

    const [
      usage,
      priorUsage,
      cash,
      snapshot,
      requests,
      openFlags,
      senderQueue,
    ] = await Promise.all([
      this.admin.usageRollup.aggregate({
        where: {
          hour: -1,
          date: { gte: lagosDateOnly(start), lte: lagosDateOnly(end) },
        },
        _sum: {
          revenueNgn: true,
          costNgn: true,
          attempted: true,
          succeeded: true,
          failed: true,
        },
      }),
      this.admin.usageRollup.aggregate({
        where: {
          hour: -1,
          date: { gte: lagosDateOnly(priorStart), lt: lagosDateOnly(start) },
        },
        _sum: { revenueNgn: true, costNgn: true },
      }),
      this.admin.cashRollup.aggregate({
        where: { date: { gte: lagosDateOnly(start), lte: lagosDateOnly(end) } },
        _sum: { collectedNgn: true, refundedNgn: true, feesNgn: true },
      }),
      this.admin.financeSnapshot.findFirst({
        where: { date: { lte: lagosDateOnly(end) } },
        orderBy: { date: 'desc' },
      }),
      this.admin.requestRollup.aggregate({
        where: { date: { gte: lagosDateOnly(start), lte: lagosDateOnly(end) } },
        _sum: { total: true, serverErrors: true, clientErrors: true },
        _max: { latencyP95Ms: true },
      }),
      this.admin.riskFlag.count({ where: { resolvedAt: null } }),
      this.admin.senderIdReview.count({
        where: { decidedAt: null, status: { in: ['SUBMITTED', 'IN_REVIEW'] } },
      }),
    ]);

    const revenue = D(usage._sum.revenueNgn);
    const cost = D(usage._sum.costNgn);
    const fees = D(cash._sum.feesNgn);
    const priorProfit =
      D(priorUsage._sum.revenueNgn) - D(priorUsage._sum.costNgn);
    const profit = revenue - cost - fees;

    const attempted = Number(usage._sum.attempted ?? 0);
    const succeeded = Number(usage._sum.succeeded ?? 0);
    const totalRequests = Number(requests._sum.total ?? 0);
    const serverErrors = Number(requests._sum.serverErrors ?? 0);

    const overdueSenderIds = await this.admin.senderIdReview.count({
      where: { decidedAt: null, slaDueAt: { lt: new Date() } },
    });

    return {
      range: { from: start, to: end },
      money: {
        recognisedRevenueNgn: round(revenue),
        providerCostNgn: round(cost),
        paymentFeesNgn: round(fees),
        grossProfitNgn: round(profit),
        grossMargin: revenue ? round(profit / revenue, 4) : null,
        // Direction of travel against the same-length period before this one.
        profitChangePct: priorProfit
          ? round(((profit - priorProfit) / Math.abs(priorProfit)) * 100, 1)
          : null,
        cashCollectedNgn: round(
          D(cash._sum.collectedNgn) - D(cash._sum.refundedNgn),
        ),
        creditLiabilityNgn: round(D(snapshot?.creditLiabilityNgn)),
        mrrNgn: round(D(snapshot?.mrrNgn)),
      },
      traffic: {
        billableEvents: attempted,
        successRate: attempted ? round(succeeded / attempted, 4) : null,
        apiRequests: totalRequests,
        apiErrorRate: totalRequests
          ? round(serverErrors / totalRequests, 4)
          : null,
        clientErrors: Number(requests._sum.clientErrors ?? 0),
        latencyP95Ms: requests._max.latencyP95Ms,
      },
      accounts: {
        active: snapshot?.activeAccounts ?? 0,
        new: snapshot?.newAccounts ?? 0,
        activated: snapshot?.activatedAccounts ?? 0,
      },
      attention: {
        openRiskFlags: openFlags,
        senderIdsAwaitingReview: senderQueue,
        senderIdsOverdue: overdueSenderIds,
      },
    };
  }

  /** Daily series for the overview charts, with empty days filled in. */
  async timeseries(dto: DateRangeDto) {
    const { start, end } = resolveRange(dto.from, dto.to, 30);

    const [usage, requests] = await Promise.all([
      this.admin.usageRollup.groupBy({
        by: ['date'],
        where: {
          hour: -1,
          date: { gte: lagosDateOnly(start), lte: lagosDateOnly(end) },
        },
        _sum: {
          revenueNgn: true,
          costNgn: true,
          attempted: true,
          succeeded: true,
        },
      }),
      this.admin.requestRollup.groupBy({
        by: ['date'],
        where: { date: { gte: lagosDateOnly(start), lte: lagosDateOnly(end) } },
        _sum: { total: true, serverErrors: true },
      }),
    ]);

    const usageByDate = new Map(usage.map((u) => [u.date.toISOString(), u]));
    const requestsByDate = new Map(
      requests.map((r) => [r.date.toISOString(), r]),
    );

    return {
      range: { from: start, to: end },
      series: eachLagosDay(start, end).map((date) => {
        const u = usageByDate.get(date.toISOString());
        const r = requestsByDate.get(date.toISOString());
        const revenue = D(u?._sum.revenueNgn);
        const cost = D(u?._sum.costNgn);
        const attempted = Number(u?._sum.attempted ?? 0);
        const total = Number(r?._sum.total ?? 0);

        return {
          date,
          revenueNgn: round(revenue),
          costNgn: round(cost),
          profitNgn: round(revenue - cost),
          billableEvents: attempted,
          successRate: attempted
            ? round(Number(u?._sum.succeeded ?? 0) / attempted, 4)
            : null,
          apiRequests: total,
          apiErrorRate: total
            ? round(Number(r?._sum.serverErrors ?? 0) / total, 4)
            : null,
        };
      }),
    };
  }

  /** Freshness and queue health, so staff can tell "no data" from "stale data". */
  async health() {
    const watermarks = await this.admin.rollupWatermark.findMany();
    const now = Date.now();
    return {
      at: nowLagos().toISO(),
      rollups: watermarks.map((w) => ({
        job: w.job,
        processedTo: w.processedTo,
        lagMinutes: Math.round((now - w.processedTo.getTime()) / 60_000),
        lastRunAt: w.lastRunAt,
        lastError: w.lastError,
      })),
    };
  }
}

function round(value: number, dp = 2): number {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}
