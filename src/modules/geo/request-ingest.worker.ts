import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import type { Prisma } from '../../generated/admin/client';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { SseService } from '../../common/sse/sse.service';
import { GeoIpService } from '../../integrations/geoip/geoip.service';
import { maskIp } from '../../common/http/masking';
import type { AdminConfig } from '../../common/config/configuration';

/** The stream api-core's middleware writes to, without awaiting it. */
export const REQUEST_STREAM = 'stream:request.logged';
const CONSUMER_GROUP = 'admin-core-geo';

interface RawRequestEvent {
  occurredAt?: string;
  accountId?: string;
  apiKeyId?: string;
  endpoint?: string;
  method?: string;
  statusCode?: string | number;
  latencyMs?: string | number;
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

/**
 * Consumes request events, resolves the client IP offline, writes the raw log and
 * publishes a sampled dot to the live map.
 *
 * Batched reads and a single createMany per batch keep this cheap: the pipeline has
 * to survive 20 million requests a day before the raw log moves to ClickHouse.
 */
@Injectable()
export class RequestIngestWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RequestIngestWorker.name);
  private reader?: Redis;
  private running = false;
  private readonly consumerName = `admin-core-${process.pid}`;
  private readonly liveMapBudget: number;

  /** Refilled every second; when it runs out, events are still logged but not drawn. */
  private mapTokens = 0;
  private tokenTimer?: NodeJS.Timeout;

  constructor(
    private readonly redis: RedisService,
    private readonly admin: AdminPrismaService,
    private readonly geoip: GeoIpService,
    private readonly sse: SseService,
    config: ConfigService<{ admin: AdminConfig }, true>,
  ) {
    this.liveMapBudget = config.get('admin', {
      infer: true,
    }).limits.liveMapEventsPerSecond;
  }

  async onModuleInit() {
    this.reader = this.redis.duplicate();

    // MKSTREAM so the group exists even before api-core has emitted anything.
    await this.reader
      .xgroup(
        'CREATE',
        `${this.redis.prefix}${REQUEST_STREAM}`,
        CONSUMER_GROUP,
        '0',
        'MKSTREAM',
      )
      .catch((err: Error) => {
        // The group already exists, which is the desired end state.
        if (!err.message.includes('BUSYGROUP')) throw err;
      });

    this.tokenTimer = setInterval(
      () => (this.mapTokens = this.liveMapBudget),
      1_000,
    );
    this.running = true;
    void this.loop();
  }

  private async loop() {
    const key = `${this.redis.prefix}${REQUEST_STREAM}`;

    while (this.running) {
      try {
        const response = (await this.reader!.xreadgroup(
          'GROUP',
          CONSUMER_GROUP,
          this.consumerName,
          'COUNT',
          500,
          'BLOCK',
          2_000,
          'STREAMS',
          key,
          '>',
        )) as [string, [string, string[]][]][] | null;

        if (!response?.length) continue;

        for (const [, entries] of response) {
          await this.handleBatch(entries);
          await this.reader!.xack(
            key,
            CONSUMER_GROUP,
            ...entries.map(([id]) => id),
          );
        }
      } catch (err) {
        if (!this.running) return;
        this.logger.error(
          `Request ingest loop error: ${(err as Error).message}`,
        );
        // Back off rather than spin against a broken Redis.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  }

  private async handleBatch(entries: [string, string[]][]) {
    const rows: Prisma.RequestLogCreateManyInput[] = [];
    const dots: Record<string, unknown>[] = [];

    for (const [, fields] of entries) {
      const event = fieldsToObject(fields) as RawRequestEvent;
      const geo = this.geoip.lookup(event.ip);
      const occurredAt = event.occurredAt
        ? new Date(event.occurredAt)
        : new Date();

      rows.push({
        occurredAt,
        accountId: event.accountId || null,
        apiKeyId: event.apiKeyId || null,
        endpoint: event.endpoint ?? 'unknown',
        method: event.method ?? 'GET',
        statusCode: Number(event.statusCode ?? 0),
        latencyMs: Number(event.latencyMs ?? 0),
        ip: event.ip || null,
        userAgent: event.userAgent || null,
        country: geo.country,
        region: geo.region,
        city: geo.city,
        latitude: geo.latitude,
        longitude: geo.longitude,
        requestId: event.requestId || null,
      });

      // Sampling protects the viewer, not the log: every event is stored either way.
      if (this.mapTokens > 0 && geo.latitude !== undefined) {
        this.mapTokens -= 1;
        dots.push({
          at: occurredAt.toISOString(),
          accountId: event.accountId ?? null,
          endpoint: event.endpoint,
          statusCode: Number(event.statusCode ?? 0),
          latencyMs: Number(event.latencyMs ?? 0),
          country: geo.country,
          city: geo.city,
          lat: geo.latitude,
          lng: geo.longitude,
          // City-level unless the viewer holds pii.reveal; the SSE route re-masks anyway.
          ip: maskIp(event.ip),
        });
      }
    }

    if (rows.length) {
      // A logging failure must never cost us the batch twice; skipDuplicates keeps a
      // redelivered stream entry from doubling up.
      await this.admin.requestLog.createMany({
        data: rows,
        skipDuplicates: true,
      });
    }
    if (dots.length) {
      await this.sse.publish('geo:live', 'request', dots);
    }
  }

  async onModuleDestroy() {
    this.running = false;
    if (this.tokenTimer) clearInterval(this.tokenTimer);
    await this.reader?.quit();
  }
}

/** Redis stream entries arrive as a flat [field, value, field, value] array. */
function fieldsToObject(fields: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < fields.length - 1; i += 2) out[fields[i]] = fields[i + 1];
  return out;
}
