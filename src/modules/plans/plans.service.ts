import { BadRequestException, Injectable } from '@nestjs/common';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { ZapiackPrismaService } from '../../common/prisma/zapiack-prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiCoreClient } from '../../integrations/api-core/api-core.client';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import type {
  ListPricingDto,
  SetMarginTargetDto,
  UpsertPlanDto,
  UpsertPricingDto,
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
    private readonly apiCore: ApiCoreClient,
    private readonly audit: AuditService,
  ) {}

  listPlans() {
    return this.zapiack.read.plan.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { subscriptions: true } } },
    });
  }

  async upsertPlan(actor: StaffPrincipal, dto: UpsertPlanDto) {
    const before = dto.id
      ? await this.zapiack.read.plan.findUnique({ where: { id: dto.id } })
      : null;

    const result = await this.apiCore.upsertPlan(
      {
        id: dto.id,
        name: dto.name,
        billingType: dto.billingType,
        priceNgn: dto.priceNgn,
        interval: dto.interval,
        active: dto.active ?? true,
      },
      { actorId: actor.id, actorEmail: actor.email },
    );

    await this.audit.record({
      actor,
      action: before ? 'plans.updated' : 'plans.created',
      targetType: 'plan',
      targetId: result?.id ?? dto.id,
      reason: dto.reason,
      before,
      after: dto,
    });

    return result;
  }

  // ---------------------------------------------------------------- pricing

  async listPricing(query: ListPricingDto) {
    const asOf = query.asOf ? new Date(query.asOf) : new Date();

    const rows = await this.zapiack.read.channelPricing.findMany({
      where: {
        ...(query.channel ? { channel: query.channel as never } : {}),
        ...(query.accountId ? { accountId: query.accountId } : {}),
        ...(query.includeHistory
          ? {}
          : {
              effectiveFrom: { lte: asOf },
              OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }],
            }),
      },
      orderBy: [{ channel: 'asc' }, { effectiveFrom: 'desc' }],
      include: { plan: { select: { id: true, name: true } } },
    });

    // Pair each price with the provider cost in force at the same moment, so the
    // pricing screen can show margin without a second round trip.
    const costs = await this.admin.providerCost.findMany({
      where: {
        ...(query.channel ? { channel: query.channel } : {}),
        effectiveFrom: { lte: asOf },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }],
      },
      orderBy: { effectiveFrom: 'desc' },
    });

    return {
      asOf,
      pricing: rows.map((row) => {
        const cost = costs.find(
          (c) =>
            c.channel === row.channel &&
            (c.country ?? null) === (row.country ?? null) &&
            (c.network ?? null) === (row.network ?? null),
        );
        return {
          ...row,
          providerCostNgn: cost?.unitCostNgn ?? null,
          provider: cost?.provider ?? null,
          marginNgn:
            cost && row.unitPriceNgn
              ? row.unitPriceNgn.minus(cost.unitCostNgn).toString()
              : null,
        };
      }),
    };
  }

  async upsertPricing(actor: StaffPrincipal, dto: UpsertPricingDto) {
    if (dto.accountId && !dto.effectiveTo) {
      // Enterprise deals that never expire become invisible discounts nobody reviews.
      throw new BadRequestException(
        'Per-account pricing must carry an expiry (effectiveTo)',
      );
    }
    if (
      dto.effectiveTo &&
      new Date(dto.effectiveTo) <= new Date(dto.effectiveFrom)
    ) {
      throw new BadRequestException('effectiveTo must be after effectiveFrom');
    }

    const result = await this.apiCore.upsertChannelPricing(dto, {
      actorId: actor.id,
      actorEmail: actor.email,
    });

    await this.audit.record({
      actor,
      action: 'pricing.updated',
      targetType: 'channel_pricing',
      targetId: result?.id,
      reason: dto.reason,
      after: dto,
    });

    return result;
  }

  // ---------------------------------------------------------------- provider costs

  listProviderCosts(query: {
    channel?: string;
    provider?: string;
    includeHistory?: boolean;
  }) {
    const now = new Date();
    return this.admin.providerCost.findMany({
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
