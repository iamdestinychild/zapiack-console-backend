import { InAppDeliveryService } from './in-app-delivery.service';

/** What a published message says, typed so assertions need no `any`. */
const parse = (m: string) => JSON.parse(m) as { userId: string; type: string };

const recipient = (n: number) => ({
  accountId: `acc${n}`,
  userId: `user${n}`,
  title: `Hi ${n}`,
  body: `Body ${n}`,
});

function setup(
  opts: {
    already?: string[];
    writeFails?: boolean;
    publishFails?: boolean;
  } = {},
) {
  const created: Record<string, unknown>[][] = [];
  const published: string[] = [];
  const zapiack = {
    read: {
      userNotifications: {
        findMany: jest.fn(() =>
          Promise.resolve((opts.already ?? []).map((userId) => ({ userId }))),
        ),
      },
    },
  };
  const writer = {
    write: {
      userNotifications: {
        createMany: jest.fn(({ data }: { data: Record<string, unknown>[] }) => {
          if (opts.writeFails)
            return Promise.reject(new Error('permission denied'));
          created.push(data);
          return Promise.resolve({ count: data.length });
        }),
      },
    },
  };
  const redis = {
    client: {
      pipeline: () => {
        const calls: [string, string][] = [];
        return {
          publish: (channel: string, message: string) =>
            calls.push([channel, message]),
          exec: () => {
            if (opts.publishFails)
              return Promise.reject(new Error('redis down'));
            calls.forEach(([, m]) => published.push(m));
            return Promise.resolve([]);
          },
        };
      },
    },
  };
  const service = new InAppDeliveryService(
    zapiack as never,
    writer as never,
    redis as never,
  );
  return { service, zapiack, writer, created, published };
}

describe('InAppDeliveryService', () => {
  it('writes one notification per user, owned by that user, tagged with the campaign', async () => {
    const { service, created } = setup();
    const res = await service.deliver({
      campaignId: 'c1',
      recipients: [recipient(1), recipient(2)],
    });
    expect(res).toEqual({ created: 2, skipped: 0 });
    expect(created[0]).toHaveLength(2);
    expect(created[0][0]).toMatchObject({
      userId: 'user1',
      accountId: 'acc1',
      type: 'NEWS',
      severity: 'INFO',
      title: 'Hi 1',
      body: 'Body 1',
      actionUrl: null,
      metadata: { campaignId: 'c1', source: 'admin-console' },
    });
  });

  it('tells the customer app about each new notification so the bell updates live', async () => {
    const { service, published } = setup();
    await service.deliver({
      campaignId: 'c1',
      recipients: [recipient(1), recipient(2)],
    });
    expect(published.map(parse)).toEqual([
      { userId: 'user1', type: 'notification.created' },
      { userId: 'user2', type: 'notification.created' },
    ]);
  });

  it('skips users who already have this campaign, so a retry never doubles up', async () => {
    const { service, created, published } = setup({ already: ['user1'] });
    const res = await service.deliver({
      campaignId: 'c1',
      recipients: [recipient(1), recipient(2)],
    });
    expect(res).toEqual({ created: 1, skipped: 1 });
    expect(created[0].map((r) => r.userId)).toEqual(['user2']);
    expect(published.map((m) => parse(m).userId)).toEqual(['user2']);
  });

  it('writes nothing and pushes nothing when everyone already has it', async () => {
    const { service, writer, published } = setup({ already: ['user1'] });
    await service.deliver({ campaignId: 'c1', recipients: [recipient(1)] });
    expect(writer.write.userNotifications.createMany).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  });

  it('does nothing for an empty batch', async () => {
    const { service, zapiack } = setup();
    expect(await service.deliver({ campaignId: 'c1', recipients: [] })).toEqual(
      { created: 0, skipped: 0 },
    );
    expect(zapiack.read.userNotifications.findMany).not.toHaveBeenCalled();
  });

  it('still succeeds when only the live push fails, because the rows are saved', async () => {
    const { service, created } = setup({ publishFails: true });
    await expect(
      service.deliver({ campaignId: 'c1', recipients: [recipient(1)] }),
    ).resolves.toEqual({
      created: 1,
      skipped: 0,
    });
    expect(created).toHaveLength(1);
  });

  it('fails the batch when the rows cannot be written, so the worker records it', async () => {
    const { service, published } = setup({ writeFails: true });
    await expect(
      service.deliver({ campaignId: 'c1', recipients: [recipient(1)] }),
    ).rejects.toThrow('permission denied');
    expect(published).toEqual([]);
  });
});
