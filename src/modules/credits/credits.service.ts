import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { ZapiackPrismaService } from '../../common/prisma/zapiack-prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiCoreClient } from '../../integrations/api-core/api-core.client';
import {
  buildPage,
  cursorWhere,
  decodeCursor,
} from '../../common/http/pagination';
import type { AdminConfig } from '../../common/config/configuration';
import type { StaffPrincipal } from '../../common/auth/staff-principal';

/**
 * Credit adjustments. Anything at or below the threshold applies straight away;
 * anything above it waits for a second approver from Finance or Super admin, so no
 * single staff member can move a large sum onto an account alone.
 */
@Injectable()
export class CreditsService {
  private readonly logger = new Logger(CreditsService.name);
  private readonly threshold: number;

  constructor(
    private readonly admin: AdminPrismaService,
    private readonly zapiack: ZapiackPrismaService,
    private readonly apiCore: ApiCoreClient,
    private readonly audit: AuditService,
    config: ConfigService<{ admin: AdminConfig }, true>,
  ) {
    this.threshold = config.get('admin', {
      infer: true,
    }).limits.creditApprovalThresholdNgn;
  }

  async request(
    actor: StaffPrincipal,
    accountId: string,
    input: { direction: 'CREDIT' | 'DEBIT'; amountNgn: string; reason: string },
  ) {
    const amount = Number(input.amountNgn);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('amountNgn must be a positive decimal');
    }

    const account = await this.zapiack.read.account.findUnique({
      where: { id: accountId },
      select: { id: true, balance: true, status: true },
    });
    if (!account) throw new NotFoundException('Account not found');

    const needsApproval = amount > this.threshold;

    const adjustment = await this.admin.creditAdjustment.create({
      data: {
        accountId,
        direction: input.direction,
        amountNgn: input.amountNgn,
        reason: input.reason,
        status: needsApproval ? 'PENDING_APPROVAL' : 'APPROVED',
        // The key travels to api-core so a retry can never double-post the ledger.
        idempotencyKey: randomUUID(),
        requestedById: actor.id,
        ...(needsApproval
          ? {}
          : { approvedById: actor.id, approvedAt: new Date() }),
      },
    });

    await this.audit.record({
      actor,
      action: 'credits.adjust_requested',
      targetType: 'account',
      targetId: accountId,
      reason: input.reason,
      after: {
        adjustmentId: adjustment.id,
        direction: input.direction,
        amountNgn: input.amountNgn,
        needsApproval,
      },
      metadata: {
        thresholdNgn: this.threshold,
        balanceBefore: account.balance.toString(),
      },
    });

    if (needsApproval) {
      await this.notifyApprovers(adjustment.id, accountId, input.amountNgn);
      return {
        id: adjustment.id,
        status: adjustment.status,
        message: `Above the ₦${this.threshold.toLocaleString()} threshold; awaiting a second approver`,
      };
    }

