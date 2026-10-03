import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { ZapiackPrismaService } from '../../common/prisma/zapiack-prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiCoreClient } from '../../integrations/api-core/api-core.client';
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
  constructor(
    private readonly apiCore: ApiCoreClient,
    private readonly writer: ZapiackWriteService,
    private readonly zapiack: ZapiackPrismaService,
    private readonly admin: AdminPrismaService,
    private readonly audit: AuditService,
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

    const updated = await this.writer.write.accounts.update({
      where: { id: accountId },
      data: { accountStatus: status },
      select: { id: true, accountStatus: true },
    });

    await this.audit.record({
      actor,
      action: `customers.status_${status.toLowerCase()}`,
      targetType: 'account',
      targetId: accountId,
      reason,
      before: { status: before.accountStatus },
      after: { status: updated.accountStatus },
    });

    return { accountId, status: updated.accountStatus };
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

    await this.audit.record({
      actor,
      action: isActive ? 'customers.restore_key' : 'customers.revoke_key',
      targetType: 'api_key',
      targetId: apiKeyId,
      reason,
      before: { isActive: apiKey.isActive },
      after: { isActive },
      metadata: { accountId, prefix: apiKey.keyPrefix },
    });

    return { accountId, apiKeyId, isActive };
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
        where: { accountId, status: 'active' },
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
