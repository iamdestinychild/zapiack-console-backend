import { Injectable } from '@nestjs/common';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { ZapiackPrismaService } from '../../common/prisma/zapiack-prisma.service';
import { lagosDateOnly, resolveRange } from '../../common/time/lagos';
import { maskIp } from '../../common/http/masking';
import { geocode } from '../../common/geo/geocode';
import type { GeoRequestsDto, RequestLogDto } from './dto/geo.dto';

/**
 * Where users sign in from and where API traffic originates.
 *
 * Request geography comes from the product's own `api_activity_logs`, which already
 * records ip, country, city and region — admin-core does not duplicate that pipeline.
 * Aggregates read the Admin DB rollups; the raw log is queried directly for detail.
 *
 * That table carries no coordinates, so the map plots at city granularity rather than
 * by latitude and longitude.
 */
@Injectable()
export class GeoService {
  constructor(
    private readonly admin: AdminPrismaService,
    private readonly zapiack: ZapiackPrismaService,
  ) {}

  /** Aggregated API request origins. Reads rollups, not the raw log. */
  async requests(dto: GeoRequestsDto) {
    const { start, end } = resolveRange(dto.from, dto.to, 7);
    const groupBy = dto.groupBy ?? 'country';

    if (groupBy === 'city') {
      // City is not a rollup dimension — the cardinality would be unmanageable — so
      // this reads the product's activity log, bounded by the range and a row limit.
      // A request with no resolved city still counts, under its country.
      const rows = await this.zapiack.read.$queryRaw<
        {
          country: string | null;
          city: string | null;
          total: bigint;
          clientErrors: bigint;
          serverErrors: bigint;
        }[]
      >`
        SELECT "countryCode" AS country, "city",
               COUNT(*)::bigint AS total,
               COUNT(*) FILTER (WHERE "statusCode" BETWEEN 400 AND 499)::bigint AS "clientErrors",
               COUNT(*) FILTER (WHERE "statusCode" >= 500)::bigint AS "serverErrors"
        FROM "api_activity_logs"
        WHERE "createdAt" >= ${start} AND "createdAt" <= ${end}
          AND ("city" IS NOT NULL OR "countryCode" IS NOT NULL)
        GROUP BY "countryCode", "city"
        ORDER BY total DESC
        LIMIT ${dto.limit ?? 100}
      `;
      return {
        range: { from: start, to: end },
        groupBy,
        data: rows.map((row) => {
          const total = Number(row.total);
          const serverErrors = Number(row.serverErrors);
          const point = geocode(row.country, row.city);
          return {
            key: row.city ?? row.country ?? 'Unknown',
            country: row.country,
            city: row.city,
            total,
            clientErrors: Number(row.clientErrors),
            serverErrors,
            errorRate: total ? Number((serverErrors / total).toFixed(4)) : 0,
            latencyP95Ms: null,
            lat: point?.lat ?? null,
            lng: point?.lng ?? null,
            precision: point?.precision ?? null,
          };
        }),
      };
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

  /**
   * The last few minutes of requests with coordinates, so the map is populated the
   * moment it opens. The live stream only carries what arrives afterwards.
   */
  async recentLive(minutes = 5, limit = 500) {
    const since = new Date(Date.now() - minutes * 60_000);
    const rows = await this.zapiack.read.apiActivityLog.findMany({
      where: { createdAt: { gt: since } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        createdAt: true,
        endpoint: true,
        method: true,
        statusCode: true,
        countryCode: true,
        city: true,
        region: true,
        service: true,
        projectId: true,
      },
    });
    return {
      since,
      data: rows.flatMap((row) => {
        const point = geocode(row.countryCode, row.city);
        if (!point) return [];
        return [
          {
            at: row.createdAt.toISOString(),
            endpoint: row.endpoint,
            method: row.method,
            statusCode: row.statusCode,
            service: row.service,
            projectId: row.projectId,
            country: row.countryCode,
            region: row.region,
            city: row.city,
            lat: point.lat,
            lng: point.lng,
            precision: point.precision,
          },
        ];
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
      data: recent.map((row) => ({
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

    // The log is keyed by API key prefix, so an account filter resolves to its keys.
    let prefixes: string[] | undefined;
    if (dto.accountId) {
      const keys = await this.zapiack.read.apiKeys.findMany({
        where: { accountId: dto.accountId },
        select: { keyPrefix: true },
      });
      prefixes = keys.map((k) => k.keyPrefix);
      if (!prefixes.length) {
        return { range: { from: start, to: end }, data: [] };
      }
    }

    const rows = await this.zapiack.read.apiActivityLog.findMany({
      where: {
        createdAt: { gte: start, lte: end },
        ...(prefixes ? { apiKeyPrefix: { in: prefixes } } : {}),
        ...(dto.endpoint ? { endpoint: { contains: dto.endpoint } } : {}),
        ...(dto.country ? { countryCode: dto.country } : {}),
        ...(dto.statusCode ? { statusCode: dto.statusCode } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: dto.limit ?? 100,
    });

    return {
      range: { from: start, to: end },
      data: rows.map((row) => ({
        id: row.id,
        requestId: row.requestId,
        occurredAt: row.createdAt,
        endpoint: row.endpoint,
        method: row.method,
        statusCode: row.statusCode,
        status: row.status,
        service: row.service,
        projectId: row.projectId,
        apiKeyPrefix: row.apiKeyPrefix,
        country: row.countryCode,
        region: row.region,
        city: row.city,
        timezone: row.timezone,
        message: row.message,
        ip: canSeeRawIp ? row.ip : maskIp(row.ip),
      })),
    };
  }
}
