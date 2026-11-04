import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { ZapiackPrismaService } from '../../common/prisma/zapiack-prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { ProductCacheService } from '../../common/redis/product-cache.service';
import { ConfigService } from '@nestjs/config';
import { ApiCoreClient } from '../../integrations/api-core/api-core.client';
import { TemplateReviewClient } from '../../integrations/api-core/template-review.client';
import type { AdminConfig } from '../../common/config/configuration';
import { ZapiackWriteService } from '../../common/prisma/zapiack-write.service';
import { AccountStatus } from '../../generated/zapiack/client';
import type { RiskFlagType, RiskSeverity } from '../../generated/admin/client';
import type { StaffPrincipal } from '../../common/auth/staff-principal';

/**
 * Write actions on customer accounts. Each one is a command to api-core, never a
 * direct write to the Zapiack DB, and each leaves a before/after snapshot behind.
 */
@Injectable()
export class CustomerActionsService {
  private readonly logger = new Logger(CustomerActionsService.name);

  constructor(
    private readonly apiCore: ApiCoreClient,
    private readonly writer: ZapiackWriteService,
    private readonly zapiack: ZapiackPrismaService,
    private readonly admin: AdminPrismaService,
    private readonly audit: AuditService,
    private readonly productCache: ProductCacheService,
    private readonly adminApiCore: TemplateReviewClient,
    private readonly config: ConfigService<{ admin: AdminConfig }, true>,
  ) {}

  private ctx(actor: StaffPrincipal, idempotencyKey?: string) {
    return { actorId: actor.id, actorEmail: actor.email, idempotencyKey };
  }

  private async requireAccount(accountId: string) {
    const account = await this.zapiack.read.accounts.findUnique({
      where: { id: accountId },
      select: { id: true, accountStatus: true },
    });
    if (!account) throw new NotFoundException('Account not found');
    return account;
  }

  /**
   * Moves an account to any state in the product's lifecycle.
   *
   * `SUSPENDED` is reversible and is what support reaches for. `BANNED` ends the
   * relationship, so it is refused while the account still holds credits — those
   * would otherwise be stranded with no way to refund them.
   */
  async setStatus(
    actor: StaffPrincipal,
    accountId: string,
    status: AccountStatus,
    reason: string,
  ) {
    const before = await this.requireAccount(accountId);
    if (before.accountStatus === status) {
      throw new ConflictException(`Account is already ${status}`);
    }

    if (status === AccountStatus.BANNED) {
      const account = await this.zapiack.read.accounts.findUniqueOrThrow({
        where: { id: accountId },
        select: { creditBalance: true },
      });
      if (Number(account.creditBalance) > 0) {
        throw new ConflictException(
          `Account still holds ${account.creditBalance.toString()} credits. ` +
            'Refund or zero the balance before banning, or suspend instead.',
        );
      }
    }

    const updated = await this.writer.write.accounts
      .update({
        where: { id: accountId },
        data: { accountStatus: status },
        select: { id: true, accountStatus: true },
      })
      .catch((err: unknown) => {
        // A write role that is missing or lacks the grant surfaces as a bare 500. Name it.
        this.logger.error(
          `Could not set account ${accountId} to ${status}: ${(err as Error).message}`,
        );
        throw new ServiceUnavailableException(
          'The account could not be updated. admin-core has no write access to the product database: ' +
            'check ZAPIACK_WRITE_DATABASE_URL and the zapiack_admin write grants.',
        );
      });

    // The customer app caches an account's status for an hour. Without clearing it a
    // suspended account keeps sending, and a reactivated one stays blocked, until it
    // expires on its own.
    const effective =
      await this.productCache.invalidateAccountStatus(accountId);

    await this.audit.record({
      actor,
      action: `customers.status_${status.toLowerCase()}`,
      targetType: 'account',
      targetId: accountId,
      reason,
      before: { status: before.accountStatus },
      after: { status: updated.accountStatus },
      metadata: { immediate: effective },
    });

    // `immediate` is false only if the cache could not be cleared, in which case the
    // change still lands, within the hour. Say so rather than promise more.
    return { accountId, status: updated.accountStatus, immediate: effective };
  }

  suspend(actor: StaffPrincipal, accountId: string, reason: string) {
    return this.setStatus(actor, accountId, AccountStatus.SUSPENDED, reason);
  }

  reactivate(actor: StaffPrincipal, accountId: string, reason: string) {
    return this.setStatus(actor, accountId, AccountStatus.ACTIVE, reason);
  }

  ban(actor: StaffPrincipal, accountId: string, reason: string) {
    return this.setStatus(actor, accountId, AccountStatus.BANNED, reason);
  }

