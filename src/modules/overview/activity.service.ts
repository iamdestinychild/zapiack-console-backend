import { Injectable } from '@nestjs/common';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { ZapiackPrismaService } from '../../common/prisma/zapiack-prisma.service';
import { TtlCache } from '../../common/cache/ttl-cache';

export type ActivityTone =
  'danger' | 'warning' | 'success' | 'info' | 'neutral';

export interface ActivityItem {
  id: string;
  kind:
    | 'provider.degraded'
    | 'senderid.submitted'
    | 'payment.received'
    | 'customer.signed_up'
    | 'account.flagged';
  tone: ActivityTone;
  title: string;
  detail: string;
  at: Date;
  /** Console path to open, when there is one. */
  link: string | null;
}

const PER_SOURCE = 6;
const LIMIT = 12;

const naira = new Intl.NumberFormat('en-NG', { maximumFractionDigits: 0 });

/**
 * "What just happened", merged from the places the console can see: payments and
 * sign-ups from the product, sender ID applications, risk flags and provider health.
 * Campaign sends are not here because the console's read role has no access to the
 * campaigns table.
 *
 * Several small indexed reads, merged in memory and held for 30 seconds, so a wall of
 * open dashboards costs one set of queries rather than one per viewer.
 */
@Injectable()
export class ActivityService {
  private readonly cache = new TtlCache<ActivityItem[]>(30_000, 4);

  constructor(
    private readonly admin: AdminPrismaService,
    private readonly zapiack: ZapiackPrismaService,
  ) {}

  async recent(): Promise<{ data: ActivityItem[] }> {
    const data = await this.cache.get('recent', () => this.load());
    return { data };
  }

  private async load(): Promise<ActivityItem[]> {
    const since = new Date(Date.now() - 6 * 60 * 60_000);

    const [payments, signups, applications, flags, providers] =
      await Promise.all([
        this.zapiack.read.transactions.findMany({
          where: { status: 'SUCCESS' },
          orderBy: { createdAt: 'desc' },
          take: PER_SOURCE,
          select: {
            id: true,
            accountId: true,
            amount: true,
            description: true,
            createdAt: true,
            account: { select: { owner: { select: { displayName: true } } } },
          },
        }),
        this.zapiack.read.accounts.findMany({
          orderBy: { createdAt: 'desc' },
          take: PER_SOURCE,
          select: {
            id: true,
            createdAt: true,
            owner: { select: { displayName: true } },
          },
        }),
        this.zapiack.read.senderIdApplication.findMany({
          where: { status: 'PENDING_REVIEW' },
          orderBy: { createdAt: 'desc' },
          take: PER_SOURCE,
          select: {
            id: true,
            senderId: true,
            businessName: true,
            createdAt: true,
          },
        }),
        this.admin.riskFlag.findMany({
          where: { resolvedAt: null },
          orderBy: { createdAt: 'desc' },
          take: PER_SOURCE,
          select: {
            id: true,
            accountId: true,
            summary: true,
            severity: true,
            createdAt: true,
          },
        }),
        this.admin.providerHealthSample.findMany({
          where: { windowStart: { gte: since }, status: { not: 'HEALTHY' } },
          orderBy: { windowStart: 'desc' },
          take: PER_SOURCE,
        }),
      ]);

    const items: ActivityItem[] = [];

    for (const p of providers) {
      const failed = Number(p.failed);
      const attempted = Number(p.attempted);
      items.push({
        id: `provider-${p.id}`,
        kind: 'provider.degraded',
        tone: 'danger',
        title: `${capitalise(p.channel)} delivery ${p.status === 'OUTAGE' ? 'down' : 'degraded'}`,
        detail: attempted
          ? `${(Number(p.errorRate) * 100).toFixed(1)}% failures across ${attempted.toLocaleString('en-NG')} sends via ${p.provider}`
          : `${p.provider} reported ${failed} failures`,
        at: p.windowEnd,
        link: '/services',
      });
    }

    for (const a of applications) {
      items.push({
        id: `senderid-${a.id}`,
        kind: 'senderid.submitted',
        tone: 'warning',
        title: `Sender ID “${a.senderId}” submitted`,
        detail: `${a.businessName} · awaiting review`,
        at: a.createdAt,
        link: `/compliance/sender-ids/${a.id}`,
      });
    }

    for (const t of payments) {
      items.push({
        id: `payment-${t.id}`,
        kind: 'payment.received',
        tone: 'success',
        title: `Payment received · ₦${naira.format(Number(t.amount))}`,
        detail:
          [t.account.owner.displayName, t.description]
            .filter(Boolean)
            .join(' · ') || 'Payment',
        at: t.createdAt,
        link: `/customers/${t.accountId}`,
      });
    }

    for (const s of signups) {
      items.push({
        id: `signup-${s.id}`,
        kind: 'customer.signed_up',
        tone: 'neutral',
        title: 'New customer signed up',
        detail: s.owner.displayName ?? 'New account',
        at: s.createdAt,
        link: `/customers/${s.id}`,
      });
    }

    for (const f of flags) {
      items.push({
        id: `flag-${f.id}`,
        kind: 'account.flagged',
        tone: f.severity === 'LOW' ? 'warning' : 'danger',
        title: 'Account flagged',
        detail: f.summary,
        at: f.createdAt,
        link: `/customers/${f.accountId}`,
      });
    }

    return items
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, LIMIT);
  }
}

function capitalise(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}
