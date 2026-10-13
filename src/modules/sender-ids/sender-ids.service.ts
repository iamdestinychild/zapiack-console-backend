import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DateTime } from 'luxon';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { ZapiackPrismaService } from '../../common/prisma/zapiack-prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { ZapiackWriteService } from '../../common/prisma/zapiack-write.service';
import { ProductCacheService } from '../../common/redis/product-cache.service';
import { NotificationsGateway } from '../inbox/notifications.gateway';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import {
  CHECKLIST,
  REASON_REQUIRED,
  allowedDecisions,
  assertDecision,
  customerNotice,
  presentStatus,
  reviewStatusesFor,
  toReviewStatus,
  type Decision,
  type ProductStatus,
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
    private readonly productCache: ProductCacheService,
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
   *
   * Drafts are skipped on purpose (nothing to review until the customer submits), and
   * so is any status that is not one of the product's four, which is logged.
   */
  async syncFromProduct() {
    const [applications, reviews] = await Promise.all([
      this.zapiack.read.senderIdApplication.findMany({
        select: {
          id: true,
          status: true,
          reviewedAt: true,
          rejectionReason: true,
          submittedAt: true,
        },
      }),
      this.admin.senderIdReview.findMany({
        select: { id: true, applicationId: true, status: true },
      }),
    ]);
    const have = new Set(reviews.map((r) => r.applicationId));
    const refreshed = await this.refreshDrifted(applications, reviews);
    const missing = applications.filter((a) => !have.has(a.id));

    const unmapped: Record<string, number> = {};
    let created = 0;
    const loud = missing.length <= 5;

    for (const application of missing) {
      // Not yet submitted: not in the queue, and not worth a warning.
      if (application.status.trim().toUpperCase() === 'DRAFT') continue;
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
      // Visible rather than silent: a status outside the product's four would
      // otherwise just never appear.
      this.logger.warn(
        `Sender ID applications skipped, status is not one of the product's four: ${JSON.stringify(unmapped)}`,
      );
    }
    return { created, refreshed, skipped: unmapped };
  }

  /**
   * The product moves applications along on its own: a customer edits a rejected
   * application and submits it again, or another path approves one. A review created
   * once and never revisited would show the status from the day it was imported.
   *
   * Statuses are compared as the product names them, so a reviewer picking an
   * application up (stored as IN_REVIEW) does not look like a change.
   */
  private async refreshDrifted(
    applications: {
      id: string;
      status: string;
      reviewedAt: Date | null;
      rejectionReason: string | null;
      submittedAt: Date | null;
    }[],
    reviews: { id: string; applicationId: string; status: SenderIdStatus }[],
  ): Promise<number> {
    const byApplication = new Map(applications.map((a) => [a.id, a]));
    let refreshed = 0;
    for (const review of reviews) {
      const application = byApplication.get(review.applicationId);
      const mapped = application && toReviewStatus(application.status);
      if (
        !application ||
        !mapped ||
        presentStatus(mapped) === presentStatus(review.status)
      ) {
        continue;
      }

      const decided = mapped === 'APPROVED' || mapped === 'REJECTED';
      // Back to waiting after a decision means the customer resubmitted. It is a new
      // review: a fresh clock, nobody assigned, and the checklist to do again.
      const resubmitted = !decided;
      const submittedAt = application.submittedAt ?? new Date();

      await this.admin.senderIdReview.update({
        where: { id: review.id },
        data: {
          status: mapped,
          decidedAt: decided ? (application.reviewedAt ?? new Date()) : null,
          decisionReason: decided ? application.rejectionReason : null,
          ...(resubmitted
            ? {
                submittedAt,
                slaDueAt: DateTime.fromJSDate(submittedAt)
                  .plus({ hours: SLA_HOURS })
                  .toJSDate(),
                assigneeId: null,
                checklist: {
                  updateMany: { where: {}, data: { passed: null } },
                },
              }
            : {}),
          events: {
            create: {
              fromStatus: review.status,
              toStatus: mapped,
              comment: resubmitted
                ? 'Resubmitted by the customer'
                : 'Status changed in the Zapiack app',
            },
          },
        },
      });
      refreshed += 1;
    }
    return refreshed;
  }

  /**
   * The queue, in the product's own statuses: PENDING_REVIEW, APPROVED, REJECTED, and
   * DRAFT (customers who have not submitted, which have no review and are read from the
   * product directly). `counts` has all four plus OVERDUE for the tabs.
   */
  async list(query: ListSenderIdsDto) {
    const limit = query.limit ?? 50;
    const wanted = asProductStatus(query.status);
    if (wanted === 'DRAFT') return this.drafts(query);

    const after = decodeCursor(query.cursor);

    const filters = {
      ...(wanted ? { status: { in: reviewStatusesFor(wanted) } } : {}),
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
    };

    const reviews = await this.admin.senderIdReview.findMany({
      where: {
        AND: [
          filters,
          // Keyset paging on the same (slaDueAt, id) order the queue is sorted by, so
          // a page boundary never skips or repeats a row when SLAs tie.
          ...(after
            ? [
                {
                  OR: [
                    { slaDueAt: { gt: after.slaDueAt } },
                    { slaDueAt: after.slaDueAt, id: { gt: after.id } },
                  ],
                },
              ]
            : []),
        ],
      },
      // Oldest SLA first: the queue is a work list, not a feed.
      orderBy: [{ slaDueAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      include: { assignee: { select: { id: true, name: true } } },
    });

    const now = Date.now();
    const page = reviews.slice(0, limit);
    const last = page[page.length - 1];

    return {
      counts: await this.queueCounts(),
      data: page.map((r) => {
        const status = presentStatus(r.status);
        const waiting = status === 'PENDING_REVIEW' && !r.decidedAt;
        return {
          id: r.id,
          applicationId: r.applicationId,
          accountId: r.accountId,
          senderId: r.senderId,
          status,
          assignee: r.assignee,
          submittedAt: r.submittedAt,
          slaDueAt: r.slaDueAt,
          overdue: waiting && r.slaDueAt.getTime() < now,
          hoursRemaining: waiting
            ? Math.round((r.slaDueAt.getTime() - now) / 3_600_000)
            : null,
        };
      }),
      hasMore: reviews.length > limit,
      nextCursor:
        reviews.length > limit && last
          ? encodeCursor(last.slaDueAt, last.id)
          : null,
    };
  }

  /** Per-status totals for the tabs, unaffected by the current filter. */
  private async queueCounts(): Promise<
    Record<ProductStatus | 'OVERDUE', number>
  > {
    const [grouped, overdue, drafts] = await Promise.all([
      this.admin.senderIdReview.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.admin.senderIdReview.count({
        where: { decidedAt: null, slaDueAt: { lt: new Date() } },
      }),
      this.zapiack.read.senderIdApplication.count({
        where: { status: 'DRAFT' },
      }),
    ]);
    const counts: Record<ProductStatus | 'OVERDUE', number> = {
      DRAFT: drafts,
      PENDING_REVIEW: 0,
      APPROVED: 0,
      REJECTED: 0,
      OVERDUE: overdue,
    };
    // Several stored statuses present as one product status; the tabs show the
    // product's.
    for (const row of grouped)
      counts[presentStatus(row.status)] += row._count._all;
    return counts;
  }

  /**
   * Applications a customer has started but not submitted. There is no review for a
   * draft, so this reads the product directly. Read-only: a draft is the customer's to
   * finish, and there is nothing for a reviewer to decide until they do.
   */
  async drafts(query: { limit?: number; cursor?: string } = {}) {
    const limit = query.limit ?? 50;
    const offset = decodeOffset(query.cursor);

    const rows = await this.zapiack.read.senderIdApplication.findMany({
      where: { status: 'DRAFT' },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      skip: offset,
      take: limit + 1,
      select: {
        id: true,
        accountId: true,
        senderId: true,
        businessName: true,
        category: true,
        companyType: true,
        cacStatus: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    const page = rows.slice(0, limit);
    const more = rows.length > limit;

    return {
      counts: await this.queueCounts(),
      data: page.map((row) => ({
        // A draft has no review, so there is no review id to open.
        id: null,
        applicationId: row.id,
        accountId: row.accountId,
        senderId: row.senderId,
        businessName: row.businessName,
        status: 'DRAFT' as const,
        category: row.category,
        companyType: row.companyType,
        cacStatus: row.cacStatus,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
      hasMore: more,
      nextCursor: more ? encodeOffset(offset + limit) : null,
    };
  }

  /** The old name for the drafts list; kept so an existing screen keeps working. */
  async unfiled() {
    return this.drafts();
  }

  /**
   * The review screen: the application in full (including what CAC said and what the
   * applicant declared), documents (metadata only), checklist and history. Statuses
   * are the product's own words throughout.
   */
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

    const status = presentStatus(review.status);
    const decisions = allowedDecisions(review.status);

    return {
      review: {
        id: review.id,
        status,
        assignee: review.assignee,
        assigned: Boolean(review.assignee),
        submittedAt: review.submittedAt,
        slaDueAt: review.slaDueAt,
        overdue: status === 'PENDING_REVIEW' && review.slaDueAt < new Date(),
        decidedAt: review.decidedAt,
        decisionReason: review.decisionReason,
        /** Offer exactly these buttons: any of APPROVED and REJECTED. */
        allowedDecisions: decisions,
        /** @deprecated The old name for allowedDecisions. */
        allowedNext: decisions,
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
            // What the applicant declared, which the letters to the networks are
            // written from.
            category: application.category,
            companyType: application.companyType,
            businessActivity: application.businessActivity,
            applicantName: application.applicantName,
            designation: application.designation,
            messageExamples: application.messageExamples,
            companyAddress: application.companyAddress,
            incorporatedAt: application.incorporatedAt,
            // What CAC's registry said. NEEDS_REVIEW means the company was found but
            // the name or the signatory did not match: a person decides.
            cac: {
              status: application.cacStatus,
              verifiedAt: application.cacVerifiedAt,
              attempts: application.cacAttempts,
              failureReason: application.cacFailureReason,
              data: application.cacData,
            },
            attestedAt: application.attestedAt,
            lettersGeneratedAt: application.lettersGeneratedAt,
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
      history: review.events.map((event) => ({
        ...event,
        fromStatus: event.fromStatus ? presentStatus(event.fromStatus) : null,
        toStatus: presentStatus(event.toStatus),
      })),
      otherApplications: otherApplications.map((other) => ({
        ...other,
        status: presentStatus(other.status),
      })),
    };
  }

  /**
   * Hands a review to a staff member. This is the console's own bookkeeping and changes
   * nothing in the product: the application stays PENDING_REVIEW. (It used to write
   * IN_REVIEW there, a status the product does not have, which would have made the
   * sender ID resolver stop finding the application mid-review.)
   */
  async assign(actor: StaffPrincipal, reviewId: string, assigneeId?: string) {
    const target = assigneeId ?? actor.id;
    const before = await this.admin.senderIdReview.findUniqueOrThrow({
      where: { id: reviewId },
    });

    const review = await this.admin.senderIdReview.update({
      where: { id: reviewId },
      data: {
        assigneeId: target,
        events: {
          create: {
            fromStatus: before.status,
            toStatus: before.status,
            actorId: actor.id,
            comment: `Assigned to ${target === actor.id ? 'self' : target}`,
          },
        },
      },
    });

    await this.audit.record({
      actor,
      action: 'senderid.assigned',
      targetType: 'sender_id_review',
      targetId: reviewId,
      before: { assigneeId: before.assigneeId },
      after: { assigneeId: target },
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
      status: presentStatus(review.status),
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
   * Approves or rejects an application.
   *
   * The product is written first and is the source of truth: only APPROVED or REJECTED
   * ever goes into its `status`, because the customer app, the sender ID resolver and
   * the letters all branch on the product's four statuses. The customer is told in the
   * same transaction, then the caches that would keep acting on the old answer for an
   * hour are cleared and an open dashboard is nudged. The review row follows; if that
   * last step fails the next sync repairs it from the product.
   */
  async decide(actor: StaffPrincipal, reviewId: string, dto: DecisionDto) {
    const review = await this.admin.senderIdReview.findUnique({
      where: { id: reviewId },
      include: { checklist: true },
    });
    if (!review) throw new NotFoundException('Review not found');

    const decision: Decision =
      dto.status === 'APPROVED' ? 'APPROVED' : 'REJECTED';
    // The old "changes requested" is a rejection that tells the customer what to fix.
    const reason =
      dto.status === 'CHANGES_REQUESTED' && dto.reason?.trim()
        ? `Changes requested: ${dto.reason.trim()}`
        : dto.reason?.trim();

    const from = review.status;
    assertDecision(from, decision);

    if (REASON_REQUIRED.includes(decision) && !reason) {
      throw new BadRequestException(
        'A written reason is required to reject an application. The customer is shown it.',
      );
    }

    if (decision === 'APPROVED') {
      const unchecked = review.checklist.filter((item) => item.passed === null);
      if (unchecked.length) {
        throw new BadRequestException(
          `Complete the checklist before approving: ${unchecked.map((i) => i.key).join(', ')}`,
        );
      }
      const failed = review.checklist.filter((item) => item.passed === false);
      if (failed.length) {
        throw new BadRequestException(
          `Checklist items failed: ${failed.map((i) => i.key).join(', ')}. Reject the application instead.`,
        );
      }
    }

    const application = await this.zapiack.read.senderIdApplication.findUnique({
      where: { id: review.applicationId },
      select: { projectId: true, status: true },
    });
    if (!application) throw new NotFoundException('Application not found');

    // The customer may have changed it since this screen loaded (withdrawn it to edit,
    // or submitted a rejected one again). Deciding on a stale view would overwrite
    // what they just did.
    const live = toReviewStatus(application.status);
    if (!live || presentStatus(live) !== presentStatus(from)) {
      throw new ConflictException(
        `This application changed in the customer's app and is now ${application.status.toLowerCase().replace('_', ' ')}. Refresh and review it again.`,
      );
    }

    const notice = customerNotice(decision, review.senderId, reason);
    let userId: string | null = null;

    // The application row and the customer's notification move together: a reviewer
    // rejecting an application without the applicant hearing why is the failure mode
    // worth spending a transaction on.
    await this.writer.write.$transaction(async (tx) => {
      await tx.senderIdApplication.update({
        where: { id: review.applicationId },
        data: {
          status: decision,
          rejectionReason: decision === 'REJECTED' ? (reason ?? null) : null,
          reviewedAt: new Date(),
        },
      });

      const account = await tx.accounts.findUnique({
        where: { id: review.accountId },
        select: { userId: true },
      });
      if (account) {
        userId = account.userId;
        await tx.userNotifications.create({
          data: {
            userId: account.userId,
            accountId: review.accountId,
            type: 'SENDER_ID',
            severity: notice.severity,
            title: notice.title,
            body: notice.body,
            actionUrl: '/sender-ids',
            metadata: {
              applicationId: review.applicationId,
              status: decision,
            },
          },
        });
      }
    });

    // The customer app caches which sender ID a project uses for an hour. Without this
    // an approval would not take effect, and a withdrawn one would keep working.
    await this.productCache.invalidateSenderId(application.projectId);
    if (userId) await this.productCache.notifyUser(userId);

    const updated = await this.admin.senderIdReview.update({
      where: { id: reviewId },
      data: {
        status: decision,
        decisionReason: reason ?? null,
        decidedAt: new Date(),
        events: {
          create: {
            fromStatus: from,
            toStatus: decision,
            actorId: actor.id,
            comment: reason,
          },
        },
      },
    });

    await this.audit.record({
      actor,
      action: `senderid.${decision.toLowerCase()}`,
      targetType: 'sender_id_application',
      targetId: review.applicationId,
      reason,
      before: { status: presentStatus(from) },
      after: { status: decision },
      metadata: {
        reviewId,
        senderId: review.senderId,
        accountId: review.accountId,
      },
    });

    return {
      id: updated.id,
      status: presentStatus(updated.status),
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

/** Maps a review outcome onto the severity the customer's notification bell shows. */

function encodeCursor(slaDueAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ t: slaDueAt.toISOString(), id }),
  ).toString('base64url');
}

function decodeCursor(cursor?: string): { slaDueAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const { t, id } = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as { t?: string; id?: string };
    const slaDueAt = new Date(t ?? '');
    if (!id || Number.isNaN(slaDueAt.getTime())) return null;
    return { slaDueAt, id };
  } catch {
    return null;
  }
}

/** The filter as a product status; the old SUBMITTED and IN_REVIEW mean PENDING_REVIEW. */
function asProductStatus(status?: string): ProductStatus | undefined {
  if (!status) return undefined;
  return status === 'SUBMITTED' || status === 'IN_REVIEW'
    ? 'PENDING_REVIEW'
    : (status as ProductStatus);
}

function encodeOffset(offset: number): string {
  return Buffer.from(String(offset)).toString('base64url');
}

function decodeOffset(cursor?: string): number {
  if (!cursor) return 0;
  const n = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  return Number.isInteger(n) && n > 0 ? n : 0;
}
