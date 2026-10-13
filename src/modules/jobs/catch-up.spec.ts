import { DateTime } from 'luxon';
import {
  MAX_CATCH_UP_DAYS,
  MAX_HISTORY_DAYS,
  historyDays,
  missingFinaliseDays,
} from './catch-up';

/** 2026-10-03 14:00 in Lagos. */
const now = DateTime.fromISO('2026-10-03T14:00:00', { zone: 'Africa/Lagos' });
/** Watermark as the finalise job leaves it: the start of the day AFTER the one done. */
const finalisedThrough = (isoDay: string) =>
  DateTime.fromISO(isoDay, { zone: 'Africa/Lagos' })
    .plus({ days: 1 })
    .toJSDate();

describe('missingFinaliseDays', () => {
  it('is empty when yesterday has already been finalised', () => {
    expect(missingFinaliseDays(finalisedThrough('2026-10-02'), now)).toEqual(
      [],
    );
  });

  it('returns the days a sleeping host missed, oldest first', () => {
    expect(missingFinaliseDays(finalisedThrough('2026-09-29'), now)).toEqual([
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
    ]);
  });

  it('never includes today, which the five-minute job still owns', () => {
    const days = missingFinaliseDays(finalisedThrough('2026-09-01'), now);
    expect(days).not.toContain('2026-10-03');
    expect(days.at(-1)).toBe('2026-10-02');
  });

  it('replays only two days on a first boot with no watermark', () => {
    expect(missingFinaliseDays(null, now)).toEqual([
      '2026-10-01',
      '2026-10-02',
    ]);
  });

  it('caps a long outage rather than finalising months in one go', () => {
    const days = missingFinaliseDays(finalisedThrough('2026-01-01'), now);
    expect(days).toHaveLength(MAX_CATCH_UP_DAYS);
    expect(days[0]).toBe('2026-09-19');
  });

  it('reads the watermark as a Lagos day, not a UTC one', () => {
    // 23:00 UTC on the 1st is 00:00 on the 2nd in Lagos: the 2nd is the first day owed.
    const watermark = new Date('2026-10-01T23:00:00Z');
    expect(missingFinaliseDays(watermark, now)[0]).toBe('2026-10-02');
  });
});

describe('historyDays', () => {
  // Tuesday 13 October 2026, 10:00 in Lagos.
  const now = DateTime.fromISO('2026-10-13T10:00:00', { zone: 'Africa/Lagos' });

  it('loads from the first day the product has activity up to three days ago', () => {
    const days = historyDays(new Date('2026-09-12T14:00:00Z'), now);
    expect(days[0]).toBe('2026-09-12');
    expect(days[days.length - 1]).toBe('2026-10-10');
    expect(days).toHaveLength(29);
  });

  it('leaves the most recent days to the normal catch-up', () => {
    const days = historyDays(new Date('2026-10-01T00:00:00Z'), now);
    expect(days).not.toContain('2026-10-11');
    expect(days).not.toContain('2026-10-12');
    expect(days).not.toContain('2026-10-13');
  });

  it('puts a late-evening UTC activity on its Lagos day', () => {
    // 23:30 UTC on the 12th is 00:30 on the 13th in Lagos (UTC+1).
    const days = historyDays(new Date('2026-09-12T23:30:00Z'), now);
    expect(days[0]).toBe('2026-09-13');
  });

  it('never goes back further than the cap, however old the product is', () => {
    const days = historyDays(new Date('2020-01-01T00:00:00Z'), now);
    expect(days).toHaveLength(MAX_HISTORY_DAYS - 2);
    expect(days[0]).toBe(
      now.startOf('day').minus({ days: MAX_HISTORY_DAYS }).toISODate(),
    );
  });

  it('has nothing to load for a product with no activity, or one that started this week', () => {
    expect(historyDays(null, now)).toEqual([]);
    expect(historyDays(new Date('2026-10-12T00:00:00Z'), now)).toEqual([]);
  });

  it('lists each day once, in order', () => {
    const days = historyDays(new Date('2026-09-20T00:00:00Z'), now);
    expect(new Set(days).size).toBe(days.length);
    expect([...days].sort()).toEqual(days);
  });
});
