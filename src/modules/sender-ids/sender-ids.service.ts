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
import { ApiCoreClient } from '../../integrations/api-core/api-core.client';
import { NotificationsGateway } from '../inbox/notifications.gateway';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import {
  CHECKLIST,
  REASON_REQUIRED,
  allowedNext,
  assertTransition,
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
    private readonly apiCore: ApiCoreClient,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsGateway,
  ) {}

  /** Creates the review shell when a `senderid.submitted` event arrives. */
  async ensureReview(applicationId: string) {
    const existing = await this.admin.senderIdReview.findUnique({
      where: { applicationId },
    });
    if (existing) return existing;

    const application = await this.zapiack.read.senderIdApplication.findUnique({
      where: { id: applicationId },
    });
    if (!application)
      throw new NotFoundException('Sender ID application not found');

    const review = await this.admin.senderIdReview.create({
      data: {
        applicationId,
        accountId: application.accountId,
        senderId: application.senderId,
        status: application.status,
        submittedAt: application.submittedAt,
        slaDueAt: DateTime.fromJSDate(application.submittedAt)
          .plus({ hours: SLA_HOURS })
          .toJSDate(),
        checklist: {
          create: CHECKLIST.map((item) => ({
            key: item.key,
            label: item.label,
          })),
        },
        events: {
          create: {
            toStatus: application.status,
            comment: 'Application received',
          },
        },
      },
    });

    await this.notifications.broadcastToPermission('senderid.review', {
      type: 'senderid.submitted',
      severity: 'MEDIUM',
      title: `New sender ID application: ${application.senderId}`,
      body: `Due for review by ${review.slaDueAt.toISOString()}`,
      link: `/sender-ids/${review.id}`,
    });

    return review;
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

    return {
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
      include: { documents: { orderBy: { uploadedAt: 'asc' } }, account: true },
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
            applicantType: application.applicantType,
            useCase: application.useCase,
            sampleMessage: application.sampleMessage,
            submittedAt: application.submittedAt,
          }
        : null,
      account: application
        ? {
            id: application.account.id,
            businessName: application.account.businessName,
            status: application.account.status,
            kycVerified: application.account.kycVerified,
            createdAt: application.account.createdAt,
          }
        : null,
      // Object keys stay server-side; the browser gets a document id and asks for a URL.
      documents: (application?.documents ?? []).map((doc) => ({
        id: doc.id,
        kind: doc.kind,
        fileName: doc.fileName,
        contentType: doc.contentType,
        sizeBytes: doc.sizeBytes,
        uploadedAt: doc.uploadedAt,
        uploadedBy: doc.uploadedBy,
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
      await this.apiCore.setSenderIdStatus(
        before.applicationId,
        { status: 'IN_REVIEW' },
        { actorId: actor.id, actorEmail: actor.email },
      );
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

    // api-core owns the application record and the customer-facing notification that
    // goes with a status change.
    await this.apiCore.setSenderIdStatus(
      review.applicationId,
      { status: dto.status, reason: dto.reason },
      { actorId: actor.id, actorEmail: actor.email },
    );

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
