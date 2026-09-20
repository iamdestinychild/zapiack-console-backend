import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/zapiack/client';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { ZapiackPrismaService } from '../../common/prisma/zapiack-prisma.service';
import { lagosDateOnly, resolveRange } from '../../common/time/lagos';
import { SERVICES, SERVICE_BY_KEY } from './service-catalogue';
import type { DateRangeDto } from '../../common/dto/common.dto';

const D = (v: unknown) => Number(v ?? 0);

/**
 * Per-service metrics for every product line. The common figures come from the
 * rollups; the service-specific ones are read from the `attributes` JSON on usage
 * rows, which is what lets a new service appear without a schema change here.
 */
@Injectable()
export class ServicesService {
  constructor(
    private readonly admin: AdminPrismaService,
    private readonly zapiack: ZapiackPrismaService,
  ) {}

  /** The service index: one card per product line, live or not yet launched. */
  async list(dto: DateRangeDto) {
    const { start, end } = resolveRange(dto.from, dto.to, 7);

    const rollups = await this.admin.usageRollup.groupBy({
      by: ['channel'],
      where: {
        hour: -1,
        date: { gte: lagosDateOnly(start), lte: lagosDateOnly(end) },
      },
      _sum: {
        attempted: true,
        succeeded: true,
        failed: true,
        revenueNgn: true,
        costNgn: true,
      },
      _max: { latencyP95Ms: true },
    });

    const byChannel = new Map(rollups.map((r) => [r.channel, r]));

    return {
      range: { from: start, to: end },
      services: SERVICES.map((service) => {
        const row = byChannel.get(service.channel);
        const attempted = Number(row?._sum.attempted ?? 0);
        const succeeded = Number(row?._sum.succeeded ?? 0);
        const revenue = D(row?._sum.revenueNgn);
        const cost = D(row?._sum.costNgn);

        return {
          key: service.key,
          label: service.label,
          channel: service.channel,
          live: service.live,
          attempted,
          succeeded,
          failed: Number(row?._sum.failed ?? 0),
          successRate: attempted
            ? Number((succeeded / attempted).toFixed(4))
            : null,
          revenueNgn: revenue,
          costNgn: cost,
          profitNgn: Number((revenue - cost).toFixed(2)),
          latencyP95Ms: row?._max.latencyP95Ms ?? null,
        };
      }),
    };
  }

  async metrics(serviceKey: string, dto: DateRangeDto) {
    const service = SERVICE_BY_KEY.get(serviceKey);
    if (!service) throw new NotFoundException(`Unknown service ${serviceKey}`);

    const { start, end } = resolveRange(dto.from, dto.to, 7);

    const [daily, failureReasons, specific, byCountry] = await Promise.all([
      this.admin.usageRollup.groupBy({
        by: ['date'],
        where: {
          channel: service.channel,
          hour: -1,
          date: { gte: lagosDateOnly(start), lte: lagosDateOnly(end) },
        },
        _sum: {
          attempted: true,
          succeeded: true,
          failed: true,
          units: true,
          revenueNgn: true,
          costNgn: true,
        },
        _max: { latencyP50Ms: true, latencyP95Ms: true },
        orderBy: { date: 'asc' },
      }),
      // Failure reasons are not a rollup dimension: the set is open-ended and only
      // interesting in the top few, so this reads the source directly.
      this.zapiack.read.$queryRaw<{ reason: string | null; count: bigint }[]>`
        SELECT "failureReason" AS reason, COUNT(*)::bigint AS count
        FROM "usage_records"
        WHERE "channel"::text = ${service.channel}
          AND "createdAt" >= ${start} AND "createdAt" <= ${end}
          AND "status" = 'failed'
        GROUP BY 1
        ORDER BY count DESC
        LIMIT 20
      `,
      this.serviceSpecific(service.channel, start, end),
      this.admin.destinationRollup.groupBy({
        by: ['country'],
        where: {
          channel: service.channel,
          date: { gte: lagosDateOnly(start), lte: lagosDateOnly(end) },
        },
        _sum: { attempted: true, delivered: true },
        orderBy: { _sum: { attempted: 'desc' } },
        take: 20,
      }),
    ]);

    const totals = daily.reduce(
      (acc, row) => ({
        attempted: acc.attempted + Number(row._sum.attempted ?? 0),
        succeeded: acc.succeeded + Number(row._sum.succeeded ?? 0),
        failed: acc.failed + Number(row._sum.failed ?? 0),
        revenue: acc.revenue + D(row._sum.revenueNgn),
        cost: acc.cost + D(row._sum.costNgn),
      }),
      { attempted: 0, succeeded: 0, failed: 0, revenue: 0, cost: 0 },
    );

    return {
      service: {
        key: service.key,
        label: service.label,
        channel: service.channel,
        live: service.live,
        unit: service.unit,
      },
      range: { from: start, to: end },
      totals: {
        ...totals,
        successRate: totals.attempted
          ? Number((totals.succeeded / totals.attempted).toFixed(4))
          : null,
        profitNgn: Number((totals.revenue - totals.cost).toFixed(2)),
        margin: totals.revenue
          ? Number(((totals.revenue - totals.cost) / totals.revenue).toFixed(4))
          : null,
      },
      series: daily.map((row) => ({
        date: row.date,
        attempted: row._sum.attempted ?? 0n,
        succeeded: row._sum.succeeded ?? 0n,
        failed: row._sum.failed ?? 0n,
        units: row._sum.units ?? 0n,
        revenueNgn: row._sum.revenueNgn ?? '0',
        costNgn: row._sum.costNgn ?? '0',
        latencyP50Ms: row._max.latencyP50Ms,
        latencyP95Ms: row._max.latencyP95Ms,
      })),
      failureReasons: failureReasons.map((r) => ({
        reason: r.reason ?? 'unknown',
        count: Number(r.count),
      })),
      specificMetrics: specific,
      destinations: byCountry.map((row) => ({
        country: row.country,
        attempted: Number(row._sum.attempted ?? 0),
        delivered: Number(row._sum.delivered ?? 0),
      })),
    };
  }

