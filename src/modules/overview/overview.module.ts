import { Module } from '@nestjs/common';
import { OverviewController } from './overview.controller';
import { OverviewService } from './overview.service';
import { ActivityService } from './activity.service';

@Module({
  controllers: [OverviewController],
  providers: [OverviewService, ActivityService],
})
export class OverviewModule {}
