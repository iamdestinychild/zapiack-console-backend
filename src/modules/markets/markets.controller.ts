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
import { SetBillingMarketDto } from './dto/markets.dto';
import { MarketsService } from './markets.service';

/** Money settings, so they sit behind the same permission as pricing. */
@Controller('markets')
@RequirePermissions('pricing.manage')
export class MarketsController {
  constructor(private readonly markets: MarketsService) {}

  @Get()
  list() {
    return this.markets.list();
  }

  /** Creates the row for a country, or changes the one it already has. */
  @Post()
  @Idempotent()
  set(@CurrentStaff() staff: StaffPrincipal, @Body() dto: SetBillingMarketDto) {
    return this.markets.set(staff, dto);
  }

  @Delete(':id')
  remove(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Query() query: ReasonDto,
  ) {
    return this.markets.remove(staff, id, query.reason);
  }
}
