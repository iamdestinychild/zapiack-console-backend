import { Controller, Get, Param, Query } from '@nestjs/common';
import { RequirePermissions } from '../../common/auth/decorators';
import { DateRangeDto } from '../../common/dto/common.dto';
import { ServicesService } from './services.service';
import { ProviderHealthService } from './provider-health.service';

@Controller()
@RequirePermissions('metrics.read')
export class ServicesController {
  constructor(
    private readonly services: ServicesService,
    private readonly providerHealth: ProviderHealthService,
  ) {}

  @Get('services')
  list(@Query() query: DateRangeDto) {
    return this.services.list(query);
  }

  @Get('services/:service/metrics')
  metrics(@Param('service') service: string, @Query() query: DateRangeDto) {
    return this.services.metrics(service, query);
  }

  @Get('providers/health')
  health() {
    return this.providerHealth.current();
  }
}