    return this.apply(actor, adjustment.id);
  }

  /** The second approver. Approving your own request is refused. */
  async approve(actor: StaffPrincipal, adjustmentId: string, reason: string) {
    const adjustment = await this.admin.creditAdjustment.findUnique({
      where: { id: adjustmentId },
    });
    if (!adjustment) throw new NotFoundException('Adjustment not found');
    if (adjustment.status !== 'PENDING_APPROVAL') {
      throw new ConflictException(
        `Adjustment is ${adjustment.status}, not awaiting approval`,
      );
    }
    if (adjustment.requestedById === actor.id) {
      throw new ForbiddenException(
        'A second approver is required; you raised this adjustment',
      );
    }

    await this.admin.creditAdjustment.update({
      where: { id: adjustmentId },
      data: {
        status: 'APPROVED',
        approvedById: actor.id,
        approvedAt: new Date(),
      },
    });

    await this.audit.record({
      actor,
      action: 'credits.adjust_approved',
      targetType: 'credit_adjustment',
      targetId: adjustmentId,
      reason,
      after: {
        accountId: adjustment.accountId,
        amountNgn: adjustment.amountNgn.toString(),
      },
    });

    return this.apply(actor, adjustmentId);
  }

  async reject(actor: StaffPrincipal, adjustmentId: string, reason: string) {
    const adjustment = await this.admin.creditAdjustment.update({
      where: { id: adjustmentId },
      data: { status: 'REJECTED', rejectedReason: reason },
    });
    await this.audit.record({
      actor,
      action: 'credits.adjust_rejected',
      targetType: 'credit_adjustment',
      targetId: adjustmentId,
      reason,
    });
    return { id: adjustment.id, status: adjustment.status };
  }

  /** Sends the approved adjustment to api-core, which owns the ledger write. */
  private async apply(actor: StaffPrincipal, adjustmentId: string) {
    const adjustment = await this.admin.creditAdjustment.findUniqueOrThrow({
      where: { id: adjustmentId },
    });

    try {
      const result = await this.apiCore.adjustCredit(
        adjustment.accountId,
        {
          direction: adjustment.direction,
          amountNgn: adjustment.amountNgn.toString(),
          reason: adjustment.reason,
          adjustmentId: adjustment.id,
        },
        {
          actorId: actor.id,
          actorEmail: actor.email,
          idempotencyKey: adjustment.idempotencyKey,
        },
      );

      const applied = await this.admin.creditAdjustment.update({
        where: { id: adjustmentId },
        data: {
          status: 'APPLIED',
          appliedAt: new Date(),
          ledgerTxnId: result?.transactionId ?? null,
        },
      });

      await this.audit.record({
        actor,
        action: 'credits.adjust_applied',
        targetType: 'account',
        targetId: adjustment.accountId,
        reason: adjustment.reason,
        after: {
          adjustmentId,
          ledgerTxnId: result?.transactionId ?? null,
          balanceAfter: result?.balanceAfter ?? null,
        },
      });

      return {
        id: applied.id,
        status: applied.status,
        ledgerTxnId: applied.ledgerTxnId,
        balanceAfter: result?.balanceAfter ?? null,
      };
    } catch (err) {
      // The row stays as a durable record of the attempt; the idempotency key means
      // a retry resolves to the same ledger entry rather than a second one.
      await this.admin.creditAdjustment.update({
        where: { id: adjustmentId },
        data: {
          status: 'FAILED',
          failureReason: (err as Error).message.slice(0, 500),
        },
      });
      this.logger.error(
        `Credit adjustment ${adjustmentId} failed: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  /** Retries a FAILED adjustment against the same idempotency key. */
  async retry(actor: StaffPrincipal, adjustmentId: string) {
    const adjustment = await this.admin.creditAdjustment.findUniqueOrThrow({
      where: { id: adjustmentId },
    });
    if (adjustment.status !== 'FAILED') {
      throw new ConflictException(
        `Only FAILED adjustments can be retried; this is ${adjustment.status}`,
      );
    }
    return this.apply(actor, adjustmentId);
  }

  async list(query: {
    cursor?: string;
    limit?: number;
    accountId?: string;
    status?: string;
  }) {
    const limit = query.limit ?? 50;
    const rows = await this.admin.creditAdjustment.findMany({
      where: {
        ...cursorWhere(decodeCursor(query.cursor)),
        ...(query.accountId ? { accountId: query.accountId } : {}),
        ...(query.status ? { status: query.status as never } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        requestedBy: { select: { id: true, name: true, email: true } },
        approvedBy: { select: { id: true, name: true, email: true } },
      },
    });
    return buildPage(rows, limit);
  }

  /** Puts the pending adjustment in front of everyone who can approve it. */
  private async notifyApprovers(
    adjustmentId: string,
    accountId: string,
    amountNgn: string,
  ) {
    const approvers = await this.admin.staff.findMany({
      where: {
        status: 'ACTIVE',
        role: { permissions: { has: 'credits.approve' } },
      },
      select: { id: true },
    });

    if (!approvers.length) {
      this.logger.warn(
        'No active staff hold credits.approve; adjustment will sit unapproved',
      );
      return;
    }

    await this.admin.staffNotification.createMany({
      data: approvers.map((approver) => ({
        staffId: approver.id,
        type: 'credits.approval_required',
        severity: 'HIGH' as const,
        title: `Credit adjustment of ₦${amountNgn} needs approval`,
        body: `Account ${accountId}`,
        link: `/credit-adjustments/${adjustmentId}`,
      })),
    });
  }
}
