import { Module } from '@nestjs/common';
import { InboxModule } from '../inbox/inbox.module';
import { RiskService } from './risk.service';

@Module({
  imports: [InboxModule],
  providers: [RiskService],
  exports: [RiskService],
})
export class RiskModule {}
