import { CustomerNames } from './customer-names';

function build() {
  const findMany = jest.fn(() =>
    Promise.resolve([
      {
        id: 'p1',
        account: {
          owner: { displayName: 'Ada' },
          senderIdApplications: [{ businessName: 'Kora Logistics' }],
        },
      },
      {
        id: 'p2',
        account: { owner: { displayName: 'Tali' }, senderIdApplications: [] },
      },
    ]),
  );
  const names = new CustomerNames({
    read: { projects: { findMany } },
  } as never);
  return { names, findMany };
}

describe('CustomerNames', () => {
  it('prefers the business name, then the owner, and skips unknown projects', async () => {
    const { names } = build();
    const result = await names.resolve(['p1', 'p2', 'p3', null]);
    expect(result.get('p1')).toBe('Kora Logistics');
    expect(result.get('p2')).toBe('Tali');
    expect(result.has('p3')).toBe(false);
  });

  it('looks each project up once, misses included', async () => {
    const { names, findMany } = build();
    await names.resolve(['p1', 'p3']);
    await names.resolve(['p1', 'p3']);
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
