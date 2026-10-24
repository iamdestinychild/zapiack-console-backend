import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  CurrentStaff,
  Idempotent,
  RequirePermissions,
} from '../../common/auth/decorators';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import { SenderIdsService } from './sender-ids.service';
import { DocumentsService } from './documents.service';
import {
  AssignReviewDto,
  DecisionDto,
  DocumentUrlDto,
  ListSenderIdsDto,
  UpdateChecklistDto,
} from './dto/sender-ids.dto';

@Controller('sender-ids')
export class SenderIdsController {
  constructor(
    private readonly senderIds: SenderIdsService,
    private readonly documents: DocumentsService,
  ) {}

  @Get()
  @RequirePermissions('senderid.review')
  list(@Query() query: ListSenderIdsDto) {
    return this.senderIds.list(query);
  }

  /** Applications customers have started but not submitted. Read-only; nothing to decide yet. */
  @Get('drafts')
  @RequirePermissions('senderid.review')
  drafts(@Query() query: ListSenderIdsDto) {
    return this.senderIds.drafts(query);
  }

  /** @deprecated The old name for `drafts`. */
  @Get('unfiled')
  @RequirePermissions('senderid.review')
  unfiled() {
    return this.senderIds.unfiled();
  }

  @Get(':id')
  @RequirePermissions('senderid.review')
  get(@Param('id') id: string) {
    return this.senderIds.get(id);
  }

  @Post(':id/assign')
  @RequirePermissions('senderid.review')
  assign(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Body() dto: AssignReviewDto,
  ) {
    return this.senderIds.assign(staff, id, dto.assigneeId);
  }

  @Post(':id/checklist')
  @RequirePermissions('senderid.review')
  checklist(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Body() dto: UpdateChecklistDto,
  ) {
    return this.senderIds.updateChecklist(staff, id, dto);
  }

  @Post(':id/decision')
  @RequirePermissions('senderid.review')
  @Idempotent()
  decide(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Body() dto: DecisionDto,
  ) {
    return this.senderIds.decide(staff, id, dto);
  }

  // ---------------------------------------------------------------- documents

  /** Bulk document pulls are exactly what to notice, so each one is audited. */
  @Get(':id/documents/:docId/url')
  @RequirePermissions('senderid.documents.download')
  documentUrl(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Param('docId') docId: string,
    @Query() query: DocumentUrlDto,
  ) {
    return this.documents.resolve(
      staff,
      id,
      docId,
      query.disposition ?? 'attachment',
    );
  }

  @Get(':id/documents.zip')
  @RequirePermissions('senderid.documents.download')
  documentsZip(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    return this.documents.streamZip(staff, id, res);
  }
}
