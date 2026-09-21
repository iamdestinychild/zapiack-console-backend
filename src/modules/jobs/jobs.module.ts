import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { EventsModule } from '../events/events.module';
import { EventsProcessor } from '../events/events.processor';
import { FinanceModule } from '../finance/finance.module';
import { InboxModule } from '../inbox/inbox.module';
import { RequestIngestWorker } from '../geo/request-ingest.worker';
import { NotificationsModule } from '../notifications/notifications.module';
import { CampaignProcessor } from '../notifications/campaign.processor';
import { RiskModule } from '../risk/risk.module';
import { RollupsModule } from '../rollups/rollups.module';
import { SenderIdsModule } from '../sender-ids/sender-ids.module';
import { ServicesModule } from '../services/services.module';
import { ExportsProcessor } from './exports.processor';
import { MaintenanceProcessor } from './maintenance.processor';
import { RollupsProcessor } from './rollups.processor';
import { SchedulerService } from './scheduler.service';
import { QUEUES } from './queues';

/**
 * Everything that runs on a timer or off a queue, gathered in one place.
 *
 * AppModule imports this only when ADMIN_ROLE is `worker` or `all`. A `web` process
 * still enqueues jobs — the queues are registered by the feature modules that write
 * to them — but consumes none, so a heavy rollup cannot slow a staff member's request.
 */
@Module({
  imports: [
    ScheduleModule.forRoot(),
    BullModule.registerQueue(
      { name: QUEUES.rollups },
      { name: QUEUES.maintenance },
      { name: QUEUES.events },
      { name: QUEUES.exports },
      { name: QUEUES.campaigns },
    ),
    RollupsModule,
    FinanceModule,
    ServicesModule,
    RiskModule,
    SenderIdsModule,
    NotificationsModule,
    EventsModule,
    // Processors raise staff alerts: SLA breaches, outages, reconciliation variances.
    InboxModule,
  ],
  providers: [
    SchedulerService,
    RollupsProcessor,
    MaintenanceProcessor,
    ExportsProcessor,
    CampaignProcessor,
    EventsProcessor,
    RequestIngestWorker,
  ],
})
export class JobsModule {}
