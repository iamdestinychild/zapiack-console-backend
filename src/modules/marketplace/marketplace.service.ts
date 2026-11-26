import { ConflictException, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import {
  TemplateReviewClient,
  type ApiCoreMarketplaceListing,
} from '../../integrations/api-core/template-review.client';

export const LISTING_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'withdrawn',
] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];
export type ListingAction = 'approve' | 'reject' | 'take_down';

/** Which decisions a listing in a given status can take. Approve and reject while it waits; take down once it is live. */
export function allowedListingActions(status: string): ListingAction[] {
  if (status === 'pending') return ['approve', 'reject'];
  if (status === 'approved') return ['take_down'];
  return [];
}

/**
 * Review of the templates customers offer to the marketplace. api-core keeps the listings and makes the decision; this adds who may
 * review, the audit trail and the shape the console reads.
 */
@Injectable()
export class MarketplaceReviewService {
  constructor(
    private readonly client: TemplateReviewClient,
    private readonly audit: AuditService,
  ) {}

  /** One status's listings, with a count for every status so the tabs can show them. */
  async list(status: ListingStatus = 'pending', q?: string) {
    const all = await Promise.all(
      LISTING_STATUSES.map((s) => this.client.marketplaceQueue(s)),
    );
    const counts = Object.fromEntries(
      LISTING_STATUSES.map((s, i) => [s, all[i].length]),
    ) as Record<ListingStatus, number>;
    const needle = q?.trim().toLowerCase();
    const rows = all[LISTING_STATUSES.indexOf(status)].filter(
      (r) =>
        !needle ||
        [r.title, r.slug, r.authorName, r.accountId, r.projectId].some((f) =>
          f?.toLowerCase().includes(needle),
        ),
    );
    return {
      counts,
      data: rows.map((r) => ({
        ...summary(r),
        actions: allowedListingActions(r.status),
      })),
    };
  }

  /** Every listing in the marketplace, for staff to manage: Zapiack's own, the community's, and what is hidden. */
  catalog(channel?: string, q?: string) {
    return this.client.marketplaceCatalog(channel, q);
  }

  /** Hides, shows or features a listing. It is recorded who did it, and what it was before. */
  async setOverride(
    actor: StaffPrincipal,
    channel: string,
    slug: string,
    input: { hidden?: boolean; featured?: boolean },
    reason: string,
  ) {
    const out = await this.client.setMarketplaceOverride(
      channel,
      slug,
      `console:${actor.id}`,
      input,
    );
    await this.audit.record({
      actor,
      action:
        input.hidden === undefined
          ? input.featured
            ? 'marketplace.feature'
            : 'marketplace.unfeature'
          : input.hidden
            ? 'marketplace.hide'
            : 'marketplace.show',
      targetType: 'marketplace_listing',
      targetId: out.key,
      reason,
      before: out.before,
      after: out.after,
      metadata: { channel, slug },
    });
    return out;
  }

  async get(id: string) {
    const row = await this.client.marketplaceListing(id);
    return { ...row, actions: allowedListingActions(row.status) };
  }

  async decide(
    actor: StaffPrincipal,
    id: string,
    action: ListingAction,
    reason: string,
  ) {
    const before = await this.client.marketplaceListing(id);
    if (!allowedListingActions(before.status).includes(action))
      throw new ConflictException(
        `A ${before.status} listing cannot be ${action === 'take_down' ? 'taken down' : `${action}d`}`,
      );
    const after = await this.client.decideMarketplace(
      id,
      `console:${actor.id}`,
      {
        approve: action === 'approve',
        reason: action === 'approve' ? undefined : reason,
      },
    );
    await this.audit.record({
      actor,
      action: `marketplace.${action}`,
      targetType: 'marketplace_listing',
      targetId: id,
      reason,
      before: { status: before.status },
      after: { status: after.status },
      metadata: {
        slug: before.slug,
        channel: before.channel,
        title: before.title,
        accountId: before.accountId,
        projectId: before.projectId,
      },
    });
    return {
      id: after.id,
      status: after.status,
      previousStatus: before.status,
      rejectionReason: after.rejectionReason,
      reviewedAt: after.reviewedAt,
    };
  }
}

function summary(r: ApiCoreMarketplaceListing) {
  return {
    id: r.id,
    slug: r.slug,
    channel: r.channel,
    kind: r.kind,
    title: r.title,
    description: r.description,
    category: r.category,
    status: r.status,
    authorName: r.authorName,
    accountId: r.accountId,
    projectId: r.projectId,
    rejectionReason: r.rejectionReason,
    createdAt: r.createdAt,
    reviewedAt: r.reviewedAt,
  };
}
