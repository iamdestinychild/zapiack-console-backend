import { ZapiackPrismaService } from './zapiack-prisma.service';
import { ZapiackWriteService } from './zapiack-write.service';

const config = (url: string) =>
  ({
    get: () => ({
      database: { zapiackReadUrl: url, zapiackWriteUrl: url, poolMax: 1 },
    }),
  }) as never;

describe('guarded Prisma clients', () => {
  // Nothing here connects: the guard throws before a query is made.
  const url = 'postgresql://u:p@127.0.0.1:1/x';

  it('builds the read client once, not on every access', () => {
    const service = new ZapiackPrismaService(config(url));

    expect(service.read).toBe(service.read);
  });

  it('still refuses a write on the read client', async () => {
    const service = new ZapiackPrismaService(config(url));

    await expect(
      service.read.projects.create({ data: {} as never }),
    ).rejects.toThrow(/Refused create on Projects.*read-only/);
    await expect(
      service.read.accounts.deleteMany({ where: {} }),
    ).rejects.toThrow(/Refused deleteMany/);
  });

  it('builds the write client once, and still keeps the ledger out of it', async () => {
    const service = new ZapiackWriteService(config(url));

    expect(service.write).toBe(service.write);
    await expect(
      service.write.tabTransaction.create({ data: {} as never }),
    ).rejects.toThrow(/Refused create on TabTransaction.*ledger/);
  });
});
