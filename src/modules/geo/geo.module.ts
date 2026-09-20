import { Module } from '@nestjs/common';
import { GeoController } from './geo.controller';
import { GeoService } from './geo.service';
import { RequestIngestWorker } from './request-ingest.worker';

@Module({
  controllers: [GeoController],
  providers: [GeoService, RequestIngestWorker],
  exports: [GeoService],
})
export class GeoModule {}
