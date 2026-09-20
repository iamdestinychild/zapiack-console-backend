import { Module } from '@nestjs/common';
import { InboxController } from './inbox.controller';
import { NotificationsGateway } from './notifications.gateway';

@Module({
  controllers: [InboxController],
  providers: [NotificationsGateway],
  exports: [NotificationsGateway],
})
export class InboxModule {}
