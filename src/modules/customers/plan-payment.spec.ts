import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { CustomerActionsService } from './customer-actions.service';

function build(
  opts: { limit?: number; result?: Record<string, unknown> } = {},
) {
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const adminApiCore = {
    recordPlanPayment: jest.fn().mockResolvedValue(
      opts.result ?? {
        alreadyApplied: false,
        subscriptionId: 'sub-1',
        creditReference: 'r1',
        credited: '3000.00',
        charged: '3000.00',
      },
    ),
  };
  const zapiack = {
    read: {
      accounts: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'acct-1',
          accountStatus: 'ACTIVE',
          creditBalance: { toString: () => '10000' },
        }),
      },
      plans: {
        findUnique: jest.fn(({ where }: { where: { id: string } }) =>
          Promise.resolve(
            where.id === 'plan-1'
              ? { id: 'plan-1', name: 'SMS Starter' }
              : null,
          ),
        ),
      },
    },
  };
  const config = {
    get: () => ({
      limits: { creditApprovalThresholdNgn: opts.limit ?? 50_000 },
    }),
  };
  const service = new CustomerActionsService(
    {} as never,
    {} as never,
    zapiack as never,
    {} as never,
    audit as never,
    {} as never,
    adminApiCore as never,
    config as never,
  );
  return { service, audit, adminApiCore };
}

const staff = (permissions: string[] = ['credits.adjust']) =>
  ({ id: 's1', email: 'finance@zapiack.com', permissions }) as never;
const input = (over: Record<string, unknown> = {}) => ({
  planId: 'plan-1',
  amountReceivedNgn: '3000',
  reference: 'GTB-0001',
  reason: 'Bank transfer received 2 Nov',
  ...over,
});

describe('recording a plan paid for outside the app', () => {
  it('sends it to api-core with who recorded it, and leaves an audit entry with the before and after', async () => {
    const { service, audit, adminApiCore } = build();
    const out = await service.recordPlanPayment(staff(), 'acct-1', input());

    expect(adminApiCore.recordPlanPayment).toHaveBeenCalledWith(
      'acct-1',
      expect.objectContaining({
        planId: 'plan-1',
        reference: 'GTB-0001',
        recordedBy: 'finance@zapiack.com',
      }),
    );
    expect(out).toMatchObject({ subscriptionId: 'sub-1' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'customers.plan_payment_recorded',
        targetId: 'acct-1',
        before: { creditBalance: '10000' },
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        after: expect.objectContaining({
          reference: 'GTB-0001',
          charged: '3000.00',
          subscriptionId: 'sub-1',
        }),
      }),
    );
  });

  it('writes no second audit entry when api-core says it was already applied', async () => {
    const { service, audit } = build({
      result: { alreadyApplied: true, creditReference: 'r1' },
    });
    await service.recordPlanPayment(staff(), 'acct-1', input());
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('needs credit approval above the limit, and nothing is sent without it', async () => {
    const { service, adminApiCore } = build({ limit: 50_000 });
    await expect(
      service.recordPlanPayment(
        staff(),
        'acct-1',
        input({ amountReceivedNgn: '75000' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(adminApiCore.recordPlanPayment).not.toHaveBeenCalled();
    await expect(
      service.recordPlanPayment(
        staff(['credits.adjust', 'credits.approve']),
        'acct-1',
        input({ amountReceivedNgn: '75000' }),
      ),
    ).resolves.toBeDefined();
  });

  it('refuses a plan that does not exist before moving any money', async () => {
    const { service, adminApiCore } = build();
    await expect(
      service.recordPlanPayment(staff(), 'acct-1', input({ planId: 'nope' })),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(adminApiCore.recordPlanPayment).not.toHaveBeenCalled();
  });
});
