import { BadRequestException, ConflictException } from '@nestjs/common';
import { SenderIdsService } from './sender-ids.service';

type Row = Record<string, unknown>;

interface World {
  /** The review as the console holds it. */
  review?: Row;
  /** The application as the product holds it. */
  application?: Row;
  reviews?: Row[];
  applications?: Row[];
  draftCount?: number;
}

function setup(world: World) {
  const productWrites: { model: string; data: Row }[] = [];
  const reviewUpdates: Row[] = [];
  const events: string[] = [];

  const admin = {
    senderIdReview: {
      findUnique: jest.fn(() => Promise.resolve(world.review)),
      findUniqueOrThrow: jest.fn(() => Promise.resolve(world.review)),
      findMany: jest.fn(() => Promise.resolve(world.reviews ?? [])),
      groupBy: jest.fn(() => {
        const counts = new Map<string, number>();
        for (const r of world.reviews ?? []) {
          counts.set(
            r.status as string,
            (counts.get(r.status as string) ?? 0) + 1,
          );
        }
        return Promise.resolve(
          [...counts].map(([status, n]) => ({ status, _count: { _all: n } })),
        );
      }),
      count: jest.fn(() => Promise.resolve(0)),
      update: jest.fn(({ data }: { data: Row }) => {
        reviewUpdates.push(data);
        return Promise.resolve({ ...world.review, ...data, id: 'rev1' });
      }),
    },
  };
  const zapiack = {
    read: {
      senderIdApplication: {
        findUnique: jest.fn(() => Promise.resolve(world.application)),
        findMany: jest.fn(() => Promise.resolve(world.applications ?? [])),
        count: jest.fn(() => Promise.resolve(world.draftCount ?? 0)),
      },
    },
  };
  const tx = {
    senderIdApplication: {
      update: jest.fn(({ data }: { data: Row }) => {
        productWrites.push({ model: 'senderIdApplication', data });
        events.push('product');
        return Promise.resolve({});
      }),
    },
    accounts: {
      findUnique: jest.fn(() => Promise.resolve({ userId: 'user1' })),
    },
    userNotifications: {
      create: jest.fn(({ data }: { data: Row }) => {
        productWrites.push({ model: 'userNotifications', data });
        return Promise.resolve({});
      }),
    },
  };
  const writer = {
    write: {
      $transaction: jest.fn((fn: (t: typeof tx) => Promise<void>) => fn(tx)),
      senderIdApplication: { update: jest.fn() },
    },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = {
    broadcastToPermission: jest.fn().mockResolvedValue(undefined),
    notifyStaff: jest.fn().mockResolvedValue(undefined),
  };
  const productCache = {
    invalidateSenderId: jest.fn(() => {
      events.push('cache');
      return Promise.resolve(true);
    }),
    notifyUser: jest.fn(() => Promise.resolve(true)),
  };

  const service = new SenderIdsService(
    admin as never,
    zapiack as never,
    writer as never,
    audit as never,
    notifications as never,
    productCache as never,
  );
  return {
    service,
    admin,
    zapiack,
    writer,
    audit,
    productCache,
    productWrites,
    reviewUpdates,
    events,
    tx,
  };
}

const staff = { id: 'staff1', email: 's@z.com' } as never;

/** The arguments the first review query was made with. */
const firstQuery = (w: {
  admin: { senderIdReview: { findMany: jest.Mock } };
}) => (w.admin.senderIdReview.findMany.mock.calls as unknown as [Row][])[0][0];

/** list() returns queue rows, or draft rows for the DRAFT filter; tests look at one shape. */
interface Listed {
  counts: Record<string, number>;
  data: {
    id: string | null;
    status: string;
    overdue: boolean;
    hoursRemaining: number | null;
    applicationId: string;
  }[];
}
const listed = async (
  service: SenderIdsService,
  query: Parameters<SenderIdsService['list']>[0] = {},
): Promise<Listed> => (await service.list(query)) as unknown as Listed;

const checklistDone = ['a', 'b', 'c', 'd'].map((key) => ({
  key,
  passed: true,
}));
const review = (over: Row = {}): Row => ({
  id: 'rev1',
  applicationId: 'app1',
  accountId: 'acc1',
  senderId: 'KANOLOG',
  status: 'SUBMITTED',
  checklist: checklistDone,
  ...over,
});
const application = (over: Row = {}): Row => ({
  id: 'app1',
  projectId: 'proj1',
  status: 'PENDING_REVIEW',
  ...over,
});

describe('decide', () => {
  it('approves: writes only APPROVED to the product, tells the customer, and clears the sender cache', async () => {
    const w = setup({ review: review(), application: application() });
    const res = await w.service.decide(staff, 'rev1', { status: 'APPROVED' });

    expect(res).toMatchObject({ status: 'APPROVED' });
    const app = w.productWrites.find(
      (x) => x.model === 'senderIdApplication',
    )!.data;
    expect(app.status).toBe('APPROVED');
    expect(app.rejectionReason).toBeNull();
    const note = w.productWrites.find(
      (x) => x.model === 'userNotifications',
    )!.data;
    expect(note).toMatchObject({
      userId: 'user1',
      type: 'SENDER_ID',
      severity: 'SUCCESS',
    });
    expect(w.productCache.invalidateSenderId).toHaveBeenCalledWith('proj1');
    expect(w.productCache.notifyUser).toHaveBeenCalledWith('user1');
  });

  it('rejects with the reason shown to the customer, and stores it on the application', async () => {
    const w = setup({ review: review(), application: application() });
    await w.service.decide(staff, 'rev1', {
      status: 'REJECTED',
      reason: 'Sample reads as a promotion.',
    });

    const app = w.productWrites.find(
      (x) => x.model === 'senderIdApplication',
    )!.data;
    expect(app).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'Sample reads as a promotion.',
    });
    const note = w.productWrites.find(
      (x) => x.model === 'userNotifications',
    )!.data;
    expect(note.severity).toBe('ERROR');
    expect(note.body).toContain('Sample reads as a promotion.');
    expect(note.body).toContain('submit it again');
  });

  it('refuses a rejection with no reason, before anything is written', async () => {
    const w = setup({ review: review(), application: application() });
    await expect(
      w.service.decide(staff, 'rev1', { status: 'REJECTED' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(w.productWrites).toEqual([]);
    expect(w.productCache.invalidateSenderId).not.toHaveBeenCalled();
  });

  it('treats the old CHANGES_REQUESTED as a rejection that says changes were requested', async () => {
    const w = setup({ review: review(), application: application() });
    await w.service.decide(staff, 'rev1', {
      status: 'CHANGES_REQUESTED',
      reason: 'Add the CAC certificate.',
    });
    const app = w.productWrites.find(
      (x) => x.model === 'senderIdApplication',
    )!.data;
    expect(app.status).toBe('REJECTED');
    expect(app.rejectionReason).toBe(
      'Changes requested: Add the CAC certificate.',
    );
  });

  it('never writes a status the product does not have', async () => {
    for (const dto of [
      { status: 'APPROVED' as const },
      { status: 'REJECTED' as const, reason: 'Not acceptable content.' },
      {
        status: 'CHANGES_REQUESTED' as const,
        reason: 'Please fix the sample.',
      },
    ]) {
      const w = setup({ review: review(), application: application() });
      await w.service.decide(staff, 'rev1', dto);
      const written = w.productWrites.find(
        (x) => x.model === 'senderIdApplication',
      )!.data.status;
      expect(['APPROVED', 'REJECTED']).toContain(written);
    }
  });

  it('will not approve with the checklist incomplete or failed', async () => {
    const incomplete = setup({
      review: review({
        checklist: [
          { key: 'a', passed: true },
          { key: 'b', passed: null },
        ],
      }),
      application: application(),
    });
    await expect(
      incomplete.service.decide(staff, 'rev1', { status: 'APPROVED' }),
    ).rejects.toThrow(/Complete the checklist/);
    const failed = setup({
      review: review({ checklist: [{ key: 'a', passed: false }] }),
      application: application(),
    });
    await expect(
      failed.service.decide(staff, 'rev1', { status: 'APPROVED' }),
    ).rejects.toThrow(/Reject the application instead/);
  });

  it('says so when the decision would change nothing', async () => {
    const w = setup({
      review: review({ status: 'APPROVED' }),
      application: application({ status: 'APPROVED' }),
    });
    await expect(
      w.service.decide(staff, 'rev1', { status: 'APPROVED' }),
    ).rejects.toThrow(/already approved/);
  });

  it('lets an approval be withdrawn', async () => {
    const w = setup({
      review: review({ status: 'APPROVED' }),
      application: application({ status: 'APPROVED' }),
    });
    const res = await w.service.decide(staff, 'rev1', {
      status: 'REJECTED',
      reason: 'Complaint about misuse.',
    });
    expect(res.status).toBe('REJECTED');
    expect(w.productCache.invalidateSenderId).toHaveBeenCalledWith('proj1');
  });

  it('refuses to decide on a stale screen: the customer changed it in the meantime', async () => {
    // The console thinks it is pending; the customer's app says it was already rejected.
    const w = setup({
      review: review(),
      application: application({ status: 'REJECTED' }),
    });
    await expect(
      w.service.decide(staff, 'rev1', { status: 'APPROVED' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(w.productWrites).toEqual([]);
  });

  it('writes the product first and clears the cache before the review row, so the source of truth leads', async () => {
    const w = setup({ review: review(), application: application() });
    await w.service.decide(staff, 'rev1', { status: 'APPROVED' });
    expect(w.events).toEqual(['product', 'cache']);
    expect(w.admin.senderIdReview.update).toHaveBeenCalled();
  });

  it('records who decided and why, in the product’s words', async () => {
    const w = setup({ review: review(), application: application() });
    await w.service.decide(staff, 'rev1', {
      status: 'REJECTED',
      reason: 'Content is promotional.',
    });
    const entry = (w.audit.record.mock.calls[0] as [Row])[0];
    expect(entry).toMatchObject({
      action: 'senderid.rejected',
      reason: 'Content is promotional.',
      before: { status: 'PENDING_REVIEW' },
      after: { status: 'REJECTED' },
    });
  });
});

describe('assign', () => {
  it('is the console’s own bookkeeping and writes nothing to the product', async () => {
    const w = setup({ review: review() });
    const res = await w.service.assign(staff, 'rev1', 'reviewer2');
    expect(res.status).toBe('PENDING_REVIEW');
    expect(w.productWrites).toEqual([]);
    expect(w.writer.write.senderIdApplication.update).not.toHaveBeenCalled();
    expect(w.reviewUpdates[0]).not.toHaveProperty('status');
  });
});

describe('list', () => {
  const reviews = [
    {
      id: 'r1',
      applicationId: 'a1',
      accountId: 'x',
      senderId: 'ONE',
      status: 'SUBMITTED',
      assignee: null,
      submittedAt: new Date('2026-10-10'),
      slaDueAt: new Date('2099-01-01'),
      decidedAt: null,
    },
    {
      id: 'r2',
      applicationId: 'a2',
      accountId: 'x',
      senderId: 'TWO',
      status: 'IN_REVIEW',
      assignee: { id: 's', name: 'S' },
      submittedAt: new Date('2026-10-10'),
      slaDueAt: new Date('2000-01-01'),
      decidedAt: null,
    },
    {
      id: 'r3',
      applicationId: 'a3',
      accountId: 'x',
      senderId: 'THREE',
      status: 'APPROVED',
      assignee: null,
      submittedAt: new Date('2026-10-01'),
      slaDueAt: new Date('2000-01-01'),
      decidedAt: new Date('2026-10-02'),
    },
    {
      id: 'r4',
      applicationId: 'a4',
      accountId: 'x',
      senderId: 'FOUR',
      status: 'REJECTED',
      assignee: null,
      submittedAt: new Date('2026-10-01'),
      slaDueAt: new Date('2000-01-01'),
      decidedAt: new Date('2026-10-02'),
    },
  ];

  it('shows only the product’s statuses, never SUBMITTED or IN_REVIEW', async () => {
    const w = setup({ reviews });
    const res = await listed(w.service);
    expect(res.data.map((r) => r.status)).toEqual([
      'PENDING_REVIEW',
      'PENDING_REVIEW',
      'APPROVED',
      'REJECTED',
    ]);
  });

  it('counts by the product’s statuses, including drafts, for the tabs', async () => {
    const w = setup({ reviews, draftCount: 6 });
    const { counts } = await listed(w.service);
    expect(counts).toMatchObject({
      PENDING_REVIEW: 2,
      APPROVED: 1,
      REJECTED: 1,
      DRAFT: 6,
    });
    expect(counts).not.toHaveProperty('SUBMITTED');
  });

  it('flags only waiting applications as overdue, not decided ones', async () => {
    const w = setup({ reviews });
    const { data } = await listed(w.service);
    expect(data.find((r) => r.id === 'r1')!.overdue).toBe(false);
    expect(data.find((r) => r.id === 'r2')!.overdue).toBe(true);
    expect(data.find((r) => r.id === 'r3')!.overdue).toBe(false);
    expect(data.find((r) => r.id === 'r3')!.hoursRemaining).toBeNull();
  });

  it('filters PENDING_REVIEW as every stored status that presents as it', async () => {
    const w = setup({ reviews });
    await w.service.list({ status: 'PENDING_REVIEW' });
    const where = firstQuery(w).where as { AND: Row[] };
    const statuses = (where.AND[0].status as { in: string[] }).in.sort();
    expect(statuses).toEqual(['IN_REVIEW', 'SUBMITTED']);
  });

  it('still understands the old SUBMITTED filter as pending review', async () => {
    const w = setup({ reviews });
    await w.service.list({ status: 'SUBMITTED' });
    const where = firstQuery(w).where as { AND: Row[] };
    expect((where.AND[0].status as { in: string[] }).in).toContain('IN_REVIEW');
  });

  it('serves DRAFT from the product, with no review to open', async () => {
    const w = setup({
      applications: [],
      draftCount: 1,
    });
    w.zapiack.read.senderIdApplication.findMany.mockResolvedValueOnce([
      {
        id: 'd1',
        accountId: 'x',
        senderId: 'DRAFTED',
        businessName: 'Acme',
        category: 'TRANSACTIONAL',
        companyType: 'COMPANY',
        cacStatus: 'UNVERIFIED',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as never);
    const res = await listed(w.service, { status: 'DRAFT' });
    expect(res.data[0]).toMatchObject({
      id: null,
      applicationId: 'd1',
      status: 'DRAFT',
    });
    expect(w.admin.senderIdReview.findMany).not.toHaveBeenCalled();
  });
});

describe('sync from the product', () => {
  const when = new Date('2026-10-12T10:00:00Z');

  it('reopens a decided review when the customer resubmits, with a fresh clock and a clean checklist', async () => {
    const w = setup({
      applications: [
        {
          id: 'app1',
          status: 'PENDING_REVIEW',
          reviewedAt: null,
          rejectionReason: null,
          submittedAt: when,
        },
      ],
      reviews: [{ id: 'rev1', applicationId: 'app1', status: 'REJECTED' }],
    });
    const res = await w.service.syncFromProduct();
    expect(res.refreshed).toBe(1);
    const update = w.reviewUpdates[0] as Row & { events: { create: Row } };
    expect(update).toMatchObject({
      status: 'SUBMITTED',
      decidedAt: null,
      assigneeId: null,
    });
    expect(update.submittedAt).toEqual(when);
    expect((update.slaDueAt as Date).getTime()).toBe(
      when.getTime() + 24 * 3_600_000,
    );
    expect(update.checklist).toEqual({
      updateMany: { where: {}, data: { passed: null } },
    });
    expect(update.events.create.comment).toBe('Resubmitted by the customer');
  });

  it('does not treat a reviewer picking an application up as a change', async () => {
    const w = setup({
      applications: [
        {
          id: 'app1',
          status: 'PENDING_REVIEW',
          reviewedAt: null,
          rejectionReason: null,
          submittedAt: when,
        },
      ],
      reviews: [{ id: 'rev1', applicationId: 'app1', status: 'IN_REVIEW' }],
    });
    expect((await w.service.syncFromProduct()).refreshed).toBe(0);
    expect(w.reviewUpdates).toEqual([]);
  });

  it('follows a decision made elsewhere', async () => {
    const decided = new Date('2026-10-11T09:00:00Z');
    const w = setup({
      applications: [
        {
          id: 'app1',
          status: 'APPROVED',
          reviewedAt: decided,
          rejectionReason: null,
          submittedAt: when,
        },
      ],
      reviews: [{ id: 'rev1', applicationId: 'app1', status: 'SUBMITTED' }],
    });
    await w.service.syncFromProduct();
    expect(w.reviewUpdates[0]).toMatchObject({
      status: 'APPROVED',
      decidedAt: decided,
    });
  });

  it('leaves drafts out of the queue without a warning', async () => {
    const w = setup({
      applications: [
        {
          id: 'd1',
          status: 'DRAFT',
          reviewedAt: null,
          rejectionReason: null,
          submittedAt: null,
        },
      ],
      reviews: [],
    });
    const res = await w.service.syncFromProduct();
    expect(res).toMatchObject({ created: 0, skipped: {} });
  });

  it('reports a status that is not one of the four rather than guessing', async () => {
    const w = setup({
      applications: [
        {
          id: 'x1',
          status: 'IN_REVIEW',
          reviewedAt: null,
          rejectionReason: null,
          submittedAt: null,
        },
      ],
      reviews: [],
    });
    expect((await w.service.syncFromProduct()).skipped).toEqual({
      IN_REVIEW: 1,
    });
  });
});
