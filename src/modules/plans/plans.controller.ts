import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  CurrentStaff,
  Idempotent,
  RequirePermissions,
} from '../../common/auth/decorators';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import { PlansService } from './plans.service';
import { CatalogueService } from './catalogue.service';
import { ReasonDto } from '../../common/dto/common.dto';
import {
  UpsertPlanDto,
  UpsertProductDto,
  UpsertProductPricingDto,
} from './dto/catalogue.dto';
import { ListProviderCostsDto } from './dto/list-provider-costs.dto';
import {
  ListPricingDto,
  SetMarginTargetDto,
  UpsertProviderCostDto,
} from './dto/plans.dto';

@Controller()
export class PlansController {
  constructor(
    private readonly plans: PlansService,
    private readonly catalogue: CatalogueService,
  ) {}

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
    return this.catalogue.upsertPlan(staff, dto);
  }

  @Patch('plans/:id')
  @RequirePermissions('plans.manage')
  updatePlan(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Body() dto: UpsertPlanDto,
  ) {
    return this.catalogue.upsertPlan(staff, { ...dto, id });
  }

  @Post('plans/:id/retire')
  @RequirePermissions('plans.manage')
  retirePlan(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Body() dto: ReasonDto,
  ) {
    return this.catalogue.setPlanActive(staff, id, false, dto.reason);
  }

  @Post('plans/:id/activate')
  @RequirePermissions('plans.manage')
  activatePlan(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Body() dto: ReasonDto,
  ) {
    return this.catalogue.setPlanActive(staff, id, true, dto.reason);
  }

  // ---------------------------------------------------------------- products

  @Get('products')
  @RequirePermissions('metrics.read')
  listProducts() {
    return this.catalogue.listProducts();
  }

  @Post('products')
  @RequirePermissions('plans.manage')
  @Idempotent()
  createProduct(
    @CurrentStaff() staff: StaffPrincipal,
    @Body() dto: UpsertProductDto,
  ) {
    return this.catalogue.createProduct(staff, dto);
  }

  /** The channel is immutable; changing it means a different product. */
  @Patch('products/:id')
  @RequirePermissions('plans.manage')
  updateProduct(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Body() dto: UpsertProductDto,
  ) {
    return this.catalogue.updateProduct(staff, id, dto);
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
    @Body() dto: UpsertProductPricingDto,
  ) {
    return this.catalogue.upsertPricing(staff, dto);
  }

  @Get('provider-costs')
  @RequirePermissions('finance.read')
  listProviderCosts(@Query() query: ListProviderCostsDto) {
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
