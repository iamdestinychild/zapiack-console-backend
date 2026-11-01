import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/zapiack/client';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { ZapiackPrismaService } from '../../common/prisma/zapiack-prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { maskApiKeyPrefix, maskEmail, maskIp } from '../../common/http/masking';
import {
  buildPage,
  cursorWhere,
  decodeCursor,
  encodeCursor,
} from '../../common/http/pagination';
import { lagosDateOnly, resolveRange } from '../../common/time/lagos';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import { TtlCache } from '../../common/cache/ttl-cache';
import type {
  CustomersTableDto,
  CustomerUsageDto,
  RevealPiiDto,
  SearchCustomersDto,
} from './dto/customers.dto';

/**
 * Reads for the customer list and Customer 360.
 *
 * An account in the product schema carries almost no identity of its own: no business
 * name, no email, no phone. The owner's email and display name come from `Users` via
 * `Accounts.userId`, and a business name only exists where the account has filed a
 * sender ID application. Phone number and KYC status are not recorded anywhere, so
 * those fields are returned as null rather than quietly omitted — the console shows a
 * blank, not a wrong value.
 *
 * Balances are **credits**, not naira: `Accounts.creditBalance` is spent against
 * `ProductPricing.creditCost`.
 */
@Injectable()
export class CustomersService {
  constructor(
    private readonly zapiack: ZapiackPrismaService,
    private readonly admin: AdminPrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Short-lived: the dashboard table is read far more often than it changes. */
  private readonly tableCache = new TtlCache<unknown>(30_000);
  private readonly summaryCache = new TtlCache<unknown>(60_000);

  /**
   * The customer table: numbered pages with a total, every active plan the account
   * holds, the wallet, the MRR those plans contribute, and a risk level.
   *
   * Searches the same identifiers as the main list, apart from API key prefixes, which
   * need a second query and are not worth it for a glance table. Emails stay masked.
   */
  table(query: CustomersTableDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 6;
    const q = query.q?.trim() ?? '';
    const key = JSON.stringify([
      page,
      pageSize,
      q,
      query.status ?? null,
      query.segment ?? null,
      query.planId ?? null,
      query.country ?? null,
      query.channel ?? null,
    ]);
    return this.tableCache.get(key, () =>
      this.loadTable(page, pageSize, q, query),
    ) as ReturnType<CustomersService['loadTable']>;
  }

  /** The list's header: totals the tabs and the stats strip both read. */
  summary() {
    return this.summaryCache.get('summary', () =>
      this.loadSummary(),
    ) as ReturnType<CustomersService['loadSummary']>;
  }

  private async loadSummary() {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    const [counts, money, flagged] = await Promise.all([
      this.zapiack.read.$queryRaw<
        {
          total: bigint;
          newThisMonth: bigint;
          active: bigint;
          suspended: bigint;
          paying: bigint;
          wallets: string | null;
        }[]
      >`
        SELECT
          COUNT(*)::bigint AS "total",
          COUNT(*) FILTER (WHERE a."createdAt" >= ${monthStart})::bigint AS "newThisMonth",
          COUNT(*) FILTER (WHERE a."accountStatus" = 'ACTIVE')::bigint AS "active",
          COUNT(*) FILTER (WHERE a."accountStatus" = 'SUSPENDED')::bigint AS "suspended",
          COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM "subscriptions" s JOIN "plans" p ON p."id" = s."planId"
             WHERE s."accountId" = a."id" AND s."status" = 'ACTIVE'
               AND p."isFree" = false AND p."basePrice" > 0))::bigint AS "paying",
          COALESCE(SUM(a."creditBalance") FILTER (WHERE a."creditBalance" > 0), 0)::text AS "wallets"
        FROM "accounts" a
        WHERE a."accountStatus" NOT IN ('CANCELED', 'BANNED')
      `,
      // MRR as the finance snapshot defines it: annual plans count a twelfth.
      this.zapiack.read.$queryRaw<{ mrr: string | null }[]>`
        SELECT COALESCE(SUM(CASE WHEN p."billingInterval" = 'YEARLY'
                                 THEN p."basePrice" / 12 ELSE p."basePrice" END), 0)::text AS "mrr"
          FROM "subscriptions" s JOIN "plans" p ON p."id" = s."planId"
         WHERE s."status" = 'ACTIVE' AND p."isFree" = false AND p."basePrice" > 0
      `,
      this.admin.riskFlag.findMany({
        where: { resolvedAt: null },
        select: { accountId: true },
        distinct: ['accountId'],
        take: 5000,
      }),
    ]);

    const row = counts[0];
    const total = Number(row?.total ?? 0);
    const paying = Number(row?.paying ?? 0);
    return {
      total,
      newThisMonth: Number(row?.newThisMonth ?? 0),
      active: Number(row?.active ?? 0),
      suspended: Number(row?.suspended ?? 0),
      paying,
      free: Math.max(0, total - paying),
      flagged: flagged.length,
      payingPct: total ? Math.round((paying / total) * 1000) / 10 : 0,
      mrrNgn: money[0]?.mrr ?? '0',
      prepaidWalletsNgn: row?.wallets ?? '0',
      walletCount: total,
    };
  }

  private async loadTable(
    page: number,
    pageSize: number,
    q: string,
    query: CustomersTableDto,
  ) {
    const conditions: Prisma.AccountsWhereInput[] = [];
    const payingPlan: Prisma.SubscriptionsWhereInput = {
      status: 'ACTIVE',
      plan: { isFree: false, basePrice: { gt: 0 } },
    };
    if (query.status) conditions.push({ accountStatus: query.status });
    if (query.country) conditions.push({ countryCode: query.country });
    if (query.planId) {
      conditions.push({
        subscriptions: { some: { planId: query.planId, status: 'ACTIVE' } },
      });
    }
    if (query.channel) {
      conditions.push({
        subscriptions: { some: { channel: query.channel, status: 'ACTIVE' } },
      });
    }
    switch (query.segment) {
      case 'active':
        conditions.push({ accountStatus: 'ACTIVE' });
        break;
      case 'suspended':
        conditions.push({ accountStatus: 'SUSPENDED' });
        break;
      case 'paying':
        conditions.push({ subscriptions: { some: payingPlan } });
        break;
      case 'free':
        conditions.push({ NOT: { subscriptions: { some: payingPlan } } });
        break;
      case 'flagged': {
        const flags = await this.admin.riskFlag.findMany({
          where: { resolvedAt: null },
          select: { accountId: true },
          distinct: ['accountId'],
          take: 5000,
        });
        conditions.push({ id: { in: flags.map((f) => f.accountId) } });
        break;
      }
      default:
    }
    if (q) {
      conditions.push({
        OR: [
          { id: q },
          { owner: { email: { contains: q, mode: 'insensitive' } } },
          { owner: { displayName: { contains: q, mode: 'insensitive' } } },
          {
            senderIdApplications: {
              some: { businessName: { contains: q, mode: 'insensitive' } },
            },
          },
          {
            senderIdApplications: {
              some: { senderId: { equals: q, mode: 'insensitive' } },
            },
          },
        ],
      });
    }
    const where: Prisma.AccountsWhereInput = conditions.length
      ? { AND: conditions }
      : {};

    const [total, accounts] = await Promise.all([
      this.zapiack.read.accounts.count({ where }),
      this.zapiack.read.accounts.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          accountStatus: true,
          createdAt: true,
          creditBalance: true,
          owner: {
            select: { email: true, displayName: true, lastLoginAt: true },
          },
          subscriptions: {
            where: { status: 'ACTIVE' },
            orderBy: { createdAt: 'asc' },
            select: {
              channel: true,
              isTrial: true,
              plan: {
                select: {
                  name: true,
                  basePrice: true,
                  billingInterval: true,
                  isFree: true,
                },
              },
            },
          },
          accountBillings: { select: { channel: true } },
          senderIdApplications: {
            select: { businessName: true },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      }),
    ]);

    const flags = await this.admin.riskFlag.findMany({
      where: { accountId: { in: accounts.map((a) => a.id) }, resolvedAt: null },
      select: { accountId: true, severity: true },
    });
    const flagsByAccount = new Map<string, string[]>();
    for (const f of flags) {
      flagsByAccount.set(f.accountId, [
        ...(flagsByAccount.get(f.accountId) ?? []),
        f.severity,
      ]);
    }

    return {
      data: accounts.map((account) => {
        const open = flagsByAccount.get(account.id) ?? [];
        const subscription = account.subscriptions[0];
        // Annual plans are divided by 12, as the finance snapshot does, so MRR means
        // the same thing on every row. Free plans contribute nothing.
        const mrr = account.subscriptions.reduce(
          (sum, s) =>
            s.plan.isFree
              ? sum
              : sum.plus(
                  s.plan.billingInterval === 'YEARLY'
                    ? s.plan.basePrice.div(12)
                    : s.plan.basePrice,
                ),
          new Prisma.Decimal(0),
        );
        return {
          id: account.id,
          name:
            account.senderIdApplications[0]?.businessName ??
            account.owner.displayName ??
            maskEmail(account.owner.email),
          email: maskEmail(account.owner.email),
          plan: subscription?.plan.name ?? null,
          products: account.subscriptions.map((s) => ({
            channel: s.channel,
            plan: s.plan.name,
            isFree: s.plan.isFree,
            isTrial: s.isTrial,
          })),
          channels: account.accountBillings.map((b) => b.channel),
          mrrNgn: mrr.toString(),
          walletNgn: account.creditBalance.toString(),
          status: account.accountStatus,
          isTrial: account.subscriptions.some((s) => s.isTrial),
          openRiskFlags: open.length,
          risk: riskLevel(open),
          lastActiveAt: account.owner.lastLoginAt,
          createdAt: account.createdAt,
        };
      }),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  /**
   * One search box over the identifiers that actually exist: account id, owner email
   * or name, business name from a sender ID filing, API key prefix, and sender ID.
   */
  async search(query: SearchCustomersDto) {
    const limit = query.limit ?? 50;
    const cursor = decodeCursor(query.cursor);
    const q = query.q?.trim();

    let idsFromRelations: string[] | undefined;
    if (q) {
      const [byKey, bySenderId] = await Promise.all([
        this.zapiack.read.apiKeys.findMany({
          where: { keyPrefix: { startsWith: q } },
          select: { accountId: true },
          take: 200,
        }),
        this.zapiack.read.senderIdApplication.findMany({
          where: {
            OR: [
              { senderId: { equals: q, mode: 'insensitive' } },
              { businessName: { contains: q, mode: 'insensitive' } },
            ],
          },
          select: { accountId: true },
          take: 200,
        }),
      ]);
      const ids = [...byKey, ...bySenderId].map((r) => r.accountId);
      if (ids.length) idsFromRelations = [...new Set(ids)];
    }

    let flaggedIds: string[] | undefined;
    if (query.flaggedOnly) {
      const flags = await this.admin.riskFlag.findMany({
        where: { resolvedAt: null },
        select: { accountId: true },
        distinct: ['accountId'],
        take: 1000,
      });
      flaggedIds = flags.map((f) => f.accountId);
      if (!flaggedIds.length)
        return { data: [], nextCursor: null, hasMore: false };
    }

    // Built up explicitly: the cursor and the search term both contribute an OR, and
    // they must be ANDed rather than one overwriting the other.
    const conditions: Prisma.AccountsWhereInput[] = [];

    if (cursor) {
      conditions.push({
        OR: [
          { createdAt: { lt: new Date(cursor.createdAt) } },
          { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
        ],
      });
    }
    if (query.status) conditions.push({ accountStatus: query.status });
    if (query.country) conditions.push({ countryCode: query.country });
    if (flaggedIds) conditions.push({ id: { in: flaggedIds } });
    if (query.planId) {
      conditions.push({
        subscriptions: { some: { planId: query.planId, status: 'ACTIVE' } },
      });
    }
    if (q) {
      const matches: Prisma.AccountsWhereInput[] = [
        { id: q },
        { owner: { email: { contains: q, mode: 'insensitive' } } },
        { owner: { displayName: { contains: q, mode: 'insensitive' } } },
      ];
      if (idsFromRelations) matches.push({ id: { in: idsFromRelations } });
      conditions.push({ OR: matches });
    }

    const accounts = await this.zapiack.read.accounts.findMany({
      where: conditions.length ? { AND: conditions } : {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        owner: { select: { email: true, displayName: true } },
        subscriptions: {
          where: { status: 'ACTIVE' },
          include: { plan: { select: { id: true, name: true } } },
          take: 1,
        },
        // The only place a business name is recorded.
        senderIdApplications: {
          select: { businessName: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    const page = accounts.slice(0, limit);
    const flags = await this.admin.riskFlag.groupBy({
      by: ['accountId'],
      where: { accountId: { in: page.map((a) => a.id) }, resolvedAt: null },
      _count: { _all: true },
    });
    const flagCount = new Map(flags.map((f) => [f.accountId, f._count._all]));

    const last = page.at(-1);
    return {
      data: page.map((account) => ({
        id: account.id,
        businessName: account.senderIdApplications[0]?.businessName ?? null,
        ownerName: account.owner.displayName,
        // Masked by default; the reveal endpoint is the only way to the real values.
        email: maskEmail(account.owner.email),
        phone: null,
        status: account.accountStatus,
        creditBalance: account.creditBalance,
        country: account.countryCode,
        kycVerified: null,
        plan: account.subscriptions[0]?.plan ?? null,
        openRiskFlags: flagCount.get(account.id) ?? 0,
        createdAt: account.createdAt,
      })),
      hasMore: accounts.length > limit,
      nextCursor:
        accounts.length > limit && last
          ? encodeCursor({
              createdAt: last.createdAt.toISOString(),
              id: last.id,
            })
          : null,
    };
  }

  /** Customer 360 in one call; the heavier tabs paginate separately. */
  async get(accountId: string) {
    const account = await this.zapiack.read.accounts.findUnique({
      where: { id: accountId },
      include: {
        owner: true,
        projects: {
          where: { isDeleted: false },
          orderBy: { createdAt: 'asc' },
          take: 20,
        },
        apiKeys: {
          where: { isDeleted: false },
          orderBy: { createdAt: 'desc' },
          take: 20,
          // Named, never `true`: the console must not load keyHash, and the read role
          // is not granted it. See prisma/grants/zapiack-roles.sql.
          select: {
            id: true,
            name: true,
            keyPrefix: true,
            permission: true,
            usageCount: true,
            isActive: true,
            projectId: true,
            lastUsedAt: true,
            expiresAt: true,
            createdAt: true,
          },
        },
        subscriptions: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          include: { plan: true },
        },
        senderIdApplications: { orderBy: { createdAt: 'desc' }, take: 20 },
        accountBillings: { include: { product: true } },
        usageBuffers: true,
      },
    });
    if (!account) throw new NotFoundException('Account not found');

    const since30 = new Date(Date.now() - 30 * 24 * 3600_000);
    const [
      notes,
      tags,
      riskFlags,
      signIns,
      usageByChannel,
      reviews,
      lastTopUp,
      recent,
      lifetime,
      activeSubs,
    ] = await Promise.all([
      this.admin.customerNote.findMany({
        where: { accountId },
        orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
        take: 20,
        include: { author: { select: { id: true, name: true } } },
      }),
      this.admin.customerTag.findMany({ where: { accountId } }),
      this.admin.riskFlag.findMany({
        where: { accountId, resolvedAt: null },
        orderBy: { createdAt: 'desc' },
      }),
      this.admin.signInEvent.findMany({
        where: { accountId },
        orderBy: { occurredAt: 'desc' },
        take: 10,
      }),
      this.admin.usageRollup.groupBy({
        by: ['channel'],
        where: { accountId, hour: -1 },
        _sum: {
          attempted: true,
          succeeded: true,
          failed: true,
          revenueNgn: true,
        },
      }),
      this.admin.senderIdReview.findMany({
        where: { accountId },
        orderBy: { submittedAt: 'desc' },
        take: 20,
      }),
      this.zapiack.read.tabTransaction.findFirst({
        where: { accountId, type: 'CREDIT' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, charge: true },
      }),
      this.admin.usageRollup.aggregate({
        where: { accountId, hour: -1, date: { gte: lagosDateOnly(since30) } },
        _sum: { attempted: true, succeeded: true },
      }),
      this.admin.usageRollup.aggregate({
        where: { accountId, hour: -1 },
        _sum: { revenueNgn: true },
      }),
      this.zapiack.read.subscriptions.findMany({
        where: { accountId, status: 'ACTIVE' },
        orderBy: { createdAt: 'asc' },
        include: { plan: true },
      }),
    ]);

    const reviewByApplication = new Map(
      reviews.map((r) => [r.applicationId, r]),
    );

    const quotaByChannel = new Map(
      account.usageBuffers.map((u) => [u.channel, u.monthlyCount]),
    );
    const attempted30 = Number(recent._sum.attempted ?? 0);
    const succeeded30 = Number(recent._sum.succeeded ?? 0);
    const mrr = activeSubs.reduce(
      (sum, sub) =>
        sub.plan.isFree
          ? sum
          : sum.plus(
              sub.plan.billingInterval === 'YEARLY'
                ? sub.plan.basePrice.div(12)
                : sub.plan.basePrice,
            ),
      new Prisma.Decimal(0),
    );
    const severities = riskFlags.map((f) => f.severity);

    return {
      // What the Customer 360 header and stat strip read, in one place.
      overview: {
        mrrNgn: mrr.toString(),
        paidPlans: activeSubs.filter((s) => !s.plan.isFree).length,
        messages30d: attempted30,
        deliveredPct: attempted30
          ? Math.round((succeeded30 / attempted30) * 1000) / 10
          : null,
        lifetimeSpendNgn: (lifetime._sum.revenueNgn ?? 0).toString(),
        lastTopUpAt: lastTopUp?.createdAt ?? null,
        lastTopUpNgn: lastTopUp?.charge.toString() ?? null,
        riskScore: riskScore(severities),
        riskLevel: riskLevel(severities),
      },
      // One row per channel the account holds a plan on.
      products: activeSubs.map((sub) => ({
        id: sub.id,
        channel: sub.channel,
        plan: sub.plan.name,
        isFree: sub.plan.isFree,
        isTrial: sub.isTrial,
        priceNgn: sub.plan.basePrice.toString(),
        interval: sub.plan.billingInterval,
        overageEnabled: sub.plan.overageEnabled,
        monthlyQuota: sub.plan.monthlyQuota,
        used: quotaByChannel.get(sub.channel) ?? sub.usageCount,
        currentPeriodEnd: sub.currentPeriodEnd,
      })),
      subscriptions: activeSubs.map((sub) => ({
        id: sub.id,
        status: sub.status,
        plan: { id: sub.plan.id, name: sub.plan.name, channel: sub.channel },
        currentPeriodEnd: sub.currentPeriodEnd,
      })),
      profile: {
        id: account.id,
        businessName: account.senderIdApplications[0]?.businessName ?? null,
        ownerName: account.owner.displayName,
        email: maskEmail(account.owner.email),
        emailVerified: account.owner.emailVerified,
        phone: null,
        status: account.accountStatus,
        country: account.countryCode,
        billingAddress: account.billingAddress,
        createdAt: account.createdAt,
        lastLoginAt: account.owner.lastLoginAt,
        piiMasked: true,
      },
      // Neither KYC status nor a phone number is recorded in the product schema.
      kyc: { verified: null, hasDetails: false },
      creditBalance: account.creditBalance,
      welcomeBonusGrantedAt: account.welcomeBonusGrantedAt,
      currentPeriodEnd: account.currentPeriodEnd,
      subscription: account.subscriptions[0]
        ? {
            id: account.subscriptions[0].id,
            status: account.subscriptions[0].status,
            channel: account.subscriptions[0].channel,
            plan: account.subscriptions[0].plan,
            isTrial: account.subscriptions[0].isTrial,
            usageCount: account.subscriptions[0].usageCount,
            currentPeriodEnd: account.subscriptions[0].currentPeriodEnd,
          }
        : null,
      billing: account.accountBillings.map((b) => ({
        channel: b.channel,
        billingType: b.billingType,
        product: b.product.name,
      })),
      quotaUsage: account.usageBuffers.map((u) => ({
        channel: u.channel,
        dailyCount: u.dailyCount,
        monthlyCount: u.monthlyCount,
        lastSyncedAt: u.lastSyncedAt,
      })),
      projects: account.projects.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        emailUsageCount: p.emailUsageCount,
        apiUsageCount: p.apiUsageCount,
        createdAt: p.createdAt,
      })),
      users: [
        {
          id: account.owner.id,
          name: account.owner.displayName,
          email: maskEmail(account.owner.email),
          phone: null,
          lastLoginAt: account.owner.lastLoginAt,
          role: 'OWNER',
        },
      ],
      apiKeys: account.apiKeys.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: maskApiKeyPrefix(k.keyPrefix),
        permission: k.permission,
        usageCount: k.usageCount,
        isActive: k.isActive,
        projectId: k.projectId,
        lastUsedAt: k.lastUsedAt,
        expiresAt: k.expiresAt,
      })),
      senderIds: account.senderIdApplications.map((s) => ({
        id: s.id,
        senderId: s.senderId,
        businessName: s.businessName,
        cacRegNo: s.cacRegNo,
        status: s.status,
        projectId: s.projectId,
        submittedAt: s.submittedAt,
        reviewId: reviewByApplication.get(s.id)?.id ?? null,
        slaDueAt: reviewByApplication.get(s.id)?.slaDueAt ?? null,
      })),
      usageByChannel: usageByChannel.map((row) => ({
        channel: row.channel,
        attempted: row._sum.attempted ?? 0n,
        succeeded: row._sum.succeeded ?? 0n,
        failed: row._sum.failed ?? 0n,
        creditsSpent: row._sum.revenueNgn ?? '0',
      })),
      signInLocations: signIns.map((s) => ({
        occurredAt: s.occurredAt,
        country: s.country,
        city: s.city,
        ip: maskIp(s.ip),
        latitude: s.latitude,
        longitude: s.longitude,
      })),
      riskFlags,
      notes,
      tags: tags.map((t) => t.tag),
    };
  }

  /** The credit ledger: one row per debit, refund or top-up. */
  async ledger(
    accountId: string,
    query: {
      cursor?: string;
      limit?: number;
      from?: string;
      to?: string;
      type?: 'CREDIT' | 'DEBIT' | 'REFUND';
    },
  ) {
    const limit = query.limit ?? 50;
    const { start, end } = resolveRange(query.from, query.to, 90);
    const cursor = decodeCursor(query.cursor);

    const rows = await this.zapiack.read.tabTransaction.findMany({
      where: {
        accountId,
        createdAt: { gte: start, lte: end },
        ...(query.type ? { type: query.type } : {}),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: new Date(cursor.createdAt) } },
                {
                  createdAt: new Date(cursor.createdAt),
                  id: { lt: cursor.id },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    return buildPage(rows, limit);
  }

  async usage(accountId: string, query: CustomerUsageDto) {
    const { start, end } = resolveRange(query.from, query.to, 30);

    const rollups = await this.admin.usageRollup.groupBy({
      by: ['date', 'channel'],
      where: {
        accountId,
        hour: -1,
        date: { gte: lagosDateOnly(start), lte: lagosDateOnly(end) },
        ...(query.channel ? { channel: query.channel } : {}),
      },
      _sum: {
        attempted: true,
        succeeded: true,
        failed: true,
        units: true,
        revenueNgn: true,
      },
      orderBy: { date: 'asc' },
    });

    return {
      range: { from: start, to: end },
      series: rollups.map((row) => ({
        date: row.date,
        channel: row.channel,
        attempted: row._sum.attempted ?? 0n,
        succeeded: row._sum.succeeded ?? 0n,
        failed: row._sum.failed ?? 0n,
        units: row._sum.units ?? 0n,
        creditsSpent: row._sum.revenueNgn ?? '0',
      })),
    };
  }

  /**
   * Recent API requests, read from the product's own activity log. Keys are matched
   * by prefix because that is what the log records.
   */
  async requests(
    accountId: string,
    query: { cursor?: string; limit?: number; from?: string; to?: string },
    canSeeRawIp: boolean,
  ) {
    const limit = query.limit ?? 50;
    const { start, end } = resolveRange(query.from, query.to, 7);

    const keys = await this.zapiack.read.apiKeys.findMany({
      where: { accountId },
      select: { keyPrefix: true },
    });
    const prefixes = keys.map((k) => k.keyPrefix);
    if (!prefixes.length) return { data: [], hasMore: false, nextCursor: null };

    const rows = await this.zapiack.read.apiActivityLog.findMany({
      where: {
        apiKeyPrefix: { in: prefixes },
        createdAt: { gte: start, lte: end },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return {
      data: rows.map((row) => ({
        id: row.id,
        occurredAt: row.createdAt,
        endpoint: row.endpoint,
        method: row.method,
        statusCode: row.statusCode,
        status: row.status,
        service: row.service,
        projectId: row.projectId,
        country: row.countryCode,
        city: row.city,
        region: row.region,
        message: row.message,
        ip: canSeeRawIp ? row.ip : maskIp(row.ip),
      })),
      hasMore: rows.length === limit,
      nextCursor: null,
    };
  }

  // ---------------------------------------------------------------- PII

  /**
   * The one path to unmasked personal data. Requires pii.reveal, a written reason,
   * and writes its own audit entry naming exactly which fields were shown.
   */
  async revealPii(actor: StaffPrincipal, accountId: string, dto: RevealPiiDto) {
    const account = await this.zapiack.read.accounts.findUnique({
      where: { id: accountId },
      include: { owner: true },
    });
    if (!account) throw new NotFoundException('Account not found');

    const revealed: Record<string, unknown> = {};
    if (dto.fields.includes('email')) revealed.email = account.owner.email;
    if (dto.fields.includes('users')) {
      revealed.users = [
        {
          id: account.owner.id,
          email: account.owner.email,
          displayName: account.owner.displayName,
          countryCode: account.owner.countryCode,
          city: account.owner.city,
          region: account.owner.region,
        },
      ];
    }
    if (dto.fields.includes('ip')) {
      const keys = await this.zapiack.read.apiKeys.findMany({
        where: { accountId },
        select: { keyPrefix: true },
      });
      revealed.recentIps = await this.zapiack.read.apiActivityLog.findMany({
        where: { apiKeyPrefix: { in: keys.map((k) => k.keyPrefix) } },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { ip: true, createdAt: true, countryCode: true, city: true },
      });
    }
    // Phone and KYC details are not recorded in the product schema; asking for them
    // returns nothing rather than pretending the account has them.
    if (dto.fields.includes('phone')) revealed.phone = null;
    if (dto.fields.includes('kyc')) revealed.kyc = null;

    await this.audit.record({
      actor,
      action: 'pii.reveal',
      targetType: 'account',
      targetId: accountId,
      reason: dto.reason,
      metadata: { fields: dto.fields },
    });

    return {
      accountId,
      revealedAt: new Date(),
      fields: dto.fields,
      data: revealed,
    };
  }

  // ---------------------------------------------------------------- annotations

  async addNote(
    actor: StaffPrincipal,
    accountId: string,
    body: string,
    pinned = false,
  ) {
    const note = await this.admin.customerNote.create({
      data: { accountId, authorId: actor.id, body, pinned },
      include: { author: { select: { id: true, name: true } } },
    });
    await this.audit.recordSafe({
      actor,
      action: 'customers.note_added',
      targetType: 'account',
      targetId: accountId,
      after: { noteId: note.id },
    });
    return note;
  }

  async listNotes(
    accountId: string,
    query: { cursor?: string; limit?: number },
  ) {
    const limit = query.limit ?? 50;
    const rows = await this.admin.customerNote.findMany({
      where: { accountId, ...cursorWhere(decodeCursor(query.cursor)) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: { author: { select: { id: true, name: true } } },
    });
    return buildPage(rows, limit);
  }
}

const SEVERITY_WEIGHT: Record<string, number> = {
  LOW: 10,
  MEDIUM: 25,
  HIGH: 45,
  CRITICAL: 70,
};

/** A 0–100 score from the open flags, so the list and the detail page agree. */
export function riskScore(severities: string[]): number {
  const total = severities.reduce((n, s) => n + (SEVERITY_WEIGHT[s] ?? 10), 0);
  return Math.min(100, total);
}

export function riskLevel(severities: string[]): 'low' | 'medium' | 'high' {
  const score = riskScore(severities);
  return score >= 45 ? 'high' : score >= 20 ? 'medium' : 'low';
}
