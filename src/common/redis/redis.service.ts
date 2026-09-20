import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { AdminConfig } from '../config/configuration';

/**
 * One Redis, three uses: session state, the request-event stream feeding the
 * God's-eye map, and pub/sub fan-out to SSE viewers. Subscriber connections cannot
 * issue commands, so they are created separately from the main client.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;
  readonly prefix: string;
  private readonly extras: Redis[] = [];

  constructor(
    private readonly config: ConfigService<{ admin: AdminConfig }, true>,
  ) {
    const redis = config.get('admin', { infer: true }).redis;
    this.prefix = redis.keyPrefix;
    this.client = new Redis(redis.url, {
      maxRetriesPerRequest: null,
      keyPrefix: this.prefix,
    });
    this.client.on('error', (err) =>
      this.logger.error(`Redis error: ${err.message}`),
    );
  }

  /** Namespaced key. The prefix differs from the customer app's, by design. */
  key(...parts: (string | number)[]) {
    return parts.join(':');
  }

  /** A dedicated connection, for subscribers and blocking stream reads. */
  duplicate(): Redis {
    const conn = this.client.duplicate();
    this.extras.push(conn);
    return conn;
  }

  /** Connection options for BullMQ, which manages its own connections. */
  get bullConnection() {
    const url = new URL(this.config.get('admin', { infer: true }).redis.url);
    return {
      host: url.hostname,
      port: Number(url.port || 6379),
      password: url.password || undefined,
      username: url.username || undefined,
      maxRetriesPerRequest: null,
    };
  }

  async onModuleDestroy() {
    await Promise.allSettled([
      this.client.quit(),
      ...this.extras.map((c) => c.quit()),
    ]);
  }
}
