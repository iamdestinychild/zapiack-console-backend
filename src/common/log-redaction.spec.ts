import { collectSecrets, createRedactor } from './log-redaction';

describe('log redaction', () => {
  const env = {
    REDIS_URL: 'redis://default:Sup3rS3cretPw@cache.example.com:6379',
    ADMIN_DATABASE_URL:
      'postgresql://owner:p%40ss%3Aword99@db.example.com/admin',
    ADMIN_JWT_SECRET: 'a-long-session-signing-secret-value',
    AWS_SECRET_ACCESS_KEY: 'aws-secret-abcdef123456',
    ADMIN_TIMEZONE: 'Africa/Lagos',
    PORT: '3001',
  };

  it('collects the password out of each connection string and the plain secrets', () => {
    const secrets = collectSecrets(env);
    expect(secrets).toEqual(
      expect.arrayContaining([
        'Sup3rS3cretPw',
        'p@ss:word99',
        'a-long-session-signing-secret-value',
        'aws-secret-abcdef123456',
      ]),
    );
    expect(secrets).not.toContain('Africa/Lagos');
    expect(secrets).not.toContain('3001');
  });

  it('removes a secret from a printed error, in both its decoded and encoded forms', () => {
    const redact = createRedactor(collectSecrets(env));
    const printed =
      "ReplyError: WRONGPASS { command: { name: 'hello', args: [ 'AUTH', 'default', 'Sup3rS3cretPw' ] } } " +
      'connecting as postgresql://owner:p%40ss%3Aword99@db.example.com and p@ss:word99';
    const cleaned = redact(printed);
    expect(cleaned).not.toContain('Sup3rS3cretPw');
    expect(cleaned).not.toContain('p@ss:word99');
    expect(cleaned).not.toContain('p%40ss%3Aword99');
    // The diagnosis survives; only the credential goes.
    expect(cleaned).toContain('WRONGPASS');
    expect(cleaned).toContain('[redacted]');
  });

  it('treats an unparseable connection string as wholly secret', () => {
    // The real incident: a pasted shell command, password inside it.
    const pasted = 'redis://redis-cli -u redis://default:HiddenPw99@host:11799';
    const redact = createRedactor(collectSecrets({ REDIS_URL: pasted }));
    expect(redact(`input: '${pasted}'`)).not.toContain('HiddenPw99');
  });

  it('ignores short values rather than mangling ordinary words in every log line', () => {
    expect(
      collectSecrets({ API_TOKEN: 'abc', ADMIN_X_PASSWORD: '12345' }),
    ).toEqual([]);
  });

  it('does nothing when there is nothing to hide', () => {
    expect(createRedactor([])('plain text stays plain')).toBe(
      'plain text stays plain',
    );
  });
});
