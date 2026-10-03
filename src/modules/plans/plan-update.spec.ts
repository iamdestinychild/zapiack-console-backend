import { BadRequestException } from '@nestjs/common';
import type { UpdatePlanDto } from './dto/catalogue.dto';
import { planChanges, type PlanRow } from './plan-update';

const plan: PlanRow = {
  name: 'Starter',
  slug: 'starter',
  description: 'For small senders',
  type: 'SUBSCRIPTION',
  channel: 'EMAIL',
  billingInterval: 'MONTHLY',
  basePrice: { toString: () => '5000.00' },
  overagePrice: { toString: () => '2.50' },
  overageEnabled: true,
  monthlyQuota: 10000,
  dailyQuota: 500,
  maxContacts: 1000,
  isActive: true,
  isPublic: false,
  isFree: false,
};

const edit = (fields: Partial<UpdatePlanDto>) =>
  planChanges(plan, {
    reason: 'because of the test',
    ...fields,
  });

describe('planChanges', () => {
  it('changes only the fields sent, so a price edit cannot flip visibility or the daily cap', () => {
    expect(edit({ basePrice: '6000' })).toEqual({ basePrice: '6000' });
  });

  it('drops values equal to what is stored, comparing prices numerically', () => {
    expect(edit({ basePrice: '5000', name: 'Starter' })).toEqual({});
    expect(edit({ overagePrice: '2.5' })).toEqual({});
  });

  it('keeps the daily cap when omitted and clears it on an explicit null', () => {
    expect(edit({ name: 'Starter 2' })).not.toHaveProperty('dailyQuota');
    expect(edit({ dailyQuota: null as unknown as string })).toEqual({
      dailyQuota: null,
    });
  });

  it('converts quotas to numbers', () => {
    expect(edit({ monthlyQuota: '20000', maxContacts: '2500' })).toEqual({
      monthlyQuota: 20000,
      maxContacts: 2500,
    });
  });

  it('refuses to make a retired plan public', () => {
    expect(() =>
      planChanges(
        { ...plan, isActive: false },
        {
          reason: 'because of the test',
          isPublic: true,
        },
      ),
    ).toThrow(BadRequestException);
  });

  it('refuses a free plan with a price, and a price on a free plan', () => {
    expect(() => edit({ isFree: true })).toThrow(/base price of 0/);
    expect(() =>
      planChanges(
        { ...plan, isFree: true, basePrice: { toString: () => '0' } },
        {
          reason: 'because of the test',
          basePrice: '100',
        },
      ),
    ).toThrow(BadRequestException);
    expect(edit({ isFree: true, basePrice: '0' })).toEqual({
      isFree: true,
      basePrice: '0',
    });
  });
});
