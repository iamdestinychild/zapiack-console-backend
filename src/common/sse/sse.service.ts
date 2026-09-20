import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Observable, Subject, filter, map } from 'rxjs';
import type Redis from 'ioredis';
import { RedisService } from '../redis/redis.service';

export interface SseMessage {
  channel: string;
  event: string;
  data: unknown;
}

/**
 * Fan-out for the live map and the staff inbox. Publishing goes through Redis pub/sub
 * so every admin-core instance reaches its own connected viewers.
 */
@Injectable()
export class SseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SseService.name);
  private readonly stream$ = new Subject<SseMessage>();
  private subscriber?: Redis;

  constructor(private readonly redis: RedisService) {}

  async onModuleInit() {
    this.subscriber = this.redis.duplicate();
    await this.subscriber.psubscribe(`${this.redis.prefix}sse:*`);
    this.subscriber.on('pmessage', (_pattern, channel, payload) => {
      try {
        const { event, data } = JSON.parse(payload) as {
          event: string;
          data: unknown;
        };
        this.stream$.next({
          channel: channel.slice(`${this.redis.prefix}sse:`.length),
          event,
          data,
        });
      } catch (err) {
        this.logger.warn(
          `Dropped malformed SSE payload on ${channel}: ${(err as Error).message}`,
        );
      }
    });
  }

  async publish(channel: string, event: string, data: unknown): Promise<void> {
    await this.redis.client.publish(
      `sse:${channel}`,
      JSON.stringify({ event, data }),
    );
  }

  /** Nest serialises `{ data, type }` as a text/event-stream frame. */
  subscribe(channel: string): Observable<{ data: unknown; type: string }> {
    return this.stream$.pipe(
      filter((message) => message.channel === channel),
      map((message) => ({ data: message.data, type: message.event })),
    );
  }

  async onModuleDestroy() {
    this.stream$.complete();
    await this.subscriber?.quit();
  }
}
