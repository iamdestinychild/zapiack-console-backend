/**
 * Every setting admin-core reads. Secrets come from the environment or a secrets
 * manager — never from the repo.
 */
export interface AdminConfig {
  env: 'development' | 'test' | 'staging' | 'production';
  port: number;
  /** The console origin; CORS allows this and nothing else. */
  corsOrigin: string[];
  timezone: string;

  database: {
    adminUrl: string;
    /** Read replica, SELECT-only role. */
    zapiackReadUrl: string;
    poolMax: number;
  };

  redis: {
    url: string;
    /** Distinct from the customer app so no key or token can be shared. */
    keyPrefix: string;
  };

  session: {
    /** Distinct cookie names so a customer token can never satisfy an admin guard. */
    accessCookie: string;
    refreshCookie: string;
    csrfCookie: string;
    jwtSecret: string;
    accessTtlSeconds: number;
    refreshTtlSeconds: number;
    absoluteLifetimeSeconds: number;
    idleTimeoutSeconds: number;
    cookieDomain?: string;
    secureCookies: boolean;
  };

  auth: {
    maxFailedLogins: number;
    lockoutMinutes: number;
    inviteTtlHours: number;
    totpIssuer: string;
    impersonationMinutes: number;
  };

  limits: {
    /** Credit adjustments above this need a second approver. */
    creditApprovalThresholdNgn: number;
    /** Broadcasts above this need super admin approval. */
    broadcastApprovalThreshold: number;
    documentUrlTtlSeconds: number;
    exportTtlHours: number;
    requestLogRetentionDays: number;
    liveMapEventsPerSecond: number;
    reconciliationVariancePct: number;
    rollupLagAlertMinutes: number;
  };

  apiCore: {
    baseUrl: string;
    /** Service token plus request signing; api-core owns every product write. */
    serviceToken: string;
    signingSecret: string;
    timeoutMs: number;
  };

  s3: {
    region: string;
    senderIdBucket: string;
    /** IAM role is scoped to this prefix, read-only. */
    senderIdPrefix: string;
    exportBucket: string;
    exportPrefix: string;
  };

  geoip: {
    /** Local MaxMind GeoLite2 City database, refreshed weekly. No per-request third-party call. */
    cityDbPath: string;
    asnDbPath?: string;
  };

  mail: {
    sesRegion: string;
    fromAddress: string;
    replyTo?: string;
  };

  smsCore: {
    baseUrl: string;
    apiKey: string;
    /** The console dogfoods the product; sends are accounted as internal usage. */
    senderId: string;
  };
}

const bool = (v: string | undefined, fallback: boolean) =>
  v === undefined ? fallback : ['1', 'true', 'yes'].includes(v.toLowerCase());
