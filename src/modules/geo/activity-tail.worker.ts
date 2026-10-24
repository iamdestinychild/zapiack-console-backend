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
import { geocode } from '../../common/geo/geocode';
import type { AdminConfig } from '../../common/config/configuration';
import { everyNth, traced } from '../../common/diagnostics/memory-trace';

/** Default gap between polls; LIVE_MAP_POLL_SECONDS overrides it. */
const DEFAULT_POLL_SECONDS = 10;
/** The channel the live map listens on. */
const LIVE_CHANNEL = 'geo:live';
/** Ceiling per poll, so a traffic burst cannot pull an unbounded page. */
const BATCH = 200;
/** With MEMORY_TRACE on, one poll in this many is measured (about once a minute). */
const TRACE_EVERY = 20;
/** At most one "skipped polls" warning per this long, so a slow database cannot flood the log. */
const SKIP_WARN_MS = 60_000;

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
  /**
   * True while a poll is in progress. Without it a poll that takes longer than POLL_MS
   * is joined by another every three seconds: each holds up to a page of rows and waits
   * for one of a handful of connections, so a slow database turns into a growing pile of
   * queued work and memory instead of a poll that simply runs a little late.
   */
  private inFlight = false;
  private skipped = 0;
  private lastSkipWarn = 0;
  private readonly sampler = { n: 0 };
  /** Rows at or before this point have already been published. */
  private watermark = new Date();
  private readonly perSecond: number;
  private readonly pollMs: number;

  constructor(
    private readonly zapiack: ZapiackPrismaService,
    private readonly sse: SseService,
    config: ConfigService<{ admin: AdminConfig }, true>,
  ) {
    const { limits } = config.get('admin', { infer: true });
    this.perSecond = limits.liveMapEventsPerSecond;
    this.pollMs = (limits.liveMapPollSeconds ?? DEFAULT_POLL_SECONDS) * 1000;
  }

  onModuleInit() {
    this.running = true;
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    this.logger.log('Tailing api_activity_logs for the live map');
  }

  private async tick() {
    if (!this.running) return;

    // The previous poll is still running: do nothing this time. The watermark means the
    // next poll picks up exactly where this one would have, so nothing is missed.
    if (this.inFlight) {
      this.skipped += 1;
      const now = Date.now();
      if (now - this.lastSkipWarn >= SKIP_WARN_MS) {
        this.lastSkipWarn = now;
        this.logger.warn(
          `Activity tail is slower than ${this.pollMs}ms; skipped ${this.skipped} poll(s) so far`,
        );
      }
      return;
    }

    this.inFlight = true;
    try {
      // Nobody has the map open: skip the query entirely. The watermark moves to now so
      // the first poll after a viewer arrives does not replay the idle period; the map
      // fills itself from /geo/live/recent when it opens.
      if (!(await this.sse.hasViewers(LIVE_CHANNEL))) {
        this.watermark = new Date();
        return;
      }
      if (everyNth(this.sampler, TRACE_EVERY)) {
        await traced('geo:activity-tail', () => this.poll());
      } else {
        await this.poll();
      }
    } finally {
      this.inFlight = false;
    }
  }

  private async poll() {
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
      const budget = Math.floor((this.perSecond * this.pollMs) / 1000);
      const sampled = rows.length > budget ? evenSample(rows, budget) : rows;

      await this.sse.publish(
        LIVE_CHANNEL,
        'request',
        sampled.flatMap((row) => {
          // The log has no coordinates; a dot with nowhere to go is dropped, not
          // plotted at 0,0.
          const point = geocode(row.countryCode, row.city);
          if (!point) return [];
          return [
            {
              at: row.createdAt.toISOString(),
              lat: point.lat,
              lng: point.lng,
              precision: point.precision,
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
            },
          ];
        }),
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
