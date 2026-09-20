import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { ApiCoreClient } from '../../integrations/api-core/api-core.client';
import { MailerService } from '../../integrations/mailer/mailer.service';
import { SmsCoreClient } from '../../integrations/sms/sms-core.client';
import { JOBS, QUEUES, type CampaignJobData } from '../jobs/queues';
import { CampaignsService } from './campaigns.service';

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
    private readonly apiCore: ApiCoreClient,
    private readonly mailer: MailerService,
    private readonly sms: SmsCoreClient,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    if (job.name !== JOBS.sendCampaign) return null;

    const { campaignId } = job.data as CampaignJobData;
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

    await this.campaigns.materialiseRecipients(campaignId);

    // Live contact details are re-read at send time rather than stored on the
    // recipient row, so the campaign table never becomes a copy of the customer list.
    const contacts = new Map(
      (await this.campaigns.resolveRecipients(campaign)).map((r) => [
        r.accountId,
        r,
      ]),
    );

    let sent = 0;
    let failed = 0;

    for (;;) {
      const batch = await this.admin.campaignRecipient.findMany({
        where: { campaignId, status: 'PENDING' },
        take: BATCH_SIZE,
      });
      if (!batch.length) break;

      if (campaign.channel === 'IN_APP') {
        // In-app notifications are customer inbox rows, which api-core owns.
        try {
          await this.apiCore.createInAppNotifications(
            {
              accountIds: batch.map((r) => r.accountId),
              title: campaign.subject ?? campaign.name,
              body: campaign.body,
              campaignId,
            },
            { actorId: campaign.createdById, actorEmail: 'campaign-worker' },
          );
          await this.admin.campaignRecipient.updateMany({
            where: { id: { in: batch.map((r) => r.id) } },
            data: { status: 'SENT', sentAt: new Date() },
          });
          sent += batch.length;
        } catch (err) {
          await this.admin.campaignRecipient.updateMany({
            where: { id: { in: batch.map((r) => r.id) } },
            data: {
              status: 'FAILED',
              failureReason: (err as Error).message.slice(0, 300),
            },
          });
          failed += batch.length;
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
          sent += 1;
        } catch (err) {
          // One bad address must not sink the campaign.
          await this.admin.campaignRecipient.update({
            where: { id: recipient.id },
            data: {
              status: 'FAILED',
              failureReason: (err as Error).message.slice(0, 300),
            },
          });
          failed += 1;
        }
      }
    }

    await this.admin.campaign.update({
      where: { id: campaignId },
      data: {
        status: 'SENT',
        completedAt: new Date(),
        sentCount: sent,
        failedCount: failed,
      },
    });

    this.logger.log(
      `Campaign ${campaignId} finished: ${sent} sent, ${failed} failed`,
    );
    return { sent, failed };
  }
}
