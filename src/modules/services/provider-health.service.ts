import { Injectable, Logger } from '@nestjs/common';
import {
  ProviderStatus,
  type ProviderHealthSample,
} from '../../generated/admin/client';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { ZapiackPrismaService } from '../../common/prisma/zapiack-prisma.service';
import { NotificationsGateway } from '../inbox/notifications.gateway';

/** Above this share of failures in a window, a provider is degraded; double it is an outage. */
const DEGRADED_ERROR_RATE = 0.1;
const OUTAGE_ERROR_RATE = 0.4;
const WINDOW_MINUTES = 10;
/** Below this many attempts the rate is noise, not a signal. */
const MIN_SAMPLE = 20;

/**
 * Provider health per SMS route, SES, WhatsApp BSP and liveness vendor, derived from
 * delivery receipts and error rates rather than from a status page.
 */
@Injectable()
export class ProviderHealthService {
  private readonly logger = new Logger(ProviderHealthService.name);

  constructor(
    private readonly admin: AdminPrismaService,
    private readonly zapiack: ZapiackPrismaService,
    private readonly notifications: NotificationsGateway,
  ) {}

  /** Samples the last window and raises an alert when a provider changes state. */
  async sample() {
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - WINDOW_MINUTES * 60_000);

    const rows = await this.zapiack.read.$queryRaw<
      {
        provider: string | null;
        channel: string;
        attempted: bigint;
        delivered: bigint;
        failed: bigint;
        avgDlrLatencyMs: number | null;
      }[]
    >`
      SELECT
        "provider",
        "channel"::text AS channel,
        COUNT(*)::bigint                                          AS attempted,
        COUNT(*) FILTER (WHERE "status" = 'delivered')::bigint    AS delivered,
        COUNT(*) FILTER (WHERE "status" = 'failed')::bigint       AS failed,
        AVG(EXTRACT(EPOCH FROM ("deliveredAt" - "createdAt")) * 1000)::int AS "avgDlrLatencyMs"
      FROM "usage_records"
      WHERE "createdAt" >= ${windowStart} AND "createdAt" < ${windowEnd}
      GROUP BY 1, 2
    `;

    const samples: ProviderHealthSample[] = [];

    for (const row of rows) {
      const provider = row.provider ?? 'UNKNOWN';
      const attempted = Number(row.attempted);
      const failed = Number(row.failed);
      const errorRate = attempted ? failed / attempted : 0;

      const status =
        attempted < MIN_SAMPLE
          ? ProviderStatus.HEALTHY
          : errorRate >= OUTAGE_ERROR_RATE
            ? ProviderStatus.OUTAGE
            : errorRate >= DEGRADED_ERROR_RATE
              ? ProviderStatus.DEGRADED
              : ProviderStatus.HEALTHY;

      const previous = await this.admin.providerHealthSample.findFirst({
        where: { provider, channel: row.channel },
        orderBy: { windowStart: 'desc' },
      });

      const sample = await this.admin.providerHealthSample.upsert({
        where: {
          provider_channel_windowStart: {
            provider,
            channel: row.channel,
            windowStart,
          },
        },
        create: {
          provider,
          channel: row.channel,
          windowStart,
          windowEnd,
          attempted: row.attempted,
          delivered: row.delivered,
          failed: row.failed,
          avgDlrLatencyMs: row.avgDlrLatencyMs,
          errorRate: errorRate.toFixed(4),
          status,
        },
        update: {
          attempted: row.attempted,
          delivered: row.delivered,
          failed: row.failed,
          errorRate: errorRate.toFixed(4),
          status,
        },
      });
      samples.push(sample);

      // Alert on the transition, not on every sample, or the inbox fills with the
      // same outage ten times an hour.
      if (
        previous &&
        previous.status !== status &&
        status !== ProviderStatus.HEALTHY
      ) {
        await this.notifications.broadcastToPermission('metrics.read', {
          type: 'provider.outage',
          severity: status === 'OUTAGE' ? 'CRITICAL' : 'HIGH',
          title: `${provider} (${row.channel}) is ${status.toLowerCase()}`,
          body: `${(errorRate * 100).toFixed(1)}% failures across ${attempted} sends in the last ${WINDOW_MINUTES} minutes`,
          link: `/services/${row.channel.toLowerCase()}`,
        });
      }
    }

    return { windowStart, windowEnd, providers: samples.length };
  }

  /** Current state per provider, newest sample first. */
  async current() {
    const since = new Date(Date.now() - 6 * 60 * 60_000);
    const samples = await this.admin.providerHealthSample.findMany({
      where: { windowStart: { gte: since } },
      orderBy: { windowStart: 'desc' },
    });

    const latest = new Map<string, (typeof samples)[number]>();
    const history = new Map<string, (typeof samples)[number][]>();

    for (const sample of samples) {
      const key = `${sample.provider}:${sample.channel}`;
      if (!latest.has(key)) latest.set(key, sample);
      history.set(key, [...(history.get(key) ?? []), sample]);
    }

    return [...latest.entries()].map(([key, sample]) => ({
      provider: sample.provider,
      channel: sample.channel,
      status: sample.status,
      errorRate: sample.errorRate,
      avgDlrLatencyMs: sample.avgDlrLatencyMs,
      windowStart: sample.windowStart,
      trend: (history.get(key) ?? []).slice(0, 36).map((s) => ({
        at: s.windowStart,
        errorRate: s.errorRate,
        status: s.status,
      })),
    }));
  }
}
