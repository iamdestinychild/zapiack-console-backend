import { Injectable, NotFoundException } from '@nestjs/common';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { ZapiackPrismaService } from '../../common/prisma/zapiack-prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import {
  maskApiKeyPrefix,
  maskEmail,
  maskIp,
  maskPhone,
} from '../../common/http/masking';
import {
  buildPage,
  cursorWhere,
  decodeCursor,
  encodeCursor,
} from '../../common/http/pagination';
import { resolveRange } from '../../common/time/lagos';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import type {
  CustomerUsageDto,
  RevealPiiDto,
  SearchCustomersDto,
} from './dto/customers.dto';

/**
 * Reads for the customer list and Customer 360. Everything here comes from the
 * Zapiack read replica plus the staff-owned annotations in the Admin DB; nothing in
 * this service writes to product data.
 */
@Injectable()
export class CustomersService {
  constructor(
    private readonly zapiack: ZapiackPrismaService,
    private readonly admin: AdminPrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * One search box over six identifiers. An account id or API key prefix is matched
   * exactly; free text falls back to a case-insensitive contains across the rest.
   */
  async search(query: SearchCustomersDto) {
    const limit = query.limit ?? 50;
    const cursor = decodeCursor(query.cursor);
    const q = query.q?.trim();

    let idsFromRelations: string[] | undefined;
    if (q) {
      const [byKey, bySenderId] = await Promise.all([
        this.zapiack.read.apiKey.findMany({
          where: { prefix: { startsWith: q } },
          select: { accountId: true },
          take: 200,
        }),
        this.zapiack.read.senderIdApplication.findMany({
          where: { senderId: { equals: q, mode: 'insensitive' } },
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

    const accounts = await this.zapiack.read.account.findMany({
      where: {
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
        ...(query.status ? { status: query.status } : {}),
        ...(query.country ? { country: query.country } : {}),
        ...(flaggedIds ? { id: { in: flaggedIds } } : {}),
        ...(query.planId
          ? {
              subscriptions: {
                some: { planId: query.planId, status: 'active' },
              },
            }
          : {}),
        ...(q
          ? {
              OR: [
                { id: q },
                { email: { contains: q, mode: 'insensitive' as const } },
                { businessName: { contains: q, mode: 'insensitive' as const } },
                { phone: { contains: q } },
                ...(idsFromRelations ? [{ id: { in: idsFromRelations } }] : []),
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        subscriptions: {
          where: { status: 'active' },
          include: { plan: { select: { id: true, name: true } } },
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
        businessName: account.businessName,
        // Masked by default; the reveal endpoint is the only way to the real values.
        email: maskEmail(account.email),
        phone: maskPhone(account.phone),
        status: account.status,
        balanceNgn: account.balance,
        country: account.country,
        kycVerified: account.kycVerified,
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

  /**
   * Customer 360. One call so the screen does not fan out into a dozen requests;
   * the heavier tabs (ledger, usage, requests) paginate separately.
   */
  async get(accountId: string) {
    const account = await this.zapiack.read.account.findUnique({
      where: { id: accountId },
      include: {
        users: { orderBy: { createdAt: 'asc' }, take: 20 },
        apiKeys: { orderBy: { createdAt: 'desc' }, take: 20 },
        subscriptions: {
          orderBy: { startedAt: 'desc' },
          take: 5,
          include: { plan: true },
        },
        senderIds: { orderBy: { submittedAt: 'desc' }, take: 20 },
      },
    });
    if (!account) throw new NotFoundException('Account not found');

    const [notes, tags, riskFlags, signIns, usageByChannel, reviews] =
      await Promise.all([
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
            costNgn: true,
          },
        }),
        this.admin.senderIdReview.findMany({
          where: { accountId },
          orderBy: { submittedAt: 'desc' },
          take: 20,
        }),
      ]);

    const reviewByApplication = new Map(
      reviews.map((r) => [r.applicationId, r]),
    );

    return {
      profile: {
        id: account.id,
        businessName: account.businessName,
        email: maskEmail(account.email),
        phone: maskPhone(account.phone),
        status: account.status,
        country: account.country,
        createdAt: account.createdAt,
        piiMasked: true,
      },
      kyc: {
        verified: account.kycVerified,
        hasDetails: Boolean(account.kycDetails),
      },
      balanceNgn: account.balance,
      subscription: account.subscriptions[0]
        ? {
            id: account.subscriptions[0].id,
            status: account.subscriptions[0].status,
            plan: account.subscriptions[0].plan,
            currentPeriodEnd: account.subscriptions[0].currentPeriodEnd,
          }
        : null,
      users: account.users.map((u) => ({
        id: u.id,
        name: [u.firstName, u.lastName].filter(Boolean).join(' ') || null,
        email: maskEmail(u.email),
        phone: maskPhone(u.phone),
        lastLoginAt: u.lastLoginAt,
      })),
      apiKeys: account.apiKeys.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: maskApiKeyPrefix(k.prefix),
        lastUsedAt: k.lastUsedAt,
        revokedAt: k.revokedAt,
      })),
      senderIds: account.senderIds.map((s) => ({
        id: s.id,
        senderId: s.senderId,
        status: s.status,
        submittedAt: s.submittedAt,
        reviewId: reviewByApplication.get(s.id)?.id ?? null,
        slaDueAt: reviewByApplication.get(s.id)?.slaDueAt ?? null,
      })),
      usageByChannel: usageByChannel.map((row) => ({
        channel: row.channel,
        attempted: row._sum.attempted ?? 0n,
        succeeded: row._sum.succeeded ?? 0n,
        failed: row._sum.failed ?? 0n,
        revenueNgn: row._sum.revenueNgn ?? '0',
        costNgn: row._sum.costNgn ?? '0',
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

  async ledger(
    accountId: string,
    query: { cursor?: string; limit?: number; from?: string; to?: string },
  ) {
    const limit = query.limit ?? 50;
    const { start, end } = resolveRange(query.from, query.to, 90);
    const cursor = decodeCursor(query.cursor);

    const rows = await this.zapiack.read.tabTransaction.findMany({
      where: {
        accountId,
        createdAt: { gte: start, lte: end },
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
        date: { gte: start, lte: end },
        ...(query.channel ? { channel: query.channel } : {}),
      },
      _sum: {
        attempted: true,
        succeeded: true,
        failed: true,
        units: true,
        revenueNgn: true,
        costNgn: true,
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
        revenueNgn: row._sum.revenueNgn ?? '0',
        costNgn: row._sum.costNgn ?? '0',
      })),
    };
  }

  /** Recent API requests for this account. Raw IPs stay masked unless revealed. */
  async requests(
    accountId: string,
    query: { cursor?: string; limit?: number; from?: string; to?: string },
    canSeeRawIp: boolean,
  ) {
    const limit = query.limit ?? 50;
    const { start, end } = resolveRange(query.from, query.to, 7);

    const rows = await this.admin.requestLog.findMany({
      where: { accountId, occurredAt: { gte: start, lte: end } },
      orderBy: { occurredAt: 'desc' },
      take: limit,
    });

    return {
      data: rows.map((row) => ({
        id: row.id,
        occurredAt: row.occurredAt,
        endpoint: row.endpoint,
        method: row.method,
        statusCode: row.statusCode,
        latencyMs: row.latencyMs,
        country: row.country,
        city: row.city,
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
    const account = await this.zapiack.read.account.findUnique({
      where: { id: accountId },
      include: { users: { take: 50 } },
    });
    if (!account) throw new NotFoundException('Account not found');

    const revealed: Record<string, unknown> = {};
    if (dto.fields.includes('email')) revealed.email = account.email;
    if (dto.fields.includes('phone')) revealed.phone = account.phone;
    if (dto.fields.includes('kyc')) revealed.kyc = account.kycDetails;
    if (dto.fields.includes('users')) {
      revealed.users = account.users.map((u) => ({
        id: u.id,
        email: u.email,
        phone: u.phone,
        firstName: u.firstName,
        lastName: u.lastName,
      }));
    }
    if (dto.fields.includes('ip')) {
      const signIns = await this.admin.signInEvent.findMany({
        where: { accountId },
        orderBy: { occurredAt: 'desc' },
        take: 20,
        select: { ip: true, occurredAt: true, country: true, city: true },
      });
      revealed.recentIps = signIns;
    }

    // Audited before the data is returned, so a crash mid-response still leaves a trail.
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
