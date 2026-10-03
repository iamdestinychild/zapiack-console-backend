import { FORBIDDEN_WRITE_MODELS, isLedgerWrite } from './zapiack-write.service';

/**
 * This guard once passed review while doing nothing: Prisma reports the model to an
 * extension as it was declared (`TabTransaction`), and the set was written in
 * camelCase, so nothing ever matched and every ledger write was allowed through.
 */
describe('ledger write guard', () => {
  it('refuses mutations of the credit ledger, whatever the case', () => {
    for (const model of [
      'TabTransaction',
      'tabTransaction',
      'TABTRANSACTION',
    ]) {
      expect(isLedgerWrite('create', model)).toBe(true);
      expect(isLedgerWrite('updateMany', model)).toBe(true);
      expect(isLedgerWrite('delete', model)).toBe(true);
    }
    expect(isLedgerWrite('update', 'Transactions')).toBe(true);
  });

  it('leaves reads of the ledger alone', () => {
    expect(isLedgerWrite('findMany', 'TabTransaction')).toBe(false);
    expect(isLedgerWrite('aggregate', 'Transactions')).toBe(false);
    expect(isLedgerWrite('groupBy', 'TabTransaction')).toBe(false);
  });

  it('allows the tables this connection exists to write', () => {
    for (const model of [
      'Products',
      'ProductPricing',
      'Plans',
      'Accounts',
      'ApiKeys',
    ]) {
      expect(isLedgerWrite('update', model)).toBe(false);
      expect(isLedgerWrite('create', model)).toBe(false);
    }
  });

  it('names both ledger tables', () => {
    expect([...FORBIDDEN_WRITE_MODELS].sort()).toEqual([
      'tabtransaction',
      'transactions',
    ]);
  });
});
