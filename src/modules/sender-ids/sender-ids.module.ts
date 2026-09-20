import { Module } from '@nestjs/common';
import { InboxModule } from '../inbox/inbox.module';
import { DocumentsService } from './documents.service';
import { SenderIdsController } from './sender-ids.controller';
import { SenderIdsService } from './sender-ids.service';

@Module({
  imports: [InboxModule],
  controllers: [SenderIdsController],
  providers: [SenderIdsService, DocumentsService],
  exports: [SenderIdsService],
})
export class SenderIdsModule {}
