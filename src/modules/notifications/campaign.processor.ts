import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { MailerService } from '../../integrations/mailer/mailer.service';
import { SmsCoreClient } from '../../integrations/sms/sms-core.client';
import { JOBS, QUEUES, type CampaignJobData } from '../jobs/queues';
import { CampaignsService } from './campaigns.service';
import {
  InAppDeliveryService,
  type InAppRecipient,
} from './in-app-delivery.service';

const BATCH_SIZE = 200;

/**
 * Sends a campaign. Delivery is tracked per recipient, and campaign sends are
 * accounted as internal usage — they must never show up as customer revenue.
 */
@Processor(QUEUES.campaigns, { concurrency: 1 })
export class CampaignProcessor extends WorkerHost {
  private readonly logger = new Logger(CampaignProcessor.name);

  constructor(
    private readonly admin: AdminPrismaService,
    private readonly campaigns: CampaignsService,
    private readonly inApp: InAppDeliveryService,
    private readonly mailer: MailerService,
    private readonly sms: SmsCoreClient,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    if (job.name !== JOBS.sendCampaign) return null;

    const { campaignId, retry } = job.data as CampaignJobData;
    const campaign = await this.admin.campaign.findUnique({
      where: { id: campaignId },
    });
    if (!campaign) return { skipped: 'campaign deleted' };

    if (campaign.status === 'CANCELLED') return { skipped: 'cancelled' };
    if (campaign.status === 'SENT') return { skipped: 'already sent' };
    if (campaign.requiresApproval && !campaign.approvedAt) {
      this.logger.warn(
        `Campaign ${campaignId} reached the worker without approval; refusing`,
      );
      await this.admin.campaign.update({
        where: { id: campaignId },
        data: { status: 'PENDING_APPROVAL' },
      });
      return { skipped: 'not approved' };
    }

    await this.admin.campaign.update({
      where: { id: campaignId },
      data: { status: 'SENDING', startedAt: new Date() },
    });

    // A retry re-sends to who failed. Re-resolving the audience would also pick up
    // accounts created since, who were never part of this campaign.
    if (!retry) await this.campaigns.materialiseRecipients(campaignId);

    // Live contact details are re-read at send time rather than stored on the
    // recipient row, so the campaign table never becomes a copy of the customer list.
    const contacts = new Map(
      (await this.campaigns.resolveRecipients(campaign)).map((r) => [
        r.accountId,
        r,
      ]),
    );

    for (;;) {
      const batch = await this.admin.campaignRecipient.findMany({
        where: { campaignId, status: 'PENDING' },
        take: BATCH_SIZE,
      });
      if (!batch.length) break;

      if (campaign.channel === 'IN_APP') {
        const idByAccount = new Map(batch.map((r) => [r.accountId, r.id]));
        const deliverable: InAppRecipient[] = [];
        const gone: string[] = [];

        for (const r of batch) {
          const contact = contacts.get(r.accountId);
          if (!contact) {
            gone.push(r.id);
            continue;
          }
          const variables = {
            account: {
              businessName: contact.businessName ?? '',
              id: r.accountId,
            },
          };
          deliverable.push({
            accountId: r.accountId,
            userId: contact.userId,
            title: this.campaigns.render(
              campaign.subject ?? campaign.name,
              variables,
            ),
            body: this.campaigns.render(campaign.body, variables),
          });
        }

        if (gone.length) {
          await this.admin.campaignRecipient.updateMany({
            where: { id: { in: gone } },
            data: {
              status: 'FAILED',
              failureReason:
                'The account no longer exists or no longer matches',
            },
          });
        }

        if (deliverable.length) {
          const ids = deliverable.map((r) => idByAccount.get(r.accountId)!);
          try {
            await this.inApp.deliver({ campaignId, recipients: deliverable });
            await this.admin.campaignRecipient.updateMany({
              where: { id: { in: ids } },
              data: { status: 'SENT', sentAt: new Date() },
            });
          } catch (err) {
            this.logger.error(
              `Campaign ${campaignId}: in-app batch of ${ids.length} failed: ${(err as Error).message}`,
            );
            await this.admin.campaignRecipient.updateMany({
              where: { id: { in: ids } },
              data: {
                status: 'FAILED',
                failureReason: (err as Error).message.slice(0, 300),
              },
            });
          }
        }
        continue;
      }

      for (const recipient of batch) {
        const contact = contacts.get(recipient.accountId);
        const variables = {
          account: {
            businessName: contact?.businessName ?? '',
            id: recipient.accountId,
          },
        };

        try {
          if (campaign.channel === 'EMAIL') {
            if (!contact?.email) throw new Error('No email address on file');
            await this.mailer.send({
              to: contact.email,
              subject: this.campaigns.render(
                campaign.subject ?? campaign.name,
                variables,
              ),
              html: this.campaigns.render(campaign.body, variables),
            });
          } else {
            if (!contact?.phone) throw new Error('No phone number on file');
            await this.sms.send({
              to: contact.phone,
              body: this.campaigns.render(campaign.body, variables),
            });
          }

          await this.admin.campaignRecipient.update({
            where: { id: recipient.id },
            data: { status: 'SENT', sentAt: new Date() },
          });
        } catch (err) {
          // One bad address must not sink the campaign.
          await this.admin.campaignRecipient.update({
            where: { id: recipient.id },
            data: {
              status: 'FAILED',
              failureReason: (err as Error).message.slice(0, 300),
            },
          });
        }
      }
    }

    // The recipients are the record. Counting them, not this run's tally, is what keeps
    // the totals right after a retry, and lets a campaign that reached nobody say so.
    const [sentTotal, failedTotal] = await Promise.all([
      this.admin.campaignRecipient.count({
        where: { campaignId, status: 'SENT' },
      }),
      this.admin.campaignRecipient.count({
        where: { campaignId, status: 'FAILED' },
      }),
    ]);

    await this.admin.campaign.update({
      where: { id: campaignId },
      data: {
        // Nothing delivered is a failure, however cleanly the worker finished.
        status: sentTotal === 0 && failedTotal > 0 ? 'FAILED' : 'SENT',
        completedAt: new Date(),
        sentCount: sentTotal,
        failedCount: failedTotal,
      },
    });

    this.logger.log(
      `Campaign ${campaignId} finished: ${sentTotal} sent, ${failedTotal} failed`,
    );
    return { sent: sentTotal, failed: failedTotal };
  }
}
