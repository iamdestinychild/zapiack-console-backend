import { Injectable, Logger } from '@nestjs/common';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { lagosDateOnly, nowLagos } from '../../common/time/lagos';
import {
  Prisma,
  type RiskFlag,
  type RiskFlagType,
  type RiskSeverity,
} from '../../generated/admin/client';
import { NotificationsGateway } from '../inbox/notifications.gateway';

/**
 * Thresholds for the automatic flags. Deliberately blunt: the job raises a flag for a
 * human to look at, it never suspends anything by itself.
 */
const RULES = {
  /** Today's volume against the trailing seven-day daily average. */
  volumeSpikeMultiple: 5,
  volumeSpikeMinimum: 500,
  failureRate: 0.35,
  failureMinimum: 100,
  destinationCountries: 15,
  signInCountries: 5,
  /** A single expensive destination taking most of an account's traffic. */
  pumpingConcentration: 0.8,
  pumpingMinimum: 1_000,
};

/**
 * Automatic risk detection over the rollups: sudden volume spikes, high failure
 * rates, many destination countries and sign-ins from many countries.
 *
 * Flags are deduplicated against open flags of the same type, so a persistent problem
 * is one row that stays open rather than a new row every half hour.
 */
@Injectable()
export class RiskService {
  private readonly logger = new Logger(RiskService.name);

  constructor(
    private readonly admin: AdminPrismaService,
    private readonly notifications: NotificationsGateway,
  ) {}

  async scan() {
    const today = lagosDateOnly(nowLagos());
    const weekAgo = lagosDateOnly(nowLagos().minus({ days: 7 }));

    const raised = (
      await Promise.all([
        this.volumeSpikes(today, weekAgo),
        this.failureRates(today),
        this.destinationSpread(today),
        this.signInSpread(),
        this.pumpingConcentration(today),
      ])
    ).flat();

    if (raised.length) {
      this.logger.log(`Risk scan raised ${raised.length} flags`);
    }
    return { raised: raised.length, at: new Date() };
  }

  private async volumeSpikes(today: Date, weekAgo: Date) {
    const [current, baseline] = await Promise.all([
      this.admin.usageRollup.groupBy({
        by: ['accountId'],
        where: { date: today },
        _sum: { attempted: true },
      }),
      this.admin.usageRollup.groupBy({
        by: ['accountId'],
        where: { date: { gte: weekAgo, lt: today }, hour: -1 },
        _sum: { attempted: true },
      }),
    ]);

    const baselineByAccount = new Map(
      baseline.map((r) => [r.accountId, Number(r._sum.attempted ?? 0) / 7]),
    );

    const out: (RiskFlag | null)[] = [];
    for (const row of current) {
      const volume = Number(row._sum.attempted ?? 0);
      const average = baselineByAccount.get(row.accountId) ?? 0;

      if (volume < RULES.volumeSpikeMinimum) continue;
      // A brand new account has no baseline; that is onboarding, not a spike.
      if (average === 0) continue;
      if (volume < average * RULES.volumeSpikeMultiple) continue;

      out.push(
        await this.raise(row.accountId, 'VOLUME_SPIKE', 'HIGH', {
          summary: `${volume.toLocaleString()} sends today against a 7-day average of ${Math.round(average).toLocaleString()}`,
          evidence: {
            volume,
            average: Math.round(average),
            multiple: Number((volume / average).toFixed(1)),
          },
        }),
      );
    }
    return out.filter(Boolean);
  }

  private async failureRates(today: Date) {
    const rows = await this.admin.usageRollup.groupBy({
      by: ['accountId', 'channel'],
      where: { date: today },
      _sum: { attempted: true, failed: true },
    });

    const out: (RiskFlag | null)[] = [];
    for (const row of rows) {
      const attempted = Number(row._sum.attempted ?? 0);
      const failed = Number(row._sum.failed ?? 0);
      if (attempted < RULES.failureMinimum) continue;

      const rate = failed / attempted;
      if (rate < RULES.failureRate) continue;

      out.push(
        await this.raise(row.accountId, 'HIGH_FAILURE_RATE', 'MEDIUM', {
          summary: `${(rate * 100).toFixed(0)}% of ${row.channel} sends failed today (${failed} of ${attempted})`,
          evidence: {
            channel: row.channel,
            attempted,
            failed,
            rate: Number(rate.toFixed(4)),
          },
        }),
      );
    }
    return out.filter(Boolean);
  }

