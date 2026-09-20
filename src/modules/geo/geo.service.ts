import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/admin/client';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { lagosDateOnly, resolveRange } from '../../common/time/lagos';
import { maskIp } from '../../common/http/masking';
import type { GeoRequestsDto, RequestLogDto } from './dto/geo.dto';

/**
 * Where users sign in from and where API traffic originates. History comes from the
 * rollups; the live map comes from the SSE stream the ingest worker publishes to.
 */
@Injectable()
export class GeoService {
  constructor(private readonly admin: AdminPrismaService) {}

  /** Aggregated API request origins. Reads rollups, not the raw log. */
  async requests(dto: GeoRequestsDto) {
    const { start, end } = resolveRange(dto.from, dto.to, 7);
    const groupBy = dto.groupBy ?? 'country';

    if (groupBy === 'city') {
      // City is not a rollup dimension — the cardinality would be unmanageable — so
      // this one query goes to the raw log, bounded by the range and a row limit.
      const rows = await this.admin.$queryRaw<
        {
          country: string | null;
          city: string | null;
          lat: number | null;
          lng: number | null;
          total: bigint;
        }[]
      >`
        SELECT "country", "city",
               AVG("latitude")::float  AS lat,
               AVG("longitude")::float AS lng,
               COUNT(*)::bigint        AS total
        FROM "request_logs"
        WHERE "occurredAt" >= ${start} AND "occurredAt" <= ${end}
          AND "city" IS NOT NULL
          ${dto.accountId ? Prisma.sql`AND "accountId" = ${dto.accountId}` : Prisma.empty}
        GROUP BY "country", "city"
        ORDER BY total DESC
        LIMIT ${dto.limit ?? 100}
      `;
      return { range: { from: start, to: end }, groupBy, data: rows };
    }

    const rows = await this.admin.requestRollup.groupBy({
      by: groupBy === 'endpoint' ? ['endpoint'] : ['country'],
      where: {
        date: { gte: lagosDateOnly(start), lte: lagosDateOnly(end) },
        ...(dto.accountId ? { accountId: dto.accountId } : {}),
        ...(dto.country ? { country: dto.country } : {}),
      },
      _sum: { total: true, clientErrors: true, serverErrors: true },
      _max: { latencyP95Ms: true },
      orderBy: { _sum: { total: 'desc' } },
      take: dto.limit ?? 100,
    });

    return {
      range: { from: start, to: end },
      groupBy,
      data: rows.map((row) => {
        const total = Number(row._sum.total ?? 0);
        const serverErrors = Number(row._sum.serverErrors ?? 0);
        return {
          key:
            groupBy === 'endpoint'
              ? (row as { endpoint: string }).endpoint
              : (row as { country: string }).country,
          total,
          clientErrors: Number(row._sum.clientErrors ?? 0),
          serverErrors,
          errorRate: total ? Number((serverErrors / total).toFixed(4)) : 0,
          latencyP95Ms: row._max.latencyP95Ms,
        };
      }),
    };
  }

  /** Sign-ins from both the customer app and the console. */
  async signIns(dto: GeoRequestsDto, canSeeRawIp: boolean) {
    const { start, end } = resolveRange(dto.from, dto.to, 7);

    const [byCountry, recent] = await Promise.all([
      this.admin.signInEvent.groupBy({
        by: ['country', 'surface'],
        where: {
          occurredAt: { gte: start, lte: end },
          ...(dto.accountId ? { accountId: dto.accountId } : {}),
        },
        _count: { _all: true },
        orderBy: { _count: { country: 'desc' } },
        take: dto.limit ?? 100,
      }),
      this.admin.signInEvent.findMany({
        where: {
          occurredAt: { gte: start, lte: end },
          ...(dto.accountId ? { accountId: dto.accountId } : {}),
        },
        orderBy: { occurredAt: 'desc' },
        take: 100,
      }),
    ]);

    return {
      range: { from: start, to: end },
      byCountry: byCountry.map((row) => ({
        country: row.country,
        surface: row.surface,
        count: row._count._all,
      })),
      recent: recent.map((row) => ({
        occurredAt: row.occurredAt,
        surface: row.surface,
        accountId: row.accountId,
        staffId: row.staffId,
        success: row.success,
        country: row.country,
        city: row.city,
        latitude: row.latitude,
        longitude: row.longitude,
        ip: canSeeRawIp ? row.ip : maskIp(row.ip),
      })),
    };
  }

  /**
   * Where messages are going, by country and network. Concentration here, especially
   * to expensive networks, is what SMS pumping looks like before the invoice arrives.
   */
  async destinations(dto: GeoRequestsDto) {
    const { start, end } = resolveRange(dto.from, dto.to, 30);

    const rows = await this.admin.destinationRollup.groupBy({
      by: ['country', 'channel'],
      where: {
        date: { gte: lagosDateOnly(start), lte: lagosDateOnly(end) },
        ...(dto.accountId ? { accountId: dto.accountId } : {}),
      },
      _sum: { attempted: true, delivered: true, costNgn: true },
      orderBy: { _sum: { attempted: 'desc' } },
      take: dto.limit ?? 100,
    });

    return {
      range: { from: start, to: end },
      data: rows.map((row) => {
        const attempted = Number(row._sum.attempted ?? 0);
        const delivered = Number(row._sum.delivered ?? 0);
        return {
          country: row.country,
          channel: row.channel,
          attempted,
          delivered,
          deliveryRate: attempted
            ? Number((delivered / attempted).toFixed(4))
            : null,
          costNgn: row._sum.costNgn ?? '0',
        };
      }),
    };
  }

  /** The raw request log, for an on-call engineer chasing one request. */
  async requestLog(dto: RequestLogDto, canSeeRawIp: boolean) {
    const { start, end } = resolveRange(dto.from, dto.to, 1);

    const rows = await this.admin.requestLog.findMany({
      where: {
        occurredAt: { gte: start, lte: end },
        ...(dto.accountId ? { accountId: dto.accountId } : {}),
        ...(dto.endpoint ? { endpoint: { contains: dto.endpoint } } : {}),
        ...(dto.country ? { country: dto.country } : {}),
        ...(dto.statusCode ? { statusCode: dto.statusCode } : {}),
      },
      orderBy: { occurredAt: 'desc' },
      take: dto.limit ?? 100,
    });

    return {
      range: { from: start, to: end },
      data: rows.map((row) => ({
        ...row,
        ip: canSeeRawIp ? row.ip : maskIp(row.ip),
      })),
    };
  }
}
