import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import type { AdminConfig } from '../../common/config/configuration';

export interface OutboundEmail {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/** Email out of the console — staff invites, alerts and email campaigns — over SES. */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private readonly client: SESv2Client;
  private readonly cfg: AdminConfig['mail'];

  constructor(config: ConfigService<{ admin: AdminConfig }, true>) {
    this.cfg = config.get('admin', { infer: true }).mail;
    this.client = new SESv2Client({ region: this.cfg.sesRegion });
  }

  async send(email: OutboundEmail): Promise<{ messageId?: string }> {
    const result = await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.cfg.fromAddress,
        ReplyToAddresses: this.cfg.replyTo ? [this.cfg.replyTo] : undefined,
        Destination: { ToAddresses: [email.to] },
        Content: {
          Simple: {
            Subject: { Data: email.subject, Charset: 'UTF-8' },
            Body: {
              Html: { Data: email.html, Charset: 'UTF-8' },
              Text: {
                Data: email.text ?? stripHtml(email.html),
                Charset: 'UTF-8',
              },
            },
          },
        },
      }),
    );
    return { messageId: result.MessageId };
  }

  /** Per-recipient results, so one bad address does not sink a campaign batch. */
  async sendBatch(emails: OutboundEmail[]) {
    return Promise.allSettled(emails.map((email) => this.send(email)));
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
