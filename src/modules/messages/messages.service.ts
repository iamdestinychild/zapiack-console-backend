import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/zapiack/client';
import { ZapiackPrismaService } from '../../common/prisma/zapiack-prisma.service';
import { maskEmail, maskPhone } from '../../common/http/masking';
import {
  buildPage,
  cursorWhere,
  decodeCursor,
} from '../../common/http/pagination';
import { resolveRange } from '../../common/time/lagos';
import { extractLinks, preview } from './message-signals';
import type { ListMessagesDto } from './dto/messages.dto';

const maskRecipient = (channel: string, value: string) =>
  (channel === 'EMAIL' ? maskEmail(value) : maskPhone(value)) ?? '***';

/**
 * What customers actually send, so a template that is only a shell ({{heading}},
 * {{#each paragraphs}}) can still be judged by what goes through it.
 *
 * Reads log_events, which api-core writes for every SMS and email accepted, and joins an
 * email's rendered body from mail_events. Recipients stay masked: a reviewer needs the
 * words and the links, not who received them.
 */
@Injectable()
export class MessagesService {
  constructor(private readonly zapiack: ZapiackPrismaService) {}

  async list(query: ListMessagesDto) {
    const limit = query.limit ?? 50;
    const { start, end } = resolveRange(query.from, query.to, 7);
    const q = query.q?.trim();

    const where: Prisma.LogEventWhereInput = {
      createdAt: { gte: start, lte: end },
      ...(query.channel && { channel: query.channel }),
      ...(query.accountId && { accountId: query.accountId }),
      ...(query.projectId && { projectId: query.projectId }),
      ...(query.status && { status: query.status as never }),
      ...(query.templateId && {
        metadata: { path: ['templateId'], equals: query.templateId },
      }),
      ...(q && { content: { contains: q, mode: 'insensitive' } }),
      ...cursorWhere(decodeCursor(query.cursor)),
    };

    const rows = await this.zapiack.read.logEvent.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        accountId: true,
        projectId: true,
        channel: true,
        status: true,
        recipient: true,
        content: true,
        senderId: true,
        countryCode: true,
        createdAt: true,
        metadata: true,
      },
    });

    const page = buildPage(rows, limit);
    return {
      ...page,
      data: page.data.map((row) => ({
        id: row.id,
        channel: row.channel,
        status: row.status,
        accountId: row.accountId,
        projectId: row.projectId,
        recipient: maskRecipient(row.channel, row.recipient),
        sender:
          row.senderId ??
          (row.metadata as { from?: string } | null)?.from ??
          null,
        countryCode: row.countryCode,
        templateId:
          (row.metadata as { templateId?: string } | null)?.templateId ?? null,
        templateName:
          (row.metadata as { templateName?: string } | null)?.templateName ??
          null,
        preview: preview(row.content),
        hasLinks: extractLinks(row.content).length > 0,
        createdAt: row.createdAt,
      })),
    };
  }

  /** The whole message as it was sent, with its links pulled out. */
  async get(id: string) {
    const log = await this.zapiack.read.logEvent.findUnique({
      where: { id },
      select: {
        id: true,
        accountId: true,
        projectId: true,
        channel: true,
        status: true,
        recipient: true,
        content: true,
        senderId: true,
        countryCode: true,
        operator: true,
        error: true,
        requestId: true,
        metadata: true,
        createdAt: true,
      },
    });
    if (!log) throw new NotFoundException('Message not found');

    const base = {
      id: log.id,
      channel: log.channel,
      status: log.status,
      accountId: log.accountId,
      projectId: log.projectId,
      recipient: maskRecipient(log.channel, log.recipient),
      countryCode: log.countryCode,
      operator: log.operator,
      error: log.error,
      createdAt: log.createdAt,
    };

    if (log.channel !== 'EMAIL') {
      return {
        ...base,
        sender: log.senderId,
        subject: null,
        text: log.content,
        html: null,
        variables: null,
        template: null,
        links: extractLinks(log.content),
      };
    }

    // An email's log row keeps only the subject; the rendered body is on the MailEvent
    // that shares its id. The body is cleared after RETENTION_EMAIL_BODY_DAYS.
    const mail = await this.zapiack.read.mailEvent.findUnique({
      where: { id: log.requestId },
      select: {
        from: true,
        replyTo: true,
        subject: true,
        text: true,
        html: true,
        variables: true,
        templateId: true,
      },
    });
    const template = mail?.templateId
      ? await this.zapiack.read.templates.findUnique({
          where: { id: mail.templateId },
          select: { id: true, name: true, verificationStatus: true },
        })
      : null;

    return {
      ...base,
      sender: mail?.from ?? null,
      replyTo: mail?.replyTo ?? null,
      subject: mail?.subject ?? log.content,
      text: mail?.text ?? null,
      html: mail?.html ?? null,
      bodyCleared: !mail || (mail.html === null && mail.text === null),
      variables: mail?.variables ?? null,
      template: template && {
        id: template.id,
        name: template.name,
        status: template.verificationStatus,
      },
      links: extractLinks(mail?.text, mail?.html, mail?.subject),
    };
  }
}
