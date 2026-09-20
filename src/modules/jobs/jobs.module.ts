import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { FinanceModule } from '../finance/finance.module';
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
 * The worker side of admin-core. In a deployment that separates web and worker
 * processes, this module is what the worker runs.
 */
@Module({
  imports: [
    BullModule.registerQueue(
      { name: QUEUES.rollups },
      { name: QUEUES.maintenance },
      { name: QUEUES.events },
      { name: QUEUES.exports },
    ),
    RollupsModule,
    FinanceModule,
    ServicesModule,
    RiskModule,
    SenderIdsModule,
  ],
  providers: [
    SchedulerService,
    RollupsProcessor,
    MaintenanceProcessor,
    ExportsProcessor,
  ],
})
export class JobsModule {}
