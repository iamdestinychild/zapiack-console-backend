import { AuditEntry, AuditService } from '../../common/audit/audit.service';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import {
  ApiCoreAvailabilityRule,
  TemplateReviewClient,
} from '../../integrations/api-core/template-review.client';
import { AvailabilityService } from './availability.service';

const actor: StaffPrincipal = {
  id: 'staff-1',
  email: 'ops@zapiack.com',
  name: 'Ops Staff',
  roleId: 'role-1',
  roleKey: 'ops',
  permissions: ['availability.manage'],
  sessionId: 'session-1',
  sessionEpoch: 1,
};

type ChangeInput = Parameters<TemplateReviewClient['changeAvailability']>[0];

const rule = (
  over: Partial<ApiCoreAvailabilityRule>,
): ApiCoreAvailabilityRule => ({
  id: 'r1',
  accountCountry: 'US',
  service: 'SMS',
  destinationCountry: 'NG',
  messageType: '*',
  enabled: false,
  note: null,
  updatedBy: 'ops@zapiack.com',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  ...over,
});

function build(existing: ApiCoreAvailabilityRule[] = []) {
  const calls: { change: ChangeInput[]; audit: AuditEntry[] } = {
    change: [],
    audit: [],
  };
  const client: Pick<
    TemplateReviewClient,
    'listAvailability' | 'changeAvailability'
  > = {
    listAvailability: () => Promise.resolve(existing),
    changeAvailability: (input) => {
      calls.change.push(input);
      return Promise.resolve([]);
    },
  };
  const audit: Pick<AuditService, 'record'> = {
    record: (entry) => {
      calls.audit.push(entry);
      return Promise.resolve();
    },
  };
  return {
    svc: new AvailabilityService(
      client as unknown as TemplateReviewClient,
      audit as unknown as AuditService,
    ),
    calls,
  };
}

describe('service availability', () => {
  it('normalises the countries, records who changed it, and audits the change as one entry', async () => {
    const { svc, calls } = build();
    await svc.change(actor, {
      upserts: [
        {
          accountCountry: 'gh',
          service: 'EMAIL',
          destinationCountry: '*',
          enabled: false,
        },
        {
          accountCountry: '*',
          service: 'SMS',
          destinationCountry: 'us',
          messageType: 'PROMOTIONAL',
          enabled: false,
        },
      ],
      deleteIds: [],
      reason: 'Not launching in Ghana yet',
    });
    expect(calls.change[0].upserts[0]).toMatchObject({
      accountCountry: 'GH',
      messageType: '*',
      updatedBy: 'ops@zapiack.com',
    });
    expect(calls.change[0].upserts[1]).toMatchObject({
      destinationCountry: 'US',
      messageType: 'PROMOTIONAL',
    });
    expect(calls.audit).toHaveLength(1);
    expect(calls.audit[0]).toMatchObject({
      action: 'availability.changed',
      reason: 'Not launching in Ghana yet',
    });
  });

  it('shows the rules that were taken away', async () => {
    const { svc, calls } = build([rule({})]);
    await svc.change(actor, {
      upserts: [],
      deleteIds: ['r1', 'gone'],
      reason: 'Reopening for US accounts',
    });
    expect((calls.audit[0].before as { removed: unknown }).removed).toEqual([
      {
        accountCountry: 'US',
        service: 'SMS',
        destinationCountry: 'NG',
        messageType: '*',
        enabled: false,
      },
    ]);
    expect(calls.change[0].deleteIds).toEqual(['r1', 'gone']);
  });
});
