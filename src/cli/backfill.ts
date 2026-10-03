/**
 * Recomputes rollups for a range of Africa/Lagos days.
 *
 *   node dist/cli/backfill.js            # the last 14 days
 *   node dist/cli/backfill.js --days 30
 *   node dist/cli/backfill.js --from 2026-09-01 --to 2026-09-07
 *
 * Safe to run at any time: every rollup is an upsert keyed by
 * (date, hour, channel, account, country, provider), recomputed from the source rows
 * rather than incremented. That is what makes this usable in production after a
 * provider cost is corrected, not only for seeding a dev database.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { AppModule } from '../app.module';
import { RollupsService } from '../modules/rollups/rollups.service';
import { ReconciliationService } from '../modules/finance/reconciliation.service';
import { ProviderHealthService } from '../modules/services/provider-health.service';
import { RiskService } from '../modules/risk/risk.service';
import { SenderIdsService } from '../modules/sender-ids/sender-ids.service';
import { ZapiackPrismaService } from '../common/prisma/zapiack-prisma.service';
import { LAGOS } from '../common/time/lagos';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const logger = new Logger('backfill');

  const to = arg('to')
    ? DateTime.fromISO(arg('to')!, { zone: LAGOS })
    : DateTime.now().setZone(LAGOS);
  const from = arg('from')
    ? DateTime.fromISO(arg('from')!, { zone: LAGOS })
    : to.minus({ days: Number(arg('days') ?? 14) - 1 });

  if (!from.isValid || !to.isValid) {
    logger.error('Invalid date range; expected ISO dates such as 2026-09-01');
    process.exit(1);
  }

  // ADMIN_ROLE=web keeps the schedulers and queue consumers out of this process, so
  // a backfill cannot race the worker that is already running.
  process.env.ADMIN_ROLE = 'web';
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const rollups = app.get(RollupsService);
  let day = from.startOf('day');
  let days = 0;

  while (day <= to.startOf('day')) {
    const buckets = await rollups.finaliseDay(day.toJSDate());
    logger.log(`${day.toISODate()}: ${buckets} buckets`);
    day = day.plus({ days: 1 });
    days += 1;
  }

  // The current day also needs its hourly rows, which finalisation does not write.
  const today = DateTime.now().setZone(LAGOS).startOf('day');
  if (to.startOf('day') >= today) {
    const hourly = await rollups.rollUsage(
      today.toJSDate(),
      today.plus({ days: 1 }).toJSDate(),
    );
    logger.log(`today hourly: ${hourly} buckets`);
  }

  await rollups.rollRequests(
    from.startOf('day').toJSDate(),
    to.endOf('day').toJSDate(),
  );
  await rollups.markProcessed('usage.current_day', new Date());
  await rollups.markProcessed('requests', new Date());

  // Reviews are normally created by the senderid.submitted event. Rebuilding any
  // that are missing covers a lost event in production, and populates the queue in a
  // freshly seeded development database.
  const senderIds = app.get(SenderIdsService);
  const applications = await app
    .get(ZapiackPrismaService)
    .read.senderIdApplication.findMany({ select: { id: true } });
  let reviews = 0;
  for (const application of applications) {
    const before = await senderIds.ensureReview(application.id);
    if (before) reviews += 1;
  }
  logger.log(`sender ID reviews present: ${reviews}`);

  await app.get(ProviderHealthService).sample();
  await app.get(RiskService).scan();
  await app.get(ReconciliationService).runForDay(to.startOf('day').toJSDate());

  logger.log(
    `Backfilled ${days} days, ${from.toISODate()} to ${to.toISODate()}`,
  );
  await app.close();
}

main().catch((err: Error) => {
  console.error(err);
  process.exit(1);
});
