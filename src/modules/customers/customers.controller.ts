import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  Audited,
  CurrentStaff,
  Idempotent,
  RequirePermissions,
  SensitiveWrite,
} from '../../common/auth/decorators';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import {
  CursorPageDto,
  DateRangePageDto,
  ReasonDto,
} from '../../common/dto/common.dto';
import { CustomersService } from './customers.service';
import { CustomerActionsService } from './customer-actions.service';
import {
  ChangePlanDto,
  CreateNoteDto,
  CreateRiskFlagDto,
  CustomerUsageDto,
  RevealPiiDto,
  RevokeKeyDto,
  SearchCustomersDto,
  SuspendCustomerDto,
} from './dto/customers.dto';

@Controller('customers')
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly actions: CustomerActionsService,
  ) {}

  @Get()
  @RequirePermissions('customers.read')
  search(@Query() query: SearchCustomersDto) {
    return this.customers.search(query);
  }

  @Get(':id')
  @RequirePermissions('customers.read')
  get(@Param('id') id: string) {
    return this.customers.get(id);
  }

  @Get(':id/usage')
  @RequirePermissions('customers.read')
  usage(@Param('id') id: string, @Query() query: CustomerUsageDto) {
    return this.customers.usage(id, query);
  }

  @Get(':id/ledger')
  @RequirePermissions('customers.read')
  ledger(@Param('id') id: string, @Query() query: DateRangePageDto) {
    return this.customers.ledger(id, query);
  }

  @Get(':id/requests')
  @RequirePermissions('customers.read')
  requests(
    @Param('id') id: string,
    @Query() query: DateRangePageDto,
    @CurrentStaff() staff: StaffPrincipal,
  ) {
    return this.customers.requests(
      id,
      query,
      staff.permissions.includes('pii.reveal'),
    );
  }

  // ---------------------------------------------------------------- actions

  @Post(':id/suspend')
  @SensitiveWrite(
    { action: 'customers.suspend', targetType: 'account', targetParam: 'id' },
    'customers.manage',
  )
  suspend(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Body() dto: SuspendCustomerDto,
    @Req() req: Request,
  ) {
    return this.actions.suspend(
      staff,
      id,
      dto.reason,
      req.get('idempotency-key'),
    );
  }

  @Post(':id/reactivate')
  @RequirePermissions('customers.manage')
  @Idempotent()
  reactivate(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Body() dto: ReasonDto,
    @Req() req: Request,
  ) {
    return this.actions.reactivate(
      staff,
      id,
      dto.reason,
      req.get('idempotency-key'),
    );
  }

  @Post(':id/force-logout')
  @RequirePermissions('customers.manage')
  @Idempotent()
  forceLogout(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Body() dto: ReasonDto,
    @Req() req: Request,
  ) {
    return this.actions.forceLogout(
      staff,
      id,
      dto.reason,
      req.get('idempotency-key'),
    );
  }

  @Post(':id/revoke-key')
  @RequirePermissions('customers.manage')
  @Idempotent()
  revokeKey(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Body() dto: RevokeKeyDto,
    @Req() req: Request,
  ) {
    return this.actions.revokeApiKey(
      staff,
      id,
      dto.apiKeyId,
      dto.reason,
      req.get('idempotency-key'),
    );
  }

  @Post(':id/change-plan')
  @RequirePermissions('customers.manage')
  @Idempotent()
  changePlan(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Body() dto: ChangePlanDto,
    @Req() req: Request,
  ) {
    return this.actions.changePlan(
      staff,
      id,
      dto.planId,
      dto.reason,
      req.get('idempotency-key'),
    );
  }

  @Post(':id/reset-rate-limits')
  @RequirePermissions('customers.manage')
  @Idempotent()
  resetRateLimits(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Body() dto: ReasonDto,
    @Req() req: Request,
  ) {
    return this.actions.resetRateLimits(
      staff,
      id,
      dto.reason,
      req.get('idempotency-key'),
    );
  }

  // ---------------------------------------------------------------- PII

  /** Rate limited per staff member: a reveal loop is how a console becomes a data leak. */
  @Post(':id/reveal')
  @RequirePermissions('pii.reveal')
  @Throttle({ pii: { limit: 20, ttl: 60_000 } })
  reveal(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Body() dto: RevealPiiDto,
  ) {
    return this.customers.revealPii(staff, id, dto);
  }

  // ---------------------------------------------------------------- annotations

  @Get(':id/notes')
  @RequirePermissions('customers.read')
  listNotes(@Param('id') id: string, @Query() query: CursorPageDto) {
    return this.customers.listNotes(id, query);
  }

  @Post(':id/notes')
  @RequirePermissions('customers.notes')
  addNote(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Body() dto: CreateNoteDto,
  ) {
    return this.customers.addNote(staff, id, dto.body, dto.pinned);
  }

  @Post(':id/risk-flags')
  @RequirePermissions('customers.manage')
  @Audited({
    action: 'customers.risk_flag_raised',
    targetType: 'account',
    targetParam: 'id',
  })
  raiseFlag(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Body() dto: CreateRiskFlagDto,
  ) {
    return this.actions.raiseFlag(staff, id, dto);
  }

  @Post('risk-flags/:flagId/resolve')
  @RequirePermissions('customers.manage')
  resolveFlag(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('flagId') flagId: string,
    @Body() dto: ReasonDto,
  ) {
    return this.actions.resolveFlag(staff, flagId, dto.reason);
  }
}
