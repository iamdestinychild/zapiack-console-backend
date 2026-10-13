import {
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { DateTime } from 'luxon';
import { Prisma } from '../../generated/admin/client';
import type { Prisma as ZapiackPrisma } from '../../generated/zapiack/client';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { ZapiackPrismaService } from '../../common/prisma/zapiack-prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { maskEmail, maskPhone } from '../../common/http/masking';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import type {
  SegmentFilterDto,
  UpsertSegmentDto,
} from './dto/notifications.dto';

export interface ResolvedRecipient {
  accountId: string;
  /** The account owner. In-app notifications belong to a user, not an account. */
  userId: string;
  email: string;
  phone: string | null;
  businessName: string | null;
}

/**
 * Saved audiences. A segment stores the filter, not the account list, so a campaign
 * sent tomorrow reaches whoever matches tomorrow.
 */
@Injectable()
export class SegmentsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SegmentsService.name);

  constructor(
    private readonly admin: AdminPrismaService,
    private readonly zapiack: ZapiackPrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Segments every console needs on day one. "Everyone" is a segment with an empty
   * filter, and having it ready is what makes a send-to-all possible without first
   * knowing that. Created once and then left alone: staff may rename or edit them.
   */
  async onApplicationBootstrap() {
    const system = [
      {
        name: 'All customers',
        description: 'Every account, whatever its status.',
        filter: {},
      },
      {
        name: 'Active customers',
        description: 'Accounts in good standing.',
        filter: { statuses: ['ACTIVE'] },
      },
    ];
    try {
      for (const segment of system) {
        const exists = await this.admin.segment.findUnique({
          where: { name: segment.name },
          select: { id: true },
        });
        if (exists) continue;
        await this.admin.segment.create({
          data: {
            name: segment.name,
            description: segment.description,
            filter: segment.filter,
          },
        });
        this.logger.log(`Created the "${segment.name}" segment`);
      }
    } catch (err) {
      this.logger.error(`System segments skipped: ${(err as Error).message}`);
    }
  }

  async list() {
    const data = await this.admin.segment.findMany({
      orderBy: { name: 'asc' },
    });
    return { data, hasMore: false, nextCursor: null };
  }

  async upsert(actor: StaffPrincipal, dto: UpsertSegmentDto) {
    const segment = await this.admin.segment.upsert({
      where: { name: dto.name },
      create: {
        name: dto.name,
        description: dto.description,
        filter: dto.filter as unknown as Prisma.InputJsonValue,
        createdBy: actor.id,
      },
      update: {
        description: dto.description,
        filter: dto.filter as unknown as Prisma.InputJsonValue,
      },
    });

    await this.audit.record({
      actor,
      action: 'segments.upserted',
      targetType: 'segment',
      targetId: segment.id,
      after: dto,
    });

    // Size is useful immediately; a segment nobody matches is usually a typo.
    const size = await this.count(dto.filter);
    return { ...segment, estimatedSize: size };
  }

  async preview(filter: SegmentFilterDto) {
    const [size, sample] = await Promise.all([
      this.count(filter),
      this.resolve(filter, 10),
    ]);
    return {
      estimatedSize: size,
      // A preview is not a reveal: the sample stays masked.
      sample: sample.map((r) => ({
        accountId: r.accountId,
        businessName: r.businessName,
        email: maskEmail(r.email),
        phone: maskPhone(r.phone),
      })),
    };
  }

  async count(filter: SegmentFilterDto): Promise<number> {
    return this.zapiack.read.accounts.count({
      where: this.buildWhere(filter),
    });
  }

  /** Resolves a filter into the accounts a campaign will actually reach. */
  async resolve(
    filter: SegmentFilterDto,
    limit?: number,
  ): Promise<ResolvedRecipient[]> {
    const accounts = await this.zapiack.read.accounts.findMany({
      where: this.buildWhere(filter),
      // Contact details come from the account owner; the account itself has none.
      select: {
        id: true,
        userId: true,
        owner: { select: { email: true, displayName: true } },
      },
      // A stable order, so a paged or resumed send never skips or repeats an account.
      orderBy: { id: 'asc' },
      ...(limit ? { take: limit } : {}),
    });
    return accounts.map((a) => ({
      accountId: a.id,
      userId: a.userId,
      email: a.owner.email,
      // The product schema records no phone number, so SMS campaigns cannot be
      // addressed from it. Email and in-app are unaffected.
      phone: null,
      businessName: a.owner.displayName,
    }));
  }

  /** The named accounts, for a hand-picked campaign. Ids that no longer exist drop out. */
  async resolveAccounts(accountIds: string[]): Promise<ResolvedRecipient[]> {
    if (!accountIds.length) return [];
    const accounts = await this.zapiack.read.accounts.findMany({
      where: { id: { in: accountIds } },
      select: {
        id: true,
        userId: true,
        owner: { select: { email: true, displayName: true } },
      },
      orderBy: { id: 'asc' },
    });
    return accounts.map((a) => ({
      accountId: a.id,
      userId: a.userId,
      email: a.owner.email,
      phone: null,
      businessName: a.owner.displayName,
    }));
  }

  async resolveById(segmentId: string): Promise<ResolvedRecipient[]> {
    const segment = await this.admin.segment.findUnique({
      where: { id: segmentId },
    });
    if (!segment) throw new NotFoundException('Segment not found');
    return this.resolve(segment.filter as SegmentFilterDto);
  }

  /**
   * The filter as a read against the product's own columns. Every clause is a real
   * field of the Zapiack schema; a guessed name does not degrade, it throws, which is
   * how every filter except "everyone" used to fail.
   */
  private buildWhere(
    filter: SegmentFilterDto,
  ): ZapiackPrisma.AccountsWhereInput {
    const clauses: ZapiackPrisma.AccountsWhereInput[] = [];

    if (filter.statuses?.length) {
      clauses.push({
        accountStatus: { in: filter.statuses as never },
      });
    }
    if (filter.countries?.length) {
      clauses.push({
        countryCode: { in: filter.countries.map((c) => c.toUpperCase()) },
      });
    }

    // `balanceBelowNgn` is the old name for the same thing: the balance is in credits.
    const creditsBelow = filter.creditsBelow ?? filter.balanceBelowNgn;
    if (creditsBelow !== undefined) {
      clauses.push({ creditBalance: { lt: creditsBelow } });
    }

    if (filter.emailVerified !== undefined) {
      clauses.push({ owner: { emailVerified: filter.emailVerified } });
    }

    if (filter.planIds?.length) {
      // Subscription status is stored upper-case; matching 'active' matched nobody.
      clauses.push({
        subscriptions: {
          some: { planId: { in: filter.planIds }, status: 'ACTIVE' },
        },
      });
    }

    if (filter.usedChannel) {
      clauses.push({
        logEvents: { some: { channel: filter.usedChannel as never } },
      });
    }

    if (filter.inactiveForDays !== undefined) {
      const cutoff = DateTime.now()
        .minus({ days: filter.inactiveForDays })
        .toJSDate();
      // "Inactive for N days" means nothing sent since the cutoff, which includes
      // accounts that have never sent anything at all.
      clauses.push({ logEvents: { none: { createdAt: { gte: cutoff } } } });
    }

    return clauses.length ? { AND: clauses } : {};
  }
}
