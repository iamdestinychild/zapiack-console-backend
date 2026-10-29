import {
  RawExecutor,
  UsageRow,
  dayString,
  mergeByKey,
  mergeDestinations,
  mergeRequests,
  mergeUsage,
  upsertDestinationRows,
  upsertRequestRows,
  upsertUsageRows,
} from './bulk-upsert';

const day = new Date('2026-10-27T00:00:00.000Z');

/** Records each statement: its SQL text and its parameters. */
function recorder() {
  const calls: { sql: string; values: unknown[] }[] = [];
  const db: RawExecutor = {
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({
        sql: strings.join('?').replace(/\s+/g, ' ').trim(),
        values,
      });
      return Promise.resolve(0);
    },
  };
  return { db, calls };
}

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
  revenueNgn: '12.5000',
  costNgn: '0',
  ...over,
});

describe('dayString', () => {
  it('is the calendar day of a date held at midnight UTC, whatever the machine timezone', () => {
    expect(dayString(new Date('2026-10-27T00:00:00.000Z'))).toBe('2026-10-27');
    expect(dayString(new Date('2026-01-01T00:00:00.000Z'))).toBe('2026-01-01');
  });
});

describe('merging rows that share a key', () => {
  it('keeps one row per key and adds the counts, instead of letting the last one win', () => {
    const rows = mergeRequests([
      {
        date: day,
        hour: 1,
        accountId: 'a',
        endpoint: '/v1/sms',
        method: 'POST',
        country: 'NG',
        total: 5n,
        clientErrors: 1n,
        serverErrors: 0n,
      },
      // The same account's second API key.
      {
        date: day,
        hour: 1,
        accountId: 'a',
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
        accountId: 'b',
        endpoint: '/v1/sms',
        method: 'POST',
        country: 'NG',
        total: 1n,
        clientErrors: 0n,
        serverErrors: 0n,
      },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.accountId === 'a')).toMatchObject({
      total: 12n,
      clientErrors: 1n,
      serverErrors: 2n,
    });
    expect(rows.find((r) => r.accountId === 'b')).toMatchObject({ total: 1n });
  });

  it('adds money exactly (no floating point)', () => {
    const [row] = mergeUsage([
      usage({ revenueNgn: '0.1000' }),
      usage({ revenueNgn: '0.2000' }),
    ]);
    expect(row.revenueNgn).toBe('0.3');
    expect(row.attempted).toBe(20n);
  });

  it('treats different hours, channels, countries and networks as different rows', () => {
    expect(
      mergeUsage([
        usage(),
        usage({ hour: 10 }),
        usage({ channel: 'EMAIL' }),
        usage({ country: 'GH' }),
        usage({ provider: 'airtel' }),
      ]),
    ).toHaveLength(5);
    const dest = (network: string) => ({
      date: day,
      channel: 'SMS',
      accountId: 'a',
      country: 'NG',
      network,
      attempted: 1n,
      delivered: 1n,
      costNgn: '0',
    });
    expect(mergeDestinations([dest('mtn'), dest('airtel')])).toHaveLength(2);
    expect(mergeDestinations([dest(''), dest('')])).toHaveLength(1);
  });

  it("keeps the first row's other fields and the order of first appearance", () => {
    const out = mergeByKey(
      [
        { k: 'a', v: 1 },
        { k: 'b', v: 2 },
        { k: 'a', v: 3 },
      ],
      (r) => r.k,
      (a, b) => ({ ...a, v: a.v + b.v }),
    );
    expect(out).toEqual([
      { k: 'a', v: 4 },
      { k: 'b', v: 2 },
    ]);
  });
});

describe('writing in bulk', () => {
  it('is one statement for a small batch, with every column as an array of the same length', async () => {
    const { db, calls } = recorder();
    await upsertUsageRows(db, [
      usage(),
      usage({ hour: 10 }),
      usage({ hour: 11 }),
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('INSERT INTO "usage_rollups"');
    expect(calls[0].sql).toContain(
      'ON CONFLICT ("date", "hour", "channel", "accountId", "country", "provider") DO UPDATE',
    );
    const arrays = calls[0].values.filter(Array.isArray) as unknown[][];
    expect(arrays).toHaveLength(12);
    expect(new Set(arrays.map((a) => a.length))).toEqual(new Set([3]));
    expect(arrays[0]).toEqual(['2026-10-27', '2026-10-27', '2026-10-27']);
  });

  it('sends 500 rows at a time, so a busy day is never one enormous statement', async () => {
    const { db, calls } = recorder();
    const rows = Array.from({ length: 1230 }, (_, i) =>
      usage({ accountId: `a-${i}` }),
    );
    await upsertUsageRows(db, rows);
    expect(
      calls.map((c) => (c.values.find(Array.isArray) as unknown[]).length),
    ).toEqual([500, 500, 230]);
  });

  it('writes nothing for nothing', async () => {
    const { db, calls } = recorder();
    await upsertUsageRows(db, []);
    await upsertDestinationRows(db, []);
    await upsertRequestRows(db, []);
    expect(calls).toHaveLength(0);
  });

  it('stamps finalisedAt when given, and otherwise leaves an existing stamp alone', async () => {
    const { db, calls } = recorder();
    const stamp = new Date('2026-10-28T00:15:00.000Z');
    await upsertUsageRows(db, [usage()], stamp);
    await upsertUsageRows(db, [usage()]);
    expect(calls[0].values).toContain(stamp);
    expect(calls[1].values).toContain(null);
    expect(calls[1].sql).toContain(
      'COALESCE(EXCLUDED."finalisedAt", "usage_rollups"."finalisedAt")',
    );
  });

  it('passes bigint and decimal values as text parameters, never inside the SQL', async () => {
    const { db, calls } = recorder();
    await upsertUsageRows(db, [
      usage({ attempted: 9007199254740993n, revenueNgn: '123456.7890' }),
    ]);
    expect(calls[0].values).toContainEqual(['9007199254740993']);
    expect(calls[0].values).toContainEqual(['123456.7890']);
    expect(calls[0].sql).not.toContain('9007199254740993');
  });

  it('writes destinations and requests to their own tables with their own keys', async () => {
    const { db, calls } = recorder();
    await upsertDestinationRows(db, [
      {
        date: day,
        channel: 'SMS',
        accountId: 'a',
        country: 'NG',
        network: '',
        attempted: 1n,
        delivered: 1n,
        costNgn: '0',
      },
    ]);
    await upsertRequestRows(db, [
      {
        date: day,
        hour: 1,
        accountId: '',
        endpoint: '/x',
        method: 'GET',
        country: 'NG',
        total: 1n,
        clientErrors: 0n,
        serverErrors: 0n,
      },
    ]);
    expect(calls[0].sql).toContain('INSERT INTO "destination_rollups"');
    expect(calls[0].sql).toContain(
      'ON CONFLICT ("date", "channel", "accountId", "country", "network")',
    );
    expect(calls[1].sql).toContain('INSERT INTO "request_rollups"');
    expect(calls[1].sql).toContain(
      'ON CONFLICT ("date", "hour", "accountId", "endpoint", "method", "country")',
    );
  });
});
