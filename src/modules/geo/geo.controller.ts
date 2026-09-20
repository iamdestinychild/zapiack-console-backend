import { Controller, Get, Query, Sse } from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import { CurrentStaff, RequirePermissions } from '../../common/auth/decorators';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import { SseService } from '../../common/sse/sse.service';
import { GeoService } from './geo.service';
import { GeoRequestsDto, RequestLogDto } from './dto/geo.dto';

@Controller('geo')
@RequirePermissions('geo.view')
export class GeoController {
  constructor(
    private readonly geo: GeoService,
    private readonly sse: SseService,
  ) {}

  @Get('requests')
  requests(@Query() query: GeoRequestsDto) {
    return this.geo.requests(query);
  }

  @Get('signins')
  signIns(
    @Query() query: GeoRequestsDto,
    @CurrentStaff() staff: StaffPrincipal,
  ) {
    return this.geo.signIns(query, staff.permissions.includes('pii.reveal'));
  }

  @Get('destinations')
  destinations(@Query() query: GeoRequestsDto) {
    return this.geo.destinations(query);
  }

  @Get('request-log')
  requestLog(
    @Query() query: RequestLogDto,
    @CurrentStaff() staff: StaffPrincipal,
  ) {
    return this.geo.requestLog(query, staff.permissions.includes('pii.reveal'));
  }

  /**
   * The live map. Dots arrive already sampled by the ingest worker; raw IPs are
   * stripped here for anyone without pii.reveal, so the stream itself is safe to open.
   */
  @Sse('live')
  live(
    @CurrentStaff() staff: StaffPrincipal,
  ): Observable<{ data: unknown; type: string }> {
    const canSeeRawIp = staff.permissions.includes('pii.reveal');
    return this.sse.subscribe('geo:live').pipe(
      map((message) => {
        if (canSeeRawIp || !Array.isArray(message.data)) return message;
        return {
          ...message,
          // Drop the raw IP for viewers without pii.reveal; city-level detail stays.
          data: (message.data as Record<string, unknown>[]).map((dot) => {
            const withoutIp = { ...dot };
            delete withoutIp.ip;
            return withoutIp;
          }),
        };
      }),
    );
  }
}
