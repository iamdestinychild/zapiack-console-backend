import { DateTime } from 'luxon';
import { LAGOS } from '../../common/time/lagos';

/** Never replay more than this many days; older gaps are a job for the backfill CLI. */
export const MAX_CATCH_UP_DAYS = 14;

/**
 * The Africa/Lagos days whose nightly finalisation has not run.
 *
 * `processedTo` is the watermark the finalise job leaves behind: the start of the day
 * AFTER the one it finalised, so its Lagos date is the first day still owed. Today is
 * never included, because today is still being written to and the five-minute job
 * owns it. With no watermark at all (first boot) only the last two days are replayed:
 * assuming nothing older is trustworthy is safer than finalising months of history
 * from a standing start.
 *
 * Returns ISO dates, oldest first.
 */
export function missingFinaliseDays(
  processedTo: Date | null,
  now: DateTime = DateTime.now(),
): string[] {
  const today = now.setZone(LAGOS).startOf('day');
  const yesterday = today.minus({ days: 1 });

  const earliest = yesterday.minus({ days: MAX_CATCH_UP_DAYS - 1 });
  let cursor = processedTo
    ? DateTime.fromJSDate(processedTo).setZone(LAGOS).startOf('day')
    : yesterday.minus({ days: 1 });

  if (cursor < earliest) cursor = earliest;

  const days: string[] = [];
  while (cursor <= yesterday) {
    days.push(cursor.toISODate()!);
    cursor = cursor.plus({ days: 1 });
  }
  return days;
}

/** How far back a first start loads history. Beyond this, use the backfill CLI. */
export const MAX_HISTORY_DAYS = 120;

/** Days to leave to the normal catch-up, which owns the most recent ones. */
const RECENT_DAYS_LEFT_ALONE = 3;

/**
 * The Africa/Lagos days of history to load, from the first day the product has any
 * activity up to a few days ago (the nightly catch-up owns the recent ones).
 *
 * The normal catch-up deliberately replays only the last two days of a new database,
 * so on its own a console deployed into a product that has been running for a month
 * shows one month less than it should. This is the other half: it reads where the
 * product's history starts and loads from there, capped at MAX_HISTORY_DAYS.
 *
 * Returns ISO dates, oldest first; empty when the product has no activity yet.
 */
export function historyDays(
  firstActivity: Date | null,
  now: DateTime = DateTime.now(),
): string[] {
  if (!firstActivity) return [];

  const today = now.setZone(LAGOS).startOf('day');
  const last = today.minus({ days: RECENT_DAYS_LEFT_ALONE });
  const earliest = today.minus({ days: MAX_HISTORY_DAYS });

  let cursor = DateTime.fromJSDate(firstActivity).setZone(LAGOS).startOf('day');
  if (cursor < earliest) cursor = earliest;

  const days: string[] = [];
  while (cursor <= last) {
    days.push(cursor.toISODate()!);
    cursor = cursor.plus({ days: 1 });
  }
  return days;
}
