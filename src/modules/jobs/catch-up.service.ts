import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { DateTime } from 'luxon';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { LAGOS } from '../../common/time/lagos';
import { missingFinaliseDays } from './catch-up';
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
}
