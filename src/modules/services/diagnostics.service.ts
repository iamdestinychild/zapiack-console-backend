import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DateTime } from 'luxon';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { ZapiackPrismaService } from '../../common/prisma/zapiack-prisma.service';
import { LAGOS, lagosDateOnly } from '../../common/time/lagos';
import type { AdminConfig } from '../../common/config/configuration';

const n = (v: unknown) => Number(v ?? 0);

/**
 * Puts what the product database holds next to what the console is showing, for today
 * in Lagos. Counts and sums only: no recipients, content, addresses or keys.
 *
 * It exists because every figure on the console is derived. When one looks wrong, the
 * first question is whether the source or the derivation is at fault, and this answers
 * it without database access.
 */
@Injectable()
export class DiagnosticsService {
  constructor(
    private readonly admin: AdminPrismaService,
    private readonly zapiack: ZapiackPrismaService,
    private readonly config: ConfigService<{ admin: AdminConfig }, true>,
  ) {}

  /** Host and database name of the product connection, never the credentials. */
  private productTarget() {
    const raw = process.env.ZAPIACK_READ_DATABASE_URL ?? '';
    try {
      const url = new URL(raw);
      return { host: url.hostname, database: url.pathname.replace('/', '') };
    } catch {
      return { host: 'unparseable', database: 'unparseable' };
    }
  }

