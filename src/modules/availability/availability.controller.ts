import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  CurrentStaff,
  Idempotent,
  RequirePermissions,
} from '../../common/auth/decorators';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import { AvailabilityService } from './availability.service';
import { ChangeAvailabilityDto } from './dto/availability.dto';

@Controller('availability')
@RequirePermissions('availability.manage')
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get()
  list() {
    return this.availability.list();
  }

  /** Creates, changes and removes rules together, as one audited change. */
  @Post()
  @Idempotent()
  change(
    @CurrentStaff() staff: StaffPrincipal,
    @Body() dto: ChangeAvailabilityDto,
  ) {
    return this.availability.change(staff, dto);
  }
}
