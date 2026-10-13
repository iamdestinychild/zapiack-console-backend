import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentStaff,
  Idempotent,
  RequirePermissions,
} from '../../common/auth/decorators';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import { ReasonDto } from '../../common/dto/common.dto';
import { ListTemplatesDto } from './dto/templates.dto';
import { TemplatesService } from './templates.service';

/**
 * Review of the email templates customers submit. A customer can only send a template
 * once it is APPROVED, so this queue is a list of people who are waiting.
 */
@Controller('templates')
@RequirePermissions('templates.review')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  /** Defaults to the review queue; `?status=DRAFT` lists templates not yet submitted. */
  @Get()
  list(@Query() query: ListTemplatesDto) {
    return this.templates.list(query);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.templates.get(id);
  }

  /** Allows sending. Works on submitted, flagged and (deliberately) draft templates. */
  @Post(':id/approve')
  @Idempotent()
  approve(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Body() dto: ReasonDto,
  ) {
    return this.templates.approve(staff, id, dto.reason);
  }

  /** Refuses a template. The reason is shown to the customer. */
  @Post(':id/reject')
  @Idempotent()
  reject(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Body() dto: ReasonDto,
  ) {
    return this.templates.reject(staff, id, dto.reason);
  }

  /** Withdraws an approval; the customer can no longer send it. The reason is shown to them. */
  @Post(':id/revoke')
  @Idempotent()
  revoke(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Body() dto: ReasonDto,
  ) {
    return this.templates.revoke(staff, id, dto.reason);
  }
}
