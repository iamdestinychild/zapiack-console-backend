import { MarketsService } from './markets.service';

const actor: any = {
  id: 'staff-1',
  email: 'ops@zapiack.com',
  permissions: ['pricing.manage'],
};

function build(existing: any[] = []) {
  const calls: any = { set: [], del: [], audit: [] };
  const client: any = {
    listBillingMarkets: async () => existing,
    setBillingMarket: async (input: any) => {
      calls.set.push(input);
      return {
        id: 'm1',
        note: input.note ?? null,
        welcomeBonusAmount:
          input.welcomeBonusAmount != null
            ? String(input.welcomeBonusAmount)
            : null,
        ...input,
      };
    },
    deleteBillingMarket: async (id: string) => {
      calls.del.push(id);
      return existing.find((m) => m.id === id);
    },
  };
  const audit: any = { record: async (e: any) => calls.audit.push(e) };
  return { svc: new MarketsService(client, audit), calls };
}

describe('billing markets', () => {
  it('normalises the country, records who changed it and audits the change', async () => {
    const { svc, calls } = build();
    await svc.set(actor, {
      countryCode: 'gh',
      currency: 'USD',
      welcomeBonusEnabled: true,
      welcomeBonusAmount: 1.5,
      reason: 'Opening Ghana',
    });
    expect(calls.set[0]).toMatchObject({
      countryCode: 'GH',
      currency: 'USD',
      welcomeBonusAmount: 1.5,
      updatedBy: 'ops@zapiack.com',
    });
    expect(calls.audit[0]).toMatchObject({
      action: 'markets.set',
      before: null,
      reason: 'Opening Ghana',
    });
  });

  it('shows what a market was before it was changed', async () => {
    const { svc, calls } = build([
      {
        id: 'm1',
        countryCode: 'NG',
        currency: 'NGN',
        welcomeBonusEnabled: true,
        welcomeBonusAmount: '100',
        note: null,
      },
    ]);
    await svc.set(actor, {
      countryCode: 'NG',
      currency: 'NGN',
      welcomeBonusEnabled: false,
      reason: 'Pausing the bonus',
    });
    expect(calls.audit[0].before).toEqual({
      currency: 'NGN',
      welcomeBonusEnabled: true,
      welcomeBonusAmount: '100',
      note: null,
    });
    expect(calls.audit[0].after).toMatchObject({ welcomeBonusEnabled: false });
  });

  it('audits a removed market with what it said', async () => {
    const { svc, calls } = build([
      {
        id: 'm1',
        countryCode: 'GH',
        currency: 'USD',
        welcomeBonusEnabled: true,
        welcomeBonusAmount: '1',
        note: null,
      },
    ]);
    await svc.remove(actor, 'm1', 'Not launching');
    expect(calls.del).toEqual(['m1']);
    expect(calls.audit[0]).toMatchObject({
      action: 'markets.removed',
      before: { countryCode: 'GH' },
    });
  });
});
