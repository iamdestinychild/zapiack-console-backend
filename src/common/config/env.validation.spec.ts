import { validateEnv } from './env.validation';

const base = {
  ADMIN_DATABASE_URL:
    'postgresql://u:p@db.example.com:5432/admin?sslmode=require',
  ZAPIACK_READ_DATABASE_URL: 'postgresql://r:p@db.example.com/product',
  REDIS_URL: 'redis://default:s3cret@cache.example.com:6379',
};

describe('validateEnv connection strings', () => {
  it('accepts well-formed URLs, including a TLS Redis and an empty username', () => {
    expect(() => validateEnv(base)).not.toThrow();
    expect(() =>
      validateEnv({
        ...base,
        REDIS_URL: 'rediss://:pw@cache.example.com:6380',
      }),
    ).not.toThrow();
  });

  /** The real failure: a provider's copy button handed over a shell command. */
  it('rejects a pasted redis-cli command, and never repeats its password', () => {
    const pasted =
      'redis://redis-cli -u redis://default:Hunter2Hunter2@redis-1.example.com:11799';
    let message = '';
    try {
      validateEnv({ ...base, REDIS_URL: pasted });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/REDIS_URL is malformed/);
    expect(message).toMatch(/looks like a command/);
    expect(message).not.toContain('Hunter2Hunter2');
    expect(message).not.toContain('redis-1.example.com');
  });

  it('rejects the wrong scheme for each connection string', () => {
    expect(() =>
      validateEnv({ ...base, REDIS_URL: 'http://cache.example.com' }),
    ).toThrow(/must start with redis:\/\/ or rediss:\/\//);
    expect(() =>
      validateEnv({
        ...base,
        ADMIN_DATABASE_URL: 'mysql://u:p@db.example.com/x',
      }),
    ).toThrow(/ADMIN_DATABASE_URL is malformed/);
  });

  it('reports every bad URL at once, not one per deploy', () => {
    let message = '';
    try {
      validateEnv({
        ...base,
        REDIS_URL: 'not a url',
        ADMIN_DATABASE_URL: 'nope',
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/ADMIN_DATABASE_URL is malformed/);
    expect(message).toMatch(/REDIS_URL is malformed/);
  });

  it('still reports missing variables first', () => {
    expect(() =>
      validateEnv({ ADMIN_DATABASE_URL: base.ADMIN_DATABASE_URL }),
    ).toThrow(
      /Missing required environment variables: ZAPIACK_READ_DATABASE_URL, REDIS_URL/,
    );
  });
});
