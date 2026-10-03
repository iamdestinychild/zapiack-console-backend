import { Module } from '@nestjs/common';
import { InboxModule } from '../inbox/inbox.module';
import { DiagnosticsController } from './diagnostics.controller';
import { DiagnosticsService } from './diagnostics.service';
import { ProviderHealthService } from './provider-health.service';
import { ServicesController } from './services.controller';
import { ServicesService } from './services.service';

@Module({
  imports: [InboxModule],
  controllers: [ServicesController, DiagnosticsController],
  providers: [ServicesService, ProviderHealthService, DiagnosticsService],
  exports: [ServicesService, ProviderHealthService],
})
export class ServicesModule {}
