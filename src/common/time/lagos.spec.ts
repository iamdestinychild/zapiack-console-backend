import { DateTime } from 'luxon';
import {
  eachLagosDay,
  lagosDateOnly,
  lagosDayBounds,
  lagosHour,
  resolveRange,
} from './lagos';

/**
 * Lagos is UTC+1 with no daylight saving, so the interesting cases are the hour
 * either side of midnight, where a UTC-based day would put the row on the wrong date.
 */
describe('Africa/Lagos day handling', () => {
  it('puts 23:30 UTC on the following Lagos day', () => {
    const at = new Date('2026-09-20T23:30:00Z');
    expect(lagosDateOnly(at).toISOString().slice(0, 10)).toBe('2026-09-21');
    expect(lagosHour(at)).toBe(0);
  });

  it('keeps 00:30 UTC on the same Lagos day', () => {
    const at = new Date('2026-09-20T00:30:00Z');
    expect(lagosDateOnly(at).toISOString().slice(0, 10)).toBe('2026-09-20');
    expect(lagosHour(at)).toBe(1);
  });

  it('bounds a Lagos day as 23:00 UTC to 23:00 UTC', () => {
    const { start, end } = lagosDayBounds(
      DateTime.fromISO('2026-09-20', { zone: 'Africa/Lagos' }),
    );
    expect(start.toISOString()).toBe('2026-09-19T23:00:00.000Z');
    expect(end.toISOString()).toBe('2026-09-20T23:00:00.000Z');
  });

  it('reads a from/to pair as inclusive Lagos days', () => {
    const { start, end } = resolveRange('2026-09-01', '2026-09-07');
    expect(start.toISOString()).toBe('2026-08-31T23:00:00.000Z');
    // Inclusive of the whole final day, not midnight at its start.
    expect(end.toISOString()).toBe('2026-09-07T22:59:59.999Z');
  });

  it('defaults to a trailing window when no range is given', () => {
    const { start, end } = resolveRange(undefined, undefined, 7);
    expect(end.getTime()).toBeGreaterThan(start.getTime());
    const days = (end.getTime() - start.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(8.1);
  });

  it('rejects an unparseable range rather than silently querying everything', () => {
    expect(() => resolveRange('not-a-date', '2026-09-07')).toThrow(
      /Invalid date range/,
    );
  });

  it('enumerates every day in a range inclusively', () => {
    const days = eachLagosDay(
      new Date('2026-09-01T12:00:00Z'),
      new Date('2026-09-04T12:00:00Z'),
    );
    expect(days.map((d) => d.toISOString().slice(0, 10))).toEqual([
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
    ]);
  });
});
