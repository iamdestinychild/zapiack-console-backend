import { Injectable } from '@nestjs/common';
import type { ChannelType } from '../../generated/zapiack/client';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { ZapiackPrismaService } from '../../common/prisma/zapiack-prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import type {
  ListPricingDto,
  SetMarginTargetDto,
  UpsertProviderCostDto,
} from './dto/plans.dto';

/**
 * Plans and customer-facing prices live in the Zapiack DB and are changed through
 * api-core. Provider costs and margin targets live in the Admin DB, which admin-core
 * owns. Both sides are versioned by effective-from and never overwritten.
 */
@Injectable()
export class PlansService {
  constructor(
    private readonly zapiack: ZapiackPrismaService,
    private readonly admin: AdminPrismaService,
    private readonly audit: AuditService,
  ) {}

  async listPlans() {
    const [plans, active] = await Promise.all([
      this.zapiack.read.plans.findMany({
        orderBy: { name: 'asc' },
        include: { _count: { select: { subscriptions: true } } },
      }),
      this.zapiack.read.subscriptions.groupBy({
        by: ['planId'],
        where: { status: 'ACTIVE' },
        _count: { _all: true },
      }),
    ]);
    const activeByPlan = new Map(active.map((r) => [r.planId, r._count._all]));
    // `subscriptions` counts every subscription ever; `activeSubscribers` is who is on
    // the plan now, which is what matters before changing its price or retiring it.
    const data = plans.map((plan) => ({
      ...plan,
      activeSubscribers: activeByPlan.get(plan.id) ?? 0,
    }));
    return { data, hasMore: false, nextCursor: null };
  }

  // ---------------------------------------------------------------- pricing

  // ---------------------------------------------------------------- provider costs

  /**
   * Customer-facing prices: credits per product per destination country. The product
   * keeps no effective-from history on these rows, so `asOf` and `includeHistory`
   * have nothing to act on yet.
   */
  async listPricing(query: ListPricingDto) {
    const asOf = query.asOf ? new Date(query.asOf) : new Date();

    const rows = await this.zapiack.read.productPricing.findMany({
      where: {
        ...(query.includeHistory ? {} : { isActive: true }),
        ...(query.channel
          ? { product: { channel: query.channel as ChannelType } }
          : {}),
      },
      orderBy: [{ countryCode: 'asc' }],
      include: { product: { select: { id: true, name: true, channel: true } } },
    });

    return {
      asOf,
      data: rows.map((row) => ({
        id: row.id,
        channel: row.product.channel,
        product: { id: row.product.id, name: row.product.name },
        countryCode: row.countryCode,
        creditCost: row.creditCost,
        isActive: row.isActive,
        updatedAt: row.updatedAt,
        // Provider cost is not recorded in the product schema, so margin cannot be
        // shown. The Admin DB's ProviderCost table is ready for when it is.
        providerCostNgn: null,
        margin: null,
      })),
    };
  }

  async listProviderCosts(query: {
    channel?: string;
    provider?: string;
    includeHistory?: boolean;
  }) {
    const now = new Date();
    const data = await this.admin.providerCost.findMany({
      where: {
        ...(query.channel ? { channel: query.channel } : {}),
        ...(query.provider ? { provider: query.provider } : {}),
        ...(query.includeHistory
          ? {}
          : {
              effectiveFrom: { lte: now },
              OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
            }),
      },
      orderBy: [
        { channel: 'asc' },
        { provider: 'asc' },
        { effectiveFrom: 'desc' },
      ],
    });
    return { data, hasMore: false, nextCursor: null };
  }

  async upsertProviderCost(actor: StaffPrincipal, dto: UpsertProviderCostDto) {
    const effectiveFrom = new Date(dto.effectiveFrom);

    // Close the open-ended row this one supersedes rather than editing it, so the
    // history stays intact and yesterday's profit does not move.
    const superseded = await this.admin.providerCost.findFirst({
      where: {
        provider: dto.provider,
        channel: dto.channel,
        country: dto.country ?? null,
        network: dto.network ?? null,
        effectiveTo: null,
        effectiveFrom: { lt: effectiveFrom },
      },
      orderBy: { effectiveFrom: 'desc' },
    });

    const created = await this.admin.$transaction(async (tx) => {
      if (superseded) {
        await tx.providerCost.update({
          where: { id: superseded.id },
          data: { effectiveTo: effectiveFrom },
        });
      }
      return tx.providerCost.create({
        data: {
          provider: dto.provider,
          channel: dto.channel,
          country: dto.country,
          network: dto.network,
          unitCostNgn: dto.unitCostNgn,
          effectiveFrom,
          effectiveTo: dto.effectiveTo ? new Date(dto.effectiveTo) : null,
          note: dto.note,
          createdBy: actor.id,
        },
      });
    });

    await this.audit.record({
      actor,
      action: 'provider_costs.updated',
      targetType: 'provider_cost',
      targetId: created.id,
      reason: dto.reason,
      before: superseded
        ? { id: superseded.id, unitCostNgn: superseded.unitCostNgn.toString() }
        : undefined,
      after: { unitCostNgn: dto.unitCostNgn, effectiveFrom: dto.effectiveFrom },
    });

    return created;
  }

  async setMarginTarget(actor: StaffPrincipal, dto: SetMarginTargetDto) {
    const target = await this.admin.marginTarget.create({
      data: {
        channel: dto.channel,
        targetMargin: dto.targetMargin,
        effectiveFrom: new Date(dto.effectiveFrom),
        createdBy: actor.id,
      },
    });
    await this.audit.record({
      actor,
      action: 'margin_targets.set',
      targetType: 'margin_target',
      targetId: target.id,
      reason: dto.reason,
      after: dto,
    });
    return target;
  }

  /** The cost in force for a channel at a moment, used by the rollup jobs. */
  async costAt(
    channel: string,
    at: Date,
    opts: { provider?: string; country?: string; network?: string } = {},
  ) {
    return this.admin.providerCost.findFirst({
      where: {
        channel,
        ...(opts.provider ? { provider: opts.provider } : {}),
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
        // Prefer the most specific match; the order below settles ties.
        AND: [
          { OR: [{ country: opts.country ?? null }, { country: null }] },
          { OR: [{ network: opts.network ?? null }, { network: null }] },
        ],
      },
      orderBy: [
        { network: 'desc' },
        { country: 'desc' },
        { effectiveFrom: 'desc' },
      ],
    });
  }
}
