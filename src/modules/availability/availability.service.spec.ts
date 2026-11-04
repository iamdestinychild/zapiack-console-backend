import { AvailabilityService } from './availability.service';

const actor: any = { id: 'staff-1', email: 'ops@zapiack.com', permissions: ['availability.manage'] };

function build(existing: any[] = []) {
  const calls: any = { set: [], del: [], audit: [] };
  const client: any = {
    listAvailability: async () => existing,
    setAvailability: async (input: any) => {
      calls.set.push(input);
      return { id: 'r1', note: input.note ?? null, ...input };
    },
    deleteAvailability: async (id: string) => {
      calls.del.push(id);
      return existing.find((r) => r.id === id);
    },
  };
  const audit: any = { record: async (e: any) => calls.audit.push(e) };
  return { svc: new AvailabilityService(client, audit), calls };
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
      { id: 'r1', accountCountry: 'US', service: 'SMS', destinationCountry: 'NG', enabled: false, note: null },
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
      { id: 'r1', accountCountry: 'GH', service: 'SMS', destinationCountry: '*', enabled: false, note: null },
    ]);
    await svc.remove(actor, 'r1', 'No longer needed');
    expect(calls.del).toEqual(['r1']);
    expect(calls.audit[0]).toMatchObject({
      action: 'availability.removed',
      before: { accountCountry: 'GH', enabled: false },
    });
  });
});
