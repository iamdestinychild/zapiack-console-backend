import { Injectable } from '@nestjs/common';
import { TtlCache, cacheKey } from '../../common/cache/ttl-cache';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { ZapiackPrismaService } from '../../common/prisma/zapiack-prisma.service';
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
  // Rollups refresh every 15 minutes, so a minute of staleness is invisible and a
  // landing screen opened by several staff costs one set of queries.
  private readonly kpiCache = new TtlCache<unknown>(60_000);
  private readonly seriesCache = new TtlCache<unknown>(60_000);
  private readonly healthCache = new TtlCache<unknown>(30_000);

  constructor(
    private readonly admin: AdminPrismaService,
    private readonly zapiack: ZapiackPrismaService,
  ) {}

  /**
   * Customer totals and churn, which the rollups do not carry. One round trip; paying
   * means an active subscription on a plan that costs something.
   */
  private async customerCounts(start: Date, end: Date) {
    const [row] = await this.zapiack.read.$queryRaw<
      {
        total: bigint;
        paying: bigint;
        payingAtStart: bigint;
        churned: bigint;
      }[]
    >`
      SELECT
        (SELECT COUNT(*) FROM "accounts"
          WHERE "accountStatus" NOT IN ('CANCELED', 'BANNED'))::bigint AS "total",
        (SELECT COUNT(DISTINCT s."accountId") FROM "subscriptions" s
           JOIN "plans" p ON p."id" = s."planId"
          WHERE s."status" = 'ACTIVE' AND p."isFree" = false AND p."basePrice" > 0)::bigint AS "paying",
        (SELECT COUNT(DISTINCT s."accountId") FROM "subscriptions" s
           JOIN "plans" p ON p."id" = s."planId"
          WHERE p."isFree" = false AND p."basePrice" > 0
            AND s."createdAt" < ${start}
            AND (s."cancelledAt" IS NULL OR s."cancelledAt" >= ${start}))::bigint AS "payingAtStart",
        (SELECT COUNT(DISTINCT s."accountId") FROM "subscriptions" s
           JOIN "plans" p ON p."id" = s."planId"
          WHERE p."isFree" = false AND p."basePrice" > 0
            AND s."cancelledAt" >= ${start} AND s."cancelledAt" <= ${end})::bigint AS "churned"
    `;
    return {
      total: Number(row?.total ?? 0),
      paying: Number(row?.paying ?? 0),
      payingAtStart: Number(row?.payingAtStart ?? 0),
      churned: Number(row?.churned ?? 0),
    };
  }

  kpis(dto: DateRangeDto) {
    return this.kpiCache.get(cacheKey(dto), () =>
      this.loadKpis(dto),
    ) as ReturnType<OverviewService['loadKpis']>;
  }

  timeseries(dto: DateRangeDto) {
    return this.seriesCache.get(cacheKey(dto), () =>
      this.loadTimeseries(dto),
    ) as ReturnType<OverviewService['loadTimeseries']>;
  }

  /** Freshness and queue health, so staff can tell "no data" from "stale data". */
  health() {
    return this.healthCache.get('health', () =>
      this.loadHealth(),
    ) as ReturnType<OverviewService['loadHealth']>;
  }

  private async loadKpis(dto: DateRangeDto) {
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
      accountTotals,
      requests,
      openFlags,
      senderQueue,
      customers,
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
      // Account counters are period totals; credit liability and MRR above are
      // point-in-time and correctly read from the latest snapshot instead.
      this.admin.financeSnapshot.aggregate({
        where: { date: { gte: lagosDateOnly(start), lte: lagosDateOnly(end) } },
        _sum: { newAccounts: true, activatedAccounts: true },
        _max: { activeAccounts: true },
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
      this.customerCounts(start, end),
    ]);

    const credits = D(usage._sum.revenueNgn);
    const priorCredits = D(priorUsage._sum.revenueNgn);

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
        // Credits consumed is the revenue figure this schema supports. Provider cost
        // and gateway fees are not recorded anywhere, so profit is reported as null
        // rather than as revenue-minus-zero, which would read as 100% margin.
        creditsConsumed: round(credits),
        // Direction of travel against the same-length period before this one.
        creditsChangePct: priorCredits
          ? round(((credits - priorCredits) / Math.abs(priorCredits)) * 100, 1)
          : null,
        cashCollectedNgn: round(
          D(cash._sum.collectedNgn) - D(cash._sum.refundedNgn),
        ),
        creditLiability: round(D(snapshot?.creditLiabilityNgn)),
        mrrNgn: round(D(snapshot?.mrrNgn)),
        providerCostNgn: null,
        paymentFeesNgn: null,
        grossProfitNgn: null,
        grossMargin: null,
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
        // Accounts active on the busiest day of the range, not a sum: an account
        // active on two days is one account, and the daily rows cannot be added.
        active: accountTotals._max.activeAccounts ?? 0,
        new: accountTotals._sum.newAccounts ?? 0,
        activated: accountTotals._sum.activatedAccounts ?? 0,
        total: customers.total,
        paying: customers.paying,
        // Paying customers at the start of the range who cancelled within it.
        payingAtStart: customers.payingAtStart,
        churned: customers.churned,
      },
      attention: {
        openRiskFlags: openFlags,
        senderIdsAwaitingReview: senderQueue,
        senderIdsOverdue: overdueSenderIds,
      },
    };
  }

  /** Daily series for the overview charts, with empty days filled in. */
  private async loadTimeseries(dto: DateRangeDto) {
    const { start, end } = resolveRange(dto.from, dto.to, 30);

    const [usage, requests, snapshots] = await Promise.all([
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
      // Daily sign-ups and MRR, for the dashboard's sparklines.
      this.admin.financeSnapshot.findMany({
        where: { date: { gte: lagosDateOnly(start), lte: lagosDateOnly(end) } },
        select: { date: true, newAccounts: true, mrrNgn: true },
      }),
    ]);

    const snapshotByDate = new Map(
      snapshots.map((s) => [s.date.toISOString(), s]),
    );
    const usageByDate = new Map(usage.map((u) => [u.date.toISOString(), u]));
    const requestsByDate = new Map(
      requests.map((r) => [r.date.toISOString(), r]),
    );

    return {
      range: { from: start, to: end },
      series: eachLagosDay(start, end).map((date) => {
        const u = usageByDate.get(date.toISOString());
        const r = requestsByDate.get(date.toISOString());
        const f = snapshotByDate.get(date.toISOString());
        const credits = D(u?._sum.revenueNgn);
        const attempted = Number(u?._sum.attempted ?? 0);
        const total = Number(r?._sum.total ?? 0);

        return {
          date,
          creditsConsumed: round(credits),
          billableEvents: attempted,
          successRate: attempted
            ? round(Number(u?._sum.succeeded ?? 0) / attempted, 4)
            : null,
          apiRequests: total,
          apiErrorRate: total
            ? round(Number(r?._sum.serverErrors ?? 0) / total, 4)
            : null,
          newAccounts: f?.newAccounts ?? 0,
          mrrNgn: round(D(f?.mrrNgn)),
        };
      }),
    };
  }

  private async loadHealth() {
    // `history.backfill` is a one-time marker, not a job that runs on a schedule, so its
    // age means nothing here and would read as a stale job.
    const watermarks = await this.admin.rollupWatermark.findMany({
      where: { job: { not: 'history.backfill' } },
    });
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
