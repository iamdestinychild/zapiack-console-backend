import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QUEUES } from '../jobs/queues';
import { InboxModule } from '../inbox/inbox.module';
import { CampaignsService } from './campaigns.service';
import { NotificationsController } from './notifications.controller';
import { SegmentsService } from './segments.service';

@Module({
  imports: [BullModule.registerQueue({ name: QUEUES.campaigns }), InboxModule],
  controllers: [NotificationsController],
  providers: [CampaignsService, SegmentsService],
  exports: [CampaignsService, SegmentsService],
})
export class NotificationsModule {}
