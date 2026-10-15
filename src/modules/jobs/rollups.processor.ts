import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { DateTime } from 'luxon';
import { LAGOS } from '../../common/time/lagos';
import { RollupsService } from '../rollups/rollups.service';
import { ReconciliationService } from '../finance/reconciliation.service';
import { ProviderHealthService } from '../services/provider-health.service';
import { RiskService } from '../risk/risk.service';
import { JOBS, QUEUES, type DayJobData } from './queues';
import { traced } from '../../common/diagnostics/memory-trace';

@Processor(QUEUES.rollups, { concurrency: 2 })
export class RollupsProcessor extends WorkerHost {
  private readonly logger = new Logger(RollupsProcessor.name);

  constructor(
    private readonly rollups: RollupsService,
    private readonly reconciliation: ReconciliationService,
    private readonly providerHealth: ProviderHealthService,
    private readonly risk: RiskService,
  ) {
    super();
  }

  /** Every job runs through here so `MEMORY_TRACE` can say which one keeps memory. */
  async process(job: Job): Promise<unknown> {
    return traced(`${job.queueName}:${job.name}`, () => this.run(job));
  }

  private async run(job: Job): Promise<unknown> {
    switch (job.name) {
      case JOBS.rollUsageCurrentDay: {
        // Recompute the whole Lagos day rather than just the last few minutes: late
        // delivery receipts change rows that an incremental window would have missed.
        const { day: isoDay } = job.data as DayJobData;
        const day = DateTime.fromISO(isoDay, { zone: LAGOS }).startOf('day');
        const count = await this.rollups.rollCurrentDay(day.toJSDate());
        await this.rollups.markProcessed('usage.current_day', new Date());
        return { buckets: count };
      }

      case JOBS.finalisePreviousDay: {
        const { day: isoDay, historical } = job.data as DayJobData;
        const day = DateTime.fromISO(isoDay, { zone: LAGOS }).startOf('day');
        const count = await this.rollups.finaliseDay(day.toJSDate(), {
          historical,
        });
        // The nightly path reconciles once, for yesterday. A day loaded from history
        // would never be reconciled otherwise, and it must follow the finalise it
        // checks, in this same job, or it would compare against a half-written day.
        if (historical) await this.reconciliation.runForDay(day.toJSDate());
        // Old days finish in any order and must not drag the "finalised up to" marker
        // back, or the next start would believe weeks of recent days are still owed.
        if (!historical) {
          await this.rollups.markProcessed(
            'usage.finalise',
            day.plus({ days: 1 }).toJSDate(),
          );
        }
        return { buckets: count };
      }

      case JOBS.rollRequests: {
        // The whole Lagos day, every time. Buckets are hourly and an upsert replaces
        // the total, so a window starting mid-hour overwrote that hour with a partial
        // count, and any stretch the process was asleep was never counted at all.
        const end = new Date();
        const start = DateTime.fromJSDate(end)
          .setZone(LAGOS)
          .startOf('day')
          .toJSDate();
        const count = await this.rollups.rollRequests(start, end);
        await this.rollups.markProcessed('requests', end);
        return { buckets: count };
      }

      case JOBS.reconcile: {
        const { day: isoDay } = job.data as DayJobData;
        const day = DateTime.fromISO(isoDay, { zone: LAGOS })
          .startOf('day')
          .toJSDate();
        return this.reconciliation.runForDay(day);
      }

      case JOBS.providerHealth:
        return this.providerHealth.sample();

      case JOBS.riskScan:
        return this.risk.scan();

      default:
        this.logger.warn(`Unknown rollup job ${job.name}`);
        return null;
    }
  }
}
