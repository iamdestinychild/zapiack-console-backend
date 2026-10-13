import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SegmentFilterDto } from './dto/notifications.dto';
import { SegmentsService } from './segments.service';

async function errorsFor(filter: Record<string, unknown>) {
  const errors = await validate(plainToInstance(SegmentFilterDto, filter));
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
}

describe('SegmentFilterDto', () => {
  it('accepts every real filter, and an empty one meaning everyone', async () => {
    expect(await errorsFor({})).toEqual([]);
    expect(
      await errorsFor({
        statuses: ['ACTIVE', 'PAST_DUE'],
        countries: ['NG'],
        creditsBelow: 50,
        inactiveForDays: 30,
        usedChannel: 'SMS',
        emailVerified: true,
        planIds: ['p1'],
      }),
    ).toEqual([]);
  });

  it('keeps accepting the old balanceBelowNgn name', async () => {
    expect(await errorsFor({ balanceBelowNgn: 100 })).toEqual([]);
  });

  it('refuses a status the product does not have', async () => {
    expect((await errorsFor({ statuses: ['CLOSED'] })).join()).toMatch(
      /must be one of/,
    );
  });

  it('refuses KYC with an explanation instead of quietly sending to everyone', async () => {
    expect((await errorsFor({ kycVerified: true })).join()).toMatch(
      /does not record KYC/,
    );
  });
});

describe('SegmentsService filter -> product query', () => {
  function whereFor(filter: Record<string, unknown>) {
    let where: unknown;
    const zapiack = {
      read: {
        accounts: {
          count: jest.fn((args: { where: unknown }) => {
            where = args.where;
            return Promise.resolve(0);
          }),
        },
      },
    };
    const service = new SegmentsService(
      {} as never,
      zapiack as never,
      {} as never,
    );
    return service.count(filter as never).then(() => where);
  }

  it('is an empty query for everyone', async () => {
    expect(await whereFor({})).toEqual({});
  });

  it('uses the product’s real columns', async () => {
    expect(await whereFor({ statuses: ['ACTIVE'], countries: ['ng'] })).toEqual(
      {
        AND: [
          { accountStatus: { in: ['ACTIVE'] } },
          { countryCode: { in: ['NG'] } },
        ],
      },
    );
  });

  it('matches subscriptions by their real, upper-case status', async () => {
    expect(await whereFor({ planIds: ['p1'] })).toEqual({
      AND: [
        {
          subscriptions: { some: { planId: { in: ['p1'] }, status: 'ACTIVE' } },
        },
      ],
    });
  });

  it('reads the credit balance, preferring the new name over the old alias', async () => {
    expect(await whereFor({ creditsBelow: 5, balanceBelowNgn: 99 })).toEqual({
      AND: [{ creditBalance: { lt: 5 } }],
    });
    expect(await whereFor({ balanceBelowNgn: 99 })).toEqual({
      AND: [{ creditBalance: { lt: 99 } }],
    });
  });

  it('turns channel use and inactivity into log-event conditions', async () => {
    const where = (await whereFor({
      usedChannel: 'EMAIL',
      inactiveForDays: 7,
    })) as {
      AND: Record<string, unknown>[];
    };
    expect(where.AND[0]).toEqual({ logEvents: { some: { channel: 'EMAIL' } } });
    expect(where.AND[1]).toHaveProperty('logEvents.none.createdAt.gte');
  });
});
