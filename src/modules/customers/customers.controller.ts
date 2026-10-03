import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
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
  LedgerQueryDto,
  RevealPiiDto,
  SetAccountStatusDto,
  SetApiKeyActiveDto,
  ArchiveProjectDto,
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
  ledger(@Param('id') id: string, @Query() query: LedgerQueryDto) {
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
    'customers.suspend',
  )
  suspend(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Body() dto: SuspendCustomerDto,
  ) {
    return this.actions.suspend(staff, id, dto.reason);
  }

  @Post(':id/reactivate')
  @RequirePermissions('customers.manage')
  @Idempotent()
  reactivate(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Body() dto: ReasonDto,
  ) {
    return this.actions.reactivate(staff, id, dto.reason);
  }

  /** Ends the relationship. Refused while the account still holds credits. */
  @Post(':id/ban')
  @SensitiveWrite(
    { action: 'customers.ban', targetType: 'account', targetParam: 'id' },
    'customers.suspend',
  )
  ban(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Body() dto: ReasonDto,
  ) {
    return this.actions.ban(staff, id, dto.reason);
  }

  /** Any transition in one call, for states without a dedicated route. */
  @Patch(':id/status')
  @SensitiveWrite(
    {
      action: 'customers.status_changed',
      targetType: 'account',
      targetParam: 'id',
    },
    'customers.suspend',
  )
  setStatus(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Body() dto: SetAccountStatusDto,
  ) {
    return this.actions.setStatus(staff, id, dto.status, dto.reason);
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

  @Patch(':id/api-keys')
  @SensitiveWrite(
    {
      action: 'customers.revoke_key',
      targetType: 'api_key',
      targetParam: 'id',
    },
    'customers.manage',
  )
  setApiKeyActive(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Body() dto: SetApiKeyActiveDto,
  ) {
    return this.actions.setApiKeyActive(
      staff,
      id,
      dto.apiKeyId,
      dto.isActive,
      dto.reason,
    );
  }

  @Post(':id/projects/archive')
  @SensitiveWrite(
    {
      action: 'customers.project_archived',
      targetType: 'project',
      targetParam: 'id',
    },
    'customers.manage',
  )
  archiveProject(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Body() dto: ArchiveProjectDto,
  ) {
    return this.actions.archiveProject(staff, id, dto.projectId, dto.reason);
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
