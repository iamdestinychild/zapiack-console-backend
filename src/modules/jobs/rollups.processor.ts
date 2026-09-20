import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { DateTime } from 'luxon';
import { LAGOS } from '../../common/time/lagos';
import { RollupsService } from '../rollups/rollups.service';
import { ReconciliationService } from '../finance/reconciliation.service';
import { ProviderHealthService } from '../services/provider-health.service';
import { RiskService } from '../risk/risk.service';
import { JOBS, QUEUES, type DayJobData, type WindowJobData } from './queues';

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

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case JOBS.rollUsageCurrentDay: {
        // Recompute the whole Lagos day rather than just the last few minutes: late
        // delivery receipts change rows that an incremental window would have missed.
        const { day: isoDay } = job.data as DayJobData;
        const day = DateTime.fromISO(isoDay, { zone: LAGOS }).startOf('day');
        const count = await this.rollups.rollUsage(
          day.toJSDate(),
          day.plus({ days: 1 }).toJSDate(),
        );
        await this.rollups.markProcessed('usage.current_day', new Date());
        return { buckets: count };
      }

      case JOBS.finalisePreviousDay: {
        const { day: isoDay } = job.data as DayJobData;
        const day = DateTime.fromISO(isoDay, { zone: LAGOS }).startOf('day');
        const count = await this.rollups.finaliseDay(day.toJSDate());
        await this.rollups.markProcessed(
          'usage.finalise',
          day.plus({ days: 1 }).toJSDate(),
        );
        return { buckets: count };
      }

      case JOBS.rollRequests: {
        const minutes = (job.data as WindowJobData).windowMinutes ?? 10;
        const end = new Date();
        const start = new Date(end.getTime() - minutes * 60_000);
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
