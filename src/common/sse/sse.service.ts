import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Observable, Subject, filter, interval, map, merge } from 'rxjs';
import type Redis from 'ioredis';
import { RedisService } from '../redis/redis.service';

const HEARTBEAT_MS = 15_000;

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
    await this.subscriber.psubscribe(this.redis.channel('sse', '*'));
    this.subscriber.on('pmessage', (_pattern, channel, payload) => {
      try {
        const { event, data } = JSON.parse(payload) as {
          event: string;
          data: unknown;
        };
        this.stream$.next({
          channel: channel.slice(this.redis.channel('sse', '').length),
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
      this.redis.channel('sse', channel),
      JSON.stringify({ event, data }),
    );
  }

  /**
   * Nest serialises `{ data, type }` as a text/event-stream frame.
   *
   * A named `ping` goes out every 15 seconds. Proxies, Render's included, close a
   * connection that stays silent for about a minute, and a quiet period on the map is
   * exactly when that happens. Clients subscribe to named events, so they ignore it.
   */
  subscribe(channel: string): Observable<{ data: unknown; type: string }> {
    const messages = this.stream$.pipe(
      filter((message) => message.channel === channel),
      map((message) => ({ data: message.data, type: message.event })),
    );
    const heartbeat = interval(HEARTBEAT_MS).pipe(
      map(() => ({ data: {}, type: 'ping' })),
    );
    return merge(messages, heartbeat);
  }

  async onModuleDestroy() {
    this.stream$.complete();
    await this.subscriber?.quit();
  }
}
