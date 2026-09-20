import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { RedisService } from '../redis/redis.service';
import type { AdminConfig } from '../config/configuration';

export interface SessionRecord {
  sessionId: string;
  staffId: string;
  sessionEpoch: number;
  createdAt: number;
  lastSeenAt: number;
  absoluteExpiresAt: number;
  ip?: string;
  userAgent?: string;
  /** Set only after TOTP has been verified; a half-authenticated session cannot read data. */
  mfaVerified: boolean;
  csrfToken: string;
  impersonation?: { accountId: string; expiresAt: number };
}

/**
 * Session state lives in Redis under an admin-only key prefix. The cookie carries an
 * opaque id, so revoking a session is a delete rather than a token blacklist.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private readonly cfg: AdminConfig['session'];

  constructor(
    private readonly redis: RedisService,
    config: ConfigService<{ admin: AdminConfig }, true>,
  ) {
    this.cfg = config.get('admin', { infer: true }).session;
  }

  private sessionKey(sessionId: string) {
    return this.redis.key('session', sessionId);
  }

  private staffIndexKey(staffId: string) {
    return this.redis.key('session-index', staffId);
  }

  async create(input: {
    staffId: string;
    sessionEpoch: number;
    ip?: string;
    userAgent?: string;
    mfaVerified: boolean;
  }): Promise<SessionRecord> {
    const now = Date.now();
    const record: SessionRecord = {
      sessionId: randomBytes(24).toString('base64url'),
      staffId: input.staffId,
      sessionEpoch: input.sessionEpoch,
      createdAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: now + this.cfg.absoluteLifetimeSeconds * 1000,
      ip: input.ip,
      userAgent: input.userAgent,
      mfaVerified: input.mfaVerified,
      csrfToken: randomBytes(24).toString('base64url'),
    };

    await this.persist(record);
    await this.redis.client.sadd(
      this.staffIndexKey(input.staffId),
      record.sessionId,
    );
    return record;
  }

  async get(sessionId: string): Promise<SessionRecord | null> {
    const raw = await this.redis.client.get(this.sessionKey(sessionId));
    if (!raw) return null;
    const record = JSON.parse(raw) as SessionRecord;

    // Two clocks apply: a 12-hour absolute lifetime and a 30-minute idle timeout.
    const now = Date.now();
    if (now > record.absoluteExpiresAt) {
      await this.revoke(sessionId, 'absolute_lifetime_reached');
      return null;
    }
    if (now - record.lastSeenAt > this.cfg.idleTimeoutSeconds * 1000) {
      await this.revoke(sessionId, 'idle_timeout');
      return null;
    }
    return record;
  }

  /** Slides the idle window. The absolute expiry is never extended. */
  async touch(record: SessionRecord): Promise<void> {
    record.lastSeenAt = Date.now();
    await this.persist(record);
  }

  async update(record: SessionRecord): Promise<void> {
    await this.persist(record);
  }

  async revoke(sessionId: string, reason: string): Promise<void> {
    const raw = await this.redis.client.get(this.sessionKey(sessionId));
    await this.redis.client.del(this.sessionKey(sessionId));
    if (raw) {
      const record = JSON.parse(raw) as SessionRecord;
      await this.redis.client.srem(
        this.staffIndexKey(record.staffId),
        sessionId,
      );
      this.logger.debug(
        `Revoked session for staff ${record.staffId}: ${reason}`,
      );
    }
  }

  /** Used on role change, password reset and explicit sign-out-everywhere. */
  async revokeAllForStaff(staffId: string, reason: string): Promise<number> {
    const ids = await this.redis.client.smembers(this.staffIndexKey(staffId));
    await Promise.all(ids.map((id) => this.revoke(id, reason)));
    await this.redis.client.del(this.staffIndexKey(staffId));
    return ids.length;
  }

  async listForStaff(staffId: string): Promise<SessionRecord[]> {
    const ids = await this.redis.client.smembers(this.staffIndexKey(staffId));
    const records = await Promise.all(ids.map((id) => this.get(id)));
    return records.filter((r): r is SessionRecord => r !== null);
  }

  /** Double-submit CSRF: the header must match the token stored with the session. */
  verifyCsrf(record: SessionRecord, presented: string | undefined): boolean {
    if (!presented) return false;
    const a = Buffer.from(record.csrfToken);
    const b = Buffer.from(presented);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private async persist(record: SessionRecord) {
    // TTL tracks whichever clock expires first.
    const ttlMs = Math.min(
      record.absoluteExpiresAt - Date.now(),
      this.cfg.idleTimeoutSeconds * 1000,
    );
    if (ttlMs <= 0) return;
    await this.redis.client.set(
      this.sessionKey(record.sessionId),
      JSON.stringify(record),
      'PX',
      ttlMs,
    );
  }
}
