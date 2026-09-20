import { Injectable, NotFoundException } from '@nestjs/common';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { ZapiackPrismaService } from '../../common/prisma/zapiack-prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiCoreClient } from '../../integrations/api-core/api-core.client';
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
    private readonly zapiack: ZapiackPrismaService,
    private readonly admin: AdminPrismaService,
    private readonly audit: AuditService,
  ) {}

  private ctx(actor: StaffPrincipal, idempotencyKey?: string) {
    return { actorId: actor.id, actorEmail: actor.email, idempotencyKey };
  }

  private async requireAccount(accountId: string) {
    const account = await this.zapiack.read.account.findUnique({
      where: { id: accountId },
      select: { id: true, status: true, businessName: true },
    });
    if (!account) throw new NotFoundException('Account not found');
    return account;
  }

  async suspend(
    actor: StaffPrincipal,
    accountId: string,
    reason: string,
    key?: string,
  ) {
    const before = await this.requireAccount(accountId);
    await this.apiCore.suspendAccount(accountId, reason, this.ctx(actor, key));

    await this.audit.record({
      actor,
      action: 'customers.suspend',
      targetType: 'account',
      targetId: accountId,
      reason,
      before: { status: before.status },
      after: { status: 'SUSPENDED' },
    });
    return { accountId, status: 'SUSPENDED' };
  }

  async reactivate(
    actor: StaffPrincipal,
    accountId: string,
    reason: string,
    key?: string,
  ) {
    const before = await this.requireAccount(accountId);
    await this.apiCore.reactivateAccount(
      accountId,
      reason,
      this.ctx(actor, key),
    );

    await this.audit.record({
      actor,
      action: 'customers.reactivate',
      targetType: 'account',
      targetId: accountId,
      reason,
      before: { status: before.status },
      after: { status: 'ACTIVE' },
    });
    return { accountId, status: 'ACTIVE' };
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

  async revokeApiKey(
    actor: StaffPrincipal,
    accountId: string,
    apiKeyId: string,
    reason: string,
    key?: string,
  ) {
    const apiKey = await this.zapiack.read.apiKey.findFirst({
      where: { id: apiKeyId, accountId },
      select: { id: true, prefix: true, revokedAt: true },
    });
    if (!apiKey)
      throw new NotFoundException('API key not found on this account');

    await this.apiCore.revokeApiKey(
      accountId,
      apiKeyId,
      reason,
      this.ctx(actor, key),
    );

    await this.audit.record({
      actor,
      action: 'customers.revoke_key',
      targetType: 'api_key',
      targetId: apiKeyId,
      reason,
      before: { revokedAt: apiKey.revokedAt },
      after: { revokedAt: new Date() },
      metadata: { accountId, prefix: apiKey.prefix },
    });
    return { accountId, apiKeyId, revoked: true };
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
      this.zapiack.read.plan.findUnique({
        where: { id: planId },
        select: { id: true, name: true },
      }),
      this.zapiack.read.subscription.findFirst({
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
