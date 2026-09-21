import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';

/**
 * These guard a bug that cost real debugging time: ioredis applies `keyPrefix` to
 * keys but NOT to pub/sub channels. Publishing with a bare name while subscribing
 * with a prefixed pattern delivers nothing, silently, and no test that only checks
 * HTTP status codes will notice.
 */
describe('RedisService namespacing', () => {
  const config = {
    get: () => ({
      redis: { url: 'redis://localhost:6379', keyPrefix: 'admin-core:' },
    }),
  } as unknown as ConfigService<never, true>;

  // The constructor opens a connection; close it rather than leak a handle per test.
  let service: RedisService;

  beforeEach(() => {
    service = new RedisService(config);
  });

  afterEach(() => {
    service.client.disconnect();
  });

  it('leaves keys unprefixed, because the client prefixes them', () => {
    // Prepending the prefix here too is what produced admin-core:admin-core:… in
    // the request-ingest worker.
    expect(service.key('session', 'abc')).toBe('session:abc');
  });

  it('writes the namespace into pub/sub channels by hand', () => {
    expect(service.channel('sse', 'geo:live')).toBe('admin-core:sse:geo:live');
  });

  it('builds a subscribe pattern that matches what publish produces', () => {
    const pattern = service.channel('sse', '*');
    const published = service.channel('sse', 'geo:live');

    expect(pattern).toBe('admin-core:sse:*');
    // The glob the subscriber registers must cover the exact channel published to.
    const asRegex = new RegExp(`^${pattern.replace('*', '.*')}$`);
    expect(published).toMatch(asRegex);
  });

  it('recovers the bare channel name from a prefixed one', () => {
    const published = service.channel('sse', 'staff:abc');
    expect(published.slice(service.channel('sse', '').length)).toBe(
      'staff:abc',
    );
  });

  it('fully qualifies a stream key for connections carrying no prefix', () => {
    // api-core must XADD to exactly this key.
    expect(service.streamKey('stream:request.logged')).toBe(
      'admin-core:stream:request.logged',
    );
  });
});
