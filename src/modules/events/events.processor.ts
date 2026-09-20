import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { GeoIpService } from '../../integrations/geoip/geoip.service';
import { SenderIdsService } from '../sender-ids/sender-ids.service';
import { NotificationsGateway } from '../inbox/notifications.gateway';
import { JOBS, QUEUES, type EventJobData } from '../jobs/queues';
import { EventsService } from './events.service';

/** Failed payments above this in a rolling hour is worth waking someone for. */
const PAYMENT_FAILURE_SPIKE = 20;

@Processor(QUEUES.events, { concurrency: 5 })
export class EventsProcessor extends WorkerHost {
  private readonly logger = new Logger(EventsProcessor.name);

  constructor(
    private readonly admin: AdminPrismaService,
    private readonly events: EventsService,
    private readonly senderIds: SenderIdsService,
    private readonly geoip: GeoIpService,
    private readonly notifications: NotificationsGateway,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    if (job.name === JOBS.eventSweep)
      return { requeued: await this.events.sweep() };
    if (job.name !== JOBS.processEvent) return null;

    const { eventId } = job.data as EventJobData;
    const event = await this.admin.ingestedEvent.findUnique({
      where: { eventId },
    });
    if (!event) return { skipped: 'event row missing' };
    if (event.status === 'PROCESSED') return { skipped: 'already processed' };

    await this.admin.ingestedEvent.update({
      where: { eventId },
      data: { status: 'PROCESSING', attempts: { increment: 1 } },
    });

    try {
      await this.handle(event.type, event.payload as Record<string, unknown>);
      await this.admin.ingestedEvent.update({
        where: { eventId },
        data: { status: 'PROCESSED', processedAt: new Date(), lastError: null },
      });
      return { handled: event.type };
    } catch (err) {
      await this.admin.ingestedEvent.update({
        where: { eventId },
        data: {
          status: 'FAILED',
          lastError: (err as Error).message.slice(0, 500),
        },
      });
      throw err;
    }
  }

  private async handle(type: string, payload: Record<string, unknown>) {
    switch (type) {
      // usage.recorded and delivery.receipt change rows the rollup jobs already read
      // from source, so there is nothing to write here — the five-minute job picks
      // them up. Recording them keeps the audit of what arrived complete.
      case 'usage.recorded':
      case 'delivery.receipt':
      case 'account.created':
      case 'subscription.changed':
        return;

      case 'auth.signin': {
        const geo = this.geoip.lookup(payload.ip as string);
        await this.admin.signInEvent.create({
          data: {
            surface: 'CUSTOMER_APP',
            accountId: (payload.accountId as string) ?? null,
            userId: (payload.userId as string) ?? null,
            email: (payload.email as string) ?? null,
            success: payload.success !== false,
            ip: (payload.ip as string) ?? null,
            userAgent: (payload.userAgent as string) ?? null,
            country: geo.country,
            region: geo.region,
            city: geo.city,
            latitude: geo.latitude,
            longitude: geo.longitude,
            occurredAt: payload.occurredAt
              ? new Date(payload.occurredAt as string)
              : new Date(),
          },
        });
        return;
      }

      case 'senderid.submitted':
        await this.senderIds.ensureReview(payload.applicationId as string);
        return;

      case 'payment.failed': {
        const since = new Date(Date.now() - 3600_000);
        const recent = await this.admin.ingestedEvent.count({
          where: { type: 'payment.failed', receivedAt: { gte: since } },
        });
        if (recent === PAYMENT_FAILURE_SPIKE) {
          // Fires exactly on the threshold crossing, so the alert is sent once.
          await this.notifications.broadcastToPermission('finance.read', {
            type: 'payment.failure_spike',
            severity: 'HIGH',
            title: `${recent} failed payments in the last hour`,
            body: 'Check Paystack status and the checkout flow',
            link: '/finance/cash',
          });
        }
        return;
      }

      case 'payment.succeeded':
        return;

      default:
        this.logger.warn(`No handler for event type ${type}`);
    }
  }
}
