import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { formatMemory } from './memory-report';

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
    const handles =
      typeof process.getActiveResourcesInfo === 'function'
        ? process.getActiveResourcesInfo()
        : [];
    this.logger.log(
      formatMemory(process.memoryUsage(), handles, process.uptime()),
    );
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}
