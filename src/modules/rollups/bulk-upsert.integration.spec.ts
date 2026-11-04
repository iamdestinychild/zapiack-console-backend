import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/admin/client';
import { RollupsService } from './rollups.service';
import {
  UsageRow,
  upsertDestinationRows,
  upsertRequestRows,
  upsertUsageRows,
} from './bulk-upsert';

/**
 * The bulk writers against a real Postgres: what they write must be exactly what the per-row `upsert` wrote, and writing
 * the same rows with new totals again and again must not grow the process. Run with a scratch database that has the admin
 * schema (`prisma db push`):
 *
 *   ROLLUPS_IT=1 ADMIN_DATABASE_URL=postgresql://... NODE_OPTIONS="--expose-gc --experimental-vm-modules" npx jest bulk-upsert.integration
 */
const suite = process.env['ROLLUPS_IT'] ? describe : describe.skip;

suite('bulk rollup writes against Postgres', () => {
  jest.setTimeout(180_000);
  const prisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env['ADMIN_DATABASE_URL'],
      max: 5,
    }),
  });
  const day = new Date('2026-10-27T00:00:00.000Z');
  const usage = (over: Partial<UsageRow> = {}): UsageRow => ({
    date: day,
    hour: 9,
    channel: 'SMS',
    accountId: 'acct-1',
    country: 'NG',
    provider: 'mtn',
    attempted: 10n,
    succeeded: 8n,
    failed: 2n,
    units: 10n,
    revenueNgn: '12.5',
    costNgn: '0',
    ...over,
  });

  beforeEach(async () => {
    await prisma.usageRollup.deleteMany();
    await prisma.destinationRollup.deleteMany();
    await prisma.requestRollup.deleteMany();
  });
  afterAll(() => prisma.$disconnect());

  it('creates rows, then replaces their totals on the next run (never adds to them)', async () => {
    await upsertUsageRows(prisma, [
      usage(),
      usage({ hour: 10, attempted: 3n }),
    ]);
    await upsertUsageRows(prisma, [
      usage({
        attempted: 99n,
        succeeded: 90n,
        failed: 9n,
        units: 99n,
        revenueNgn: '200.1234',
      }),
    ]);
    const rows = await prisma.usageRollup.findMany({
      orderBy: { hour: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      hour: 9,
      attempted: 99n,
      succeeded: 90n,
      failed: 9n,
      units: 99n,
      planId: null,
    });
    expect(rows[0].revenueNgn.toString()).toBe('200.1234');
    expect(rows[1]).toMatchObject({ hour: 10, attempted: 3n });
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    expect(rows[0].date.toISOString()).toBe('2026-10-27T00:00:00.000Z');
  });

  it('a daily write stamps finalisedAt; an hourly rewrite afterwards does not clear it', async () => {
    const stamp = new Date('2026-10-28T00:15:00.000Z');
    await upsertUsageRows(prisma, [usage({ hour: -1 })], stamp);
    await upsertUsageRows(prisma, [usage({ hour: -1, attempted: 11n })]);
    const row = await prisma.usageRollup.findFirstOrThrow({
      where: { hour: -1 },
    });
    expect(row.finalisedAt?.toISOString()).toBe(stamp.toISOString());
    expect(row.attempted).toBe(11n);
    const fresh = await upsertUsageRows(prisma, [usage({ hour: 3 })]).then(() =>
      prisma.usageRollup.findFirstOrThrow({ where: { hour: 3 } }),
    );
    expect(fresh.finalisedAt).toBeNull();
  });

  it('stamps updatedAt in UTC, as Prisma does, whatever timezone the database session uses', async () => {
    await upsertUsageRows(prisma, [usage()]);
    const row = await prisma.usageRollup.findFirstOrThrow();
    expect(Math.abs(row.updatedAt.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('adds up two API keys of one account instead of letting the last win, and keeps the unattributed row', async () => {
    const req = (accountId: string, total: bigint) => ({
      date: day,
      hour: 1,
      accountId,
      endpoint: '/v1/sms',
      method: 'POST',
      country: 'NG',
      total,
      clientErrors: 1n,
      serverErrors: 0n,
    });
    await upsertRequestRows(prisma, [req('a', 5n), req('a', 7n), req('', 2n)]);
    const rows = await prisma.requestRollup.findMany({
      orderBy: { accountId: 'desc' },
    });
    expect(rows.map((r) => [r.accountId, r.total, r.clientErrors])).toEqual([
      ['a', 12n, 2n],
      ['', 2n, 1n],
    ]);
    await upsertRequestRows(prisma, [req('a', 1n)]);
    expect(
      (
        await prisma.requestRollup.findFirstOrThrow({
          where: { accountId: 'a' },
        })
      ).total,
    ).toBe(1n);
  });

  it('destinations: an unknown network is stored as an empty string and matches itself next time', async () => {
    const dest = (network: string, attempted: bigint) => ({
      date: day,
      channel: 'SMS',
      accountId: 'a',
      country: 'NG',
      network,
      attempted,
      delivered: attempted,
      costNgn: '1.5',
    });
    await upsertDestinationRows(prisma, [dest('', 4n), dest('mtn', 6n)]);
    await upsertDestinationRows(prisma, [dest('', 40n)]);
    const rows = await prisma.destinationRollup.findMany({
      orderBy: { network: 'asc' },
    });
    expect(rows.map((r) => [r.network, r.attempted])).toEqual([
      ['', 40n],
      ['mtn', 6n],
    ]);
  });

  it('the real rollRequests: two API keys of one account are added together, unattributed traffic is kept, a re-run replaces', async () => {
    const source = [
      {
        date: day,
        hour: 1,
        apiKeyPrefix: 'zk_aaa',
        endpoint: '/v1/sms',
        method: 'POST',
        country: 'NG',
        total: 5n,
        clientErrors: 1n,
        serverErrors: 0n,
      },
      {
        date: day,
        hour: 1,
        apiKeyPrefix: 'zk_bbb',
        endpoint: '/v1/sms',
        method: 'POST',
        country: 'NG',
        total: 7n,
        clientErrors: 0n,
        serverErrors: 2n,
      },
      {
        date: day,
        hour: 1,
        apiKeyPrefix: null,
        endpoint: '/v1/sms',
        method: 'POST',
        country: 'NG',
        total: 2n,
        clientErrors: 0n,
        serverErrors: 0n,
      },
      {
        date: day,
        hour: 2,
        apiKeyPrefix: 'zk_gone',
        endpoint: '/v1/sms',
        method: 'POST',
        country: 'NG',
        total: 1n,
        clientErrors: 0n,
        serverErrors: 0n,
      },
    ];
    const zapiack = {
      read: {
        $queryRaw: () => Promise.resolve(source),
        apiKeys: {
          findMany: () =>
            Promise.resolve([
              { keyPrefix: 'zk_aaa', accountId: 'acct-1' },
              { keyPrefix: 'zk_bbb', accountId: 'acct-1' },
            ]),
        },
      },
    };
    const rollups = new RollupsService(prisma as never, zapiack as never);
    expect(
      await rollups.rollRequests(day, new Date(day.getTime() + 86_400_000)),
    ).toBe(4);
    await rollups.rollRequests(day, new Date(day.getTime() + 86_400_000));
    const rows = await prisma.requestRollup.findMany({
      orderBy: [{ hour: 'asc' }, { accountId: 'desc' }],
    });
    expect(
      rows.map((r) => [
        r.hour,
        r.accountId,
        r.total,
        r.clientErrors,
        r.serverErrors,
      ]),
    ).toEqual([
      [1, 'acct-1', 12n, 1n, 2n],
      [1, '', 2n, 0n, 0n],
      [2, '', 1n, 0n, 0n],
    ]);
  });

  it('writing the same rows with new totals again and again does not grow the process (the leak this replaced)', async () => {
    const gc = (globalThis as { gc?: () => void }).gc;
    if (!gc)
      return console.warn(
        'run with --expose-gc and --experimental-vm-modules to check memory',
      );
    const rows = Array.from({ length: 1500 }, (_, i) =>
      usage({
        hour: i % 24,
        accountId: `acct-${Math.floor(i / 72)}`,
        channel: ['SMS', 'EMAIL', 'WHATSAPP'][i % 3],
        country: ['NG', 'GH', 'KE', 'UNKNOWN'][i % 4],
        provider: `p${i % 7}`,
      }),
    );
    const heap = () => (gc(), gc(), process.memoryUsage().heapUsed / 1048576);
    await upsertUsageRows(prisma, rows);
    const before = heap();
    for (let run = 1; run <= 20; run++) {
      await upsertUsageRows(
        prisma,
        rows.map((r) => ({
          ...r,
          attempted: r.attempted + BigInt(run),
          revenueNgn: String(run * 1.37),
        })),
      );
    }
    // `upsert` per row grew this by about 30 MB per run (600 MB over 20 runs).
    expect(heap() - before).toBeLessThan(25);
  });
});
