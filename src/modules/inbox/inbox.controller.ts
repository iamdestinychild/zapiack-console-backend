import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Sse,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { CurrentStaff } from '../../common/auth/decorators';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { SseService } from '../../common/sse/sse.service';
import {
  buildPage,
  cursorWhere,
  decodeCursor,
} from '../../common/http/pagination';
import { CursorPageDto } from '../../common/dto/common.dto';

/** The staff member's own inbox. Session is enough; no extra permission applies. */
@Controller()
export class InboxController {
  constructor(
    private readonly admin: AdminPrismaService,
    private readonly sse: SseService,
  ) {}

  @Get('inbox')
  async list(
    @CurrentStaff() staff: StaffPrincipal,
    @Query() query: CursorPageDto & { unreadOnly?: string },
  ) {
    const limit = query.limit ?? 50;
    const rows = await this.admin.staffNotification.findMany({
      where: {
        staffId: staff.id,
        ...cursorWhere(decodeCursor(query.cursor)),
        ...(query.unreadOnly === 'true' ? { readAt: null } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const unread = await this.admin.staffNotification.count({
      where: { staffId: staff.id, readAt: null },
    });

    return { ...buildPage(rows, limit), unread };
  }

  @Post('inbox/:id/read')
  @HttpCode(204)
  async markRead(
    @CurrentStaff() staff: StaffPrincipal,
    @Param('id') id: string,
  ) {
    // Scoped by staffId so one staff member cannot mark another's notifications read.
    await this.admin.staffNotification.updateMany({
      where: { id, staffId: staff.id, readAt: null },
      data: { readAt: new Date() },
    });
  }

  @Post('inbox/read-all')
  @HttpCode(204)
  async markAllRead(@CurrentStaff() staff: StaffPrincipal) {
    await this.admin.staffNotification.updateMany({
      where: { staffId: staff.id, readAt: null },
      data: { readAt: new Date() },
    });
  }

  /** Live console notifications for this staff member. */
  @Sse('events')
  events(
    @CurrentStaff() staff: StaffPrincipal,
  ): Observable<{ data: unknown; type: string }> {
    return this.sse.subscribe(`staff:${staff.id}`);
  }
}