  private async destinationSpread(today: Date) {
    const rows = await this.admin.destinationRollup.groupBy({
      by: ['accountId'],
      where: { date: today },
      _count: { country: true },
    });

    const out: (RiskFlag | null)[] = [];
    for (const row of rows) {
      if (row._count.country < RULES.destinationCountries) continue;
      out.push(
        await this.raise(
          row.accountId,
          'MANY_DESTINATION_COUNTRIES',
          'MEDIUM',
          {
            summary: `Sending to ${row._count.country} destination countries today`,
            evidence: { countries: row._count.country },
          },
        ),
      );
    }
    return out.filter(Boolean);
  }

  private async signInSpread() {
    const since = new Date(Date.now() - 24 * 3600_000);
    const rows = await this.admin.signInEvent.groupBy({
      by: ['accountId'],
      where: {
        occurredAt: { gte: since },
        accountId: { not: null },
        success: true,
      },
      _count: { country: true },
    });

    const out: (RiskFlag | null)[] = [];
    for (const row of rows) {
      if (!row.accountId || row._count.country < RULES.signInCountries)
        continue;
      out.push(
        await this.raise(row.accountId, 'MANY_SIGNIN_COUNTRIES', 'HIGH', {
          summary: `Signed in from ${row._count.country} countries in the last 24 hours`,
          evidence: { countries: row._count.country },
        }),
      );
    }
    return out.filter(Boolean);
  }

  /**
   * SMS pumping: traffic suddenly concentrated on one destination, usually an
   * expensive network the account has never used before.
   */
  private async pumpingConcentration(today: Date) {
    const rows = await this.admin.destinationRollup.findMany({
      where: { date: today, channel: 'SMS' },
      select: {
        accountId: true,
        country: true,
        network: true,
        attempted: true,
      },
    });

    const totals = new Map<string, number>();
    for (const row of rows) {
      totals.set(
        row.accountId,
        (totals.get(row.accountId) ?? 0) + Number(row.attempted),
      );
    }

    const out: (RiskFlag | null)[] = [];
    for (const row of rows) {
      const total = totals.get(row.accountId) ?? 0;
      const attempted = Number(row.attempted);
      if (total < RULES.pumpingMinimum) continue;
      if (attempted / total < RULES.pumpingConcentration) continue;
      // Concentration on the home market is just a Nigerian business.
      if (row.country === 'NG') continue;

      out.push(
        await this.raise(row.accountId, 'SMS_PUMPING_SUSPECTED', 'CRITICAL', {
          summary: `${((attempted / total) * 100).toFixed(0)}% of today's SMS went to ${row.country}${row.network ? ` / ${row.network}` : ''}`,
          evidence: {
            country: row.country,
            network: row.network,
            attempted,
            total,
          },
        }),
      );
    }
    return out.filter(Boolean);
  }

  /** Raises a flag unless an unresolved one of the same type is already open. */
  private async raise(
    accountId: string,
    type: RiskFlagType,
    severity: RiskSeverity,
    detail: { summary: string; evidence: Prisma.InputJsonValue },
  ) {
    const open = await this.admin.riskFlag.findFirst({
      where: { accountId, type, resolvedAt: null },
      select: { id: true },
    });
    if (open) {
      // Refresh the evidence so the flag reflects today, not the day it opened.
      await this.admin.riskFlag.update({
        where: { id: open.id },
        data: { summary: detail.summary, evidence: detail.evidence },
      });
      return null;
    }

    const flag = await this.admin.riskFlag.create({
      data: {
        accountId,
        type,
        severity,
        source: 'AUTOMATIC',
        summary: detail.summary,
        evidence: detail.evidence,
      },
    });

    if (severity === 'HIGH' || severity === 'CRITICAL') {
      await this.notifications.broadcastToPermission('customers.read', {
        type: 'risk.flag_raised',
        severity,
        title: `Risk flag on ${accountId}: ${type.toLowerCase().replace(/_/g, ' ')}`,
        body: detail.summary,
        link: `/customers/${accountId}`,
      });
    }

    return flag;
  }
}
