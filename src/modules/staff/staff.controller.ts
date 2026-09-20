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
  Audited,
  CurrentStaff,
  Idempotent,
  RequirePermissions,
} from '../../common/auth/decorators';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import { StaffService } from './staff.service';
import {
  InviteStaffDto,
  ListStaffDto,
  UpdateStaffDto,
  UpsertRoleDto,
} from './dto/staff.dto';

@Controller()
@RequirePermissions('staff.manage')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get('staff')
  list(@Query() query: ListStaffDto) {
    return this.staff.list(query);
  }

  @Post('staff')
  @Idempotent()
  invite(@CurrentStaff() actor: StaffPrincipal, @Body() dto: InviteStaffDto) {
    return this.staff.invite(actor, dto);
  }

  @Patch('staff/:id')
  update(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() dto: UpdateStaffDto,
  ) {
    return this.staff.update(actor, id, dto);
  }

  @Post('staff/invites/:id/revoke')
  @Audited({
    action: 'staff.invite_revoked',
    targetType: 'staff_invite',
    targetParam: 'id',
  })
  revokeInvite(@CurrentStaff() actor: StaffPrincipal, @Param('id') id: string) {
    return this.staff.revokeInvite(actor, id);
  }

  @Get('roles')
  listRoles() {
    return this.staff.listRoles();
  }

  @Get('roles/permissions')
  permissions() {
    return this.staff.permissionCatalogue();
  }

  @Post('roles')
  upsertRole(
    @CurrentStaff() actor: StaffPrincipal,
    @Body() dto: UpsertRoleDto,
  ) {
    return this.staff.upsertRole(actor, dto);
  }
}
