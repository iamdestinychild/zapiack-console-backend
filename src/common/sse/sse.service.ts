import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  Observable,
  Subject,
  defer,
  filter,
  finalize,
  interval,
  map,
  merge,
} from 'rxjs';
import type Redis from 'ioredis';
import { RedisService } from '../redis/redis.service';

const HEARTBEAT_MS = 25_000;
/** How often an instance with viewers renews its presence; the entry outlives two misses. */
const PRESENCE_MS = 20_000;
const PRESENCE_TTL_MS = 60_000;

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
  /** Open streams on this instance, per channel. */
  private readonly viewers = new Map<string, number>();
  private presenceTimer?: NodeJS.Timeout;
  private readonly instanceId = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

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
   * A named `ping` goes out every 25 seconds. Proxies, Render's included, close a
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
    return defer(() => {
      this.addViewer(channel);
      return merge(messages, heartbeat);
    }).pipe(finalize(() => this.removeViewer(channel)));
  }

  /**
   * Whether anyone, on any instance, has this channel open. Producers use it to skip
   * work nobody would see; the stream is built for exactly one answer to this question.
   * On a Redis error it answers true, because dropping live updates is worse than
   * doing one unneeded poll.
   */
  async hasViewers(channel: string): Promise<boolean> {
    try {
      const key = this.presenceKey(channel);
      await this.redis.client.zremrangebyscore(key, '-inf', Date.now());
      return (await this.redis.client.zcard(key)) > 0;
    } catch {
      return true;
    }
  }

  private presenceKey(channel: string) {
    return this.redis.key('sse-viewers', channel);
  }

  private addViewer(channel: string) {
    this.viewers.set(channel, (this.viewers.get(channel) ?? 0) + 1);
    void this.renewPresence([channel]);
    this.presenceTimer ??= setInterval(
      () => void this.renewPresence([...this.viewers.keys()]),
      PRESENCE_MS,
    );
  }

  private removeViewer(channel: string) {
    const left = (this.viewers.get(channel) ?? 1) - 1;
    if (left > 0) {
      this.viewers.set(channel, left);
      return;
    }
    this.viewers.delete(channel);
    this.redis.client
      .zrem(this.presenceKey(channel), this.instanceId)
      .catch(() => undefined);
    if (!this.viewers.size && this.presenceTimer) {
      clearInterval(this.presenceTimer);
      this.presenceTimer = undefined;
    }
  }

  private async renewPresence(channels: string[]) {
    const expires = Date.now() + PRESENCE_TTL_MS;
    await Promise.all(
      channels.map((channel) =>
        this.redis.client
          .zadd(this.presenceKey(channel), expires, this.instanceId)
          .catch((err: Error) =>
            this.logger.warn(`Could not record SSE presence: ${err.message}`),
          ),
      ),
    );
  }

  async onModuleDestroy() {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.stream$.complete();
    await this.subscriber?.quit();
  }
}
