import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { formatMemory } from './memory-report';
import { canForceGc, traceEnabled, traceSummary } from './memory-trace';

const EVERY_MS = 5 * 60_000;

/**
 * Logs the process's memory every five minutes. admin-core runs in a small container
 * where a slow climb ends in garbage-collection thrash and a pegged CPU, and the first
 * question is always what grew. `MEMORY_REPORT_SECONDS=0` turns it off.
 */
@Injectable()
export class MemoryReporter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MemoryReporter.name);
  private timer?: NodeJS.Timeout;

  onModuleInit() {
    const seconds = Number(
      process.env['MEMORY_REPORT_SECONDS'] ?? EVERY_MS / 1000,
    );
    if (seconds === 0 || !Number.isFinite(seconds)) return;
    this.report();
    this.timer = setInterval(() => this.report(), seconds * 1000);
    this.timer.unref();
  }

  private report() {
    // With MEMORY_TRACE on and --expose-gc, collect first: the heap figure is then what is
    // really being retained, and a climb in it across reports is the leak, without the
    // noise of garbage that simply has not been collected yet.
    const collected = traceEnabled() && canForceGc();
    if (collected) (globalThis as { gc?: () => void }).gc?.();

    const handles =
      typeof process.getActiveResourcesInfo === 'function'
        ? process.getActiveResourcesInfo()
        : [];
    const holders = traceEnabled() ? traceSummary() : '';
    this.logger.log(
      formatMemory(process.memoryUsage(), handles, process.uptime()) +
        (collected ? ' (after gc)' : '') +
        (holders ? ` retained-by: ${holders}` : ''),
    );
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}
