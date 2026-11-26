import { NotFoundException } from '@nestjs/common';
import { CustomerActionsService } from './customer-actions.service';

function build(
  result: Record<string, unknown> = {
    alreadyApplied: false,
    direction: 'UPGRADE',
    subscriptionId: 'sub-1',
    charged: '7500.00',
  },
) {
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const adminApiCore = {
    changePlanFromWallet: jest.fn().mockResolvedValue(result),
  };
  const zapiack = {
    read: {
      accounts: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'acct-1', accountStatus: 'ACTIVE' }),
      },
      plans: {
        findUnique: jest.fn(({ where }: { where: { id: string } }) =>
          Promise.resolve(
            where.id === 'pro' ? { id: 'pro', name: 'Pro' } : null,
          ),
        ),
      },
      subscriptions: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ plan: { id: 'basic', name: 'Basic' } }),
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
  email: 'finance@zapiack.com',
  permissions: ['customers.manage'],
} as never;

describe('changing a customer plan from their wallet', () => {
  it('goes through the admin route in api-core and is audited', async () => {
    const { service, audit, adminApiCore } = build();
    const out = await service.changePlan(
      staff,
      'acct-1',
      'pro',
      'Customer asked to upgrade',
      'key-1',
    );

    expect(adminApiCore.changePlanFromWallet).toHaveBeenCalledWith('acct-1', {
      planId: 'pro',
      reason: 'Customer asked to upgrade',
      recordedBy: 'finance@zapiack.com',
      idempotencyKey: 'key-1',
    });
    expect(out).toMatchObject({
      direction: 'UPGRADE',
      charged: '7500.00',
      subscriptionId: 'sub-1',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'customers.change_plan',
        after: expect.objectContaining({
          direction: 'UPGRADE',
          charged: '7500.00',
        }) as Record<string, unknown>,
      }),
    );
  });

  it('does not audit a repeat that api-core already applied', async () => {
    const { service, audit } = build({
      alreadyApplied: true,
      direction: 'UPGRADE',
    });
    await service.changePlan(
      staff,
      'acct-1',
      'pro',
      'Customer asked to upgrade',
      'key-1',
    );
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses a plan that does not exist, before calling api-core', async () => {
    const { service, adminApiCore } = build();
    await expect(
      service.changePlan(staff, 'acct-1', 'nope', 'Customer asked to upgrade'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(adminApiCore.changePlanFromWallet).not.toHaveBeenCalled();
  });
});
