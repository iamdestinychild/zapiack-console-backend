import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QUEUES } from '../jobs/queues';
import { InboxModule } from '../inbox/inbox.module';
import { SenderIdsModule } from '../sender-ids/sender-ids.module';
import { EventsController } from './events.controller';
import { EventsProcessor } from './events.processor';
import { EventsService } from './events.service';

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUES.events }),
    SenderIdsModule,
    InboxModule,
  ],
  controllers: [EventsController],
  providers: [EventsService, EventsProcessor],
  exports: [EventsService],
})
export class EventsModule {}