  /**
   * Reads the service's own metrics out of the `attributes` JSON. Booleans become
   * rates, numbers become sums and averages; anything else is counted by value, which
   * covers WhatsApp categories and mapping request types.
   */
  private async serviceSpecific(channel: string, start: Date, end: Date) {
    const service = SERVICES.find((s) => s.channel === channel);
    if (!service?.specificMetrics.length) return [];

    const results = await Promise.all(
      service.specificMetrics
        .filter((metric) => metric.attribute)
        .map(async (metric) => {
          const attribute = metric.attribute!;

          if (metric.kind === 'rate') {
            const [row] = await this.zapiack.read.$queryRaw<
              { hits: bigint; total: bigint }[]
            >`
              SELECT COUNT(*) FILTER (WHERE ("attributes" ->> ${attribute})::boolean)::bigint AS hits,
                     COUNT(*) FILTER (WHERE jsonb_exists("attributes", ${attribute}))::bigint  AS total
              FROM "usage_records"
              WHERE "channel"::text = ${channel}
                AND "createdAt" >= ${start} AND "createdAt" <= ${end}
            `;
            const total = Number(row?.total ?? 0);
            return {
              key: metric.key,
              label: metric.label,
              kind: metric.kind,
              value: total
                ? Number((Number(row?.hits ?? 0) / total).toFixed(4))
                : null,
              sampleSize: total,
            };
          }

          // The aggregate name is SQL, not a value, so it cannot be a bound parameter.
          // It comes from the fixed catalogue above, never from a request.
          const aggregate = Prisma.raw(metric.kind === 'avg' ? 'AVG' : 'SUM');

          const [row] = await this.zapiack.read.$queryRaw<
            { value: string | null; total: bigint }[]
          >`
            SELECT ${aggregate}(
                     NULLIF("attributes" ->> ${attribute}, '')::numeric
                   )::text AS value,
                   COUNT(*) FILTER (WHERE jsonb_exists("attributes", ${attribute}))::bigint AS total
            FROM "usage_records"
            WHERE "channel"::text = ${channel}
              AND "createdAt" >= ${start} AND "createdAt" <= ${end}
          `;
          return {
            key: metric.key,
            label: metric.label,
            kind: metric.kind,
            value: row?.value ? Number(row.value) : null,
            sampleSize: Number(row?.total ?? 0),
          };
        }),
    );

    return results;
  }
}
