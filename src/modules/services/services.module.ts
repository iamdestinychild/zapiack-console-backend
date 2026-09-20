import { Module } from '@nestjs/common';
import { InboxModule } from '../inbox/inbox.module';
import { ProviderHealthService } from './provider-health.service';
import { ServicesController } from './services.controller';
import { ServicesService } from './services.service';

@Module({
  imports: [InboxModule],
  controllers: [ServicesController],
  providers: [ServicesService, ProviderHealthService],
  exports: [ServicesService, ProviderHealthService],
})
export class ServicesModule {}
