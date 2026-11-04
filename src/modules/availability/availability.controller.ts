import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  CurrentStaff,
  Idempotent,
  RequirePermissions,
} from '../../common/auth/decorators';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import { ReasonDto } from '../../common/dto/common.dto';
import { AvailabilityService } from './availability.service';
import { SetAvailabilityDto } from './dto/availability.dto';

@Controller('availability')
@RequirePermissions('availability.manage')
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get()
  list() {
    return this.availability.list();
  }

  /** Creates the rule, or changes the one for the same account country, service and destination. */
  @Post()
  @Idempotent()
  set(@CurrentStaff() staff: StaffPrincipal, @Body() dto: SetAvailabilityDto) {
    return this.availability.set(staff, dto);
  }

  @Delete(':id')
  remove(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Query() query: ReasonDto,
  ) {
    return this.availability.remove(staff, id, query.reason);
  }
}
