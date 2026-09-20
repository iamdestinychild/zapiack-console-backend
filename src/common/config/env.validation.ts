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
  'S3_SENDER_ID_BUCKET',
  'S3_EXPORT_BUCKET',
  'SES_FROM_ADDRESS',
];

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

  const secret = raw.ADMIN_JWT_SECRET as string | undefined;
  if (isProd && secret && secret.length < 32) {
    throw new Error('ADMIN_JWT_SECRET must be at least 32 characters');
  }

  return raw;
}
