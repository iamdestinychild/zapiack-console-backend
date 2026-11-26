import { ConflictException } from '@nestjs/common';
import { allowedListingActions, MarketplaceReviewService } from './marketplace.service';

const listing = (status: string) => ({ id: 'l1', slug: 'rainy-day', channel: 'push', title: 'Rainy day', description: 'd', category: 'E-commerce', status, rejectionReason: null, authorName: 'BillsJet', projectId: 'p1', accountId: 'a1', sourceId: 't1', content: {}, sample: {}, submittedBy: 'u1', reviewedBy: null, reviewedAt: null, createdAt: '', updatedAt: '' });
const staff = { id: 's1', email: 'reviewer@zapiack.com' } as never;

function setup(status: string) {
  const client = {
    marketplaceQueue: jest.fn(async (s: string) => (s === status ? [listing(status)] : [])),
    marketplaceListing: jest.fn(async () => listing(status)),
    decideMarketplace: jest.fn(async (_id: string, _who: string, input: { approve: boolean }) => ({ ...listing(input.approve ? 'approved' : 'rejected'), rejectionReason: input.approve ? null : 'bad' })),
  };
  const audit = { record: jest.fn(async () => undefined) };
  return { client, audit, service: new MarketplaceReviewService(client as never, audit as never) };
}

describe('marketplace review', () => {
  it('offers approve and reject while waiting, take down once live, nothing after', () => {
    expect(allowedListingActions('pending')).toEqual(['approve', 'reject']);
    expect(allowedListingActions('approved')).toEqual(['take_down']);
    expect(allowedListingActions('rejected')).toEqual([]);
    expect(allowedListingActions('withdrawn')).toEqual([]);
  });

  it('counts every status for the tabs and lists the one asked for', async () => {
    const { service } = setup('pending');
    const out = await service.list('pending');
    expect(out.counts).toEqual({ pending: 1, approved: 0, rejected: 0, withdrawn: 0 });
    expect(out.data[0]).toMatchObject({ id: 'l1', actions: ['approve', 'reject'] });
  });

  it('approves through api-core as the console, and audits who and why', async () => {
    const { service, client, audit } = setup('pending');
    await service.decide(staff, 'l1', 'approve', 'Looks good and works');
    expect(client.decideMarketplace).toHaveBeenCalledWith('l1', 'console:s1', { approve: true, reason: undefined });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'marketplace.approve', targetType: 'marketplace_listing', targetId: 'l1', reason: 'Looks good and works', before: { status: 'pending' }, after: { status: 'approved' } }));
  });

  it('sends the reason to the customer on a take-down, and refuses a decision the status does not allow', async () => {
    const live = setup('approved');
    await live.service.decide(staff, 'l1', 'take_down', 'Uses another brand name');
    expect(live.client.decideMarketplace).toHaveBeenCalledWith('l1', 'console:s1', { approve: false, reason: 'Uses another brand name' });
    await expect(live.service.decide(staff, 'l1', 'approve', 'Approve it again')).rejects.toBeInstanceOf(ConflictException);
    expect(live.client.decideMarketplace).toHaveBeenCalledTimes(1);
  });
});

describe('marketplace catalogue', () => {
  const row = { key: 'push:streak-countdown', slug: 'streak-countdown', channel: 'push', kind: 'template', title: 'Streak countdown', category: 'Education', source: 'zapiack', authorName: 'Zapiack', hidden: false, featured: false, copies: 12, rating: { average: 4.8, count: 3 } };
  const change = { key: 'push:streak-countdown', before: { hidden: false, featured: false }, after: { hidden: true, featured: false } };

  function catalogSetup() {
    const client = {
      marketplaceCatalog: jest.fn(async () => ({ counts: { push: 1 }, data: [row] })),
      setMarketplaceOverride: jest.fn(async () => change),
    };
    const audit = { record: jest.fn(async () => undefined) };
    return { client, audit, service: new MarketplaceReviewService(client as never, audit as never) };
  }

  it('passes the channel and search to api-core and returns every listing it has', async () => {
    const { service, client } = catalogSetup();
    const out = await service.catalog('push', 'streak');
    expect(client.marketplaceCatalog).toHaveBeenCalledWith('push', 'streak');
    expect(out.data[0]).toMatchObject({ source: 'zapiack', copies: 12 });
  });

  it('hides a listing as the console and audits who, why, and what it was before', async () => {
    const { service, client, audit } = catalogSetup();
    await service.setOverride(staff, 'push', 'streak-countdown', { hidden: true }, 'Copy says another company');
    expect(client.setMarketplaceOverride).toHaveBeenCalledWith('push', 'streak-countdown', 'console:s1', { hidden: true });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'marketplace.hide', targetId: 'push:streak-countdown', reason: 'Copy says another company', before: change.before, after: change.after }));
  });

  it('names each change in the audit log: show, feature, unfeature', async () => {
    const { service, audit } = catalogSetup();
    await service.setOverride(staff, 'push', 'streak-countdown', { hidden: false }, 'Fixed now');
    await service.setOverride(staff, 'push', 'streak-countdown', { featured: true }, 'Good example');
    await service.setOverride(staff, 'push', 'streak-countdown', { featured: false }, 'Rotating it out');
    expect((audit.record.mock.calls as unknown as { action: string }[][]).map((c) => c[0].action)).toEqual(['marketplace.show', 'marketplace.feature', 'marketplace.unfeature']);
  });
});
