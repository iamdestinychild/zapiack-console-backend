/**
 * One line describing where a Node process's memory is, for the logs.
 *
 * `rss` is what the container is charged for; the rest says what it is made of. A heap
 * that grows is a leak in our code; `external` or `arrayBuffers` growing is buffers
 * (a loaded file, a stream, a response); rising handle counts are connections or timers
 * that are never closed. Without the split, "it uses 500 MB" says nothing about why.
 */
export interface MemorySample {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
}

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);

export function formatMemory(
  sample: MemorySample,
  handles: string[] = [],
  uptimeSeconds = 0,
): string {
  const counts = new Map<string, number>();
  for (const name of handles) counts.set(name, (counts.get(name) ?? 0) + 1);
  const resources = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, n]) => `${name}=${n}`)
    .join(' ');

  return (
    `memory rss=${mb(sample.rss)}MB heapUsed=${mb(sample.heapUsed)}MB heapTotal=${mb(sample.heapTotal)}MB ` +
    `external=${mb(sample.external)}MB arrayBuffers=${mb(sample.arrayBuffers)}MB ` +
    `uptime=${Math.round(uptimeSeconds / 60)}min` +
    (resources ? ` handles: ${resources}` : '')
  );
}
