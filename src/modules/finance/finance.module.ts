import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QUEUES } from '../jobs/queues';
import { InboxModule } from '../inbox/inbox.module';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';
import { ReconciliationService } from './reconciliation.service';
import { ExportsService } from './exports.service';

@Module({
  imports: [BullModule.registerQueue({ name: QUEUES.exports }), InboxModule],
  controllers: [FinanceController],
  providers: [FinanceService, ReconciliationService, ExportsService],
  exports: [FinanceService, ReconciliationService, ExportsService],
})
export class FinanceModule {}
