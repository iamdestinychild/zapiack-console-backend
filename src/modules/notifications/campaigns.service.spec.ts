import { ConflictException, ForbiddenException } from '@nestjs/common';
import { CampaignsService } from './campaigns.service';

type Row = Record<string, unknown>;

function setup(opts: {
  campaign?: Row;
  failedRecipients?: number;
  otherSuperAdmins?: number;
}) {
  const queued: {
    name: string;
    data: unknown;
    opts: Record<string, unknown>;
  }[] = [];
  const admin = {
    campaign: {
      findUniqueOrThrow: jest.fn(() => Promise.resolve(opts.campaign)),
      update: jest.fn(({ data }: { data: Row }) =>
        Promise.resolve({ ...opts.campaign, ...data }),
      ),
    },
    campaignRecipient: {
      count: jest.fn(() => Promise.resolve(opts.failedRecipients ?? 0)),
      updateMany: jest.fn(() =>
        Promise.resolve({ count: opts.failedRecipients ?? 0 }),
      ),
    },
    staff: {
      count: jest.fn(() => Promise.resolve(opts.otherSuperAdmins ?? 0)),
    },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const queue = {
    add: jest.fn((name: string, data: unknown, o: Record<string, unknown>) => {
      queued.push({ name, data, opts: o });
      return Promise.resolve();
    }),
    remove: jest.fn(),
  };
  const notifications = { notifyStaff: jest.fn().mockResolvedValue(undefined) };
  const config = {
    get: () => ({ limits: { broadcastApprovalThreshold: 1000 } }),
  };
  const service = new CampaignsService(
    admin as never,
    {} as never,
    audit as never,
    {} as never,
    notifications as never,
    queue as never,
    config as never,
  );
  return { service, admin, audit, queue, queued, notifications };
}

const actor = {
  id: 'staff1',
  email: 'a@z.com',
  roleKey: 'super_admin',
  permissions: [],
} as never;

describe('CampaignsService.retry', () => {
  it('re-queues only the failed recipients, as a retry, with a job id that cannot be deduplicated', async () => {
    const { service, admin, queued, audit } = setup({
      campaign: { id: 'c1', status: 'SENT' },
      failedRecipients: 7,
    });
    const res = await service.retry(actor, 'c1');
    expect(res).toEqual({ id: 'c1', status: 'SCHEDULED', retrying: 7 });
    expect(admin.campaignRecipient.updateMany).toHaveBeenCalledWith({
      where: { campaignId: 'c1', status: 'FAILED' },
      data: { status: 'PENDING', failureReason: null },
    });
    expect(queued[0].data).toEqual({ campaignId: 'c1', retry: true });
    expect(String(queued[0].opts.jobId)).toMatch(/^campaign-c1-retry-\d+$/);
    expect(audit.record).toHaveBeenCalled();
  });

  it('works on a campaign that reached nobody', async () => {
    const { service } = setup({
      campaign: { id: 'c1', status: 'FAILED' },
      failedRecipients: 3,
    });
    await expect(service.retry(actor, 'c1')).resolves.toMatchObject({
      retrying: 3,
    });
  });

  it('refuses a campaign that is still going or never started', async () => {
    for (const status of ['DRAFT', 'SCHEDULED', 'SENDING', 'CANCELLED']) {
      const { service, queue } = setup({
        campaign: { id: 'c1', status },
        failedRecipients: 5,
      });
      await expect(service.retry(actor, 'c1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(queue.add).not.toHaveBeenCalled();
    }
  });

  it('refuses when nothing failed', async () => {
    const { service, queue } = setup({
      campaign: { id: 'c1', status: 'SENT' },
      failedRecipients: 0,
    });
    await expect(service.retry(actor, 'c1')).rejects.toThrow(
      /nothing to retry/,
    );
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('CampaignsService.approve', () => {
  const campaign = {
    id: 'c1',
    createdById: 'staff1',
    recipientCount: 5000,
    name: 'Big one',
  };

  it('lets the only super admin approve their own campaign, and records that it was self-approved', async () => {
    const { service, audit } = setup({ campaign, otherSuperAdmins: 0 });
    await expect(
      service.approve(actor, 'c1', 'Reviewed the audience and copy'),
    ).resolves.toBeDefined();
    const entry = (
      audit.record.mock.calls[0] as [{ metadata: { selfApproved: boolean } }]
    )[0];
    expect(entry.metadata.selfApproved).toBe(true);
  });

  it('keeps the second-pair-of-eyes rule when someone else could approve', async () => {
    const { service } = setup({ campaign, otherSuperAdmins: 1 });
    await expect(
      service.approve(actor, 'c1', 'Reviewed the audience and copy'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('records an approval by someone else as not self-approved', async () => {
    const { service, audit } = setup({
      campaign: { ...campaign, createdById: 'other' },
    });
    await service.approve(actor, 'c1', 'Reviewed the audience and copy');
    const entry = (
      audit.record.mock.calls[0] as [{ metadata: { selfApproved: boolean } }]
    )[0];
    expect(entry.metadata.selfApproved).toBe(false);
  });

  it('is limited to super admins', async () => {
    const { service } = setup({ campaign });
    await expect(
      service.approve(
        { ...(actor as object), roleKey: 'finance' } as never,
        'c1',
        'Reviewed the audience',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('CampaignsService.sendNow', () => {
  it('schedules for this instant, with no delay', async () => {
    const { service, queued } = setup({
      campaign: {
        id: 'c1',
        status: 'DRAFT',
        requiresApproval: false,
        recipientCount: 10,
      },
    });
    await service.sendNow(actor, 'c1');
    expect(queued[0].opts.delay).toBeLessThan(2000);
    expect(queued[0].opts.jobId).toBe('campaign-c1');
  });

  it('still insists on approval for a large audience', async () => {
    const { service, queue } = setup({
      campaign: {
        id: 'c1',
        status: 'DRAFT',
        requiresApproval: true,
        approvedAt: null,
        recipientCount: 5000,
      },
    });
    await expect(service.sendNow(actor, 'c1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(queue.add).not.toHaveBeenCalled();
  });
});
