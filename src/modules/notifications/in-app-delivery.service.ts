import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../common/redis/redis.service';
import { ZapiackPrismaService } from '../../common/prisma/zapiack-prisma.service';
import { ZapiackWriteService } from '../../common/prisma/zapiack-write.service';

/** The channel the customer app's api-core listens on to refresh an open bell. */
export const ACCOUNT_EVENTS_CHANNEL = 'account-events';

export interface InAppRecipient {
  accountId: string;
  userId: string;
  title: string;
  body: string;
}

export interface InAppDelivery {
  campaignId: string;
  recipients: InAppRecipient[];
  /** Icon and colour in the bell: INFO | PENDING | SUCCESS | ERROR. */
  severity?: string;
  /** Dashboard path the notification opens; omit for a row that is not clickable. */
  actionUrl?: string;
}

/**
 * Puts a notification in each customer's bell.
 *
 * A notification is a row in the product's `user_notifications`, owned by the user who
 * owns the account. The customer app reads it from there, and learns of a new one when
 * something publishes `notification.created` for that user, which is how the bell
 * updates without a refresh. admin-core does both itself: the row through the narrow
 * write role (INSERT on this one table), the nudge straight onto Redis. Redis channels
 * belong to the server, not a database, so the message reaches the main app although
 * admin-core's keys live in a different database.
 *
 * Safe to run again for the same campaign: a user who already has this campaign's
 * notification is skipped, so a retry after a half-finished batch never doubles up.
 */
@Injectable()
export class InAppDeliveryService {
  private readonly logger = new Logger(InAppDeliveryService.name);

  constructor(
    private readonly zapiack: ZapiackPrismaService,
    private readonly writer: ZapiackWriteService,
    private readonly redis: RedisService,
  ) {}

  /** Throws if the rows could not be written; the nudge is best effort and never does. */
  async deliver(
    input: InAppDelivery,
  ): Promise<{ created: number; skipped: number }> {
    const { campaignId, recipients } = input;
    if (!recipients.length) return { created: 0, skipped: 0 };

    const userIds = recipients.map((r) => r.userId);
    const already = await this.zapiack.read.userNotifications.findMany({
      where: {
        userId: { in: userIds },
        metadata: { path: ['campaignId'], equals: campaignId },
      },
      select: { userId: true },
    });
    const done = new Set(already.map((n) => n.userId));
    const fresh = recipients.filter((r) => !done.has(r.userId));

    if (fresh.length) {
      // One statement per batch: all of it lands or none of it does, so a failure
      // leaves nothing half-written for the retry to trip over.
      await this.writer.write.userNotifications.createMany({
        data: fresh.map((r) => ({
          userId: r.userId,
          accountId: r.accountId,
          // Announcements from the team. The customer app groups and icons by this.
          type: 'NEWS',
          severity: input.severity ?? 'INFO',
          title: r.title,
          body: r.body,
          actionUrl: input.actionUrl ?? null,
          metadata: { campaignId, source: 'admin-console' },
        })),
      });
      await this.nudge(fresh.map((r) => r.userId));
    }

    return { created: fresh.length, skipped: recipients.length - fresh.length };
  }

  /**
   * Tells the customer app a notification exists. If this fails the row is already
   * saved, so the customer sees it on their next load instead of instantly.
   */
  private async nudge(userIds: string[]): Promise<void> {
    try {
      const pipeline = this.redis.client.pipeline();
      for (const userId of userIds) {
        pipeline.publish(
          ACCOUNT_EVENTS_CHANNEL,
          JSON.stringify({ userId, type: 'notification.created' }),
        );
      }
      await pipeline.exec();
    } catch (err) {
      this.logger.warn(
        `Saved ${userIds.length} notification(s) but could not push the live update: ${(err as Error).message}`,
      );
    }
  }
}
