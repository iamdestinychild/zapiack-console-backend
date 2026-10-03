import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DateTime } from 'luxon';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { ZapiackPrismaService } from '../../common/prisma/zapiack-prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { ZapiackWriteService } from '../../common/prisma/zapiack-write.service';
import { NotificationsGateway } from '../inbox/notifications.gateway';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import {
  CHECKLIST,
  REASON_REQUIRED,
  allowedNext,
  assertTransition,
  type SenderIdStatus,
} from './sender-id-state';
import type {
  DecisionDto,
  ListSenderIdsDto,
  UpdateChecklistDto,
} from './dto/sender-ids.dto';

/** Median review target of one business day, per the PRD's success measure. */
const SLA_HOURS = 24;

/**
 * The compliance queue. The application itself lives in the Zapiack DB; the review —
 * assignment, checklist, comments, SLA — lives in the Admin DB and is keyed by
 * application id with no cross-database foreign key.
 */
@Injectable()
export class SenderIdsService {
  private readonly logger = new Logger(SenderIdsService.name);

  constructor(
    private readonly admin: AdminPrismaService,
    private readonly zapiack: ZapiackPrismaService,
    private readonly writer: ZapiackWriteService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsGateway,
  ) {}

  /**
   * Creates the review shell when a `senderid.submitted` event arrives.
   *
   * The product stores `status` as a free string starting at `DRAFT`; the review
   * record keeps a typed status of its own, so the two are mapped rather than shared.
   */
  async ensureReview(applicationId: string, notify = true) {
    const existing = await this.admin.senderIdReview.findUnique({
      where: { applicationId },
    });
    if (existing) return existing;

    const application = await this.zapiack.read.senderIdApplication.findUnique({
      where: { id: applicationId },
    });
    if (!application)
      throw new NotFoundException('Sender ID application not found');

    const status = toReviewStatus(application.status);
    // A draft has not been filed yet, so there is nothing to review.
    if (!status) return null;

    // An application filed before its review row existed still carries its filing
    // date; falling back to createdAt keeps the SLA honest rather than starting now.
    const submittedAt = application.submittedAt ?? application.createdAt;
    const decided = [
      'APPROVED',
      'REJECTED',
      'ACTIVE',
      'OPERATOR_REJECTED',
    ].includes(status);

    const review = await this.admin.senderIdReview.create({
      data: {
        applicationId,
        accountId: application.accountId,
        senderId: application.senderId,
        status,
        submittedAt,
        decidedAt: decided ? (application.reviewedAt ?? new Date()) : null,
        decisionReason: application.rejectionReason,
        slaDueAt: DateTime.fromJSDate(submittedAt)
          .plus({ hours: SLA_HOURS })
          .toJSDate(),
        checklist: {
          create: CHECKLIST.map((item) => ({
            key: item.key,
            label: item.label,
          })),
        },
        events: {
          create: { toStatus: status, comment: 'Application received' },
        },
      },
    });

    if (!notify) return review;

    await this.notifications.broadcastToPermission('senderid.review', {
      type: 'senderid.submitted',
      severity: 'MEDIUM',
      title: `New sender ID application: ${application.senderId}`,
      body: `Due for review by ${review.slaDueAt.toISOString()}`,
      link: `/sender-ids/${review.id}`,
    });

    return review;
  }

  /**
   * Imports applications the product has that the console has no review for.
   *
   * The product creates these itself, so the `senderid.submitted` event this queue was
   * built around never arrives. A handful of arrivals still notify reviewers; a large
   * first import is silent apart from one summary, so the bell is not flooded.
   */
  async syncFromProduct() {
    const [applications, reviews] = await Promise.all([
      this.zapiack.read.senderIdApplication.findMany({
        select: { id: true, status: true },
      }),
      this.admin.senderIdReview.findMany({ select: { applicationId: true } }),
    ]);
    const have = new Set(reviews.map((r) => r.applicationId));
    const missing = applications.filter((a) => !have.has(a.id));

    const unmapped: Record<string, number> = {};
    let created = 0;
    const loud = missing.length <= 5;

    for (const application of missing) {
      if (!toReviewStatus(application.status)) {
        const key = application.status || '(empty)';
        unmapped[key] = (unmapped[key] ?? 0) + 1;
        continue;
      }
      try {
        if (await this.ensureReview(application.id, loud)) created += 1;
      } catch (err) {
        // Two instances racing to import the same application: the other one won.
        if ((err as { code?: string }).code !== 'P2002') throw err;
      }
    }

    if (!loud && created > 0) {
      await this.notifications.broadcastToPermission('senderid.review', {
        type: 'senderid.submitted',
        severity: 'MEDIUM',
        title: `${created} sender ID applications imported`,
        body: 'Existing applications were added to the review queue.',
        link: '/sender-ids',
      });
    }
    if (Object.keys(unmapped).length) {
      // Visible rather than silent: an application in a status this console does not
      // know about would otherwise just never appear.
      this.logger.warn(
        `Sender ID applications skipped, unrecognised status: ${JSON.stringify(unmapped)}`,
      );
    }
    return { created, skipped: unmapped };
  }

