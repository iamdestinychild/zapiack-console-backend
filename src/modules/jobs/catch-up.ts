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
