import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { AdminConfig } from '../config/configuration';

/**
 * One Redis, three uses: session state, the request-event stream feeding the
 * God's-eye map, and pub/sub fan-out to SSE viewers. Subscriber connections cannot
 * issue commands, so they are created separately from the main client.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
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

  /**
   * One line of Redis health at startup. Sessions, queues and live-map fan-out all
   * live here, so whether it is full or evicting explains a lot of odd behaviour.
   */
  async onModuleInit() {
    try {
      const [memory, stats] = await Promise.all([
        this.client.info('memory'),
        this.client.info('stats'),
      ]);
      const field = (text: string, name: string) =>
        text.match(new RegExp(`^${name}:(.*)$`, 'm'))?.[1]?.trim() ?? '?';
      const evicted = field(stats, 'evicted_keys');
      const policy = field(memory, 'maxmemory_policy');
      this.logger.log(
        `Redis memory ${field(memory, 'used_memory_human')} of ${field(memory, 'maxmemory_human')}, policy ${policy}, evicted keys since start ${evicted}`,
      );
      if (Number(evicted) > 0) {
        this.logger.warn(
          `Redis has evicted ${evicted} key(s). Session and queue keys can be among them; use a database with spare memory and a noeviction policy dedicated to admin-core.`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Could not read Redis health: ${(err as Error).message}`,
      );
    }
  }

  /**
   * A namespaced key. The client carries `keyPrefix`, so callers pass the bare name
   * and must NOT prepend the prefix themselves — doing so namespaces it twice.
   */
  key(...parts: (string | number)[]) {
    return parts.join(':');
  }

  /**
   * A pub/sub channel, fully qualified.
   *
   * ioredis applies `keyPrefix` to keys but NOT to pub/sub channels, so the namespace
   * has to be written in by hand here. Publisher and subscriber must both go through
   * this method, or they agree on nothing and no message is ever delivered.
   */
  channel(...parts: (string | number)[]) {
    return `${this.prefix}${parts.join(':')}`;
  }

  /**
   * A stream key for a connection that has no `keyPrefix` of its own.
   * Used by the request-ingest reader, which is deliberately unprefixed so the key it
   * reads is written out in full and can be matched exactly against api-core.
   */
  streamKey(name: string) {
    return `${this.prefix}${name}`;
  }

  /**
   * A dedicated connection, for subscribers and blocking stream reads.
   *
   * `withKeyPrefix: false` returns a connection that applies no prefix, for callers
   * that build fully-qualified keys themselves.
   */
  duplicate(options: { withKeyPrefix?: boolean } = {}): Redis {
    const conn =
      options.withKeyPrefix === false
        ? new Redis(this.config.get('admin', { infer: true }).redis.url, {
            maxRetriesPerRequest: null,
          })
        : this.client.duplicate();
    conn.on('error', (err) => this.logger.error(`Redis error: ${err.message}`));
    this.extras.push(conn);
    return conn;
  }

  /**
   * Connection options for BullMQ, which manages its own connections and therefore
   * never sees the ioredis `keyPrefix`. BullModule sets `prefix` separately so its
   * keys land under the admin namespace rather than the shared default `bull:`.
   */
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
