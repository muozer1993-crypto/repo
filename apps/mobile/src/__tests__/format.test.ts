import { formatNumberTr } from '@koydum/shared';

import {
  clockGapTr,
  dateRange,
  formatClock,
  formatDayKey,
  formatDayKeyAttributive,
  formatDayKeyFriendly,
  formatWeekRange,
  formatMinutes,
  formatNumber,
  forHoursTr,
  hoursSince,
  relativeTime,
  withUnit,
} from '@/utils/format';
import { upperTr } from '@/utils/turkish';

describe('Turkish formatting', () => {
  it('groups thousands the Turkish way', () => {
    expect(formatNumber(12430)).toBe('12.430');
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(999)).toBe('999');
    expect(formatNumber(1234567)).toBe('1.234.567');
  });

  it('matches the shared formatter (two decimals)', () => {
    // a typed 2,25 km read "2,3" in the toast and "2,25" on the feed beside it
    expect(formatNumber(5.24)).toBe('5,24');
    expect(formatNumber(2.25)).toBe('2,25');
    expect(formatNumber(0.125)).toBe('0,13');
    expect(formatNumber(5.375)).toBe('5,38');
    expect(formatNumber(5.0)).toBe('5');
    expect(formatNumber(12430)).toBe('12.430');
    expect(formatNumber(-1.5)).toBe('-1,5');
    for (const n of [0, 1, 2.25, 5.375, 583.333, 12430, 1234567.891]) expect(formatNumber(n)).toBe(formatNumberTr(n));
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

  it('writes a week the short way when it stays in one month', () => {
    expect(formatWeekRange('2026-01-05', '2026-01-11')).toBe('5 – 11 Ocak');
    expect(formatWeekRange('2026-09-28', '2026-10-04')).toBe('28 Eylül – 4 Ekim');
  });

  it('names a çelınc\'s days in the reader\'s zone, both ends written out', () => {
    // a one-day çelınc: 09:00 to the last millisecond of 8 Eylül in Istanbul
    expect(dateRange('2026-09-08T06:00:00.000Z', '2026-09-08T20:59:59.999Z', 'Europe/Istanbul')).toBe('8 Eylül');
    // 01:00 on 1 Eylül in Istanbul is still 31 Ağustos in UTC
    expect(dateRange('2026-08-31T22:00:00.000Z', '2026-09-07T20:59:59.999Z', 'Europe/Istanbul')).toBe(
      '1 Eylül – 7 Eylül'
    );
    expect(dateRange('2026-09-28T06:00:00.000Z', '2026-10-04T20:59:59.999Z', 'Europe/Istanbul')).toBe(
      '28 Eylül – 4 Ekim'
    );
    expect(dateRange('bozuk', '2026-10-04T20:59:59.999Z', 'Europe/Istanbul')).toBe('');
  });

  it('describes recent times in Turkish without Intl.RelativeTimeFormat', () => {
    const now = new Date('2026-09-08T12:00:00Z');
    expect(relativeTime('2026-09-08T11:59:50Z', now)).toBe('az önce');
    expect(relativeTime('2026-09-08T11:59:00Z', now)).toBe('1 dakika önce');
    expect(relativeTime('2026-09-08T11:00:00Z', now)).toBe('1 saat önce');
    expect(relativeTime('2026-09-08T09:30:00Z', now)).toBe('3 saat önce');
    expect(relativeTime('2026-09-07T12:00:00Z', now)).toBe('dün');
    expect(relativeTime('2026-09-05T12:00:00Z', now)).toBe('3 gün önce');
    expect(relativeTime('2026-08-20T12:00:00Z', now)).toBe('3 hafta önce');
    expect(relativeTime('2026-09-08T12:10:00Z', now)).toBe('10 dakika sonra');
    expect(relativeTime('2026-09-09T12:00:00Z', now)).toBe('yarın');
    expect(relativeTime('bozuk', now)).toBe('');
  });

  it('counts days on the calendar of the zone the date beside it is in', () => {
    const tz = 'Europe/Istanbul';
    // 09:00 on 31 Aralık read at 21:00 on 1 Ocak: 36 hours, but the row says "Dün"
    expect(relativeTime('2026-12-31T06:00:00Z', new Date('2027-01-01T18:00:00Z'), tz)).toBe('dün');
    expect(relativeTime('2026-12-31T06:00:00Z', new Date('2027-01-01T18:00:00Z'))).toBe('2 gün önce');
    // 22:00 on 31 Aralık read at 08:00 on 2 Ocak: 34 hours under a "31 Aralık"
    expect(relativeTime('2026-12-31T19:00:00Z', new Date('2027-01-02T05:00:00Z'), tz)).toBe('2 gün önce');
    expect(relativeTime('2026-12-31T19:00:00Z', new Date('2027-01-02T05:00:00Z'))).toBe('dün');
    // a çelınc closed at 00:10 on 31 Aralık is "dün" all of 1 Ocak, late or early
    expect(relativeTime('2026-12-30T21:10:00Z', new Date('2027-01-01T20:00:00Z'), tz)).toBe('dün');
    expect(relativeTime('2026-12-30T21:10:00Z', new Date('2027-01-01T06:00:00Z'), tz)).toBe('dün');
    // late last evening is two days back once midnight has passed here, though
    // in UTC both moments still sit a day apart
    expect(relativeTime('2026-12-31T20:50:00Z', new Date('2027-01-01T21:10:00Z'), tz)).toBe('2 gün önce');
    expect(relativeTime('2026-12-31T20:50:00Z', new Date('2027-01-01T21:10:00Z'), 'UTC')).toBe('dün');
    // under a day it stays hours, whichever days the two ends fall on
    expect(relativeTime('2026-12-31T20:50:00Z', new Date('2027-01-01T06:00:00Z'), tz)).toBe('9 saat önce');
    // ahead too: 07:00 on 3 Ocak seen at 21:00 on 1 Ocak is 34 hours away
    expect(relativeTime('2027-01-03T04:00:00Z', new Date('2027-01-01T18:00:00Z'), tz)).toBe('2 gün sonra');
    expect(relativeTime('2027-01-03T04:00:00Z', new Date('2027-01-01T18:00:00Z'))).toBe('yarın');
    // the night the clocks go back has 25 hours: 00:10 to 23:50 is the same day
    expect(relativeTime('2026-10-24T22:10:00Z', new Date('2026-10-25T22:50:00Z'), 'Europe/Berlin')).toBe(
      '25 saat önce'
    );
  });

  it('counts how long a phone has been quiet, the way people say it', () => {
    const now = Date.parse('2026-09-08T12:00:00Z');
    expect(hoursSince('2026-09-08T08:59:00Z', now)).toBe(3);
    expect(hoursSince('2026-09-08T09:01:00Z', now)).toBe(2);
    // a phone clock ahead of the server's is not "-1 saattir"
    expect(hoursSince('2026-09-08T12:30:00Z', now)).toBe(0);
    expect(hoursSince('bozuk', now)).toBeNull();
    expect(forHoursTr(5)).toBe('5 saattir');
    expect(forHoursTr(47)).toBe('47 saattir');
    expect(forHoursTr(50)).toBe('2 gündür');
  });

  it('says how far apart two clocks are, whichever is ahead', () => {
    expect(clockGapTr(20 * 60_000)).toBe('20 dakika');
    // a reading a few seconds either side of the hour is still that hour
    expect(clockGapTr(-(3 * 3_600_000 - 2_000))).toBe('3 saat');
    expect(clockGapTr(3 * 3_600_000 + 5 * 60_000)).toBe('3 saat 5 dakika');
    expect(clockGapTr(4 * 24 * 3_600_000)).toBe('4 gün');
  });

  it('joins a value with its unit', () => {
    expect(withUnit(12430, 'adım')).toBe('12.430 adım');
  });
});

describe('upperTr', () => {
  it('capitalises the Turkish way on any engine', () => {
    expect(upperTr('Yedin')).toBe('YEDİN');
    expect(upperTr('Hepsini okundu yap')).toBe('HEPSİNİ OKUNDU YAP');
    expect(upperTr('çelınc ığdır')).toBe('ÇELINC IĞDIR');
  });
});

describe('formatDayKeyAttributive', () => {
  it('names the day before a noun, with no suffix glued to "Bugün"', () => {
    expect(formatDayKeyAttributive('2026-09-08', '2026-09-08', '2026-09-07')).toBe('bugünkü');
    expect(formatDayKeyAttributive('2026-09-07', '2026-09-08', '2026-09-07')).toBe('dünkü');
    expect(formatDayKeyAttributive('2026-09-01', '2026-09-08', '2026-09-07')).toBe('1 Eylül günkü');
  });
});
