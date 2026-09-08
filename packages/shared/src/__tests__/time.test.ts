import { describe, expect, it } from 'vitest';
import {
  addDays,
  compareDayKeys,
  dayKeyInTz,
  dayKeysBetween,
  diffDayKeys,
  hhmmToMinutes,
  isBeforeOrEqualHHmm,
  isValidDayKey,
  isValidHHmm,
  isValidTimeZone,
  localHour,
  localTimeHHmm,
  todayKey,
} from '../time';

const IST = 'Europe/Istanbul';
const NY = 'America/New_York';

describe('dayKeyInTz', () => {
  it('uses the target timezone, not UTC', () => {
    // 21:00Z is 00:00 next day in Istanbul (UTC+3, no DST)
    expect(dayKeyInTz(new Date('2024-06-30T20:59:59Z'), IST)).toBe('2024-06-30');
    expect(dayKeyInTz(new Date('2024-06-30T21:00:00Z'), IST)).toBe('2024-07-01');
    expect(dayKeyInTz(new Date('2024-06-30T21:00:00Z'), 'UTC')).toBe('2024-06-30');
  });

  it('handles New York DST offsets', () => {
    // Before DST (EST, UTC-5): 04:59Z is still the previous day
    expect(dayKeyInTz(new Date('2024-03-10T04:59:00Z'), NY)).toBe('2024-03-09');
    // After DST (EDT, UTC-4): 03:59Z is still the previous day, 04:00Z is the new day
    expect(dayKeyInTz(new Date('2024-03-11T03:59:00Z'), NY)).toBe('2024-03-10');
    expect(dayKeyInTz(new Date('2024-03-11T04:00:00Z'), NY)).toBe('2024-03-11');
  });

  it('throws on invalid dates', () => {
    expect(() => dayKeyInTz(new Date('garbage'), IST)).toThrow(RangeError);
  });
});

describe('localTimeHHmm / localHour', () => {
  it('formats around midnight in Istanbul', () => {
    expect(localTimeHHmm(new Date('2024-01-01T20:59:00Z'), IST)).toBe('23:59');
    expect(localTimeHHmm(new Date('2024-01-01T21:00:00Z'), IST)).toBe('00:00');
    expect(localTimeHHmm(new Date('2024-01-01T21:05:00Z'), IST)).toBe('00:05');
    expect(localHour(new Date('2024-01-01T21:00:00Z'), IST)).toBe(0);
    expect(localHour(new Date('2024-01-01T20:59:00Z'), IST)).toBe(23);
  });

  it('formats noon and single-digit hours with padding', () => {
    expect(localTimeHHmm(new Date('2024-01-01T09:00:00Z'), IST)).toBe('12:00');
    expect(localTimeHHmm(new Date('2024-01-01T04:07:00Z'), IST)).toBe('07:07');
    expect(localTimeHHmm(new Date('2024-07-01T04:07:00Z'), NY)).toBe('00:07');
  });

  it('todayKey accepts an injected clock', () => {
    expect(todayKey(IST, new Date('2024-01-01T21:00:00Z'))).toBe('2024-01-02');
  });
});

