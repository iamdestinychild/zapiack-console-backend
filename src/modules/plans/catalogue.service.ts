import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { ZapiackPrismaService } from '../../common/prisma/zapiack-prisma.service';
import { ZapiackWriteService } from '../../common/prisma/zapiack-write.service';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import type {
  UpsertPlanDto,
  UpsertProductDto,
  UpsertProductPricingDto,
} from './dto/catalogue.dto';

/**
 * The billable catalogue: products, the credits they cost per country, and the plans
 * customers subscribe to.
 *
 * These rows decide what every future send is charged, so each change is audited with
 * a before/after snapshot and a written reason. Note that the product schema keeps no
 * price history — a change replaces the current value rather than superseding it, so
 * past usage cannot be re-priced and the audit log is the only record of what a rate
 * used to be.
 */
@Injectable()
export class CatalogueService {
  constructor(
    private readonly zapiack: ZapiackPrismaService,
    private readonly writer: ZapiackWriteService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- products

  async listProducts() {
    const data = await this.zapiack.read.products.findMany({
      orderBy: { channel: 'asc' },
      include: { pricing: { orderBy: { countryCode: 'asc' } } },
    });
    return { data, hasMore: false, nextCursor: null };
  }

  /**
   * Creates a product. A channel may only have one, so this refuses rather than
   * overwriting: upserting on channel would let "create WhatsApp" silently rename
   * the live SMS product, which is a quiet way to lose a catalogue entry.
   */
  async createProduct(actor: StaffPrincipal, dto: UpsertProductDto) {
    const existing = await this.zapiack.read.products.findUnique({
      where: { channel: dto.channel },
    });
    if (existing) {
      throw new ConflictException(
        `The ${dto.channel} channel already has a product ("${existing.name}", id ${existing.id}). Update that one instead.`,
      );
    }

    const product = await this.writer.write.products.create({
      data: {
        name: dto.name,
        channel: dto.channel,
        description: dto.description,
        billingTypes: dto.billingTypes,
        isActive: dto.isActive ?? true,
      },
    });

    await this.audit.record({
      actor,
      action: 'products.created',
      targetType: 'product',
      targetId: product.id,
      reason: dto.reason,
      after: product,
    });

    return product;
  }

  /** Updates a product by id. The channel is immutable: it is the product's identity. */
  async updateProduct(
    actor: StaffPrincipal,
    productId: string,
    dto: UpsertProductDto,
  ) {
    const before = await this.zapiack.read.products.findUnique({
      where: { id: productId },
    });
    if (!before) throw new NotFoundException('Product not found');

    if (dto.channel !== before.channel) {
      throw new ConflictException(
        `A product's channel cannot change (${before.channel} to ${dto.channel}). Create a separate product instead.`,
      );
    }

    const product = await this.writer.write.products.update({
      where: { id: productId },
      data: {
        name: dto.name,
        description: dto.description,
        billingTypes: dto.billingTypes,
        isActive: dto.isActive ?? before.isActive,
      },
    });

    await this.audit.record({
      actor,
      action: 'products.updated',
      targetType: 'product',
      targetId: product.id,
      reason: dto.reason,
      before,
      after: product,
    });

    return product;
  }

  // ---------------------------------------------------------------- pricing

  async upsertPricing(actor: StaffPrincipal, dto: UpsertProductPricingDto) {
    const product = await this.zapiack.read.products.findUnique({
      where: { id: dto.productId },
    });
    if (!product) throw new NotFoundException('Product not found');

    const countryCode = dto.countryCode.toUpperCase();
    const before = await this.zapiack.read.productPricing.findUnique({
      where: {
        productId_countryCode: { productId: dto.productId, countryCode },
      },
    });

    const pricing = await this.writer.write.productPricing.upsert({
      where: {
        productId_countryCode: { productId: dto.productId, countryCode },
      },
      create: {
        productId: dto.productId,
        countryCode,
        creditCost: dto.creditCost,
        isActive: dto.isActive ?? true,
      },
      update: { creditCost: dto.creditCost, isActive: dto.isActive ?? true },
    });

    await this.audit.record({
      actor,
      action: before ? 'pricing.updated' : 'pricing.created',
      targetType: 'product_pricing',
      targetId: pricing.id,
      reason: dto.reason,
      // The only record of the previous rate: the product keeps no price history.
      before: before && {
        creditCost: before.creditCost,
        isActive: before.isActive,
      },
      after: { creditCost: pricing.creditCost, isActive: pricing.isActive },
      metadata: { channel: product.channel, countryCode },
    });

    return pricing;
  }

  // ---------------------------------------------------------------- plans

  async upsertPlan(actor: StaffPrincipal, dto: UpsertPlanDto) {
    const before = dto.id
      ? await this.zapiack.read.plans.findUnique({ where: { id: dto.id } })
      : null;
    if (dto.id && !before) throw new NotFoundException('Plan not found');

    const clash = await this.zapiack.read.plans.findUnique({
      where: { slug: dto.slug },
    });
    if (clash && clash.id !== dto.id) {
      throw new ConflictException(`A plan already uses the slug "${dto.slug}"`);
    }

    const data = {
      name: dto.name,
      slug: dto.slug,
      description: dto.description,
      type: dto.type,
      channel: dto.channel,
      billingInterval: dto.billingInterval ?? 'MONTHLY',
      basePrice: dto.basePrice,
      overagePrice: dto.overagePrice,
      overageEnabled: dto.overageEnabled ?? true,
      monthlyQuota: Number(dto.monthlyQuota),
      dailyQuota: dto.dailyQuota ? Number(dto.dailyQuota) : null,
      maxContacts: dto.maxContacts ? Number(dto.maxContacts) : 0,
      isActive: dto.isActive ?? true,
      isPublic: dto.isPublic ?? true,
      isFree: dto.isFree ?? false,
    };

    const plan = before
      ? await this.writer.write.plans.update({ where: { id: before.id }, data })
      : await this.writer.write.plans.create({ data });

    await this.audit.record({
      actor,
      action: before ? 'plans.updated' : 'plans.created',
      targetType: 'plan',
      targetId: plan.id,
      reason: dto.reason,
      before,
      after: plan,
    });

    return plan;
  }

  /**
   * Retiring a plan hides it from signup without touching anyone already on it —
   * deleting it would orphan live subscriptions.
   */
  async setPlanActive(
    actor: StaffPrincipal,
    planId: string,
    isActive: boolean,
    reason: string,
  ) {
    const before = await this.zapiack.read.plans.findUnique({
      where: { id: planId },
    });
    if (!before) throw new NotFoundException('Plan not found');

    const subscribers = await this.zapiack.read.subscriptions.count({
      where: { planId, status: 'ACTIVE' },
    });

    const plan = await this.writer.write.plans.update({
      where: { id: planId },
      data: { isActive, isPublic: isActive ? before.isPublic : false },
    });

    await this.audit.record({
      actor,
      action: isActive ? 'plans.activated' : 'plans.retired',
      targetType: 'plan',
      targetId: planId,
      reason,
      before: { isActive: before.isActive, isPublic: before.isPublic },
      after: { isActive: plan.isActive, isPublic: plan.isPublic },
      metadata: { activeSubscribers: subscribers },
    });

    return {
      id: plan.id,
      isActive: plan.isActive,
      activeSubscribers: subscribers,
    };
  }
}
