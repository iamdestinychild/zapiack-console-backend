import { Controller, Get, Query } from '@nestjs/common';
import { RequirePermissions } from '../../common/auth/decorators';
import { DateRangeDto } from '../../common/dto/common.dto';
import { OverviewService } from './overview.service';
import { ActivityService } from './activity.service';

@Controller('overview')
@RequirePermissions('metrics.read')
export class OverviewController {
  constructor(
    private readonly overview: OverviewService,
    private readonly activity: ActivityService,
  ) {}

  @Get('kpis')
  kpis(@Query() query: DateRangeDto) {
    return this.overview.kpis(query);
  }

  @Get('timeseries')
  timeseries(@Query() query: DateRangeDto) {
    return this.overview.timeseries(query);
  }

  /** What just happened across payments, sign-ups, sender IDs, flags and providers. */
  @Get('activity')
  recentActivity() {
    return this.activity.recent();
  }

  @Get('health')
  health() {
    return this.overview.health();
  }
}
