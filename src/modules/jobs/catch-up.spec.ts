import { DateTime } from 'luxon';
import { MAX_CATCH_UP_DAYS, missingFinaliseDays } from './catch-up';

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
