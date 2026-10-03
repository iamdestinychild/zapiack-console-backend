import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ZapiackPrismaService } from '../../common/prisma/zapiack-prisma.service';
import { SseService } from '../../common/sse/sse.service';
import { maskIp } from '../../common/http/masking';
import type { AdminConfig } from '../../common/config/configuration';

/** How often the tail looks for new rows. The map's "under 5s" target allows this. */
const POLL_MS = 3_000;
/** Ceiling per poll, so a traffic burst cannot pull an unbounded page. */
const BATCH = 200;

/**
 * Feeds the live map by tailing the product's own `api_activity_logs`.
 *
 * admin-core used to run its own ingest pipeline — a Redis stream, a worker and a
 * partitioned copy of every request. The product already records the same thing,
 * including ip, country, city and region, so the copy was removed and this reads the
 * source instead. Nothing is duplicated at rest.
 *
 * The cost of that trade: the activity log carries no coordinates, so the map plots by
 * city rather than by latitude and longitude, and resolution is whatever api-core
 * recorded at request time.
 */
@Injectable()
export class ActivityTailWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ActivityTailWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  /** Rows at or before this point have already been published. */
  private watermark = new Date();
  private readonly perSecond: number;

  constructor(
    private readonly zapiack: ZapiackPrismaService,
    private readonly sse: SseService,
    config: ConfigService<{ admin: AdminConfig }, true>,
  ) {
    this.perSecond = config.get('admin', {
      infer: true,
    }).limits.liveMapEventsPerSecond;
  }

  onModuleInit() {
    this.running = true;
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    this.logger.log('Tailing api_activity_logs for the live map');
  }

  private async tick() {
    if (!this.running) return;

    try {
      const rows = await this.zapiack.read.apiActivityLog.findMany({
        where: { createdAt: { gt: this.watermark } },
        orderBy: { createdAt: 'asc' },
        take: BATCH,
        select: {
          createdAt: true,
          endpoint: true,
          method: true,
          statusCode: true,
          countryCode: true,
          city: true,
          region: true,
          ip: true,
          service: true,
          projectId: true,
        },
      });
      if (!rows.length) return;

      // Advance past everything read, including rows the sampling drops, so the
      // watermark never rewinds and nothing is replayed.
      this.watermark = rows[rows.length - 1].createdAt;

      // Sampling protects the viewer, not the data: the log keeps every row.
      const budget = Math.floor((this.perSecond * POLL_MS) / 1000);
      const sampled = rows.length > budget ? evenSample(rows, budget) : rows;

      await this.sse.publish(
        'geo:live',
        'request',
        sampled.map((row) => ({
          at: row.createdAt.toISOString(),
          endpoint: row.endpoint,
          method: row.method,
          statusCode: row.statusCode,
          service: row.service,
          projectId: row.projectId,
          country: row.countryCode,
          region: row.region,
          city: row.city,
          // Re-masked per viewer on the SSE route; masked here too so a raw address
          // never sits in Redis.
          ip: maskIp(row.ip),
        })),
      );
    } catch (err) {
      this.logger.error(`Activity tail failed: ${(err as Error).message}`);
    }
  }

  onModuleDestroy() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
  }
}

/** Spreads the sample across the batch rather than taking the first N. */
function evenSample<T>(rows: T[], size: number): T[] {
  if (size <= 0) return [];
  const step = rows.length / size;
  return Array.from({ length: size }, (_, i) => rows[Math.floor(i * step)]);
}
