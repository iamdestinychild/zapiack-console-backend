import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AdminConfig } from '../../common/config/configuration';

export interface OutboundSms {
  to: string;
  body: string;
}

/**
 * SMS out of the console goes through Zapiack's own sms-core, so the console dogfoods
 * the product. These sends are accounted as internal usage and excluded from customer
 * revenue.
 */
@Injectable()
export class SmsCoreClient {
  private readonly logger = new Logger(SmsCoreClient.name);
  private readonly cfg: AdminConfig['smsCore'];

  constructor(config: ConfigService<{ admin: AdminConfig }, true>) {
    this.cfg = config.get('admin', { infer: true }).smsCore;
  }

  async send(
    message: OutboundSms,
  ): Promise<{ messageId?: string; costNgn?: string }> {
    const response = await fetch(`${this.cfg.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.cfg.apiKey}`,
        // Marks the send as internal so rollups can exclude it from revenue.
        'x-zapiack-internal': 'admin-console',
      },
      body: JSON.stringify({
        to: message.to,
        from: this.cfg.senderId,
        body: message.body,
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `sms-core rejected the send (${response.status}): ${detail.slice(0, 300)}`,
      );
    }

    const parsed = (await response.json()) as { id?: string; cost?: string };
    return { messageId: parsed.id, costNgn: parsed.cost };
  }
}
