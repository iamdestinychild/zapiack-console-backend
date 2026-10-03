/**
 * Fail fast at boot rather than at the first request. Anything listed here has no
 * safe default: a missing JWT secret or S3 bucket is a security bug, not a warning.
 */
const REQUIRED_ALWAYS = [
  'ADMIN_DATABASE_URL',
  'ZAPIACK_READ_DATABASE_URL',
  'REDIS_URL',
];

const REQUIRED_IN_PRODUCTION = [
  'ADMIN_JWT_SECRET',
  'ADMIN_CORS_ORIGIN',
  'API_CORE_BASE_URL',
  'API_CORE_SERVICE_TOKEN',
  'API_CORE_SIGNING_SECRET',
  'S3_EXPORT_BUCKET',
  'SES_FROM_ADDRESS',
];

/**
 * Connection strings, and the schemes each may use. Checked at boot so a bad paste fails
 * here, with a message that NEVER repeats the value: a connection string carries its
 * password, and an unchecked one reaches ioredis or pg, whose errors echo their input
 * straight into the logs.
 */
const CONNECTION_URLS: Record<string, string[]> = {
  ADMIN_DATABASE_URL: ['postgres:', 'postgresql:'],
  ZAPIACK_READ_DATABASE_URL: ['postgres:', 'postgresql:'],
  ZAPIACK_WRITE_DATABASE_URL: ['postgres:', 'postgresql:'],
  REDIS_URL: ['redis:', 'rediss:'],
};

function describeBadUrl(
  name: string,
  value: string,
  schemes: string[],
): string | null {
  const expected = schemes.map((s) => `${s}//`).join(' or ');
  const problems: string[] = [];

  if (/\s/.test(value)) {
    // The usual cause: a provider's copy button gave a whole shell command.
    problems.push(
      'it contains whitespace, so it looks like a command (for example "redis-cli -u ...") rather than a bare URL',
    );
  }
  try {
    const url = new URL(value.trim());
    if (!schemes.includes(url.protocol)) {
      problems.push(`it must start with ${expected}`);
    } else if (!url.hostname) {
      problems.push('it has no host');
    }
  } catch {
    problems.push(
      `it is not a valid URL; it must look like ${expected}user:password@host:port`,
    );
  }

  return problems.length
    ? `${name} is malformed: ${[...new Set(problems)].join('; ')}. (The value is not shown because it contains a password.)`
    : null;
}

export function validateEnv(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const isProd = raw.NODE_ENV === 'production';
  const required = isProd
    ? [...REQUIRED_ALWAYS, ...REQUIRED_IN_PRODUCTION]
    : REQUIRED_ALWAYS;
  const missing = required.filter((key) => !raw[key]);

  if (missing.length) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`,
    );
  }

  const badUrls = Object.entries(CONNECTION_URLS)
    .filter(([name]) => typeof raw[name] === 'string' && raw[name])
    .map(([name, schemes]) =>
      describeBadUrl(name, raw[name] as string, schemes),
    )
    .filter((message): message is string => message !== null);
  if (badUrls.length) throw new Error(badUrls.join(' '));

  const secret = raw.ADMIN_JWT_SECRET as string | undefined;
  if (isProd && secret && secret.length < 32) {
    throw new Error('ADMIN_JWT_SECRET must be at least 32 characters');
  }

  return raw;
}
