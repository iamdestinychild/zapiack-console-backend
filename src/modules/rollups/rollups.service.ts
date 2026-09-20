import { Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { ZapiackPrismaService } from '../../common/prisma/zapiack-prisma.service';
import { LAGOS, lagosDateOnly } from '../../common/time/lagos';

interface UsageBucket {
  date: Date;
  hour: number;
  channel: string;
  accountId: string;
  country: string;
  provider: string;
  attempted: bigint;
  succeeded: bigint;
  failed: bigint;
  units: bigint;
  revenueNgn: string;
  costNgn: string;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
}

/**
 * Aggregation from raw product rows into the Admin DB rollups every screen reads.
 *
 * Every job is idempotent: it upserts a (date, hour, channel, accountId, country,
 * provider) bucket, so re-running a window never double-counts. That is what makes it
 * safe to run the current day every five minutes and finalise it again at night.
 */
@Injectable()
export class RollupsService {
  private readonly logger = new Logger(RollupsService.name);

  constructor(
    private readonly admin: AdminPrismaService,
    private readonly zapiack: ZapiackPrismaService,
  ) {}

  // ---------------------------------------------------------------- usage

  /**
   * Hourly usage buckets for a window. `hour` is the Lagos hour; the daily row that
   * finalisation writes uses hour = -1 so the two never collide.
   */
  async rollUsage(start: Date, end: Date): Promise<number> {
    const buckets = await this.zapiack.read.$queryRaw<UsageBucket[]>`
      SELECT
        ("createdAt" AT TIME ZONE ${LAGOS})::date                                  AS date,
        EXTRACT(HOUR FROM ("createdAt" AT TIME ZONE ${LAGOS}))::int                 AS hour,
        "channel"::text                                                            AS channel,
        "accountId",
        COALESCE("destinationCountry", 'UNKNOWN')                                  AS country,
        COALESCE("provider", 'UNKNOWN')                                            AS provider,
        COUNT(*)::bigint                                                           AS attempted,
        COUNT(*) FILTER (WHERE "status" IN ('delivered', 'accepted', 'success'))::bigint AS succeeded,
        COUNT(*) FILTER (WHERE "status" = 'failed')::bigint                        AS failed,
        COALESCE(SUM("units"), 0)::bigint                                          AS units,
        COALESCE(SUM("totalPriceNgn"), 0)::text                                    AS "revenueNgn",
        COALESCE(SUM("providerCostNgn"), 0)::text                                  AS "costNgn",
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY "latencyMs")::int              AS "latencyP50Ms",
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY "latencyMs")::int             AS "latencyP95Ms"
      FROM "usage_records"
      WHERE "createdAt" >= ${start} AND "createdAt" < ${end}
      GROUP BY 1, 2, 3, 4, 5, 6
    `;

    await this.upsertUsageBuckets(buckets);
    this.logger.log(
      `Rolled ${buckets.length} usage buckets for ${start.toISOString()}..${end.toISOString()}`,
    );
    return buckets.length;
  }

  /**
   * Writes the finalised daily row (hour = -1) for a Lagos day from the raw source,
   * rather than by summing the hourly rows, so a gap in hourly runs self-heals.
   */
  async finaliseDay(day: Date): Promise<number> {
    const start = DateTime.fromJSDate(day).setZone(LAGOS).startOf('day');
    const end = start.plus({ days: 1 });

    const buckets = await this.zapiack.read.$queryRaw<UsageBucket[]>`
      SELECT
        ("createdAt" AT TIME ZONE ${LAGOS})::date                                  AS date,
        -1                                                                         AS hour,
        "channel"::text                                                            AS channel,
        "accountId",
        COALESCE("destinationCountry", 'UNKNOWN')                                  AS country,
        COALESCE("provider", 'UNKNOWN')                                            AS provider,
        COUNT(*)::bigint                                                           AS attempted,
        COUNT(*) FILTER (WHERE "status" IN ('delivered', 'accepted', 'success'))::bigint AS succeeded,
        COUNT(*) FILTER (WHERE "status" = 'failed')::bigint                        AS failed,
        COALESCE(SUM("units"), 0)::bigint                                          AS units,
        COALESCE(SUM("totalPriceNgn"), 0)::text                                    AS "revenueNgn",
        COALESCE(SUM("providerCostNgn"), 0)::text                                  AS "costNgn",
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY "latencyMs")::int              AS "latencyP50Ms",
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY "latencyMs")::int             AS "latencyP95Ms"
      FROM "usage_records"
      WHERE "createdAt" >= ${start.toJSDate()} AND "createdAt" < ${end.toJSDate()}
      GROUP BY 1, 3, 4, 5, 6
    `;

    await this.upsertUsageBuckets(buckets, new Date());
    await this.rollDestinations(day);
    await this.rollCash(day);
    await this.snapshotFinance(day);

    this.logger.log(
      `Finalised ${buckets.length} daily usage buckets for ${start.toISODate()}`,
    );
    return buckets.length;
  }

  private async upsertUsageBuckets(buckets: UsageBucket[], finalisedAt?: Date) {
    // Chunked so a busy day does not open one enormous transaction.
    for (const chunk of chunked(buckets, 500)) {
      await this.admin.$transaction(
        chunk.map((b) =>
          this.admin.usageRollup.upsert({
            where: {
              date_hour_channel_accountId_country_provider: {
                date: b.date,
                hour: b.hour,
                channel: b.channel,
                accountId: b.accountId,
                country: b.country,
                provider: b.provider,
              },
            },
            create: { ...b, finalisedAt },
            // Replace rather than increment: the bucket is recomputed from source,
            // which is what makes a re-run safe.
            update: {
              attempted: b.attempted,
              succeeded: b.succeeded,
              failed: b.failed,
              units: b.units,
              revenueNgn: b.revenueNgn,
              costNgn: b.costNgn,
              latencyP50Ms: b.latencyP50Ms,
              latencyP95Ms: b.latencyP95Ms,
              finalisedAt,
            },
          }),
        ),
      );
    }
  }

  // ---------------------------------------------------------------- destinations

  /** Where messages went. Concentration in one country or network is the pumping signal. */
  async rollDestinations(day: Date): Promise<number> {
    const start = DateTime.fromJSDate(day).setZone(LAGOS).startOf('day');
    const end = start.plus({ days: 1 });

    const rows = await this.zapiack.read.$queryRaw<
      {
        date: Date;
        channel: string;
        accountId: string;
        country: string;
        network: string | null;
        attempted: bigint;
        delivered: bigint;
        costNgn: string;
      }[]
    >`
      SELECT
        ("createdAt" AT TIME ZONE ${LAGOS})::date         AS date,
        "channel"::text                                   AS channel,
        "accountId",
        COALESCE("destinationCountry", 'UNKNOWN')         AS country,
        "destinationNetwork"                              AS network,
        COUNT(*)::bigint                                  AS attempted,
        COUNT(*) FILTER (WHERE "status" = 'delivered')::bigint AS delivered,
        COALESCE(SUM("providerCostNgn"), 0)::text         AS "costNgn"
      FROM "usage_records"
      WHERE "createdAt" >= ${start.toJSDate()} AND "createdAt" < ${end.toJSDate()}
        AND "channel" IN ('SMS', 'WHATSAPP', 'VOICE')
      GROUP BY 1, 2, 3, 4, 5
    `;

    for (const chunk of chunked(rows, 500)) {
      await this.admin.$transaction(
        chunk.map((r) =>
          this.admin.destinationRollup.upsert({
            where: {
              date_channel_accountId_country_network: {
                date: r.date,
                channel: r.channel,
                accountId: r.accountId,
                country: r.country,
                network: r.network ?? '',
              },
            },
            create: { ...r, network: r.network ?? '' },
            update: {
              attempted: r.attempted,
              delivered: r.delivered,
              costNgn: r.costNgn,
            },
          }),
        ),
      );
    }
    return rows.length;
  }

  // ---------------------------------------------------------------- cash

  /**
   * Cash collected, kept apart from recognised revenue: a prepaid top-up is a
   * liability until the credit is spent, so it must never be read as earnings.
   */
  async rollCash(day: Date): Promise<void> {
    const start = DateTime.fromJSDate(day).setZone(LAGOS).startOf('day');
    const end = start.plus({ days: 1 });

    const [row] = await this.zapiack.read.$queryRaw<
      {
        collected: string;
        refunded: string;
        fees: string;
        paymentCount: bigint;
        failedCount: bigint;
      }[]
    >`
      SELECT
        COALESCE(SUM("amountNgn")   FILTER (WHERE "status" = 'SUCCESS'), 0)::text AS collected,
        COALESCE(SUM("refundedNgn"), 0)::text                                     AS refunded,
        COALESCE(SUM("feeNgn")      FILTER (WHERE "status" = 'SUCCESS'), 0)::text AS fees,
        COUNT(*) FILTER (WHERE "status" = 'SUCCESS')::bigint                      AS "paymentCount",
        COUNT(*) FILTER (WHERE "status" = 'FAILED')::bigint                       AS "failedCount"
      FROM "payments"
      WHERE "createdAt" >= ${start.toJSDate()} AND "createdAt" < ${end.toJSDate()}
    `;

    const date = lagosDateOnly(day);
    const data = {
      collectedNgn: row?.collected ?? '0',
      refundedNgn: row?.refunded ?? '0',
      feesNgn: row?.fees ?? '0',
      paymentCount: Number(row?.paymentCount ?? 0),
      failedCount: Number(row?.failedCount ?? 0),
    };
    await this.admin.cashRollup.upsert({
      where: { date },
      create: { date, ...data },
      update: data,
    });
  }

  // ---------------------------------------------------------------- snapshots

  /** End-of-day balances and subscription figures, which are point-in-time by nature. */
  async snapshotFinance(day: Date): Promise<void> {
    const start = DateTime.fromJSDate(day).setZone(LAGOS).startOf('day');
    const end = start.plus({ days: 1 });
    const date = lagosDateOnly(day);

    const [liability, mrr, activity] = await Promise.all([
      this.zapiack.read.$queryRaw<{ total: string }[]>`
        SELECT COALESCE(SUM("balance"), 0)::text AS total FROM "accounts" WHERE "status" <> 'CLOSED'
      `,
      // Annual plans are divided by 12 so MRR means the same thing across plans.
      this.zapiack.read.$queryRaw<{ mrr: string }[]>`
        SELECT COALESCE(SUM(
          CASE WHEN p."interval" = 'year' THEN p."priceNgn" / 12 ELSE p."priceNgn" END
        ), 0)::text AS mrr
        FROM "subscriptions" s
        JOIN "plans" p ON p."id" = s."planId"
        WHERE s."status" = 'active' AND s."startedAt" < ${end.toJSDate()}
          AND (s."cancelledAt" IS NULL OR s."cancelledAt" >= ${end.toJSDate()})
      `,
      this.zapiack.read.$queryRaw<
        {
          newAccounts: bigint;
          activatedAccounts: bigint;
          activeAccounts: bigint;
          subscriptionRevenue: string;
        }[]
      >`
        SELECT
          (SELECT COUNT(*) FROM "accounts"
             WHERE "createdAt" >= ${start.toJSDate()} AND "createdAt" < ${end.toJSDate()})::bigint
            AS "newAccounts",
          -- Activated: created in the last 14 days and already made a paid send.
          (SELECT COUNT(DISTINCT a."id") FROM "accounts" a
             JOIN "usage_records" u ON u."accountId" = a."id"
            WHERE a."createdAt" >= ${start.minus({ days: 14 }).toJSDate()}
              AND a."createdAt" < ${end.toJSDate()}
              AND u."createdAt" <= a."createdAt" + INTERVAL '14 days'
              AND u."totalPriceNgn" > 0)::bigint
            AS "activatedAccounts",
          (SELECT COUNT(DISTINCT "accountId") FROM "usage_records"
             WHERE "createdAt" >= ${start.toJSDate()} AND "createdAt" < ${end.toJSDate()})::bigint
            AS "activeAccounts",
          -- Subscription fees are recognised on the day the period starts. See the
          -- open question on daily recognition in the PRD.
          (SELECT COALESCE(SUM(p."priceNgn"), 0) FROM "subscriptions" s
             JOIN "plans" p ON p."id" = s."planId"
            WHERE s."currentPeriodStart" >= ${start.toJSDate()}
              AND s."currentPeriodStart" < ${end.toJSDate()})::text
            AS "subscriptionRevenue"
      `,
    ]);

    const data = {
      creditLiabilityNgn: liability[0]?.total ?? '0',
      mrrNgn: mrr[0]?.mrr ?? '0',
      newAccounts: Number(activity[0]?.newAccounts ?? 0),
      activatedAccounts: Number(activity[0]?.activatedAccounts ?? 0),
      activeAccounts: Number(activity[0]?.activeAccounts ?? 0),
      subscriptionRevenueNgn: activity[0]?.subscriptionRevenue ?? '0',
    };

    await this.admin.financeSnapshot.upsert({
      where: { date },
      create: { date, ...data },
      update: data,
    });
  }

  // ---------------------------------------------------------------- requests

  /** API traffic rollups, sourced from the Admin DB's own request log. */
  async rollRequests(start: Date, end: Date): Promise<number> {
    const rows = await this.admin.$queryRaw<
      {
        date: Date;
        hour: number;
        accountId: string | null;
        endpoint: string;
        method: string;
        country: string;
        total: bigint;
        clientErrors: bigint;
        serverErrors: bigint;
        latencyP50Ms: number | null;
        latencyP95Ms: number | null;
      }[]
    >`
      SELECT
        ("occurredAt" AT TIME ZONE ${LAGOS})::date                      AS date,
        EXTRACT(HOUR FROM ("occurredAt" AT TIME ZONE ${LAGOS}))::int     AS hour,
        "accountId",
        "endpoint",
        "method",
        COALESCE("country", 'UNKNOWN')                                  AS country,
        COUNT(*)::bigint                                                AS total,
        COUNT(*) FILTER (WHERE "statusCode" BETWEEN 400 AND 499)::bigint AS "clientErrors",
        COUNT(*) FILTER (WHERE "statusCode" >= 500)::bigint             AS "serverErrors",
        PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY "latencyMs")::int  AS "latencyP50Ms",
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY "latencyMs")::int  AS "latencyP95Ms"
      FROM "request_logs"
      WHERE "occurredAt" >= ${start} AND "occurredAt" < ${end}
      GROUP BY 1, 2, 3, 4, 5, 6
    `;

    for (const chunk of chunked(rows, 500)) {
      await this.admin.$transaction(
        chunk.map((r) =>
          this.admin.requestRollup.upsert({
            where: {
              date_hour_accountId_endpoint_method_country: {
                date: r.date,
                hour: r.hour,
                accountId: r.accountId ?? '',
                endpoint: r.endpoint,
                method: r.method,
                country: r.country,
              },
            },
            create: { ...r, accountId: r.accountId ?? '' },
            update: {
              total: r.total,
              clientErrors: r.clientErrors,
              serverErrors: r.serverErrors,
              latencyP50Ms: r.latencyP50Ms,
              latencyP95Ms: r.latencyP95Ms,
            },
          }),
        ),
      );
    }
    return rows.length;
  }

  // ---------------------------------------------------------------- watermarks

  /** Records how far a job has got, so rollup lag can be alerted on. */
  async markProcessed(job: string, processedTo: Date, error?: string) {
    await this.admin.rollupWatermark.upsert({
      where: { job },
      create: { job, processedTo, lastError: error },
      update: { processedTo, lastRunAt: new Date(), lastError: error ?? null },
    });
  }

  async lag(): Promise<
    {
      job: string;
      processedTo: Date;
      lagMinutes: number;
      lastError: string | null;
    }[]
  > {
    const watermarks = await this.admin.rollupWatermark.findMany();
    const now = Date.now();
    return watermarks.map((w) => ({
      job: w.job,
      processedTo: w.processedTo,
      lagMinutes: Math.round((now - w.processedTo.getTime()) / 60_000),
      lastError: w.lastError,
    }));
  }
}

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}
