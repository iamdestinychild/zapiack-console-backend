import { Module } from '@nestjs/common';
import { GeoController } from './geo.controller';
import { GeoService } from './geo.service';
import { CustomerNames } from './customer-names';

@Module({
  controllers: [GeoController],
  providers: [GeoService, CustomerNames],
  exports: [GeoService, CustomerNames],
})
export class GeoModule {}