const int = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export default (): AdminConfig => ({
  env: (process.env.NODE_ENV as AdminConfig['env']) ?? 'development',
  port: int(process.env.PORT, 3001),
  corsOrigin: list(process.env.ADMIN_CORS_ORIGIN ?? 'http://localhost:3000'),
  timezone: process.env.ADMIN_TIMEZONE ?? 'Africa/Lagos',

  database: {
    adminUrl: process.env.ADMIN_DATABASE_URL ?? '',
    zapiackReadUrl: process.env.ZAPIACK_READ_DATABASE_URL ?? '',
    poolMax: int(process.env.DB_POOL_MAX, 10),
  },

  redis: {
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
    keyPrefix: process.env.REDIS_KEY_PREFIX ?? 'admin-core:',
  },

  session: {
    accessCookie: process.env.ADMIN_ACCESS_COOKIE ?? 'zpk_admin_at',
    refreshCookie: process.env.ADMIN_REFRESH_COOKIE ?? 'zpk_admin_rt',
    csrfCookie: process.env.ADMIN_CSRF_COOKIE ?? 'zpk_admin_csrf',
    jwtSecret: process.env.ADMIN_JWT_SECRET ?? '',
    accessTtlSeconds: int(process.env.ADMIN_ACCESS_TTL, 15 * 60),
    refreshTtlSeconds: int(process.env.ADMIN_REFRESH_TTL, 12 * 60 * 60),
    absoluteLifetimeSeconds: int(
      process.env.ADMIN_SESSION_ABSOLUTE_TTL,
      12 * 60 * 60,
    ),
    idleTimeoutSeconds: int(process.env.ADMIN_SESSION_IDLE_TTL, 30 * 60),
    cookieDomain: process.env.ADMIN_COOKIE_DOMAIN || undefined,
    secureCookies: bool(
      process.env.ADMIN_SECURE_COOKIES,
      process.env.NODE_ENV === 'production',
    ),
  },

  auth: {
    maxFailedLogins: int(process.env.ADMIN_MAX_FAILED_LOGINS, 5),
    lockoutMinutes: int(process.env.ADMIN_LOCKOUT_MINUTES, 15),
    inviteTtlHours: int(process.env.ADMIN_INVITE_TTL_HOURS, 48),
    totpIssuer: process.env.ADMIN_TOTP_ISSUER ?? 'Zapiack Admin',
    impersonationMinutes: int(process.env.ADMIN_IMPERSONATION_MINUTES, 30),
  },

  limits: {
    creditApprovalThresholdNgn: int(
      process.env.CREDIT_APPROVAL_THRESHOLD_NGN,
      100_000,
    ),
    broadcastApprovalThreshold: int(
      process.env.BROADCAST_APPROVAL_THRESHOLD,
      1_000,
    ),
    documentUrlTtlSeconds: int(process.env.DOCUMENT_URL_TTL_SECONDS, 5 * 60),
    exportTtlHours: int(process.env.EXPORT_TTL_HOURS, 24),
    requestLogRetentionDays: int(process.env.REQUEST_LOG_RETENTION_DAYS, 90),
    liveMapEventsPerSecond: int(process.env.LIVE_MAP_EPS, 50),
    reconciliationVariancePct: Number(
      process.env.RECONCILIATION_VARIANCE_PCT ?? 1,
    ),
    rollupLagAlertMinutes: int(process.env.ROLLUP_LAG_ALERT_MINUTES, 15),
  },

  apiCore: {
    baseUrl:
      process.env.API_CORE_BASE_URL ?? 'http://localhost:3000/internal/v1',
    serviceToken: process.env.API_CORE_SERVICE_TOKEN ?? '',
    signingSecret: process.env.API_CORE_SIGNING_SECRET ?? '',
    timeoutMs: int(process.env.API_CORE_TIMEOUT_MS, 10_000),
  },

  s3: {
    region: process.env.AWS_REGION ?? 'eu-west-1',
    senderIdBucket: process.env.S3_SENDER_ID_BUCKET ?? '',
    senderIdPrefix: process.env.S3_SENDER_ID_PREFIX ?? 'sender-ids/',
    exportBucket: process.env.S3_EXPORT_BUCKET ?? '',
    exportPrefix: process.env.S3_EXPORT_PREFIX ?? 'exports/',
  },

  geoip: {
    cityDbPath: process.env.GEOIP_CITY_DB_PATH ?? './data/GeoLite2-City.mmdb',
    asnDbPath: process.env.GEOIP_ASN_DB_PATH || undefined,
  },

  mail: {
    sesRegion: process.env.SES_REGION ?? process.env.AWS_REGION ?? 'eu-west-1',
    fromAddress: process.env.SES_FROM_ADDRESS ?? 'no-reply@zapiack.com',
    replyTo: process.env.SES_REPLY_TO || undefined,
  },

  smsCore: {
    baseUrl: process.env.SMS_CORE_BASE_URL ?? '',
    apiKey: process.env.SMS_CORE_API_KEY ?? '',
    senderId: process.env.SMS_CORE_SENDER_ID ?? 'Zapiack',
  },
});
