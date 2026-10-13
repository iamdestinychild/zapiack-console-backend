import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { AdminConfig } from '../config/configuration';
import { redisOptionsFromUrl } from './redis-url';

/**
 * Cache keys and channels of the customer app (api-core), copied exactly. If api-core
 * renames one, clearing it here silently stops working, so they live together in this
 * one place and are covered by a test that pins them.
 */
export const PRODUCT_CACHE = {
  /** Which sender ID a project sends under. Cached for an hour. */
  senderId: (projectId: string) => `sender:${projectId}`,
  /** Whether an account may send. Cached for an hour. */
  accountStatus: (accountId: string) => `account:${accountId}:status`,
  /** An API key's identity and hash. Cached for an hour. */
  apiKey: (keyPrefix: string) => `apikey:${keyPrefix}`,
  /** The channel an open customer dashboard listens on to refresh its bell. */
  accountEvents: 'account-events',
} as const;

/**
 * Keeps the customer app from acting on stale facts after the console changes them.
 *
 * api-core caches three things in Redis for an hour: whether an account is active, an
 * API key's details, and a project's sender ID. A console action that changes the
 * database alone therefore takes up to an hour to bite: a suspended account keeps
 * sending, a revoked API key keeps working, an approved sender ID is not used. Each of
 * those writes should be followed by clearing the matching entry here, so the next
 * request reads the database.
 *
 * Every method is best effort and never throws. The database change has already been
 * made and is what counts; if Redis cannot be reached the cache expires by itself
 * within the hour, so the caller carries on and the failure is logged.
 */
@Injectable()
export class ProductCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(ProductCacheService.name);
  private connection?: Redis;

  constructor(
    private readonly config: ConfigService<{ admin: AdminConfig }, true>,
  ) {}

  invalidateSenderId(projectId: string): Promise<boolean> {
    return this.del(PRODUCT_CACHE.senderId(projectId));
  }

  invalidateAccountStatus(accountId: string): Promise<boolean> {
    return this.del(PRODUCT_CACHE.accountStatus(accountId));
  }

  invalidateApiKey(keyPrefix: string): Promise<boolean> {
    return this.del(PRODUCT_CACHE.apiKey(keyPrefix));
  }

  /** Tells an open customer dashboard to refresh its bell. Channels are server-wide. */
  async notifyUser(userId: string): Promise<boolean> {
    try {
      await this.redis().publish(
        PRODUCT_CACHE.accountEvents,
        JSON.stringify({ userId, type: 'notification.created' }),
      );
      return true;
    } catch (err) {
      this.logger.warn(
        `Could not push a live update to ${userId}: ${(err as Error).message}`,
      );
      return false;
    }
  }

  private async del(key: string): Promise<boolean> {
    try {
      await this.redis().del(key);
      return true;
    } catch (err) {
      // The key is named, not its value: nothing sensitive is in a cache key's name.
      this.logger.warn(
        `Could not clear ${key}; it will expire on its own within the hour: ${(err as Error).message}`,
      );
      return false;
    }
  }

  /** Opened on first use, so a deployment that never needs it never connects. */
  private redis(): Redis {
    if (!this.connection) {
      const { url, productDb } = this.config.get('admin', {
        infer: true,
      }).redis;
      this.connection = new Redis({
        ...redisOptionsFromUrl(url),
        db: productDb,
        // No keyPrefix: these are api-core's keys, exactly as it wrote them.
        maxRetriesPerRequest: 1,
        connectTimeout: 3_000,
      });
      this.connection.on('error', (err) =>
        this.logger.warn(`Product Redis: ${err.message}`),
      );
    }
    return this.connection;
  }

  async onModuleDestroy() {
    await this.connection?.quit().catch(() => undefined);
  }
}
