import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentStaff,
  Idempotent,
  RequirePermissions,
} from '../../common/auth/decorators';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import { CursorPageDto, ReasonDto } from '../../common/dto/common.dto';
import { CampaignsService } from './campaigns.service';
import { SegmentsService } from './segments.service';
import {
  ApproveCampaignDto,
  CreateCampaignDto,
  ScheduleCampaignDto,
  SegmentFilterDto,
  UpsertSegmentDto,
  UpsertTemplateDto,
} from './dto/notifications.dto';

@Controller()
export class NotificationsController {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly segments: SegmentsService,
  ) {}

  // ---------------------------------------------------------------- campaigns

  @Get('campaigns')
  @RequirePermissions('notifications.send')
  list(@Query() query: CursorPageDto & { status?: string }) {
    return this.campaigns.list(query);
  }

  @Get('campaigns/:id')
  @RequirePermissions('notifications.send')
  get(@Param('id') id: string) {
    return this.campaigns.get(id);
  }

  @Post('campaigns')
  @RequirePermissions('notifications.send')
  @Idempotent()
  create(
    @CurrentStaff() staff: StaffPrincipal,
    @Body() dto: CreateCampaignDto,
  ) {
    return this.campaigns.create(staff, dto);
  }

  @Post('campaigns/:id/test')
  @RequirePermissions('notifications.send')
  test(@CurrentStaff() staff: StaffPrincipal, @Param('id') id: string) {
    return this.campaigns.testSend(staff, id);
  }

  /** Super admin only; enforced in the service, not just by permission. */
  @Post('campaigns/:id/approve')
  @RequirePermissions('notifications.broadcast')
  approve(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Body() dto: ApproveCampaignDto,
  ) {
    return this.campaigns.approve(staff, id, dto.reason);
  }

  @Post('campaigns/:id/schedule')
  @RequirePermissions('notifications.send')
  @Idempotent()
  schedule(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Body() dto: ScheduleCampaignDto,
  ) {
    return this.campaigns.schedule(staff, id, dto);
  }

  @Post('campaigns/:id/cancel')
  @RequirePermissions('notifications.send')
  cancel(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Body() dto: ReasonDto,
  ) {
    return this.campaigns.cancel(staff, id, dto.reason);
  }

  // ---------------------------------------------------------------- segments

  @Get('segments')
  @RequirePermissions('notifications.segments')
  listSegments() {
    return this.segments.list();
  }

  @Post('segments')
  @RequirePermissions('notifications.segments')
  upsertSegment(
    @CurrentStaff() staff: StaffPrincipal,
    @Body() dto: UpsertSegmentDto,
  ) {
    return this.segments.upsert(staff, dto);
  }

  @Post('segments/preview')
  @RequirePermissions('notifications.segments')
  previewSegment(@Body() filter: SegmentFilterDto) {
    return this.segments.preview(filter);
  }

  // ---------------------------------------------------------------- templates

  @Get('templates')
  @RequirePermissions('notifications.send')
  listTemplates() {
    return this.campaigns.listTemplates();
  }

  @Post('templates')
  @RequirePermissions('notifications.send')
  upsertTemplate(
    @CurrentStaff() staff: StaffPrincipal,
    @Body() dto: UpsertTemplateDto,
  ) {
    return this.campaigns.upsertTemplate(staff, dto);
  }
}
