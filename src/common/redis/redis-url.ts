/**
 * What a `redis://` or `rediss://` URL says, in the shape ioredis and BullMQ take.
 *
 * ioredis understands the whole URL itself, but BullMQ is handed plain options, and a
 * hand-rolled parse that reads only host, port and password quietly drops the rest:
 *  - the database index (`/1`), so the queues land in database 0 beside the other
 *    application's keys while sessions go to database 1, and
 *  - `rediss://`, so a TLS-only Redis refuses the queue connections.
 */
export function redisOptionsFromUrl(raw: string) {
  const url = new URL(raw);
  const index = Number(url.pathname.replace('/', ''));
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    password: url.password ? decodeURIComponent(url.password) : undefined,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    db: Number.isInteger(index) && index > 0 ? index : undefined,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}
