import { reconciliationKindInfo } from './reconciliation-kinds';

describe('reconciliationKindInfo', () => {
  it('describes the payments check for what it does, and not as a Paystack check', () => {
    const info = reconciliationKindInfo('PAYSTACK_SETTLEMENT');
    expect(info.label).toBe('Payments check');
    expect(info.label).not.toMatch(/paystack|settlement/i);
    expect(info.description).toMatch(/does not check Paystack or your bank/);
  });

  it('says plainly that the provider invoice check is not running', () => {
    expect(reconciliationKindInfo('PROVIDER_INVOICE').description).toMatch(
      /Not running yet/,
    );
  });

  it('falls back to a readable name for a kind it does not know', () => {
    expect(reconciliationKindInfo('SOMETHING_NEW')).toEqual({
      label: 'something new',
      description: '',
    });
  });
});
