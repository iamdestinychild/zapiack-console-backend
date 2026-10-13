import { CustomerActionsService } from './customer-actions.service';

function setup(cacheWorks = true) {
  const writer = {
    write: {
      accounts: {
        update: jest.fn(({ data }: { data: { accountStatus: string } }) =>
          Promise.resolve({ id: 'acc1', accountStatus: data.accountStatus }),
        ),
      },
      apiKeys: {
        update: jest.fn(({ data }: { data: { isActive: boolean } }) =>
          Promise.resolve({ id: 'key1', isActive: data.isActive }),
        ),
      },
    },
  };
  const zapiack = {
    read: {
      accounts: {
        findUnique: jest.fn(() =>
          Promise.resolve({ id: 'acc1', accountStatus: 'ACTIVE' }),
        ),
        findUniqueOrThrow: jest.fn(() => Promise.resolve({ creditBalance: 0 })),
      },
      apiKeys: {
        findFirst: jest.fn(() =>
          Promise.resolve({
            id: 'key1',
            keyPrefix: 'zpk_abc',
            isActive: true,
            isDeleted: false,
          }),
        ),
      },
    },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const productCache = {
    invalidateAccountStatus: jest.fn(() => Promise.resolve(cacheWorks)),
    invalidateApiKey: jest.fn(() => Promise.resolve(cacheWorks)),
  };
  const service = new CustomerActionsService(
    {} as never,
    writer as never,
    zapiack as never,
    {} as never,
    audit as never,
    productCache as never,
  );
  return { service, writer, audit, productCache };
}

const staff = { id: 's1', email: 's@z.com' } as never;

describe('account status changes reach the customer app straight away', () => {
  it('clears the cached status after suspending, so the account stops sending now, not within the hour', async () => {
    const { service, writer, productCache } = setup();
    const res = await service.suspend(
      staff,
      'acc1',
      'Abuse reported by networks',
    );
    expect(writer.write.accounts.update).toHaveBeenCalled();
    expect(productCache.invalidateAccountStatus).toHaveBeenCalledWith('acc1');
    expect(res).toMatchObject({ status: 'SUSPENDED', immediate: true });
  });

  it('says so when the cache could not be cleared, rather than promising it took effect', async () => {
    const { service, audit } = setup(false);
    const res = await service.suspend(
      staff,
      'acc1',
      'Abuse reported by networks',
    );
    expect(res.immediate).toBe(false);
    expect(
      (audit.record.mock.calls[0] as [{ metadata: { immediate: boolean } }])[0]
        .metadata.immediate,
    ).toBe(false);
  });
});

describe('disabling an API key', () => {
  it('clears the key’s cache entry, by prefix, so a leaked key stops working now', async () => {
    const { service, productCache } = setup();
    const res = await service.setApiKeyActive(
      staff,
      'acc1',
      'key1',
      false,
      'Key was leaked in a repo',
    );
    expect(productCache.invalidateApiKey).toHaveBeenCalledWith('zpk_abc');
    expect(res).toMatchObject({ isActive: false, immediate: true });
  });

  it('reports when it could not be cleared', async () => {
    const { service } = setup(false);
    const res = await service.setApiKeyActive(
      staff,
      'acc1',
      'key1',
      false,
      'Key was leaked in a repo',
    );
    expect(res.immediate).toBe(false);
  });
});
