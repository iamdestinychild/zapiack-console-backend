import { AuditEntry, AuditService } from '../../common/audit/audit.service';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import {
  ApiCoreBillingMarket,
  TemplateReviewClient,
} from '../../integrations/api-core/template-review.client';
import { MarketsService } from './markets.service';

const actor: StaffPrincipal = {
  id: 'staff-1',
  email: 'ops@zapiack.com',
  name: 'Ops Staff',
  roleId: 'role-1',
  roleKey: 'ops',
  permissions: ['pricing.manage'],
  sessionId: 'session-1',
  sessionEpoch: 1,
};

type SetBillingMarketInput = Parameters<
  TemplateReviewClient['setBillingMarket']
>[0];

function build(existing: ApiCoreBillingMarket[] = []) {
  const calls: {
    set: SetBillingMarketInput[];
    del: string[];
    audit: AuditEntry[];
  } = { set: [], del: [], audit: [] };
  const client: Pick<
    TemplateReviewClient,
    'listBillingMarkets' | 'setBillingMarket' | 'deleteBillingMarket'
  > = {
    listBillingMarkets: () => Promise.resolve(existing),
    setBillingMarket: (input) => {
      calls.set.push(input);
      return Promise.resolve({
        id: 'm1',
        countryCode: input.countryCode,
        currency: input.currency,
        welcomeBonusEnabled: input.welcomeBonusEnabled,
        note: input.note ?? null,
        welcomeBonusAmount:
          input.welcomeBonusAmount != null
            ? String(input.welcomeBonusAmount)
            : null,
        updatedBy: input.updatedBy,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      });
    },
    deleteBillingMarket: (id) => {
      calls.del.push(id);
      const row = existing.find((market) => market.id === id);
      if (!row) throw new Error(`Billing market not found: ${id}`);
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
    svc: new MarketsService(
      client as unknown as TemplateReviewClient,
      audit as unknown as AuditService,
    ),
    calls,
  };
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
        updatedBy: 'ops@zapiack.com',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
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
        updatedBy: 'ops@zapiack.com',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
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
