import { Controller, Get, Query } from '@nestjs/common';
import { RequirePermissions } from '../../common/auth/decorators';
import { DateRangeDto } from '../../common/dto/common.dto';
import { OverviewService } from './overview.service';

@Controller('overview')
@RequirePermissions('metrics.read')
export class OverviewController {
  constructor(private readonly overview: OverviewService) {}

  @Get('kpis')
  kpis(@Query() query: DateRangeDto) {
    return this.overview.kpis(query);
  }

  @Get('timeseries')
  timeseries(@Query() query: DateRangeDto) {
    return this.overview.timeseries(query);
  }

  @Get('health')
  health() {
    return this.overview.health();
  }
}
