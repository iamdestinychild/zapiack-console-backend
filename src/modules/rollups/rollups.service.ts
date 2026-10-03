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
}

/**
 * Aggregation from raw product rows into the Admin DB rollups every screen reads.
 *
 * Every timestamp column here is `timestamp without time zone` holding UTC, which is
 * how Prisma stores a DateTime. Converting one to a Lagos calendar day therefore takes
 * two steps: `AT TIME ZONE 'UTC'` to say what the naive value means, then
 * `AT TIME ZONE 'Africa/Lagos'` to move it. The second alone reads the value as Lagos
 * local time and shifts everything in the 23:00 UTC hour onto the wrong day — which
 * also makes a window straddle two dates, so consecutive daily runs overwrite each
 * other's buckets.
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
        ("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${LAGOS})::date                                  AS date,
        EXTRACT(HOUR FROM ("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${LAGOS}))::int                 AS hour,
        "channel"::text                                                            AS channel,
        "accountId",
        COALESCE("countryCode", 'UNKNOWN')                                  AS country,
        COALESCE("operator", 'UNKNOWN')                                            AS provider,
        COUNT(*)::bigint                                                           AS attempted,
        COUNT(*) FILTER (WHERE "status" = 'DELIVERED')::bigint AS succeeded,
        COUNT(*) FILTER (WHERE "status" = 'FAILED')::bigint                        AS failed,
        COUNT(*)::bigint                                          AS units,
        COALESCE(SUM("cost"), 0)::text                                    AS "revenueNgn",
        '0'::text                                  AS "costNgn"
      FROM "log_events"
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
    // Every bucket this run writes is stamped with this instant, so anything left
    // carrying an older stamp afterwards is a bucket whose source no longer exists.
    const runStartedAt = new Date();

    const buckets = await this.zapiack.read.$queryRaw<UsageBucket[]>`
      SELECT
        ("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${LAGOS})::date                                  AS date,
        -1                                                                         AS hour,
        "channel"::text                                                            AS channel,
        "accountId",
        COALESCE("countryCode", 'UNKNOWN')                                  AS country,
        COALESCE("operator", 'UNKNOWN')                                            AS provider,
        COUNT(*)::bigint                                                           AS attempted,
        COUNT(*) FILTER (WHERE "status" = 'DELIVERED')::bigint AS succeeded,
        COUNT(*) FILTER (WHERE "status" = 'FAILED')::bigint                        AS failed,
        COUNT(*)::bigint                                          AS units,
        COALESCE(SUM("cost"), 0)::text                                    AS "revenueNgn",
        '0'::text                                  AS "costNgn"
      FROM "log_events"
      WHERE "createdAt" >= ${start.toJSDate()} AND "createdAt" < ${end.toJSDate()}
      GROUP BY 1, 3, 4, 5, 6
    `;

    await this.upsertUsageBuckets(buckets, runStartedAt);

    // Recomputing from source has to mean REPLACING the day, not just overwriting the
    // buckets that still exist: rows deleted or corrected upstream would otherwise
    // keep their old totals forever, and the day would never reconcile again.
    const swept = await this.admin.usageRollup.deleteMany({
      where: {
        date: lagosDateOnly(day),
        hour: -1,
        OR: [{ finalisedAt: null }, { finalisedAt: { lt: runStartedAt } }],
      },
    });
    if (swept.count) {
      this.logger.warn(
        `Removed ${swept.count} stale bucket(s) for ${start.toISODate()}; their source rows are gone`,
      );
    }
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
    const runStartedAt = new Date();

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
        ("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${LAGOS})::date         AS date,
        "channel"::text                                   AS channel,
        "accountId",
        COALESCE("countryCode", 'UNKNOWN')         AS country,
        "operator"                                         AS network,
        COUNT(*)::bigint                                  AS attempted,
        COUNT(*) FILTER (WHERE "status" = 'DELIVERED')::bigint AS delivered,
        '0'::text         AS "costNgn"
      FROM "log_events"
      WHERE "createdAt" >= ${start.toJSDate()} AND "createdAt" < ${end.toJSDate()}
        AND "channel" IN ('SMS', 'WHATSAPP', 'VOICE', 'AUDIO')
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
    // Anything the run did not touch has a stale `updatedAt` and no source behind it.
    await this.admin.destinationRollup.deleteMany({
      where: { date: lagosDateOnly(day), updatedAt: { lt: runStartedAt } },
    });
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
        COALESCE(SUM("amount") FILTER (WHERE "status" = 'SUCCESS'), 0)::text  AS collected,
        COALESCE(SUM("amount") FILTER (WHERE "status" = 'REVERSED'), 0)::text AS refunded,
        -- Payment processing fees are not recorded on a transaction, so there is
        -- nothing to sum. Left at zero rather than guessed.
        '0'::text                                                             AS fees,
        COUNT(*) FILTER (WHERE "status" = 'SUCCESS')::bigint                  AS "paymentCount",
        COUNT(*) FILTER (WHERE "status" = 'FAILED')::bigint                   AS "failedCount"
      FROM "transactions"
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
        SELECT COALESCE(SUM("creditBalance"), 0)::text AS total
        FROM "accounts"
        WHERE "accountStatus" NOT IN ('CANCELED', 'BANNED')
      `,
      // Annual plans are divided by 12 so MRR means the same thing across plans.
      this.zapiack.read.$queryRaw<{ mrr: string }[]>`
        SELECT COALESCE(SUM(
          CASE WHEN p."billingInterval" = 'YEARLY' THEN p."basePrice" / 12 ELSE p."basePrice" END
        ), 0)::text AS mrr
        FROM "subscriptions" s
        JOIN "plans" p ON p."id" = s."planId"
        WHERE s."status" = 'ACTIVE' AND s."createdAt" < ${end.toJSDate()}
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
             JOIN "log_events" u ON u."accountId" = a."id"
            WHERE a."createdAt" >= ${start.minus({ days: 14 }).toJSDate()}
              AND a."createdAt" < ${end.toJSDate()}
              AND u."createdAt" <= a."createdAt" + INTERVAL '14 days'
              AND u."cost" > 0)::bigint
            AS "activatedAccounts",
          (SELECT COUNT(DISTINCT "accountId") FROM "log_events"
             WHERE "createdAt" >= ${start.toJSDate()} AND "createdAt" < ${end.toJSDate()})::bigint
            AS "activeAccounts",
          -- Subscription fees are recognised on the day the period starts. See the
          -- open question on daily recognition in the PRD.
          (SELECT COALESCE(SUM(p."basePrice"), 0) FROM "subscriptions" s
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

  /**
   * API traffic rollups, read from the product's own `api_activity_logs`.
   *
   * That table keys traffic by API key prefix rather than by account, so the prefixes
   * are resolved to accounts here. It records no latency, so the p50/p95 columns stay
   * null until the product captures request duration.
   */
  async rollRequests(start: Date, end: Date): Promise<number> {
    const rows = await this.zapiack.read.$queryRaw<
      {
        date: Date;
        hour: number;
        apiKeyPrefix: string | null;
        endpoint: string;
        method: string;
        country: string;
        total: bigint;
        clientErrors: bigint;
        serverErrors: bigint;
      }[]
    >`
      SELECT
        ("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${LAGOS})::date                   AS date,
        EXTRACT(HOUR FROM ("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${LAGOS}))::int AS hour,
        "apiKeyPrefix",
        "endpoint",
        "method",
        COALESCE("countryCode", 'UNKNOWN')                                             AS country,
        COUNT(*)::bigint                                                               AS total,
        COUNT(*) FILTER (WHERE "statusCode" BETWEEN 400 AND 499)::bigint               AS "clientErrors",
        COUNT(*) FILTER (WHERE "statusCode" >= 500)::bigint                            AS "serverErrors"
      FROM "api_activity_logs"
      WHERE "createdAt" >= ${start} AND "createdAt" < ${end}
      GROUP BY 1, 2, 3, 4, 5, 6
    `;

    const prefixes = [
      ...new Set(
        rows.map((r) => r.apiKeyPrefix).filter((p): p is string => Boolean(p)),
      ),
    ];
    const keys = prefixes.length
      ? await this.zapiack.read.apiKeys.findMany({
          where: { keyPrefix: { in: prefixes } },
          select: { keyPrefix: true, accountId: true },
        })
      : [];
    const accountByPrefix = new Map(
      keys.map((k) => [k.keyPrefix, k.accountId]),
    );

    for (const chunk of chunked(rows, 500)) {
      await this.admin.$transaction(
        chunk.map((r) => {
          // Unattributed traffic (no key, or a key since deleted) is kept under an
          // empty account rather than dropped: the totals still have to add up.
          const accountId = r.apiKeyPrefix
            ? (accountByPrefix.get(r.apiKeyPrefix) ?? '')
            : '';
          const data = {
            total: r.total,
            clientErrors: r.clientErrors,
            serverErrors: r.serverErrors,
          };
          return this.admin.requestRollup.upsert({
            where: {
              date_hour_accountId_endpoint_method_country: {
                date: r.date,
                hour: r.hour,
                accountId,
                endpoint: r.endpoint,
                method: r.method,
                country: r.country,
              },
            },
            create: {
              date: r.date,
              hour: r.hour,
              accountId,
              endpoint: r.endpoint,
              method: r.method,
              country: r.country,
              ...data,
            },
            update: data,
          });
        }),
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
