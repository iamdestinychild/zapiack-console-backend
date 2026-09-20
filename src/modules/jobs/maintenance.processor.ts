import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { DateTime } from 'luxon';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { Prisma } from '../../generated/admin/client';
import { GeoIpService } from '../../integrations/geoip/geoip.service';
import { LAGOS } from '../../common/time/lagos';
import { SenderIdsService } from '../sender-ids/sender-ids.service';
import type { AdminConfig } from '../../common/config/configuration';
import { JOBS, QUEUES } from './queues';

/** Partitions are created this far ahead so a clock skew never loses a day's logs. */
const PARTITION_LOOKAHEAD_DAYS = 3;

@Processor(QUEUES.maintenance, { concurrency: 1 })
export class MaintenanceProcessor extends WorkerHost {
  private readonly logger = new Logger(MaintenanceProcessor.name);
  private readonly retentionDays: number;

  constructor(
    private readonly admin: AdminPrismaService,
    private readonly geoip: GeoIpService,
    private readonly senderIds: SenderIdsService,
    config: ConfigService<{ admin: AdminConfig }, true>,
  ) {
    super();
    this.retentionDays = config.get('admin', {
      infer: true,
    }).limits.requestLogRetentionDays;
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case JOBS.partitions:
        return { created: await this.ensurePartitions() };
      case JOBS.retention:
        return {
          dropped: await this.dropExpiredPartitions(),
          expiredExports: await this.expireExports(),
        };
      case JOBS.geoipRefresh:
        return { reloaded: await this.geoip.load() };
      case JOBS.slaSweep:
        return { overdue: await this.senderIds.sweepSlaBreaches() };
      default:
        this.logger.warn(`Unknown maintenance job ${job.name}`);
        return null;
    }
  }

  /**
   * Daily partitions for the request log. Creating them ahead of time matters: an
   * insert into a partitioned table with no matching partition fails outright.
   */
  private async ensurePartitions(): Promise<number> {
    let created = 0;

    for (let offset = 0; offset <= PARTITION_LOOKAHEAD_DAYS; offset += 1) {
      const day = DateTime.now()
        .setZone(LAGOS)
        .plus({ days: offset })
        .startOf('day');
      const name = `request_logs_${day.toFormat('yyyy_LL_dd')}`;

      await this.admin.$executeRaw`
        SELECT create_request_log_partition(${name}, ${day.toJSDate()}, ${day.plus({ days: 1 }).toJSDate()})
      `;
      created += 1;
    }

    return created;
  }

  /** Raw request logs are kept 90 days, dropped by partition rather than by DELETE. */
  private async dropExpiredPartitions(): Promise<string[]> {
    const cutoff = DateTime.now()
      .setZone(LAGOS)
      .minus({ days: this.retentionDays })
      .startOf('day');

    const partitions = await this.admin.$queryRaw<{ tablename: string }[]>`
      SELECT c.relname AS tablename
      FROM pg_class c
      JOIN pg_inherits i ON i.inhrelid = c.oid
      JOIN pg_class parent ON parent.oid = i.inhparent
      WHERE parent.relname = 'request_logs'
    `;

    const dropped: string[] = [];
    for (const partition of partitions) {
      const match = partition.tablename.match(
        /^request_logs_(\d{4})_(\d{2})_(\d{2})$/,
      );
      if (!match) continue;

      const day = DateTime.fromObject(
        {
          year: Number(match[1]),
          month: Number(match[2]),
          day: Number(match[3]),
        },
        { zone: LAGOS },
      );
      if (day >= cutoff) continue;

      // Identifier, not a value, so it cannot be a bound parameter — hence the regex
      // above, which is what makes this safe.
      await this.admin.$executeRaw(
        Prisma.sql`DROP TABLE IF EXISTS ${Prisma.raw(`"${partition.tablename}"`)}`,
      );
      dropped.push(partition.tablename);
    }

    if (dropped.length)
      this.logger.log(
        `Dropped ${dropped.length} expired request log partitions`,
      );
    return dropped;
  }

  /** Export links expire after 24 hours; the rows stay for the audit trail. */
  private async expireExports(): Promise<number> {
    const result = await this.admin.exportJob.updateMany({
      where: { status: 'READY', expiresAt: { lt: new Date() } },
      data: { status: 'EXPIRED' },
    });
    return result.count;
  }
}
