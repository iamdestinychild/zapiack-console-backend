/**
 * A small in-process cache for read-heavy answers that are allowed to be a little
 * stale. Concurrent callers for the same key share one in-flight load, so a dashboard
 * opened by ten staff at once costs one query, not ten.
 *
 * It is per process: another instance has its own copy, so only cache what tolerates
 * being up to `ttlMs` old.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; expires: number }>();
  private readonly loading = new Map<string, Promise<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 200,
  ) {}

  async get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;

    const pending = this.loading.get(key);
    if (pending) return pending;

    const promise = load()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => this.loading.delete(key));
    this.loading.set(key, promise);
    return promise;
  }

  delete(key: string) {
    this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
  }

  private set(key: string, value: T) {
    if (this.entries.size >= this.maxEntries) {
      const now = Date.now();
      for (const [k, e] of this.entries)
        if (e.expires <= now) this.entries.delete(k);
      // Still full: drop the oldest insertion rather than grow without bound.
      if (this.entries.size >= this.maxEntries) {
        const [oldest] = this.entries.keys();
        if (oldest !== undefined) this.entries.delete(oldest);
      }
    }
    this.entries.set(key, { value, expires: Date.now() + this.ttlMs });
  }
}

/** Stable key for a DTO: undefined fields are ignored, key order does not matter. */
export function cacheKey(input: unknown): string {
  return JSON.stringify(input, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : v,
  );
}
