import { ActivityTailWorker } from './activity-tail.worker';

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A poll the test can hold open, to see what a second tick does while it is running. */
function build() {
  let release!: (rows: unknown[]) => void;
  let calls = 0;
  const published: unknown[] = [];
  const state = { viewers: true };

  const zapiack = {
    read: {
      apiActivityLog: {
        findMany: () => {
          calls += 1;
          return new Promise<unknown[]>((resolve) => {
            release = resolve;
          });
        },
      },
    },
  };
  const sse = {
    hasViewers: () => Promise.resolve(state.viewers),
    publish: (_c: string, _e: string, data: unknown) => {
      published.push(data);
      return Promise.resolve();
    },
  };
  const config = {
    get: () => ({
      limits: { liveMapEventsPerSecond: 50, liveMapPollSeconds: 3 },
    }),
  };

  const worker = new ActivityTailWorker(
    zapiack as never,
    sse as never,
    config as never,
  );
  (worker as unknown as { running: boolean }).running = true;

  return {
    worker,
    tick: () => (worker as unknown as { tick: () => Promise<void> }).tick(),
    calls: () => calls,
    // The tick checks for viewers before it queries, so let that settle first.
    finish: async (rows: unknown[] = []) => {
      await flush();
      release(rows);
    },
    state,
    flush,
    published,
  };
}

const row = (n: number) => ({
  createdAt: new Date(Date.UTC(2026, 9, 15, 10, 0, n)),
  endpoint: '/v1/x',
  method: 'GET',
  statusCode: 200,
  countryCode: 'NG',
  city: 'Lagos',
  region: 'Lagos',
  ip: '10.0.0.1',
  service: 'api',
  projectId: 'p',
});

describe('ActivityTailWorker polling', () => {
  it('does not start a second poll while the first is still running', async () => {
    const h = build();

    const first = h.tick();
    await h.flush();
    await h.tick();
    await h.tick();

    expect(h.calls()).toBe(1);

    await h.finish();
    await first;
  });

  it('polls again once the previous poll has finished', async () => {
    const h = build();

    const first = h.tick();
    await h.finish();
    await first;

    const second = h.tick();
    await h.flush();
    expect(h.calls()).toBe(2);
    await h.finish();
    await second;
  });

  it('is not left blocked by a poll that fails', async () => {
    const h = build();
    const failing = (
      h.worker as unknown as {
        zapiack: { read: { apiActivityLog: { findMany: () => never } } };
      }
    ).zapiack;
    failing.read.apiActivityLog.findMany = () => {
      throw new Error('db down');
    };

    await h.tick();
    // The same worker can poll again.
    const next = h.tick();
    await next;
    expect((h.worker as unknown as { inFlight: boolean }).inFlight).toBe(false);
  });

  it('publishes what a poll found, and advances past it', async () => {
    const h = build();

    const poll = h.tick();
    await h.finish([row(1), row(2)]);
    await poll;

    expect(h.published).toHaveLength(1);
    expect((h.published[0] as unknown[]).length).toBe(2);
    expect(
      (h.worker as unknown as { watermark: Date }).watermark.toISOString(),
    ).toBe(row(2).createdAt.toISOString());
  });

  it('does not query at all while nobody has the map open', async () => {
    const h = build();
    h.state.viewers = false;

    await h.tick();

    expect(h.calls()).toBe(0);
    expect(h.published).toHaveLength(0);
    // The idle period is skipped, not replayed to the next viewer.
    expect(
      (h.worker as unknown as { watermark: Date }).watermark.getTime(),
    ).toBeGreaterThan(Date.now() - 5_000);
  });
});
