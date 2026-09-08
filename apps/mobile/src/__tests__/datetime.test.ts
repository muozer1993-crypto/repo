import { DEFAULT_TIMEZONE } from '@koydum/shared';

import { resolveTimezone, safeDayKey, safeDayKeysBetween, safeTodayKey } from '@/utils/datetime';

/**
 * `me.timezone` and `challenge.startsAt` both come off the wire, and the raw
 * shared helpers throw on bad input. These wrappers are what keeps a single bad
 * row from blanking a screen mid-render.
 */
describe('resolveTimezone', () => {
  it('takes the first zone the runtime understands', () => {
    expect(resolveTimezone('Europe/Berlin', 'Europe/Istanbul')).toBe('Europe/Berlin');
  });

  it('skips a zone the server made up', () => {
    expect(resolveTimezone('Mars/Olympus', 'Europe/Berlin')).toBe('Europe/Berlin');
  });

  it('skips null, undefined and empty strings', () => {
    expect(resolveTimezone(null, undefined, '', 'Europe/Berlin')).toBe('Europe/Berlin');
  });

  it('falls back to Istanbul when nothing is usable', () => {
    expect(resolveTimezone(null, 'nope/nope')).toBe(DEFAULT_TIMEZONE);
  });
});

describe('safeTodayKey', () => {
  const noon = new Date('2026-09-08T09:00:00.000Z');

  it('reads the day in the given zone', () => {
    expect(safeTodayKey('Europe/Istanbul', noon)).toBe('2026-09-08');
  });

  it('rolls over the date line rather than throwing', () => {
    // 09:00 UTC is already the 8th in Auckland's evening
    expect(safeTodayKey('Pacific/Auckland', noon)).toBe('2026-09-08');
    expect(safeTodayKey('America/Los_Angeles', noon)).toBe('2026-09-08');
  });

  it('falls back to the default zone instead of throwing', () => {
    expect(safeTodayKey('Mars/Olympus', noon)).toBe('2026-09-08');
  });
});

describe('safeDayKey', () => {
  it('converts an ISO instant into a local day key', () => {
    expect(safeDayKey('2026-09-08T21:30:00.000Z', 'Europe/Istanbul')).toBe('2026-09-09');
  });

  it('returns null for a malformed instant', () => {
    expect(safeDayKey('not-a-date', 'Europe/Istanbul')).toBeNull();
    expect(safeDayKey('', 'Europe/Istanbul')).toBeNull();
  });

  it('returns null for a missing instant', () => {
    expect(safeDayKey(null, 'Europe/Istanbul')).toBeNull();
    expect(safeDayKey(undefined, 'Europe/Istanbul')).toBeNull();
  });

  it('still answers when the zone is nonsense', () => {
    expect(safeDayKey('2026-09-08T09:00:00.000Z', 'Mars/Olympus')).toBe('2026-09-08');
  });
});

describe('safeDayKeysBetween', () => {
  it('lists every day in the window, both ends included', () => {
    expect(
      safeDayKeysBetween('2026-09-08T06:00:00.000Z', '2026-09-10T06:00:00.000Z', 'Europe/Istanbul')
    ).toEqual(['2026-09-08', '2026-09-09', '2026-09-10']);
  });

  it('returns an empty window for malformed dates instead of throwing', () => {
    expect(safeDayKeysBetween('nope', '2026-09-10T06:00:00.000Z', 'Europe/Istanbul')).toEqual([]);
    expect(safeDayKeysBetween('2026-09-08T06:00:00.000Z', 'nope', 'Europe/Istanbul')).toEqual([]);
  });

  it('returns an empty window when either end is missing', () => {
    expect(safeDayKeysBetween(null, '2026-09-10T06:00:00.000Z', 'Europe/Istanbul')).toEqual([]);
    expect(safeDayKeysBetween('2026-09-08T06:00:00.000Z', undefined, 'Europe/Istanbul')).toEqual([]);
  });

  it('returns an empty window when the zone is nonsense', () => {
    expect(
      safeDayKeysBetween('2026-09-08T06:00:00.000Z', '2026-09-10T06:00:00.000Z', 'Mars/Olympus')
    ).toEqual([]);
  });
});
