import { BadRequestException, ConflictException } from '@nestjs/common';
import type { ApiCoreTemplate } from '../../integrations/api-core/template-review.client';
import { TemplatesService } from './templates.service';

const base = (over: Partial<ApiCoreTemplate>): ApiCoreTemplate => ({
  id: 'id',
  templateId: 'tpl',
  name: 'Welcome',
  slug: 'welcome',
  category: 'TRANSACTIONAL',
  subject: 'Hello',
  projectId: 'p1',
  variables: null,
  status: 'IN_REVIEW',
  rejectionReason: null,
  reviewNotes: null,
  submittedAt: '2026-10-10T10:00:00.000Z',
  reviewedAt: null,
  createdAt: '2026-10-09T10:00:00.000Z',
  updatedAt: '2026-10-10T10:00:00.000Z',
  accountId: 'acc1',
  project: { id: 'p1', name: 'Shop' },
  ...over,
});

function setup(
  byStatus: Record<string, ApiCoreTemplate[]>,
  detail?: ApiCoreTemplate,
) {
  const decided: unknown[] = [];
  const client = {
    queue: jest.fn((status: string) => Promise.resolve(byStatus[status] ?? [])),
    get: jest.fn(() => Promise.resolve(detail)),
    decide: jest.fn(
      (
        _id: string,
        reviewer: string,
        input: { approve: boolean; reason?: string },
      ) => {
        decided.push({ reviewer, ...input });
        return Promise.resolve(
          base({
            ...(detail ?? {}),
            status: input.approve ? 'APPROVED' : 'REJECTED',
            rejectionReason: input.approve ? null : (input.reason ?? null),
            reviewedAt: '2026-10-11T00:00:00.000Z',
          }),
        );
      },
    ),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new TemplatesService(client as never, audit as never);
  return { service, client, audit, decided };
}

const staff = { id: 'staff1', email: 's@z.com' } as never;

/** The one audit entry the service wrote, typed so assertions need no `any`. */
function auditEntry(audit: { record: jest.Mock }) {
  return (audit.record.mock.calls[0] as [Record<string, unknown>])[0];
}

describe('TemplatesService.list', () => {
  const data = {
    DRAFT: [
      base({ id: 'd1', status: 'DRAFT', name: 'Draft one', submittedAt: null }),
    ],
    SUBMITTED: [
      base({
        id: 's1',
        status: 'SUBMITTED',
        submittedAt: '2026-10-08T00:00:00.000Z',
      }),
    ],
    IN_REVIEW: [
      base({
        id: 'r2',
        status: 'IN_REVIEW',
        submittedAt: '2026-10-09T00:00:00.000Z',
        reviewNotes: 'Uses a link shortener\nNo variables found',
      }),
    ],
    APPROVED: [base({ id: 'a1', status: 'APPROVED' })],
    REJECTED: [],
  };

  it('defaults to the review queue, oldest submission first', async () => {
    const { service } = setup(data);
    const res = await service.list({});
    expect(res.data.map((r) => r.id)).toEqual(['s1', 'r2']);
  });

  it('counts every status for the tabs, including the combined queue', async () => {
    const { service } = setup(data);
    const { counts } = await service.list({});
    expect(counts).toMatchObject({
      DRAFT: 1,
      SUBMITTED: 1,
      IN_REVIEW: 1,
      APPROVED: 1,
      REJECTED: 0,
      PENDING: 2,
    });
  });

  it('lists drafts when asked, and splits the automated findings into flags', async () => {
    const { service } = setup(data);
    expect(
      (await service.list({ status: 'DRAFT' })).data.map((r) => r.id),
    ).toEqual(['d1']);
    const queue = await service.list({});
    expect(queue.data.find((r) => r.id === 'r2')!.flags).toEqual([
      'Uses a link shortener',
      'No variables found',
    ]);
  });

  it('searches name, account and project', async () => {
    const { service } = setup(data);
    expect(
      (await service.list({ status: 'ALL', q: 'draft one' })).data,
    ).toHaveLength(1);
    expect(
      (await service.list({ status: 'ALL', q: 'shop' })).data,
    ).toHaveLength(4);
    expect(
      (await service.list({ status: 'ALL', q: 'nothing-matches' })).data,
    ).toHaveLength(0);
  });

  it('pages with a cursor', async () => {
    const { service } = setup(data);
    const first = await service.list({ status: 'ALL', limit: 3 });
    expect(first.data).toHaveLength(3);
    expect(first.hasMore).toBe(true);
    const second = await service.list({
      status: 'ALL',
      limit: 3,
      cursor: first.nextCursor!,
    });
    expect(second.data).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  it('flags a status whose count hit api-core’s page size as a floor', async () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      base({ id: `m${i}`, status: 'APPROVED' }),
    );
    const { service } = setup({ ...data, APPROVED: many });
    expect((await service.list({})).countsCapped).toEqual(['APPROVED']);
  });

  it('fetches once for a burst of requests', async () => {
    const { service, client } = setup(data);
    await service.list({});
    await service.list({ status: 'DRAFT' });
    expect(client.queue).toHaveBeenCalledTimes(5);
  });
});

describe('TemplatesService decisions', () => {
  it('approves a flagged template, records who, and audits it', async () => {
    const t = base({
      status: 'IN_REVIEW',
      html: '<p>{{name}}</p>',
      reviewNotes: 'Uses a link shortener',
    });
    const { service, audit, decided } = setup({}, t);
    const res = await service.approve(
      staff,
      'id',
      'Link is our own domain, checked',
    );
    expect(res).toMatchObject({
      status: 'APPROVED',
      previousStatus: 'IN_REVIEW',
    });
    expect(decided[0]).toEqual({
      reviewer: 'console:staff1',
      approve: true,
      reason: undefined,
    });
    const entry = auditEntry(audit);
    expect(entry).toMatchObject({
      action: 'templates.approved',
      reason: 'Link is our own domain, checked',
      before: { status: 'IN_REVIEW' },
      after: { status: 'APPROVED' },
    });
    expect(entry.metadata).toMatchObject({
      approvedFromDraft: false,
      automatedFlags: ['Uses a link shortener'],
    });
  });

  it('lets a draft be approved, and records that it skipped the checks', async () => {
    const t = base({
      status: 'DRAFT',
      html: '<p>hi {{x}}</p>',
      submittedAt: null,
    });
    const { service, audit } = setup({}, t);
    await service.approve(
      staff,
      'id',
      'Support approved on the customer’s behalf',
    );
    expect(auditEntry(audit).metadata).toMatchObject({
      approvedFromDraft: true,
    });
  });

  it('will not approve a draft with no body', async () => {
    const { service, client } = setup(
      {},
      base({ status: 'DRAFT', html: null }),
    );
    await expect(
      service.approve(staff, 'id', 'approving it anyway'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(client.decide).not.toHaveBeenCalled();
  });

  it('sends the reason to api-core on rejection, where the customer sees it', async () => {
    const { service, decided } = setup(
      {},
      base({ status: 'IN_REVIEW', html: '<p>x</p>' }),
    );
    const res = await service.reject(
      staff,
      'id',
      'Asks customers for their card number',
    );
    expect(res.rejectionReason).toBe('Asks customers for their card number');
    expect(decided[0]).toMatchObject({
      approve: false,
      reason: 'Asks customers for their card number',
    });
  });

  it('revokes only an approved template, as a rejection', async () => {
    const approved = setup({}, base({ status: 'APPROVED', html: '<p>x</p>' }));
    const res = await approved.service.revoke(
      staff,
      'id',
      'Complaint received about this wording',
    );
    expect(res).toMatchObject({
      status: 'REJECTED',
      previousStatus: 'APPROVED',
    });
    expect(approved.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'templates.revoked' }),
    );

    const pending = setup({}, base({ status: 'IN_REVIEW', html: '<p>x</p>' }));
    await expect(
      pending.service.revoke(staff, 'id', 'not approved yet'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(pending.client.decide).not.toHaveBeenCalled();
  });

  it('points a reviewer at revoke instead of reject for an approved template', async () => {
    const { service } = setup(
      {},
      base({ status: 'APPROVED', html: '<p>x</p>' }),
    );
    await expect(
      service.reject(staff, 'id', 'changed my mind'),
    ).rejects.toThrow(/revoke/i);
  });

  it('exposes what the reviewer may do, and warns when approval skips the checks', async () => {
    const draft = setup({}, base({ status: 'DRAFT', html: '<p>x</p>' }));
    expect(await draft.service.get('id')).toMatchObject({
      allowedActions: ['approve', 'reject'],
      approvalSkipsChecks: true,
      hasContent: true,
    });
    const approved = setup({}, base({ status: 'APPROVED', html: '<p>x</p>' }));
    expect(await approved.service.get('id')).toMatchObject({
      allowedActions: ['revoke'],
      approvalSkipsChecks: false,
    });
  });
});