describe('dayKeysBetween', () => {
  it('is inclusive of both boundary days in Istanbul', () => {
    expect(dayKeysBetween('2024-06-30T20:00:00Z', '2024-07-02T05:00:00Z', IST)).toEqual([
      '2024-06-30',
      '2024-07-01',
      '2024-07-02',
    ]);
  });

  it('depends on the timezone', () => {
    const start = '2024-06-30T21:00:00Z';
    const end = '2024-07-01T10:00:00Z';
    expect(dayKeysBetween(start, end, IST)).toEqual(['2024-07-01']);
    expect(dayKeysBetween(start, end, 'UTC')).toEqual(['2024-06-30', '2024-07-01']);
  });

  it('crosses the New York DST start without skipping or duplicating a day', () => {
    // Mar 9 00:00 EST → Mar 10 23:59 EDT
    expect(dayKeysBetween('2024-03-09T05:00:00Z', '2024-03-11T03:59:00Z', NY)).toEqual(['2024-03-09', '2024-03-10']);
    expect(dayKeysBetween('2024-03-09T05:00:00Z', '2024-03-11T04:00:00Z', NY)).toEqual([
      '2024-03-09',
      '2024-03-10',
      '2024-03-11',
    ]);
  });

  it('crosses the New York DST end', () => {
    // Nov 3 2024: clocks go back. Nov 2 00:00 EDT (04:00Z) → Nov 4 00:00 EST (05:00Z)
    expect(dayKeysBetween('2024-11-02T04:00:00Z', '2024-11-04T05:00:00Z', NY)).toEqual([
      '2024-11-02',
      '2024-11-03',
      '2024-11-04',
    ]);
  });

  it('spans month and year boundaries', () => {
    expect(dayKeysBetween('2023-12-30T12:00:00Z', '2024-01-02T12:00:00Z', 'UTC')).toEqual([
      '2023-12-30',
      '2023-12-31',
      '2024-01-01',
      '2024-01-02',
    ]);
  });

  it('returns a single day when start and end fall on the same local day', () => {
    expect(dayKeysBetween('2024-05-01T08:00:00Z', '2024-05-01T09:00:00Z', IST)).toEqual(['2024-05-01']);
  });

  it('returns [] when end is before start and accepts Date objects', () => {
    expect(dayKeysBetween('2024-05-03T00:00:00Z', '2024-05-01T00:00:00Z', IST)).toEqual([]);
    expect(dayKeysBetween(new Date('2024-05-01T00:00:00Z'), new Date('2024-05-01T23:00:00Z'), 'UTC')).toEqual(['2024-05-01']);
  });

  it('a 60-day window yields 60 or 61 keys', () => {
    const start = '2024-01-01T10:00:00Z';
    const end = new Date(Date.parse(start) + 60 * 24 * 3600 * 1000).toISOString();
    expect(dayKeysBetween(start, end, IST)).toHaveLength(61);
  });
});

describe('day key arithmetic', () => {
  it('validates day keys strictly', () => {
    expect(isValidDayKey('2024-02-29')).toBe(true);
    expect(isValidDayKey('2023-02-29')).toBe(false);
    expect(isValidDayKey('2024-04-31')).toBe(false);
    expect(isValidDayKey('2024-13-01')).toBe(false);
    expect(isValidDayKey('2024-1-01')).toBe(false);
    expect(isValidDayKey('2024-01-01T00:00')).toBe(false);
    expect(isValidDayKey(20240101)).toBe(false);
  });

  it('addDays handles month/year rollover and negatives', () => {
    expect(addDays('2024-01-31', 1)).toBe('2024-02-01');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2024-12-31', 1)).toBe('2025-01-01');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
    expect(addDays('2024-01-01', -2)).toBe('2023-12-30');
    expect(addDays('2024-01-01', 0)).toBe('2024-01-01');
    expect(() => addDays('nope', 1)).toThrow(RangeError);
  });

  it('compareDayKeys and diffDayKeys', () => {
    expect(compareDayKeys('2024-01-01', '2024-01-02')).toBe(-1);
    expect(compareDayKeys('2024-01-02', '2024-01-02')).toBe(0);
    expect(compareDayKeys('2024-02-01', '2024-01-31')).toBe(1);
    expect(diffDayKeys('2024-01-01', '2024-01-11')).toBe(10);
    expect(diffDayKeys('2024-01-11', '2024-01-01')).toBe(-10);
  });
});

describe('HH:mm helpers', () => {
  it('validates HH:mm', () => {
    expect(isValidHHmm('00:00')).toBe(true);
    expect(isValidHHmm('23:59')).toBe(true);
    expect(isValidHHmm('24:00')).toBe(false);
    expect(isValidHHmm('7:30')).toBe(false);
    expect(isValidHHmm('07:60')).toBe(false);
  });

  it('isBeforeOrEqualHHmm compares by minutes', () => {
    expect(isBeforeOrEqualHHmm('07:29', '07:30')).toBe(true);
    expect(isBeforeOrEqualHHmm('07:30', '07:30')).toBe(true);
    expect(isBeforeOrEqualHHmm('07:31', '07:30')).toBe(false);
    expect(isBeforeOrEqualHHmm('00:00', '23:59')).toBe(true);
    expect(hhmmToMinutes('01:30')).toBe(90);
    expect(() => hhmmToMinutes('1:30')).toThrow(RangeError);
  });
});

describe('isValidTimeZone', () => {
  it('accepts IANA names and rejects junk', () => {
    expect(isValidTimeZone('Europe/Istanbul')).toBe(true);
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });
});
