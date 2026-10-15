import { Logger } from '@nestjs/common';

/**
 * Finds what is holding memory, by name.
 *
 * With `MEMORY_TRACE=true`, each traced unit of work (a queue job, a sampled poll tick)
 * logs how much heap it left behind:
 *
 *   memory-trace roll-usage-current-day retained=+6.4MB took=840ms
 *
 * "Retained" means after a full garbage collection, so it is what the work kept alive,
 * not the garbage it made on the way. That needs `--expose-gc` in NODE_OPTIONS; without
 * it the number includes uncollected garbage and the log says so once.
 *
 * Off by default. A forced collection pauses the process for tens of milliseconds, which
 * is fine for a diagnosis and not something to leave on.
 */

const logger = new Logger('MemoryTrace');

export const traceEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  String(env['MEMORY_TRACE'] ?? '').toLowerCase() === 'true';

type Gc = () => void;
const gcFn = (): Gc | undefined =>
  typeof (globalThis as { gc?: Gc }).gc === 'function'
    ? (globalThis as { gc?: Gc }).gc
    : undefined;

let warnedNoGc = false;

/** The heap, after a collection when one can be forced. */
export function heapUsedMb(forceGc = true): number {
  const gc = forceGc ? gcFn() : undefined;
  gc?.();
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

/** Whether `heapUsedMb` can force a collection in this process. */
export const canForceGc = (): boolean => gcFn() !== undefined;

interface Totals {
  runs: number;
  retainedMb: number;
}
const totals = new Map<string, Totals>();

/** Running totals per label, largest first, for the periodic memory line. */
export function traceSummary(limit = 5): string {
  return [...totals.entries()]
    .sort((a, b) => b[1].retainedMb - a[1].retainedMb)
    .slice(0, limit)
    .filter(([, t]) => t.retainedMb > 0.05)
    .map(([label, t]) => `${label}=+${t.retainedMb.toFixed(1)}MB/${t.runs}runs`)
    .join(' ');
}

/** Test seam: forget what has been recorded. */
export function resetTrace() {
  totals.clear();
  warnedNoGc = false;
}

/**
 * Runs `fn` and, when tracing is on, reports what it retained. Never changes the result
 * or swallows an error: a failing job still fails, and is measured on the way out.
 */
export async function traced<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!traceEnabled()) return fn();

  if (!canForceGc() && !warnedNoGc) {
    warnedNoGc = true;
    logger.warn(
      'MEMORY_TRACE is on but the process was not started with --expose-gc, so figures include uncollected garbage. Add --expose-gc to NODE_OPTIONS for retained sizes.',
    );
  }

  const before = heapUsedMb();
  const started = Date.now();
  try {
    return await fn();
  } finally {
    const retained = heapUsedMb() - before;
    const entry = totals.get(label) ?? { runs: 0, retainedMb: 0 };
    entry.runs += 1;
    entry.retainedMb += retained;
    totals.set(label, entry);

    logger.log(
      `memory-trace ${label} retained=${retained >= 0 ? '+' : ''}${retained.toFixed(1)}MB took=${Date.now() - started}ms`,
    );
  }
}

/**
 * True for one call in every `every`, for work that runs too often to trace each time
 * (a poll every few seconds). The counter is the caller's.
 */
export function everyNth(counter: { n: number }, every: number): boolean {
  counter.n += 1;
  return counter.n % every === 0;
}
