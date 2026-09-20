import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentStaff,
  Idempotent,
  RequirePermissions,
  SensitiveWrite,
} from '../../common/auth/decorators';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import { CursorPageDto, ReasonDto } from '../../common/dto/common.dto';
import { CreditAdjustmentDto } from '../customers/dto/customers.dto';
import { CreditsService } from './credits.service';

@Controller()
export class CreditsController {
  constructor(private readonly credits: CreditsService) {}

  @Post('customers/:id/credit-adjustments')
  @SensitiveWrite(
    { action: 'credits.adjust', targetType: 'account', targetParam: 'id' },
    'credits.adjust',
  )
  request(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Body() dto: CreditAdjustmentDto,
  ) {
    return this.credits.request(staff, id, dto);
  }

  @Get('credit-adjustments')
  @RequirePermissions('credits.adjust')
  list(
    @Query() query: CursorPageDto & { accountId?: string; status?: string },
  ) {
    return this.credits.list(query);
  }

  @Post('credit-adjustments/:id/approve')
  @RequirePermissions('credits.approve')
  @Idempotent()
  approve(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Body() dto: ReasonDto,
  ) {
    return this.credits.approve(staff, id, dto.reason);
  }

  @Post('credit-adjustments/:id/reject')
  @RequirePermissions('credits.approve')
  reject(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Body() dto: ReasonDto,
  ) {
    return this.credits.reject(staff, id, dto.reason);
  }

  @Post('credit-adjustments/:id/retry')
  @RequirePermissions('credits.approve')
  retry(@CurrentStaff() staff: StaffPrincipal, @Param('id') id: string) {
    return this.credits.retry(staff, id);
  }
}
