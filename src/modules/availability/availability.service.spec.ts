import { AvailabilityService } from './availability.service';

const actor: any = {
  id: 'staff-1',
  email: 'ops@zapiack.com',
  permissions: ['availability.manage'],
};

function build(existing: any[] = []) {
  const calls: any = { change: [], audit: [] };
  const client: any = {
    listAvailability: async () => existing,
    changeAvailability: async (input: any) => {
      calls.change.push(input);
      return [];
    },
  };
  const audit: any = { record: async (e: any) => calls.audit.push(e) };
  return { svc: new AvailabilityService(client, audit), calls };
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
    const { svc, calls } = build([
      {
        id: 'r1',
        accountCountry: 'US',
        service: 'SMS',
        destinationCountry: 'NG',
        messageType: '*',
        enabled: false,
      },
    ]);
    await svc.change(actor, {
      upserts: [],
      deleteIds: ['r1', 'gone'],
      reason: 'Reopening for US accounts',
    });
    expect(calls.audit[0].before.removed).toEqual([
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
