import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Queue } from 'bullmq';
import { DateTime } from 'luxon';
import { LAGOS } from '../../common/time/lagos';
import { DEFAULT_JOB_OPTIONS, JOBS, QUEUES } from './queues';

/**
 * The console's clock. Cron only enqueues; the processors do the work, so a slow
 * rollup cannot block the next tick and every run is retryable.
 *
 * Job ids are deterministic per window, so two admin-core instances ticking at the
 * same second enqueue one job between them rather than two.
 */
@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    @InjectQueue(QUEUES.rollups) private readonly rollups: Queue,
    @InjectQueue(QUEUES.maintenance) private readonly maintenance: Queue,
    @InjectQueue(QUEUES.events) private readonly events: Queue,
  ) {}

  async onModuleInit() {
    // Partitions must exist before the first request of the day lands.
    await this.maintenance.add(JOBS.partitions, {}, DEFAULT_JOB_OPTIONS);
  }

  /** Rollup freshness target for today is 5 minutes. */
  @Cron('*/5 * * * *')
  async rollCurrentDay() {
    const now = DateTime.now().setZone(LAGOS);
    await this.rollups.add(
      JOBS.rollUsageCurrentDay,
      { day: now.toISODate() },
      {
        ...DEFAULT_JOB_OPTIONS,
        jobId: `usage-${now.toFormat('yyyy-LL-dd-HH-mm')}`,
      },
    );
    await this.rollups.add(
      JOBS.rollRequests,
      { windowMinutes: 10 },
      {
        ...DEFAULT_JOB_OPTIONS,
        jobId: `requests-${now.toFormat('yyyy-LL-dd-HH-mm')}`,
      },
    );
  }

  /** Nightly finalisation of the previous Lagos day, then reconciliation against it. */
  @Cron('15 0 * * *', { timeZone: LAGOS })
  async finalisePreviousDay() {
    const yesterday = DateTime.now()
      .setZone(LAGOS)
      .minus({ days: 1 })
      .toISODate();
    await this.rollups.add(
      JOBS.finalisePreviousDay,
      { day: yesterday },
      { ...DEFAULT_JOB_OPTIONS, jobId: `finalise-${yesterday}` },
    );
  }

  @Cron('45 1 * * *', { timeZone: LAGOS })
  async reconcile() {
    const yesterday = DateTime.now()
      .setZone(LAGOS)
      .minus({ days: 1 })
      .toISODate();
    await this.rollups.add(
      JOBS.reconcile,
      { day: yesterday },
      { ...DEFAULT_JOB_OPTIONS, jobId: `reconcile-${yesterday}` },
    );
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async providerHealth() {
    await this.rollups.add(JOBS.providerHealth, {}, DEFAULT_JOB_OPTIONS);
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async riskScan() {
    await this.rollups.add(JOBS.riskScan, {}, DEFAULT_JOB_OPTIONS);
  }

  /** Sender ID SLA timers; breaches become staff notifications. */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async slaSweep() {
    await this.maintenance.add(JOBS.slaSweep, {}, DEFAULT_JOB_OPTIONS);
  }

  /**
   * Re-queues events that were persisted but never processed, which is the whole
   * point of persisting them first.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async eventSweep() {
    await this.events.add(JOBS.eventSweep, {}, DEFAULT_JOB_OPTIONS);
  }

  /** Tomorrow's partition, then the 90-day drop. */
  @Cron('30 2 * * *', { timeZone: LAGOS })
  async retention() {
    await this.maintenance.add(JOBS.partitions, {}, DEFAULT_JOB_OPTIONS);
    await this.maintenance.add(JOBS.retention, {}, DEFAULT_JOB_OPTIONS);
  }

  /** GeoLite2 is refreshed weekly. */
  @Cron('0 3 * * 2', { timeZone: LAGOS })
  async geoipRefresh() {
    await this.maintenance.add(JOBS.geoipRefresh, {}, DEFAULT_JOB_OPTIONS);
  }
}