  async list(query: ListSenderIdsDto) {
    const limit = query.limit ?? 50;

    const reviews = await this.admin.senderIdReview.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.assigneeId ? { assigneeId: query.assigneeId } : {}),
        ...(query.overdueOnly
          ? { slaDueAt: { lt: new Date() }, decidedAt: null }
          : {}),
        ...(query.q
          ? {
              OR: [
                {
                  senderId: { contains: query.q, mode: 'insensitive' as const },
                },
                { accountId: query.q },
                { applicationId: query.q },
              ],
            }
          : {}),
      },
      // Oldest SLA first: the queue is a work list, not a feed.
      orderBy: [{ slaDueAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      include: { assignee: { select: { id: true, name: true } } },
    });

    const now = Date.now();
    const page = reviews.slice(0, limit);

    // Queue counts per status, unaffected by the current filter, so the tabs can show
    // totals while the list shows one of them.
    const grouped = await this.admin.senderIdReview.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    const counts = Object.fromEntries(
      grouped.map((row) => [row.status, row._count._all]),
    );
    counts.OVERDUE = await this.admin.senderIdReview.count({
      where: { decidedAt: null, slaDueAt: { lt: new Date() } },
    });

    return {
      counts,
      data: page.map((r) => ({
        id: r.id,
        applicationId: r.applicationId,
        accountId: r.accountId,
        senderId: r.senderId,
        status: r.status,
        assignee: r.assignee,
        submittedAt: r.submittedAt,
        slaDueAt: r.slaDueAt,
        overdue: !r.decidedAt && r.slaDueAt.getTime() < now,
        hoursRemaining: r.decidedAt
          ? null
          : Math.round((r.slaDueAt.getTime() - now) / 3_600_000),
      })),
      hasMore: reviews.length > limit,
      nextCursor: null,
    };
  }

  /** The review screen: application, documents (metadata only), checklist and history. */
  async get(reviewId: string) {
    const review = await this.admin.senderIdReview.findUnique({
      where: { id: reviewId },
      include: {
        assignee: { select: { id: true, name: true, email: true } },
        checklist: { orderBy: { key: 'asc' } },
        events: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!review) throw new NotFoundException('Review not found');

    const application = await this.zapiack.read.senderIdApplication.findUnique({
      where: { id: review.applicationId },
      include: {
        documents: { orderBy: { createdAt: 'asc' } },
        accounts: {
          include: { owner: { select: { email: true, displayName: true } } },
        },
        project: { select: { id: true, name: true, slug: true } },
      },
    });

    const otherApplications = await this.admin.senderIdReview.findMany({
      where: { accountId: review.accountId, id: { not: reviewId } },
      select: { id: true, senderId: true, status: true, submittedAt: true },
      orderBy: { submittedAt: 'desc' },
      take: 10,
    });

    return {
      review: {
        id: review.id,
        status: review.status,
        assignee: review.assignee,
        submittedAt: review.submittedAt,
        slaDueAt: review.slaDueAt,
        overdue: !review.decidedAt && review.slaDueAt < new Date(),
        decidedAt: review.decidedAt,
        decisionReason: review.decisionReason,
        allowedNext: allowedNext(review.status),
      },
      application: application
        ? {
            id: application.id,
            senderId: application.senderId,
            status: application.status,
            businessName: application.businessName,
            cacRegNo: application.cacRegNo,
            rejectionReason: application.rejectionReason,
            project: application.project,
            submittedAt: application.submittedAt ?? application.createdAt,
            reviewedAt: application.reviewedAt,
          }
        : null,
      account: application?.accounts
        ? {
            id: application.accounts.id,
            businessName: application.businessName,
            ownerName: application.accounts.owner.displayName,
            status: application.accounts.accountStatus,
            creditBalance: application.accounts.creditBalance,
            createdAt: application.accounts.createdAt,
          }
        : null,
      // Object keys stay server-side; the browser gets a document id and asks for a URL.
      // Metadata only. The file URL is fetched per document, which is what records
      // the access in the audit log.
      documents: (application?.documents ?? []).map((doc) => ({
        id: doc.id,
        type: doc.type,
        fileName: doc.fileOriginalName,
        provider: doc.provider,
        uploadedAt: doc.createdAt,
      })),
      checklist: review.checklist,
      history: review.events,
      otherApplications,
    };
  }

  async assign(actor: StaffPrincipal, reviewId: string, assigneeId?: string) {
    const target = assigneeId ?? actor.id;
    const before = await this.admin.senderIdReview.findUniqueOrThrow({
      where: { id: reviewId },
    });

    const review = await this.admin.senderIdReview.update({
      where: { id: reviewId },
      data: {
        assigneeId: target,
        // Picking up an application starts the review, so the status follows.
        ...(before.status === 'SUBMITTED' ? { status: 'IN_REVIEW' } : {}),
        events: {
          create: {
            fromStatus: before.status,
            toStatus:
              before.status === 'SUBMITTED' ? 'IN_REVIEW' : before.status,
            actorId: actor.id,
            comment: `Assigned to ${target === actor.id ? 'self' : target}`,
          },
        },
      },
    });

    if (before.status === 'SUBMITTED') {
      await this.writer.write.senderIdApplication.update({
        where: { id: before.applicationId },
        data: { status: 'IN_REVIEW' },
      });
    }

    await this.audit.record({
      actor,
      action: 'senderid.assigned',
      targetType: 'sender_id_review',
      targetId: reviewId,
      before: { assigneeId: before.assigneeId, status: before.status },
      after: { assigneeId: target, status: review.status },
    });

    if (target !== actor.id) {
      await this.notifications.notifyStaff(target, {
        type: 'senderid.assigned',
        severity: 'MEDIUM',
        title: `Sender ID ${before.senderId} assigned to you`,
        link: `/sender-ids/${reviewId}`,
      });
    }

    return {
      id: review.id,
      status: review.status,
      assigneeId: review.assigneeId,
    };
  }

  async updateChecklist(
    actor: StaffPrincipal,
    reviewId: string,
    dto: UpdateChecklistDto,
  ) {
    const known = new Set<string>(CHECKLIST.map((c) => c.key));
    const unknown = dto.items.filter((i) => !known.has(i.key));
    if (unknown.length) {
      throw new BadRequestException(
        `Unknown checklist items: ${unknown.map((i) => i.key).join(', ')}`,
      );
    }

    await this.admin.$transaction(
      dto.items.map((item) =>
        this.admin.senderIdChecklistItem.update({
          where: { reviewId_key: { reviewId, key: item.key } },
          data: {
            passed: item.passed,
            note: item.note,
            checkedBy: actor.id,
            checkedAt: new Date(),
          },
        }),
      ),
    );

    await this.audit.recordSafe({
      actor,
      action: 'senderid.checklist_updated',
      targetType: 'sender_id_review',
      targetId: reviewId,
      after: { items: dto.items },
    });

    return this.admin.senderIdChecklistItem.findMany({
      where: { reviewId },
      orderBy: { key: 'asc' },
    });
  }

  /**
   * Records a decision. The state machine gates which moves are legal; the human
   * decides which one to make. Approval is refused while the checklist is incomplete,
   * because an approval is what gets sent on to the operators.
   */
  async decide(actor: StaffPrincipal, reviewId: string, dto: DecisionDto) {
    const review = await this.admin.senderIdReview.findUnique({
      where: { id: reviewId },
      include: { checklist: true },
    });
    if (!review) throw new NotFoundException('Review not found');

    const from = review.status;
    assertTransition(from, dto.status);

    if (REASON_REQUIRED.includes(dto.status) && !dto.reason?.trim()) {
      throw new BadRequestException(
        `A written reason is required to record ${dto.status}`,
      );
    }

    if (dto.status === 'APPROVED') {
      const unchecked = review.checklist.filter((item) => item.passed === null);
      if (unchecked.length) {
        throw new BadRequestException(
          `Complete the checklist before approving: ${unchecked.map((i) => i.key).join(', ')}`,
        );
      }
      const failed = review.checklist.filter((item) => item.passed === false);
      if (failed.length) {
        throw new BadRequestException(
          `Checklist items failed: ${failed.map((i) => i.key).join(', ')}. Reject or request changes instead.`,
        );
      }
    }

    const terminal = [
      'APPROVED',
      'REJECTED',
      'ACTIVE',
      'OPERATOR_REJECTED',
    ].includes(dto.status);

    const updated = await this.admin.senderIdReview.update({
      where: { id: reviewId },
      data: {
        status: dto.status,
        decisionReason: dto.reason,
        ...(terminal ? { decidedAt: new Date() } : {}),
        events: {
          create: {
            fromStatus: from,
            toStatus: dto.status,
            actorId: actor.id,
            comment: dto.reason,
          },
        },
      },
    });

    // The application row and the customer's notification move together: a reviewer
    // rejecting an application without the applicant hearing why is the failure mode
    // worth spending a transaction on.
    await this.writer.write.$transaction(async (tx) => {
      await tx.senderIdApplication.update({
        where: { id: review.applicationId },
        data: {
          status: dto.status,
          rejectionReason: REASON_REQUIRED.includes(dto.status)
            ? (dto.reason ?? null)
            : null,
          ...(terminal ? { reviewedAt: new Date() } : {}),
        },
      });

      const account = await tx.accounts.findUnique({
        where: { id: review.accountId },
        select: { userId: true },
      });
      if (account) {
        await tx.userNotifications.create({
          data: {
            userId: account.userId,
            accountId: review.accountId,
            type: 'SENDER_ID',
            severity: NOTIFICATION_SEVERITY[dto.status] ?? 'INFO',
            title: `Sender ID ${review.senderId}: ${dto.status.toLowerCase().replace(/_/g, ' ')}`,
            body:
              dto.reason ??
              `Your sender ID ${review.senderId} is now ${dto.status.toLowerCase().replace(/_/g, ' ')}.`,
            actionUrl: '/sender-ids',
            metadata: {
              applicationId: review.applicationId,
              status: dto.status,
            },
          },
        });
      }
    });

    await this.audit.record({
      actor,
      action: `senderid.${dto.status.toLowerCase()}`,
      targetType: 'sender_id_application',
      targetId: review.applicationId,
      reason: dto.reason,
      before: { status: from },
      after: { status: dto.status },
      metadata: {
        reviewId,
        senderId: review.senderId,
        accountId: review.accountId,
      },
    });

    return {
      id: updated.id,
      status: updated.status,
      decidedAt: updated.decidedAt,
    };
  }

  /** Called by the SLA sweep; a breach is an alert, not a status change. */
  async sweepSlaBreaches(): Promise<number> {
    const overdue = await this.admin.senderIdReview.findMany({
      where: {
        decidedAt: null,
        slaDueAt: { lt: new Date() },
        status: { in: ['SUBMITTED', 'IN_REVIEW'] },
      },
      select: { id: true, senderId: true, slaDueAt: true, assigneeId: true },
    });

    for (const review of overdue) {
      const alert = {
        type: 'senderid.sla_breach' as const,
        severity: 'HIGH' as const,
        title: `Sender ID ${review.senderId} is past its review SLA`,
        body: `Due ${review.slaDueAt.toISOString()}`,
        link: `/sender-ids/${review.id}`,
      };

      // Already-sent breach alerts are not repeated every ten minutes.
      const alreadyAlerted = await this.admin.staffNotification.findFirst({
        where: { type: alert.type, link: alert.link },
        select: { id: true },
      });
      if (alreadyAlerted) continue;

      if (review.assigneeId) {
        await this.notifications.notifyStaff(review.assigneeId, alert);
      } else {
        await this.notifications.broadcastToPermission(
          'senderid.review',
          alert,
        );
      }
    }

    return overdue.length;
  }
}

/**
 * Maps the product's free-text application status onto the review lifecycle.
 * Returns null for states that are not reviewable yet, and for anything unrecognised
 * — a new status upstream should not silently become the wrong one here.
 */
function toReviewStatus(productStatus: string): SenderIdStatus | null {
  const normalised = productStatus.trim().toUpperCase();
  const known: Record<string, SenderIdStatus> = {
    SUBMITTED: 'SUBMITTED',
    PENDING: 'SUBMITTED',
    IN_REVIEW: 'IN_REVIEW',
    REVIEWING: 'IN_REVIEW',
    UNDER_REVIEW: 'IN_REVIEW',
    PENDING_REVIEW: 'SUBMITTED',
    DECLINED: 'REJECTED',
    CHANGES_REQUESTED: 'CHANGES_REQUESTED',
    APPROVED: 'APPROVED',
    REJECTED: 'REJECTED',
    SUBMITTED_TO_OPERATORS: 'SUBMITTED_TO_OPERATORS',
    ACTIVE: 'ACTIVE',
    OPERATOR_REJECTED: 'OPERATOR_REJECTED',
    SUSPENDED: 'SUSPENDED',
  };
  return known[normalised] ?? null;
}

/** Maps a review outcome onto the severity the customer's notification bell shows. */
const NOTIFICATION_SEVERITY: Record<string, string> = {
  IN_REVIEW: 'PENDING',
  CHANGES_REQUESTED: 'PENDING',
  SUBMITTED_TO_OPERATORS: 'PENDING',
  APPROVED: 'SUCCESS',
  ACTIVE: 'SUCCESS',
  REJECTED: 'ERROR',
  OPERATOR_REJECTED: 'ERROR',
  SUSPENDED: 'ERROR',
};
