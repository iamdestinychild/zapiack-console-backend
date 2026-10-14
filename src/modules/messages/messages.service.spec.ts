import { NotFoundException } from '@nestjs/common';
import type { ZapiackPrismaService } from '../../common/prisma/zapiack-prisma.service';
import { ListMessagesDto } from './dto/messages.dto';
import { MessagesService } from './messages.service';

const sms = {
  id: 'l1',
  accountId: 'a1',
  projectId: 'p1',
  channel: 'SMS',
  status: 'DELIVERED',
  recipient: '+2348031234567',
  content: 'Your code is 1234. Pay at http://bit.ly/x',
  senderId: 'ACME',
  countryCode: 'NG',
  operator: 'MTN',
  error: null,
  requestId: 'r1',
  metadata: null,
  createdAt: new Date('2026-10-14T10:00:00Z'),
};
const email = {
  ...sms,
  id: 'l2',
  channel: 'EMAIL',
  recipient: 'jane.doe@example.com',
  content: 'Welcome',
  senderId: null,
  requestId: 'm1',
  metadata: { templateId: 't1', templateName: 'Shell', from: 'hi@acme.test' },
};

type Row = Omit<typeof sms, 'senderId' | 'metadata'> & {
  senderId: string | null;
  metadata: Record<string, unknown> | null;
};
type FindManyArgs = {
  where: Record<string, unknown>;
  take: number;
};

function service(opts: { logs?: Row[]; mail?: unknown } = {}) {
  const calls: FindManyArgs[] = [];
  const zapiack = {
    read: {
      logEvent: {
        findMany: jest.fn((args: FindManyArgs) => {
          calls.push(args);
          return Promise.resolve(opts.logs ?? []);
        }),
        findUnique: jest.fn(({ where }: { where: { id: string } }) =>
          Promise.resolve([sms, email].find((r) => r.id === where.id) ?? null),
        ),
      },
      mailEvent: {
        findUnique: jest.fn(() => Promise.resolve(opts.mail ?? null)),
      },
      templates: {
        findUnique: jest.fn(() =>
          Promise.resolve({
            id: 't1',
            name: 'Shell',
            verificationStatus: 'APPROVED',
          }),
        ),
      },
    },
  };
  return {
    svc: new MessagesService(zapiack as unknown as ZapiackPrismaService),
    calls,
  };
}

describe('listing messages', () => {
  it('masks the recipient, shows a preview, and says whether there are links', async () => {
    const { svc } = service({ logs: [sms, email] });
    const page = await svc.list(new ListMessagesDto());
    expect(page.data[0]).toMatchObject({
      recipient: '***********567',
      hasLinks: true,
      templateId: null,
    });
    expect(page.data[1]).toMatchObject({
      recipient: 'ja******@example.com',
      templateName: 'Shell',
      sender: 'hi@acme.test',
      hasLinks: false,
    });
    expect(JSON.stringify(page)).not.toContain('2348031234567');
  });

  it('filters by channel, account, template and words', async () => {
    const { svc, calls } = service();
    await svc.list(
      Object.assign(new ListMessagesDto(), {
        channel: 'EMAIL',
        accountId: 'a1',
        templateId: 't1',
        q: 'otp',
      }),
    );
    expect(calls[0].where).toMatchObject({
      channel: 'EMAIL',
      accountId: 'a1',
      metadata: { path: ['templateId'], equals: 't1' },
      content: { contains: 'otp', mode: 'insensitive' },
    });
  });

  it('pages: asks for one extra row to know there is more', async () => {
    const { svc, calls } = service({
      logs: [sms, { ...sms, id: 'l9' }, { ...sms, id: 'l8' }],
    });
    const page = await svc.list({ limit: 2 });
    expect(calls[0].take).toBe(3);
    expect(page.hasMore).toBe(true);
    expect(page.data).toHaveLength(2);
  });
});

describe('opening one message', () => {
  it('gives an SMS in full with its links', async () => {
    const { svc } = service();
    expect(await svc.get('l1')).toMatchObject({
      text: sms.content,
      sender: 'ACME',
      links: [{ host: 'bit.ly', shortener: true }],
    });
  });

  it('gives an email as it was rendered, with the variables that filled the template', async () => {
    const { svc } = service({
      mail: {
        from: 'hi@acme.test',
        replyTo: null,
        subject: 'Verify your account',
        text: 'Log in at https://acme-bank.example',
        html: '<p>hi</p>',
        variables: { heading: 'Verify' },
        templateId: 't1',
      },
    });
    expect(await svc.get('l2')).toMatchObject({
      subject: 'Verify your account',
      html: '<p>hi</p>',
      variables: { heading: 'Verify' },
      template: { name: 'Shell', status: 'APPROVED' },
      bodyCleared: false,
      links: [{ host: 'acme-bank.example' }],
    });
  });

  it('says so when the body has been cleared by retention, and falls back to the subject', async () => {
    const { svc } = service({
      mail: {
        from: 'hi@acme.test',
        replyTo: null,
        subject: 'Verify',
        text: null,
        html: null,
        variables: null,
        templateId: null,
      },
    });
    expect(await svc.get('l2')).toMatchObject({
      bodyCleared: true,
      template: null,
    });
  });

  it('refuses an unknown id', async () => {
    await expect(service().svc.get('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
