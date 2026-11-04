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

type SetAvailabilityInput = Parameters<
  TemplateReviewClient['setAvailability']
>[0];

function build(existing: ApiCoreAvailabilityRule[] = []) {
  const calls: {
    set: SetAvailabilityInput[];
    del: string[];
    audit: AuditEntry[];
  } = { set: [], del: [], audit: [] };
  const client: Pick<
    TemplateReviewClient,
    'listAvailability' | 'setAvailability' | 'deleteAvailability'
  > = {
    listAvailability: () => Promise.resolve(existing),
    setAvailability: (input) => {
      calls.set.push(input);
      return Promise.resolve({
        id: 'r1',
        accountCountry: input.accountCountry,
        service: input.service,
        destinationCountry: input.destinationCountry,
        enabled: input.enabled,
        note: input.note ?? null,
        updatedBy: input.updatedBy,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      });
    },
    deleteAvailability: (id) => {
      calls.del.push(id);
      const row = existing.find((rule) => rule.id === id);
      if (!row) throw new Error(`Availability rule not found: ${id}`);
      return Promise.resolve(row);
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
  it('normalises the countries, records who changed it, and audits the change', async () => {
    const { svc, calls } = build();
    await svc.set(actor, {
      accountCountry: 'us',
      service: 'SMS',
      destinationCountry: 'ng',
      enabled: false,
      reason: 'Nigerian SMS is for local accounts only',
    });
    expect(calls.set[0]).toMatchObject({
      accountCountry: 'US',
      destinationCountry: 'NG',
      enabled: false,
      updatedBy: 'ops@zapiack.com',
    });
    expect(calls.audit[0]).toMatchObject({
      action: 'availability.set',
      before: null,
      reason: 'Nigerian SMS is for local accounts only',
    });
  });

  it('shows what a rule was before it was changed', async () => {
    const { svc, calls } = build([
      {
        id: 'r1',
        accountCountry: 'US',
        service: 'SMS',
        destinationCountry: 'NG',
        enabled: false,
        note: null,
        updatedBy: 'ops@zapiack.com',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    ]);
    await svc.set(actor, {
      accountCountry: 'US',
      service: 'SMS',
      destinationCountry: 'NG',
      enabled: true,
      reason: 'Reopening for US accounts',
    });
    expect(calls.audit[0].before).toEqual({ enabled: false, note: null });
    expect(calls.audit[0].after).toMatchObject({ enabled: true });
  });

  it('audits a removed rule with what it said', async () => {
    const { svc, calls } = build([
      {
        id: 'r1',
        accountCountry: 'GH',
        service: 'SMS',
        destinationCountry: '*',
        enabled: false,
        note: null,
        updatedBy: 'ops@zapiack.com',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    ]);
    await svc.remove(actor, 'r1', 'No longer needed');
    expect(calls.del).toEqual(['r1']);
    expect(calls.audit[0]).toMatchObject({
      action: 'availability.removed',
      before: { accountCountry: 'GH', enabled: false },
    });
  });
});
