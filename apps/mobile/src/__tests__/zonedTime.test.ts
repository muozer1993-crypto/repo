import { endOfDayInTz, zonedInstant } from '@/utils/datetime';

/**
 * The create wizard builds a challenge window the SERVER slices into day keys
 * in the account's timezone, so "yarın 09:00" and "the end of the last day"
 * have to resolve in that zone — including across a DST switch and in a
 * half-hour offset zone.
 */
describe('zoned wall-clock helpers', () => {
  const localOf = (date: Date, tz: string) =>
    date.toLocaleString('en-CA', { timeZone: tz, hour12: false });

  it('resolves 09:00 in the account zone, not the device zone', () => {
    expect(zonedInstant('2026-09-09', 9, 0, 'Europe/Istanbul')?.toISOString()).toBe(
      '2026-09-09T06:00:00.000Z'
    );
    expect(zonedInstant('2026-09-09', 9, 0, 'Asia/Kolkata')?.toISOString()).toBe(
      '2026-09-09T03:30:00.000Z'
    );
    expect(zonedInstant('2026-09-09', 9, 0, 'Pacific/Auckland')?.toISOString()).toBe(
      '2026-09-08T21:00:00.000Z'
    );
  });

  it('lands on the right side of a DST switch', () => {
    const berlin = zonedInstant('2026-03-29', 9, 0, 'Europe/Berlin');
    expect(localOf(berlin as Date, 'Europe/Berlin')).toContain('09:00');
    const newYork = zonedInstant('2026-11-01', 9, 0, 'America/New_York');
    expect(localOf(newYork as Date, 'America/New_York')).toContain('09:00');
  });

  it('ends a day at its last local millisecond', () => {
    const end = endOfDayInTz('2026-09-08', 'Europe/Istanbul');
    expect(end?.toISOString()).toBe('2026-09-08T20:59:59.999Z');
    expect(localOf(end as Date, 'Europe/Istanbul')).toContain('23:59:59');
  });

  it('degrades instead of throwing on unusable input', () => {
    expect(zonedInstant('not-a-day', 9, 0, 'Europe/Istanbul')).toBeNull();
    // an unknown zone falls back to the default rather than raising a RangeError
    expect(zonedInstant('2026-09-09', 9, 0, 'Mars/Olympus')?.toISOString()).toBe(
      '2026-09-09T06:00:00.000Z'
    );
  });
});
