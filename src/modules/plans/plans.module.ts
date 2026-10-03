import { Module } from '@nestjs/common';
import { PlansController } from './plans.controller';
import { PlansService } from './plans.service';
import { CatalogueService } from './catalogue.service';

@Module({
  controllers: [PlansController],
  providers: [PlansService, CatalogueService],
  exports: [PlansService, CatalogueService],
})
export class PlansModule {}
