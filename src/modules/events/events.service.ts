import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { Prisma } from '../../generated/admin/client';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { DEFAULT_JOB_OPTIONS, JOBS, QUEUES } from '../jobs/queues';

/** Events admin-core consumes from api-core, sms-core and mailing-core. */
export type EventType =
  | 'usage.recorded'
  | 'request.logged'
  | 'auth.signin'
  | 'payment.succeeded'
  | 'payment.failed'
  | 'account.created'
  | 'subscription.changed'
  | 'senderid.submitted'
  | 'delivery.receipt';

export interface IncomingEvent {
  eventId: string;
  type: EventType;
  source: string;
  payload: Record<string, unknown>;
}

/**
 * Follows the existing webhook pattern: persist the event row first, process it
 * through a BullMQ job keyed by event id, and let a reconciliation sweep re-queue
 * anything stuck. Nothing is processed inline, so a slow handler cannot make the
 * producer wait.
 */
@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly admin: AdminPrismaService,
    @InjectQueue(QUEUES.events) private readonly queue: Queue,
  ) {}

  async ingest(
    event: IncomingEvent,
  ): Promise<{ eventId: string; duplicate: boolean }> {
    const existing = await this.admin.ingestedEvent.findUnique({
      where: { eventId: event.eventId },
      select: { id: true },
    });
    if (existing) return { eventId: event.eventId, duplicate: true };

    await this.admin.ingestedEvent.create({
      data: {
        eventId: event.eventId,
        type: event.type,
        source: event.source,
        payload: event.payload as Prisma.InputJsonValue,
      },
    });

    // The job id is the event id, so a redelivery never enqueues twice.
    await this.queue.add(
      JOBS.processEvent,
      { eventId: event.eventId },
      { ...DEFAULT_JOB_OPTIONS, jobId: `event-${event.eventId}` },
    );

    return { eventId: event.eventId, duplicate: false };
  }

  async ingestBatch(events: IncomingEvent[]) {
    const results = await Promise.all(events.map((e) => this.ingest(e)));
    return {
      accepted: results.filter((r) => !r.duplicate).length,
      duplicates: results.filter((r) => r.duplicate).length,
    };
  }

  /**
   * Re-queues events that were persisted but never finished. This is why persisting
   * first is worth the extra write.
   */
  async sweep(): Promise<number> {
    const stuck = await this.admin.ingestedEvent.findMany({
      where: {
        status: { in: ['PENDING', 'PROCESSING'] },
        // Anything under two minutes old may simply still be in flight.
        receivedAt: { lt: new Date(Date.now() - 2 * 60_000) },
        attempts: { lt: 10 },
      },
      select: { eventId: true },
      take: 500,
    });

    for (const event of stuck) {
      await this.queue.add(
        JOBS.processEvent,
        { eventId: event.eventId },
        {
          ...DEFAULT_JOB_OPTIONS,
          jobId: `event-${event.eventId}-retry-${Date.now()}`,
        },
      );
    }

    if (stuck.length)
      this.logger.warn(`Re-queued ${stuck.length} stuck events`);
    return stuck.length;
  }

  async stats() {
    const byStatus = await this.admin.ingestedEvent.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    return Object.fromEntries(byStatus.map((r) => [r.status, r._count._all]));
  }
}