  async dataHealth() {
    const start = DateTime.now().setZone(LAGOS).startOf('day');
    const from = start.toJSDate();
    const to = start.plus({ days: 1 }).toJSDate();
    const date = lagosDateOnly(from);
    const read = this.zapiack.read;

    const [
      events,
      ledger,
      activity,
      activityGeo,
      applications,
      payments,
      accounts,
      newest,
    ] = await Promise.all([
      read.$queryRaw<
        {
          channel: string;
          events: bigint;
          withCost: bigint;
          costSum: string;
          linkedToLedger: bigint;
        }[]
      >`
        SELECT "channel"::text AS channel, COUNT(*)::bigint AS events,
               COUNT("cost")::bigint AS "withCost",
               COALESCE(SUM("cost"), 0)::text AS "costSum",
               COUNT("tabTransactionId")::bigint AS "linkedToLedger"
        FROM "log_events" WHERE "createdAt" >= ${from} AND "createdAt" < ${to}
        GROUP BY 1 ORDER BY 2 DESC`,
      read.$queryRaw<
        {
          type: string;
          status: string;
          channel: string | null;
          rows: bigint;
          chargeSum: string;
        }[]
      >`
        SELECT "type"::text AS type, "status"::text AS status, "channel"::text AS channel,
               COUNT(*)::bigint AS rows, COALESCE(SUM("charge"), 0)::text AS "chargeSum"
        FROM "tab_transactions" WHERE "createdAt" >= ${from} AND "createdAt" < ${to}
        GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
      read.$queryRaw<{ service: string; requests: bigint }[]>`
        SELECT "service"::text AS service, COUNT(*)::bigint AS requests
        FROM "api_activity_logs" WHERE "createdAt" >= ${from} AND "createdAt" < ${to}
        GROUP BY 1 ORDER BY 2 DESC`,
      read.$queryRaw<
        {
          total: bigint;
          withCountry: bigint;
          withCity: bigint;
          withIp: bigint;
        }[]
      >`
        SELECT COUNT(*)::bigint AS total, COUNT("countryCode")::bigint AS "withCountry",
               COUNT("city")::bigint AS "withCity", COUNT("ip")::bigint AS "withIp"
        FROM "api_activity_logs" WHERE "createdAt" >= ${from} AND "createdAt" < ${to}`,
      read.$queryRaw<{ status: string; total: bigint }[]>`
        SELECT "status", COUNT(*)::bigint AS total FROM "sender_id_applications"
        GROUP BY 1 ORDER BY 2 DESC`,
      read.$queryRaw<{ status: string; rows: bigint; amount: string }[]>`
        SELECT "status"::text AS status, COUNT(*)::bigint AS rows,
               COALESCE(SUM("amount"), 0)::text AS amount
        FROM "transactions" WHERE "createdAt" >= ${from} AND "createdAt" < ${to}
        GROUP BY 1 ORDER BY 1`,
      read.$queryRaw<
        { total: bigint }[]
      >`SELECT COUNT(*)::bigint AS total FROM "accounts"`,
      read.$queryRaw<
        { logEvents: Date | null; activity: Date | null; ledger: Date | null }[]
      >`
        SELECT (SELECT MAX("createdAt") FROM "log_events") AS "logEvents",
               (SELECT MAX("createdAt") FROM "api_activity_logs") AS activity,
               (SELECT MAX("createdAt") FROM "tab_transactions") AS ledger`,
    ]);

    const [usage, usageHourly, requests, reviews, reviewByStatus, watermarks] =
      await Promise.all([
        this.admin.usageRollup.aggregate({
          where: { date, hour: -1 },
          _sum: { attempted: true, revenueNgn: true },
          _count: { _all: true },
        }),
        this.admin.usageRollup.aggregate({
          where: { date, hour: { gte: 0 } },
          _sum: { attempted: true, revenueNgn: true },
          _count: { _all: true },
        }),
        this.admin.requestRollup.aggregate({
          where: { date },
          _sum: { total: true },
        }),
        this.admin.senderIdReview.count(),
        this.admin.senderIdReview.groupBy({
          by: ['status'],
          _count: { _all: true },
        }),
        this.admin.rollupWatermark.findMany(),
      ]);

    const sourceEvents = events.reduce((a, r) => a + n(r.events), 0);
    const sourceRequests = activity.reduce((a, r) => a + n(r.requests), 0);
    // A draft has not been filed, so it is rightly absent from the review queue.
    const sourceApplications = applications
      .filter((r) => r.status.trim().toUpperCase() !== 'DRAFT')
      .reduce((a, r) => a + n(r.total), 0);
    const debits = ledger
      .filter((r) => r.type === 'DEBIT' && r.status !== 'FAILED')
      .reduce((a, r) => a + n(r.chargeSum), 0);
    const eventCostSum = events.reduce((a, r) => a + n(r.costSum), 0);

    const findings: string[] = [];
    const rolledEvents = n(usage._sum.attempted);
    if (sourceEvents !== rolledEvents)
      findings.push(
        `Today's usage rollup shows ${rolledEvents} events but the product has ${sourceEvents}. Rollups catch up within 5 minutes of the service being awake.`,
      );
    const rolledRequests = n(requests._sum.total);
    if (sourceRequests !== rolledRequests)
      findings.push(
        `Today's request rollup shows ${rolledRequests} but api_activity_logs has ${sourceRequests}.`,
      );
    if (sourceEvents > 0 && sourceRequests * 5 < sourceEvents)
      findings.push(
        `The product logged ${sourceRequests} API requests against ${sourceEvents} messages today. Messages sent some other way than an API call (a dashboard campaign, SMTP, a worker) never reach api_activity_logs, so "API requests" will always read low next to message volume. That is the product's logging, not a console fault.`,
      );
    if (eventCostSum === 0 && debits > 0)
      findings.push(
        `log_events.cost sums to 0 today while the ledger holds ${debits} of debits. Revenue must come from the ledger, which the rollups now do.`,
      );
    if (reviews < sourceApplications)
      findings.push(
        `The product has ${sourceApplications} filed (non-draft) sender ID applications and the console has ${reviews} reviews. The 5-minute import brings them in; any left over have a status the console does not recognise (see applicationStatuses).`,
      );
    const geo = activityGeo[0];
    if (geo && n(geo.total) > 0 && n(geo.withCountry) === 0)
      findings.push(
        'No request today carries a country code, so the map has nothing to place. api-core must record countryCode (and ideally city) on api_activity_logs.',
      );

    return {
      generatedAt: new Date(),
      lagosDay: start.toISODate(),
      productDatabase: this.productTarget(),
      findings,
      product: {
        accounts: n(accounts[0]?.total),
        newestRow: newest[0],
        messageEventsToday: events.map((r) => ({
          channel: r.channel,
          events: n(r.events),
          withCost: n(r.withCost),
          costSum: r.costSum,
          linkedToLedger: n(r.linkedToLedger),
        })),
        ledgerToday: ledger.map((r) => ({ ...r, rows: n(r.rows) })),
        apiRequestsToday: activity.map((r) => ({
          service: r.service,
          requests: n(r.requests),
        })),
        requestGeographyToday: geo && {
          total: n(geo.total),
          withCountry: n(geo.withCountry),
          withCity: n(geo.withCity),
          withIp: n(geo.withIp),
        },
        applicationStatuses: applications.map((r) => ({
          status: r.status,
          total: n(r.total),
        })),
        paymentsToday: payments.map((r) => ({ ...r, rows: n(r.rows) })),
      },
      console: {
        usageDaily: {
          rows: usage._count._all,
          attempted: n(usage._sum.attempted),
          revenue: usage._sum.revenueNgn,
        },
        usageHourly: {
          rows: usageHourly._count._all,
          attempted: n(usageHourly._sum.attempted),
          revenue: usageHourly._sum.revenueNgn,
        },
        apiRequests: rolledRequests,
        senderIdReviews: reviews,
        senderIdReviewsByStatus: reviewByStatus.map((r) => ({
          status: r.status,
          total: r._count._all,
        })),
        watermarks: watermarks.map((w) => ({
          job: w.job,
          processedTo: w.processedTo,
          lastError: w.lastError,
        })),
        timezone: this.config.get('admin', { infer: true }).timezone,
      },
    };
  }
}
