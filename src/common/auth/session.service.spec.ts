import { SessionService } from './session.service';

/** An in-memory stand-in for the slice of ioredis the service uses. */
function fakeRedis() {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const sets = new Map<string, Set<string>>();
  return {
    key: (...p: (string | number)[]) => p.join(':'),
    client: {
      set: (k: string, v: string, _px: string, ttl: number) => {
        store.set(k, { value: v, expiresAt: Date.now() + ttl });
        return Promise.resolve('OK');
      },
      get: (k: string) => {
        const hit = store.get(k);
        return Promise.resolve(
          hit && hit.expiresAt > Date.now() ? hit.value : null,
        );
      },
      del: (k: string) => Promise.resolve(store.delete(k) ? 1 : 0),
      sadd: (k: string, v: string) => {
        sets.set(k, (sets.get(k) ?? new Set()).add(v));
        return Promise.resolve(1);
      },
      srem: () => Promise.resolve(1),
      smembers: (k: string) => Promise.resolve([...(sets.get(k) ?? [])]),
    },
    ttlOf: (k: string) => (store.get(k)?.expiresAt ?? 0) - Date.now(),
  };
}

const service = (idle: number, absolute = 43_200) => {
  const redis = fakeRedis();
  const config = {
    get: () => ({
      session: { idleTimeoutSeconds: idle, absoluteLifetimeSeconds: absolute },
    }),
  };
  return {
    redis,
    sessions: new SessionService(redis as never, config as never),
  };
};

describe('SessionService', () => {
  it('keeps a session awaiting 2FA alive for at least ten minutes, whatever the idle window', async () => {
    const { redis, sessions } = service(300);
    const s = await sessions.create({
      staffId: 'st',
      sessionEpoch: 0,
      mfaVerified: false,
    });
    expect(redis.ttlOf(`session:${s.sessionId}`)).toBeGreaterThan(9 * 60_000);
  });

  it('uses the idle window once the second factor is verified', async () => {
    const { redis, sessions } = service(300);
    const s = await sessions.create({
      staffId: 'st',
      sessionEpoch: 0,
      mfaVerified: true,
    });
    expect(redis.ttlOf(`session:${s.sessionId}`)).toBeLessThanOrEqual(300_000);
  });

  it('refuses to store an already-expired session rather than failing later', async () => {
    const { sessions } = service(300, 0);
    await expect(
      sessions.create({ staffId: 'st', sessionEpoch: 0, mfaVerified: false }),
    ).rejects.toThrow(/already expired/);
  });

  it('firstLive skips a stale id and returns the live session', async () => {
    const { sessions } = service(1800);
    const s = await sessions.create({
      staffId: 'st',
      sessionEpoch: 0,
      mfaVerified: false,
    });
    const found = await sessions.firstLive(['stale', s.sessionId]);
    expect(found?.sessionId).toBe(s.sessionId);
    expect(await sessions.firstLive(['stale'])).toBeNull();
  });
});
