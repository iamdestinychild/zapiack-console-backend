import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { DateTime } from 'luxon';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { ZapiackPrismaService } from '../../common/prisma/zapiack-prisma.service';
import { LAGOS } from '../../common/time/lagos';
import { historyDays, missingFinaliseDays } from './catch-up';
import { DEFAULT_JOB_OPTIONS, JOBS, QUEUES } from './queues';

/**
 * Re-queues work that a cron tick should have done while the process was not running.
 *
 * `@Cron` fires only while the process is up. On a host that sleeps when idle, or
 * through a deploy or a crash at 00:15, the nightly finalise and the reconciliation
 * simply never happen and nothing notices. On boot this looks at how far the finalise
 * job got, and enqueues whatever days were skipped.
 *
 * Safe to run on every start and from several instances at once: rollups are
 * recomputed from source rather than incremented, and each job carries a
 * deterministic id, so a duplicate is dropped rather than doubled.
 */
@Injectable()
export class CatchUpService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CatchUpService.name);

  constructor(
    private readonly admin: AdminPrismaService,
    private readonly zapiack: ZapiackPrismaService,
    @InjectQueue(QUEUES.rollups) private readonly rollups: Queue,
    @InjectQueue(QUEUES.maintenance) private readonly maintenance: Queue,
  ) {}

  async onApplicationBootstrap() {
    try {
      const watermark = await this.admin.rollupWatermark.findUnique({
        where: { job: 'usage.finalise' },
        select: { processedTo: true },
      });

      const days = missingFinaliseDays(watermark?.processedTo ?? null);

      for (const day of days) {
        await this.rollups.add(
          JOBS.finalisePreviousDay,
          { day },
          { ...DEFAULT_JOB_OPTIONS, jobId: `finalise-${day}` },
        );
      }
      // Reconciliation compares a finalised day against its source, so only the most
      // recent one is worth re-running; older ones were compared when they were new.
      if (days.length) {
        const latest = days[days.length - 1];
        await this.rollups.add(
          JOBS.reconcile,
          { day: latest },
          { ...DEFAULT_JOB_OPTIONS, jobId: `reconcile-${latest}` },
        );
      }

      // Today is not finalised, but it should not wait five minutes after a wake-up.
      const today = DateTime.now().setZone(LAGOS).toISODate()!;
      await this.rollups.add(
        JOBS.rollUsageCurrentDay,
        { day: today },
        { ...DEFAULT_JOB_OPTIONS, jobId: `usage-boot-${Date.now()}` },
      );

      await this.loadHistory();

      // Request totals are rebuilt for the whole day each run; do it now rather than
      // leaving the figure at whatever the last awake window happened to count.
      await this.rollups.add(
        JOBS.rollRequests,
        {},
        { ...DEFAULT_JOB_OPTIONS, jobId: `requests-boot-${Date.now()}` },
      );

      await this.maintenance.add(
        JOBS.senderIdSync,
        {},
        { ...DEFAULT_JOB_OPTIONS, jobId: `sender-id-sync-boot-${Date.now()}` },
      );

      if (days.length) {
        this.logger.warn(
          `Caught up ${days.length} missed day(s): ${days[0]}..${days[days.length - 1]}`,
        );
      }
    } catch (err) {
      // Catching up is a courtesy; failing to must never stop the service starting.
      this.logger.error(`Catch-up skipped: ${(err as Error).message}`);
    }
  }

  /**
   * Loads the product's history, once per database.
   *
   * A console deployed into a product that has been running for weeks starts with an
   * empty rollup store, and the nightly catch-up replays only the last two days. So
   * every screen quietly showed one month less than reality: low revenue, low request
   * counts, no payments. This reads where the product's history begins and queues each
   * day from there. The days are marked `historical`, which keeps today's credit
   * liability off past dates and runs each day's reconciliation.
   *
   * A marker records that it has been done, so a restart does not redo it. To load
   * history again (a wrong rollup, a longer window), delete the `history.backfill` row
   * from `rollup_watermarks`, or run the backfill CLI.
   */
  private async loadHistory() {
    const done = await this.admin.rollupWatermark.findUnique({
      where: { job: 'history.backfill' },
      select: { job: true },
    });
    if (done) return;

    const [row] = await this.zapiack.read.$queryRaw<{ first: Date | null }[]>`
      SELECT LEAST(
        (SELECT MIN("createdAt") FROM "log_events"),
        (SELECT MIN("createdAt") FROM "transactions"),
        (SELECT MIN("createdAt") FROM "api_activity_logs")
      ) AS first
    `;
    const days = historyDays(row?.first ?? null);

    for (const day of days) {
      await this.rollups.add(
        JOBS.finalisePreviousDay,
        { day, historical: true },
        // Its own id, apart from the nightly `finalise-<day>`: BullMQ drops a second
        // job that reuses an id still on file, which would silently skip a day.
        { ...DEFAULT_JOB_OPTIONS, jobId: `history-${day}` },
      );
    }

    await this.admin.rollupWatermark.create({
      data: { job: 'history.backfill', processedTo: new Date() },
    });
    if (days.length) {
      this.logger.warn(
        `Loading ${days.length} day(s) of history: ${days[0]}..${days[days.length - 1]}`,
      );
    }
  }
}