  async forceLogout(
    actor: StaffPrincipal,
    accountId: string,
    reason: string,
    key?: string,
  ) {
    await this.requireAccount(accountId);
    const result = await this.apiCore.forceLogout(
      accountId,
      this.ctx(actor, key),
    );

    await this.audit.record({
      actor,
      action: 'customers.force_logout',
      targetType: 'account',
      targetId: accountId,
      reason,
      after: { revokedSessions: result?.revokedSessions ?? null },
    });
    return { accountId, revokedSessions: result?.revokedSessions ?? null };
  }

  async setApiKeyActive(
    actor: StaffPrincipal,
    accountId: string,
    apiKeyId: string,
    isActive: boolean,
    reason: string,
  ) {
    const apiKey = await this.zapiack.read.apiKeys.findFirst({
      where: { id: apiKeyId, accountId },
      select: { id: true, keyPrefix: true, isActive: true, isDeleted: true },
    });
    if (!apiKey)
      throw new NotFoundException('API key not found on this account');
    if (apiKey.isDeleted)
      throw new ConflictException('This key has been deleted');

    await this.writer.write.apiKeys.update({
      where: { id: apiKeyId },
      data: { isActive },
      // Prisma returns the whole row from an update unless told otherwise, and the
      // writer is not granted keyHash. Name the columns; never load the hash.
      select: { id: true, isActive: true },
    });

    // api-core caches a key's details for an hour. A key disabled without clearing that
    // would keep working, which defeats the point of disabling a leaked one.
    const effective = await this.productCache.invalidateApiKey(
      apiKey.keyPrefix,
    );

    await this.audit.record({
      actor,
      action: isActive ? 'customers.restore_key' : 'customers.revoke_key',
      targetType: 'api_key',
      targetId: apiKeyId,
      reason,
      before: { isActive: apiKey.isActive },
      after: { isActive },
      metadata: { accountId, prefix: apiKey.keyPrefix, immediate: effective },
    });

    return { accountId, apiKeyId, isActive, immediate: effective };
  }

  /** Soft delete: a project carries history a hard delete would take with it. */
  async archiveProject(
    actor: StaffPrincipal,
    accountId: string,
    projectId: string,
    reason: string,
  ) {
    const project = await this.zapiack.read.projects.findFirst({
      where: { id: projectId, accountId },
      select: { id: true, name: true, isDeleted: true },
    });
    if (!project)
      throw new NotFoundException('Project not found on this account');

    await this.writer.write.projects.update({
      where: { id: projectId },
      data: { isDeleted: true },
    });

    await this.audit.record({
      actor,
      action: 'customers.project_archived',
      targetType: 'project',
      targetId: projectId,
      reason,
      before: { isDeleted: project.isDeleted },
      after: { isDeleted: true },
      metadata: { accountId, name: project.name },
    });

    return { accountId, projectId, isDeleted: true };
  }

  async changePlan(
    actor: StaffPrincipal,
    accountId: string,
    planId: string,
    reason: string,
    key?: string,
  ) {
    await this.requireAccount(accountId);

    const [plan, current] = await Promise.all([
      this.zapiack.read.plans.findUnique({
        where: { id: planId },
        select: { id: true, name: true },
      }),
      this.zapiack.read.subscriptions.findFirst({
        where: { accountId, status: 'ACTIVE' },
        include: { plan: { select: { id: true, name: true } } },
      }),
    ]);
    if (!plan) throw new NotFoundException('Plan not found');

    const result = await this.apiCore.changePlan(
      accountId,
      planId,
      reason,
      this.ctx(actor, key),
    );

    await this.audit.record({
      actor,
      action: 'customers.change_plan',
      targetType: 'account',
      targetId: accountId,
      reason,
      before: { plan: current?.plan ?? null },
      after: { plan },
    });
    return {
      accountId,
      planId,
      subscriptionId: result?.subscriptionId ?? null,
    };
  }

