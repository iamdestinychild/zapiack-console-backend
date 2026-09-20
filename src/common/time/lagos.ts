import { DateTime } from 'luxon';

/**
 * Every number on the console is an Africa/Lagos day. Rollup buckets are keyed by
 * the Lagos calendar date and hour, so "yesterday" means the same thing to finance,
 * to support and to the jobs.
 */
export const LAGOS = 'Africa/Lagos';

export function nowLagos(): DateTime {
  return DateTime.now().setZone(LAGOS);
}

/** The UTC instant stored in a `@db.Date` column for a given Lagos day. */
export function lagosDateOnly(input: Date | DateTime): Date {
  const dt =
    input instanceof Date
      ? DateTime.fromJSDate(input).setZone(LAGOS)
      : input.setZone(LAGOS);
  return new Date(Date.UTC(dt.year, dt.month - 1, dt.day));
}

export function lagosHour(input: Date): number {
  return DateTime.fromJSDate(input).setZone(LAGOS).hour;
}

/** Inclusive start, exclusive end, as UTC instants bounding a Lagos day. */
export function lagosDayBounds(day: Date | DateTime): {
  start: Date;
  end: Date;
} {
  const dt = (day instanceof Date ? DateTime.fromJSDate(day) : day)
    .setZone(LAGOS)
    .startOf('day');
  return { start: dt.toJSDate(), end: dt.plus({ days: 1 }).toJSDate() };
}

export function lagosHourBounds(at: Date): { start: Date; end: Date } {
  const dt = DateTime.fromJSDate(at).setZone(LAGOS).startOf('hour');
  return { start: dt.toJSDate(), end: dt.plus({ hours: 1 }).toJSDate() };
}

/**
 * Resolves a `from`/`to` query pair into UTC instants. Dates are read as Lagos days;
 * `to` is made exclusive by advancing to the end of that day.
 */
export function resolveRange(
  from?: string,
  to?: string,
  defaultDays = 30,
): { start: Date; end: Date } {
  const end = to
    ? DateTime.fromISO(to, { zone: LAGOS }).endOf('day')
    : nowLagos().endOf('day');
  const start = from
    ? DateTime.fromISO(from, { zone: LAGOS }).startOf('day')
    : end.minus({ days: defaultDays }).startOf('day');

  if (!start.isValid || !end.isValid) {
    throw new Error(
      'Invalid date range; expected ISO dates such as 2026-09-01',
    );
  }
  return { start: start.toJSDate(), end: end.toJSDate() };
}

/** Lagos days covered by a range, for filling gaps in a timeseries. */
export function eachLagosDay(start: Date, end: Date): Date[] {
  const days: Date[] = [];
  let cursor = DateTime.fromJSDate(start).setZone(LAGOS).startOf('day');
  const last = DateTime.fromJSDate(end).setZone(LAGOS).startOf('day');
  while (cursor <= last) {
    days.push(lagosDateOnly(cursor));
    cursor = cursor.plus({ days: 1 });
  }
  return days;
}
