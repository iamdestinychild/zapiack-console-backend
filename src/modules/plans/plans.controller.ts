import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  CurrentStaff,
  Idempotent,
  RequirePermissions,
} from '../../common/auth/decorators';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import { PlansService } from './plans.service';
import {
  ListPricingDto,
  SetMarginTargetDto,
  UpsertPlanDto,
  UpsertPricingDto,
  UpsertProviderCostDto,
} from './dto/plans.dto';

@Controller()
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get('plans')
  @RequirePermissions('metrics.read')
  listPlans() {
    return this.plans.listPlans();
  }

  @Post('plans')
  @RequirePermissions('plans.manage')
  @Idempotent()
  upsertPlan(
    @CurrentStaff() staff: StaffPrincipal,
    @Body() dto: UpsertPlanDto,
  ) {
    return this.plans.upsertPlan(staff, dto);
  }

  @Get('pricing')
  @RequirePermissions('metrics.read')
  listPricing(@Query() query: ListPricingDto) {
    return this.plans.listPricing(query);
  }

  @Post('pricing')
  @RequirePermissions('pricing.manage')
  @Idempotent()
  upsertPricing(
    @CurrentStaff() staff: StaffPrincipal,
    @Body() dto: UpsertPricingDto,
  ) {
    return this.plans.upsertPricing(staff, dto);
  }

  @Get('provider-costs')
  @RequirePermissions('finance.read')
  listProviderCosts(
    @Query()
    query: {
      channel?: string;
      provider?: string;
      includeHistory?: boolean;
    },
  ) {
    return this.plans.listProviderCosts(query);
  }

  @Post('provider-costs')
  @RequirePermissions('pricing.manage')
  @Idempotent()
  upsertProviderCost(
    @CurrentStaff() staff: StaffPrincipal,
    @Body() dto: UpsertProviderCostDto,
  ) {
    return this.plans.upsertProviderCost(staff, dto);
  }

  @Post('margin-targets')
  @RequirePermissions('pricing.manage')
  setMarginTarget(
    @CurrentStaff() staff: StaffPrincipal,
    @Body() dto: SetMarginTargetDto,
  ) {
    return this.plans.setMarginTarget(staff, dto);
  }
}
