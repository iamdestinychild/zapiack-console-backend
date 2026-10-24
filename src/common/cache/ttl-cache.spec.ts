import { TtlCache, cacheKey } from './ttl-cache';

describe('TtlCache', () => {
  afterEach(() => jest.useRealTimers());

  it('serves a repeat call from memory until the ttl passes', async () => {
    jest.useFakeTimers();
    const cache = new TtlCache<number>(1_000);
    const load = jest.fn(() => Promise.resolve(1));

    await cache.get('a', load);
    await cache.get('a', load);
    expect(load).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1_001);
    await cache.get('a', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shares one load between concurrent callers', async () => {
    const cache = new TtlCache<number>(1_000);
    const load = jest.fn(() => Promise.resolve(7));
    await Promise.all([cache.get('a', load), cache.get('a', load)]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed load', async () => {
    const cache = new TtlCache<number>(1_000);
    await expect(
      cache.get('a', () => Promise.reject(new Error('down'))),
    ).rejects.toThrow('down');
    await expect(cache.get('a', () => Promise.resolve(2))).resolves.toBe(2);
  });

  it('stays within its size bound', async () => {
    const cache = new TtlCache<number>(60_000, 2);
    for (const k of ['a', 'b', 'c'])
      await cache.get(k, () => Promise.resolve(1));
    const load = jest.fn(() => Promise.resolve(1));
    await cache.get('a', load); // oldest was evicted
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('cacheKey', () => {
  it('ignores key order and undefined fields', () => {
    expect(cacheKey({ a: 1, b: undefined, c: 2 })).toBe(
      cacheKey({ c: 2, a: 1 }),
    );
  });
});
