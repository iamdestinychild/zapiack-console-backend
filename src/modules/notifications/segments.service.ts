import { Injectable, NotFoundException } from '@nestjs/common';
import { DateTime } from 'luxon';
import { Prisma } from '../../generated/admin/client';
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
  email: string;
  phone: string | null;
  businessName: string | null;
}

/**
 * Saved audiences. A segment stores the filter, not the account list, so a campaign
 * sent tomorrow reaches whoever matches tomorrow.
 */
@Injectable()
export class SegmentsService {
  constructor(
    private readonly admin: AdminPrismaService,
    private readonly zapiack: ZapiackPrismaService,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.admin.segment.findMany({ orderBy: { name: 'asc' } });
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
    return this.zapiack.read.account.count({
      where: this.buildWhere(filter),
    });
  }

  /** Resolves a filter into the accounts a campaign will actually reach. */
  async resolve(
    filter: SegmentFilterDto,
    limit?: number,
  ): Promise<ResolvedRecipient[]> {
    const accounts = await this.zapiack.read.account.findMany({
      where: this.buildWhere(filter),
      select: { id: true, email: true, phone: true, businessName: true },
      ...(limit ? { take: limit } : {}),
    });
    return accounts.map((a) => ({
      accountId: a.id,
      email: a.email,
      phone: a.phone,
      businessName: a.businessName,
    }));
  }

  async resolveById(segmentId: string): Promise<ResolvedRecipient[]> {
    const segment = await this.admin.segment.findUnique({
      where: { id: segmentId },
    });
    if (!segment) throw new NotFoundException('Segment not found');
    return this.resolve(segment.filter as SegmentFilterDto);
  }

  private buildWhere(filter: SegmentFilterDto) {
    const where: Record<string, unknown> = {};

    if (filter.statuses?.length) where.status = { in: filter.statuses };
    if (filter.countries?.length) where.country = { in: filter.countries };
    if (filter.kycVerified !== undefined)
      where.kycVerified = filter.kycVerified;
    if (filter.balanceBelowNgn !== undefined)
      where.balance = { lt: filter.balanceBelowNgn };

    if (filter.planIds?.length) {
      where.subscriptions = {
        some: { planId: { in: filter.planIds }, status: 'active' },
      };
    }

    if (filter.usedChannel) {
      where.usage = { some: { channel: filter.usedChannel } };
    }

    if (filter.inactiveForDays !== undefined) {
      const cutoff = DateTime.now()
        .minus({ days: filter.inactiveForDays })
        .toJSDate();
      // "Inactive for N days" means no usage since the cutoff, which includes accounts
      // that have never sent anything at all.
      where.usage = { none: { createdAt: { gte: cutoff } } };
    }

    return where;
  }
}
