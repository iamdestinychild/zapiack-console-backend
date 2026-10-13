/** A stand-in for ioredis that records what it was asked to do. */
const calls: { method: string; args: unknown[] }[] = [];
let failWith: Error | null = null;
let constructed: Record<string, unknown>[] = [];

jest.mock('ioredis', () => {
  return class FakeRedis {
    constructor(options: Record<string, unknown>) {
      constructed.push(options);
    }
    on() {
      return this;
    }
    del(...args: unknown[]) {
      calls.push({ method: 'del', args });
      return failWith ? Promise.reject(failWith) : Promise.resolve(1);
    }
    publish(...args: unknown[]) {
      calls.push({ method: 'publish', args });
      return failWith ? Promise.reject(failWith) : Promise.resolve(1);
    }
    quit() {
      return Promise.resolve('OK');
    }
  };
});

import { PRODUCT_CACHE, ProductCacheService } from './product-cache.service';

const service = (productDb = 0) =>
  new ProductCacheService({
    get: () => ({
      redis: {
        url: 'redis://:pw@10.0.0.5:6379/1',
        keyPrefix: 'admin-core:',
        productDb,
      },
    }),
  } as never);

beforeEach(() => {
  calls.length = 0;
  failWith = null;
  constructed = [];
});

describe('PRODUCT_CACHE', () => {
  // These are api-core's own key names. If api-core renames one, clearing it here stops
  // working without any error, so the names are pinned.
  it('uses exactly the keys and channel the customer app uses', () => {
    expect(PRODUCT_CACHE.senderId('proj1')).toBe('sender:proj1');
    expect(PRODUCT_CACHE.accountStatus('acc1')).toBe('account:acc1:status');
    expect(PRODUCT_CACHE.apiKey('zpk_abc')).toBe('apikey:zpk_abc');
    expect(PRODUCT_CACHE.accountEvents).toBe('account-events');
  });
});

describe('ProductCacheService', () => {
  it('clears the exact entry for each kind of change', async () => {
    const cache = service();
    await cache.invalidateSenderId('proj1');
    await cache.invalidateAccountStatus('acc1');
    await cache.invalidateApiKey('zpk_abc');
    expect(calls.map((c) => c.args[0])).toEqual([
      'sender:proj1',
      'account:acc1:status',
      'apikey:zpk_abc',
    ]);
  });

  it('connects to the customer app’s database, not admin-core’s own, with no key prefix', async () => {
    await service(0).invalidateSenderId('p');
    expect(constructed[0]).toMatchObject({
      db: 0,
      host: '10.0.0.5',
      password: 'pw',
    });
    expect(constructed[0]).not.toHaveProperty('keyPrefix');
  });

  it('honours a different product database', async () => {
    await service(3).invalidateSenderId('p');
    expect(constructed[0]).toMatchObject({ db: 3 });
  });

  it('opens one connection and reuses it', async () => {
    const cache = service();
    await cache.invalidateSenderId('a');
    await cache.invalidateAccountStatus('b');
    expect(constructed).toHaveLength(1);
  });

  it('does not connect at all until something needs it', () => {
    service();
    expect(constructed).toHaveLength(0);
  });

  it('tells an open dashboard to refresh its bell', async () => {
    await service().notifyUser('user1');
    expect(calls[0].args[0]).toBe('account-events');
    expect(JSON.parse(calls[0].args[1] as string)).toEqual({
      userId: 'user1',
      type: 'notification.created',
    });
  });

  it('reports success and failure, and never throws, because the database change has already landed', async () => {
    const cache = service();
    expect(await cache.invalidateAccountStatus('acc1')).toBe(true);

    failWith = new Error('ECONNREFUSED');
    await expect(cache.invalidateAccountStatus('acc1')).resolves.toBe(false);
    await expect(cache.invalidateApiKey('k')).resolves.toBe(false);
    await expect(cache.invalidateSenderId('p')).resolves.toBe(false);
    await expect(cache.notifyUser('u')).resolves.toBe(false);
  });
});
