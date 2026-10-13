import { redisOptionsFromUrl } from './redis-url';

describe('redisOptionsFromUrl', () => {
  it('reads host, port, password and the database index', () => {
    expect(
      redisOptionsFromUrl('redis://:s3cret@10.0.0.5:6379/1'),
    ).toMatchObject({
      host: '10.0.0.5',
      port: 6379,
      password: 's3cret',
      db: 1,
      tls: undefined,
    });
  });

  it('defaults the port and leaves the database alone when none is given', () => {
    const o = redisOptionsFromUrl('redis://:pw@redis.internal');
    expect(o.port).toBe(6379);
    expect(o.db).toBeUndefined();
  });

  it('turns TLS on for rediss://', () => {
    expect(redisOptionsFromUrl('rediss://:pw@host:6380').tls).toEqual({});
  });

  it('decodes a percent-encoded password', () => {
    expect(redisOptionsFromUrl('redis://:p%40ss%2Fword@h:6379').password).toBe(
      'p@ss/word',
    );
  });
});
