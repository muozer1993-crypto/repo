import {
  formatClock,
  formatDayKey,
  formatDayKeyFriendly,
  formatMinutes,
  formatNumber,
  relativeTime,
  withUnit,
} from '@/utils/format';

describe('Turkish formatting', () => {
  it('groups thousands the Turkish way', () => {
    expect(formatNumber(12430)).toBe('12.430');
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(999)).toBe('999');
    expect(formatNumber(1234567)).toBe('1.234.567');
  });

  it('rounds fractions to one decimal', () => {
    expect(formatNumber(5.24)).toBe('5,2');
    expect(formatNumber(5.0)).toBe('5');
  });

  it('survives nonsense input', () => {
    expect(formatNumber(Number.NaN)).toBe('0');
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe('0');
  });

  it('writes durations the way people say them', () => {
    expect(formatMinutes(45)).toBe('45dk');
    expect(formatMinutes(60)).toBe('1sa');
    expect(formatMinutes(90)).toBe('1sa 30dk');
    expect(formatMinutes(0)).toBe('0dk');
    expect(formatMinutes(-5)).toBe('0dk');
  });

  it('renders a stopwatch', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(65)).toBe('01:05');
    expect(formatClock(1499)).toBe('24:59');
  });

  it('names days in Turkish without shifting timezone', () => {
    expect(formatDayKey('2026-09-08')).toBe('8 Eylül');
    expect(formatDayKey('2026-01-01', { withWeekday: true })).toBe('1 Ocak Perşembe');
    expect(formatDayKey('bozuk')).toBe('bozuk');
  });

  it('prefers Bugün and Dün', () => {
    expect(formatDayKeyFriendly('2026-09-08', '2026-09-08', '2026-09-07')).toBe('Bugün');
    expect(formatDayKeyFriendly('2026-09-07', '2026-09-08', '2026-09-07')).toBe('Dün');
    expect(formatDayKeyFriendly('2026-09-01', '2026-09-08', '2026-09-07')).toBe('1 Eylül');
  });

  it('describes recent times', () => {
    const now = new Date('2026-09-08T12:00:00Z');
    expect(relativeTime('2026-09-08T11:59:50Z', now)).toBe('az önce');
    expect(relativeTime('2026-09-08T11:00:00Z', now)).toContain('saat');
    expect(relativeTime('bozuk', now)).toBe('');
  });

  it('joins a value with its unit', () => {
    expect(withUnit(12430, 'adım')).toBe('12.430 adım');
  });
});
