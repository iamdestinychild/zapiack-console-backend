import { Controller, Get, Query } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsISO8601, IsOptional, IsString } from 'class-validator';
import { RequirePermissions } from '../../common/auth/decorators';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import {
  buildPage,
  cursorWhere,
  decodeCursor,
} from '../../common/http/pagination';
import { CursorPageDto } from '../../common/dto/common.dto';
import { resolveRange } from '../../common/time/lagos';

export class AuditQueryDto extends CursorPageDto {
  @IsOptional()
  @IsString()
  actorId?: string;

  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  action?: string;

  @IsOptional()
  @IsString()
  targetType?: string;

  @IsOptional()
  @IsString()
  targetId?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}

/**
 * Read access to the audit log. There is deliberately no write, update or delete
 * route: the table is append-only, and a database trigger blocks changes even from a
 * superuser connection, so no role — including Super admin — can edit history.
 */
@Controller('audit')
export class AuditQueryController {
  constructor(private readonly admin: AdminPrismaService) {}

  @Get()
  @RequirePermissions('audit.read')
  async list(@Query() query: AuditQueryDto) {
    const limit = query.limit ?? 50;
    const { start, end } = resolveRange(query.from, query.to, 30);

    const rows = await this.admin.auditLog.findMany({
      where: {
        createdAt: { gte: start, lte: end },
        ...cursorWhere(decodeCursor(query.cursor)),
        ...(query.actorId ? { actorId: query.actorId } : {}),
        // Prefix match, so "customers." finds every customer action.
        ...(query.action ? { action: { startsWith: query.action } } : {}),
        ...(query.targetType ? { targetType: query.targetType } : {}),
        ...(query.targetId ? { targetId: query.targetId } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: { actor: { select: { id: true, name: true, email: true } } },
    });

    return buildPage(rows, limit);
  }

  /** The distinct actions in use, for the filter dropdown. */
  @Get('actions')
  @RequirePermissions('audit.read')
  async actions() {
    const rows = await this.admin.auditLog.groupBy({
      by: ['action'],
      _count: { _all: true },
      orderBy: { _count: { action: 'desc' } },
      take: 200,
    });
    return rows.map((r) => ({ action: r.action, count: r._count._all }));
  }
}