  /**
   * Starts a plan for a customer by charging the card on their account. Real money leaves their card, so the amount draws the
   * same line the wallet adjustments do: above the limit it needs `credits.approve` as well. The plan itself starts when the
   * card payment clears, which is when the customer is told.
   */
  async chargePlanToCard(
    actor: StaffPrincipal,
    accountId: string,
    input: { planId: string; reason: string },
  ) {
    await this.requireAccount(accountId);

    const plan = await this.zapiack.read.plans.findUnique({
      where: { id: input.planId },
      select: { id: true, name: true, basePrice: true },
    });
    if (!plan) throw new NotFoundException('Plan not found');

    const limit = this.config.get('admin', { infer: true }).limits
      .creditApprovalThresholdNgn;
    if (
      Number(plan.basePrice) > limit &&
      !actor.permissions.includes('credits.approve')
    ) {
      throw new ForbiddenException(
        `Charging a card for more than ₦${limit.toLocaleString('en-NG')} needs someone with credit approval.`,
      );
    }

    const result = await this.adminApiCore.chargePlanToCard(accountId, {
      planId: input.planId,
    });

    await this.audit.record({
      actor,
      action: 'customers.plan_card_charge',
      targetType: 'account',
      targetId: accountId,
      reason: input.reason,
      before: null,
      after: {
        plan: { id: plan.id, name: plan.name },
        reference: result.reference ?? null,
        paidWith: result.paidWith ?? null,
      },
    });
    return result;
  }

  /**
   * A customer paid outside the app (a bank transfer) and the plan has to be started by hand. The payment goes into their
   * wallet and the plan is paid from it, in one transaction in api-core; this adds who may do it, the limit, and the audit.
   *
   * Above the credit-approval limit it needs `credits.approve` as well, the same line the wallet adjustments draw, so one
   * person cannot both receive and wave through a large sum.
   */
  async recordPlanPayment(
    actor: StaffPrincipal,
    accountId: string,
    input: {
      planId: string;
      amountReceivedNgn: string;
      reference: string;
      reason: string;
    },
  ) {
    await this.requireAccount(accountId);

    const amount = Number(input.amountReceivedNgn);
    // Zero is allowed: the plan is then charged to what the wallet already holds.
    if (!Number.isFinite(amount) || amount < 0) {
      throw new ConflictException('The amount received cannot be negative.');
    }
    const limit = this.config.get('admin', { infer: true }).limits
      .creditApprovalThresholdNgn;
    if (amount > limit && !actor.permissions.includes('credits.approve')) {
      throw new ForbiddenException(
        `Payments above ₦${limit.toLocaleString('en-NG')} need someone with credit approval to record them.`,
      );
    }

    const [plan, before] = await Promise.all([
      this.zapiack.read.plans.findUnique({
        where: { id: input.planId },
        select: { id: true, name: true },
      }),
      this.zapiack.read.accounts.findUnique({
        where: { id: accountId },
        select: { creditBalance: true },
      }),
    ]);
    if (!plan) throw new NotFoundException('Plan not found');

    const result = await this.adminApiCore.recordPlanPayment(accountId, {
      ...input,
      recordedBy: actor.email,
    });

    if (!result.alreadyApplied) {
      await this.audit.record({
        actor,
        action: 'customers.plan_payment_recorded',
        targetType: 'account',
        targetId: accountId,
        reason: input.reason,
        before: { creditBalance: before?.creditBalance.toString() ?? null },
        after: {
          plan,
          reference: input.reference,
          credited: result.credited,
          charged: result.charged,
          subscriptionId: result.subscriptionId,
        },
      });
    }
    return result;
  }

  async resetRateLimits(
    actor: StaffPrincipal,
    accountId: string,
    reason: string,
    key?: string,
  ) {
    await this.requireAccount(accountId);
    await this.apiCore.resetRateLimits(accountId, this.ctx(actor, key));

    await this.audit.record({
      actor,
      action: 'customers.reset_rate_limits',
      targetType: 'account',
      targetId: accountId,
      reason,
    });
    return { accountId, reset: true };
  }

  // ---------------------------------------------------------------- risk flags

  async raiseFlag(
    actor: StaffPrincipal,
    accountId: string,
    input: {
      type: RiskFlagType;
      severity: RiskSeverity;
      summary: string;
      reason: string;
    },
  ) {
    const flag = await this.admin.riskFlag.create({
      data: {
        accountId,
        type: input.type,
        severity: input.severity,
        source: 'MANUAL',
        summary: input.summary,
        raisedBy: actor.id,
      },
    });

    await this.audit.record({
      actor,
      action: 'customers.risk_flag_raised',
      targetType: 'account',
      targetId: accountId,
      reason: input.reason,
      after: { flagId: flag.id, type: flag.type, severity: flag.severity },
    });
    return flag;
  }

  async resolveFlag(actor: StaffPrincipal, flagId: string, resolution: string) {
    const flag = await this.admin.riskFlag.update({
      where: { id: flagId },
      data: { resolvedAt: new Date(), resolvedBy: actor.id, resolution },
    });
    await this.audit.record({
      actor,
      action: 'customers.risk_flag_resolved',
      targetType: 'risk_flag',
      targetId: flagId,
      reason: resolution,
      after: { accountId: flag.accountId },
    });
    return flag;
  }
}
