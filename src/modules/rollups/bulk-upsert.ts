import { Prisma } from '../../generated/zapiack/client';

/**
 * Writes rollup rows in bulk: one `INSERT ... ON CONFLICT DO UPDATE` per chunk, with the values as array parameters.
 *
 * This replaces `$transaction(rows.map((r) => model.upsert(...)))`. Prisma 7 (7.10.0 and 7.10.1) keeps something for every
 * distinct set of numbers it is given in an `upsert`, about 20 KB each and never released. The rollup jobs re-write the same
 * rows every fifteen minutes with new totals, so each run left a few MB behind until the process ran out of heap (an
 * out-of-memory crash after about 20 hours). Measured with 1,500 rows re-written with changing totals: +30 MB per run with
 * `upsert`, under 1 MB per run with this.
 *
 * A plain SQL statement is also one round trip per 500 rows instead of 500.
 */

/** The part of a Prisma client these writers need (so a test can pass a fake). */
export interface RawExecutor {
  $executeRaw(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<number>;
}

const CHUNK = 500;

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

/** A calendar day as `YYYY-MM-DD`, from a Date that is that day at 00:00 UTC (how the rollups carry a Lagos day). */
export const dayString = (d: Date): string => d.toISOString().slice(0, 10);

const add = (a: string, b: string): string =>
  new Prisma.Decimal(a).plus(b).toString();

/**
 * One row per key. A key can appear twice in one run (two API keys of the same account; a network that is null in one row and
 * empty in another). `INSERT ... ON CONFLICT` refuses to touch a row twice in one statement, and the old per-row upserts let the
 * last one win and so undercounted; the rows are added together instead.
 */
export function mergeByKey<T>(
  rows: T[],
  key: (row: T) => string,
  sum: (a: T, b: T) => T,
): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) {
    const k = key(row);
    const seen = byKey.get(k);
    byKey.set(k, seen ? sum(seen, row) : row);
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------- usage_rollups

export interface UsageRow {
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

export const mergeUsage = (rows: UsageRow[]): UsageRow[] =>
  mergeByKey(
    rows,
    (r) =>
      [
        dayString(r.date),
        r.hour,
        r.channel,
        r.accountId,
        r.country,
        r.provider,
      ].join('\u0000'),
    (a, b) => ({
      ...a,
      attempted: a.attempted + b.attempted,
      succeeded: a.succeeded + b.succeeded,
      failed: a.failed + b.failed,
      units: a.units + b.units,
      revenueNgn: add(a.revenueNgn, b.revenueNgn),
      costNgn: add(a.costNgn, b.costNgn),
    }),
  );

/**
 * `finalisedAt` is stamped on the row when given. When it is not (the hourly rows), a row that already has one keeps it, as the
 * per-row upsert did by leaving the field out of the update.
 */
export async function upsertUsageRows(
  db: RawExecutor,
  rows: UsageRow[],
  finalisedAt?: Date,
): Promise<void> {
  for (const chunk of chunked(mergeUsage(rows), CHUNK)) {
    await db.$executeRaw`
      INSERT INTO "usage_rollups"
        ("id", "date", "hour", "channel", "accountId", "country", "provider", "attempted", "succeeded", "failed", "units", "revenueNgn", "costNgn", "finalisedAt", "updatedAt")
      SELECT gen_random_uuid()::text, t."date", t."hour", t."channel", t."accountId", t."country", t."provider",
             t."attempted", t."succeeded", t."failed", t."units", t."revenueNgn", t."costNgn", ${finalisedAt ?? null}::timestamp,
             (now() AT TIME ZONE 'UTC')
      FROM unnest(
        ${chunk.map((r) => dayString(r.date))}::date[], ${chunk.map((r) => r.hour)}::int[], ${chunk.map((r) => r.channel)}::text[],
        ${chunk.map((r) => r.accountId)}::text[], ${chunk.map((r) => r.country)}::text[], ${chunk.map((r) => r.provider)}::text[],
        ${chunk.map((r) => r.attempted.toString())}::bigint[], ${chunk.map((r) => r.succeeded.toString())}::bigint[],
        ${chunk.map((r) => r.failed.toString())}::bigint[], ${chunk.map((r) => r.units.toString())}::bigint[],
        ${chunk.map((r) => r.revenueNgn)}::numeric[], ${chunk.map((r) => r.costNgn)}::numeric[]
      ) AS t("date", "hour", "channel", "accountId", "country", "provider", "attempted", "succeeded", "failed", "units", "revenueNgn", "costNgn")
      ON CONFLICT ("date", "hour", "channel", "accountId", "country", "provider") DO UPDATE SET
        "attempted" = EXCLUDED."attempted", "succeeded" = EXCLUDED."succeeded", "failed" = EXCLUDED."failed", "units" = EXCLUDED."units",
        "revenueNgn" = EXCLUDED."revenueNgn", "costNgn" = EXCLUDED."costNgn",
        "finalisedAt" = COALESCE(EXCLUDED."finalisedAt", "usage_rollups"."finalisedAt"),
        "updatedAt" = (now() AT TIME ZONE 'UTC')`;
  }
}

// ---------------------------------------------------------------- destination_rollups

export interface DestinationRow {
  date: Date;
  channel: string;
  accountId: string;
  country: string;
  /** Never null here: an unknown network is stored as an empty string, so the unique key can match it. */
  network: string;
  attempted: bigint;
  delivered: bigint;
  costNgn: string;
}

export const mergeDestinations = (rows: DestinationRow[]): DestinationRow[] =>
  mergeByKey(
    rows,
    (r) =>
      [dayString(r.date), r.channel, r.accountId, r.country, r.network].join(
        '\u0000',
      ),
    (a, b) => ({
      ...a,
      attempted: a.attempted + b.attempted,
      delivered: a.delivered + b.delivered,
      costNgn: add(a.costNgn, b.costNgn),
    }),
  );

export async function upsertDestinationRows(
  db: RawExecutor,
  rows: DestinationRow[],
): Promise<void> {
  for (const chunk of chunked(mergeDestinations(rows), CHUNK)) {
    await db.$executeRaw`
      INSERT INTO "destination_rollups"
        ("id", "date", "channel", "accountId", "country", "network", "attempted", "delivered", "costNgn", "updatedAt")
      SELECT gen_random_uuid()::text, t."date", t."channel", t."accountId", t."country", t."network", t."attempted", t."delivered", t."costNgn",
             (now() AT TIME ZONE 'UTC')
      FROM unnest(
        ${chunk.map((r) => dayString(r.date))}::date[], ${chunk.map((r) => r.channel)}::text[], ${chunk.map((r) => r.accountId)}::text[],
        ${chunk.map((r) => r.country)}::text[], ${chunk.map((r) => r.network)}::text[],
        ${chunk.map((r) => r.attempted.toString())}::bigint[], ${chunk.map((r) => r.delivered.toString())}::bigint[],
        ${chunk.map((r) => r.costNgn)}::numeric[]
      ) AS t("date", "channel", "accountId", "country", "network", "attempted", "delivered", "costNgn")
      ON CONFLICT ("date", "channel", "accountId", "country", "network") DO UPDATE SET
        "attempted" = EXCLUDED."attempted", "delivered" = EXCLUDED."delivered", "costNgn" = EXCLUDED."costNgn",
        "updatedAt" = (now() AT TIME ZONE 'UTC')`;
  }
}

// ---------------------------------------------------------------- request_rollups

export interface RequestRow {
  date: Date;
  hour: number;
  /** '' for traffic with no key, or a key since deleted: kept rather than dropped, so the totals still add up. */
  accountId: string;
  endpoint: string;
  method: string;
  country: string;
  total: bigint;
  clientErrors: bigint;
  serverErrors: bigint;
}

export const mergeRequests = (rows: RequestRow[]): RequestRow[] =>
  mergeByKey(
    rows,
    (r) =>
      [
        dayString(r.date),
        r.hour,
        r.accountId,
        r.endpoint,
        r.method,
        r.country,
      ].join('\u0000'),
    (a, b) => ({
      ...a,
      total: a.total + b.total,
      clientErrors: a.clientErrors + b.clientErrors,
      serverErrors: a.serverErrors + b.serverErrors,
    }),
  );

export async function upsertRequestRows(
  db: RawExecutor,
  rows: RequestRow[],
): Promise<void> {
  for (const chunk of chunked(mergeRequests(rows), CHUNK)) {
    await db.$executeRaw`
      INSERT INTO "request_rollups"
        ("id", "date", "hour", "accountId", "endpoint", "method", "country", "total", "clientErrors", "serverErrors", "updatedAt")
      SELECT gen_random_uuid()::text, t."date", t."hour", t."accountId", t."endpoint", t."method", t."country",
             t."total", t."clientErrors", t."serverErrors", (now() AT TIME ZONE 'UTC')
      FROM unnest(
        ${chunk.map((r) => dayString(r.date))}::date[], ${chunk.map((r) => r.hour)}::int[], ${chunk.map((r) => r.accountId)}::text[],
        ${chunk.map((r) => r.endpoint)}::text[], ${chunk.map((r) => r.method)}::text[], ${chunk.map((r) => r.country)}::text[],
        ${chunk.map((r) => r.total.toString())}::bigint[], ${chunk.map((r) => r.clientErrors.toString())}::bigint[],
        ${chunk.map((r) => r.serverErrors.toString())}::bigint[]
      ) AS t("date", "hour", "accountId", "endpoint", "method", "country", "total", "clientErrors", "serverErrors")
      ON CONFLICT ("date", "hour", "accountId", "endpoint", "method", "country") DO UPDATE SET
        "total" = EXCLUDED."total", "clientErrors" = EXCLUDED."clientErrors", "serverErrors" = EXCLUDED."serverErrors",
        "updatedAt" = (now() AT TIME ZONE 'UTC')`;
  }
}
