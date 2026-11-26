import { NotFoundException } from '@nestjs/common';
import { CustomerActionsService } from './customer-actions.service';

function build(found = true) {
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const adminApiCore = {
    forceLogout: jest.fn().mockResolvedValue({ revokedSessions: 1 }),
    resetRateLimits: jest.fn().mockResolvedValue({ reset: true, cleared: 6 }),
  };
  const zapiack = {
    read: {
      accounts: {
        findUnique: jest
          .fn()
          .mockResolvedValue(
            found ? { id: 'acct-1', accountStatus: 'ACTIVE' } : null,
          ),
      },
    },
  };
  const service = new CustomerActionsService(
    {} as never,
    zapiack as never,
    {} as never,
    audit as never,
    {} as never,
    adminApiCore as never,
    { get: () => ({}) } as never,
  );
  return { service, audit, adminApiCore };
}

const staff = {
  id: 's1',
  email: 'support@zapiack.com',
  permissions: ['customers.manage'],
} as never;

describe('force logout and reset rate limits', () => {
  it("ends the login through api-core's admin route and audits how many sessions it ended", async () => {
    const { service, audit, adminApiCore } = build();
    await expect(
      service.forceLogout(staff, 'acct-1', 'Suspected shared password'),
    ).resolves.toEqual({ accountId: 'acct-1', revokedSessions: 1 });
    expect(adminApiCore.forceLogout).toHaveBeenCalledWith('acct-1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'customers.force_logout',
        after: { revokedSessions: 1 },
      }),
    );
  });

  it("clears the counters through api-core's admin route and audits how many it cleared", async () => {
    const { service, audit, adminApiCore } = build();
    await expect(
      service.resetRateLimits(
        staff,
        'acct-1',
        'Customer was throttled in error',
      ),
    ).resolves.toEqual({ accountId: 'acct-1', reset: true, cleared: 6 });
    expect(adminApiCore.resetRateLimits).toHaveBeenCalledWith('acct-1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'customers.reset_rate_limits',
        after: { cleared: 6 },
      }),
    );
  });

  it('refuses an account that does not exist, calling nothing', async () => {
    const { service, adminApiCore } = build(false);
    await expect(
      service.forceLogout(staff, 'x', 'reason here'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.resetRateLimits(staff, 'x', 'reason here'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(adminApiCore.forceLogout).not.toHaveBeenCalled();
    expect(adminApiCore.resetRateLimits).not.toHaveBeenCalled();
  });
});
