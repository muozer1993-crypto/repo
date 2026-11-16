import { effectiveDeadline, hhmmToMinutes, requireChallengeType } from '@koydum/shared';

import { computeWindow, type ChallengeWindow } from '@/utils/challengeWindow';
import { safeDayKeysBetween, zonedInstant } from '@/utils/datetime';

/**
 * The wizard's start and end. A check-in çelınc's "N gün" is N deadlines, so
 * its first day has to be one that can still be played.
 */
const IST = 'Europe/Istanbul'; // no DST since 2016: an evening is an evening
const NEW_YEARS_EVE_22 = new Date('2026-12-31T19:00:00.000Z'); // 22:00 in Istanbul
const ERKEN_KUS = requireChallengeType('erken_kus'); // 04:00 – 07:00
const YATAK = requireChallengeType('yatak_toplama'); // 05:00 – 09:00
const ERKEN_YAT = requireChallengeType('erken_yat'); // 19:00 – 23:00
const ADIM = requireChallengeType('adim_yarisi');

/**
 * The deadlines that fall inside the window: what the players can actually
 * score. The rules card counts the day keys (`📅 N gün`); the two must agree.
 */
function playableDeadlines(window: ChallengeWindow, deadline: string): number {
  const start = Date.parse(window.startsAt);
  const end = Date.parse(window.endsAt);
  const minutes = hhmmToMinutes(deadline);
  return safeDayKeysBetween(window.startsAt, window.endsAt, IST).filter((key) => {
    const at = zonedInstant(key, Math.floor(minutes / 60), minutes % 60, IST);
    // a check-in stamped with the deadline's minute is still on time
    return !!at && at.getTime() + 59_999 >= start && at.getTime() <= end;
  }).length;
}

describe('a check-in çelınc opened in the evening', () => {
  it('starts "Yarın" when the window opens, so five days are five mornings', () => {
    const window = computeWindow('tomorrow', 5, IST, NEW_YEARS_EVE_22, ERKEN_KUS, '07:00');
    expect(window).toEqual({
      startsAt: '2027-01-01T01:00:00.000Z', // 04:00, not 09:00, two hours after the first deadline
      endsAt: '2027-01-05T20:59:59.999Z',
      startsTomorrow: false,
    });
  });

  it('starts yatak_toplama at 05:00 and erken_yat at 09:00 as before', () => {
    expect(computeWindow('tomorrow', 5, IST, NEW_YEARS_EVE_22, YATAK, '09:00').startsAt).toBe(
      '2027-01-01T02:00:00.000Z'
    );
    expect(computeWindow('tomorrow', 5, IST, NEW_YEARS_EVE_22, ERKEN_YAT, '23:00').startsAt).toBe(
      '2027-01-01T06:00:00.000Z'
    );
  });

  it('moves a "Hemen" past today\'s deadline to the same start as "Yarın"', () => {
    const now = computeWindow('now', 5, IST, NEW_YEARS_EVE_22, ERKEN_KUS, '07:00');
    const tomorrow = computeWindow('tomorrow', 5, IST, NEW_YEARS_EVE_22, ERKEN_KUS, '07:00');
    expect(now).toEqual({ ...tomorrow, startsTomorrow: true });
  });

  it('starts a "Hemen" at once while today\'s deadline is still ahead', () => {
    const threeAm = new Date('2027-01-01T00:00:00.000Z'); // 03:00 in Istanbul
    expect(computeWindow('now', 5, IST, threeAm, ERKEN_KUS, '07:00')).toEqual({
      startsAt: threeAm.toISOString(),
      endsAt: '2027-01-05T20:59:59.999Z',
      startsTomorrow: false,
    });
    // erken_yat at 22:00: tonight's 23:00 can still be met
    expect(computeWindow('now', 5, IST, NEW_YEARS_EVE_22, ERKEN_YAT, '23:00')).toMatchObject({
      startsAt: NEW_YEARS_EVE_22.toISOString(),
      startsTomorrow: false,
    });
    // the deadline's own minute is on time on the server too
    const sevenAm = new Date('2027-01-01T04:00:30.000Z');
    expect(computeWindow('now', 5, IST, sevenAm, ERKEN_KUS, '07:00').startsAt).toBe(sevenAm.toISOString());
  });

  it('goes by the hour typed, and by the type\'s own while it is half typed', () => {
    // an erken_kus at 23:30 tonight can still be played tonight
    expect(computeWindow('now', 5, IST, NEW_YEARS_EVE_22, ERKEN_KUS, '23:30').startsTomorrow).toBe(false);
    expect(computeWindow('now', 5, IST, NEW_YEARS_EVE_22, ERKEN_KUS, '23:').startsTomorrow).toBe(true);
  });

  it('gives as many playable deadlines as the days picked, whatever the type and start', () => {
    for (const [type, deadline] of [
      [ERKEN_KUS, '07:00'],
      [YATAK, '09:00'],
      [ERKEN_YAT, '23:00'],
    ] as const) {
      expect(effectiveDeadline(type, deadline)).toBe(deadline);
      for (const startMode of ['now', 'tomorrow'] as const) {
        for (const days of [1, 5, 7]) {
          const window = computeWindow(startMode, days, IST, NEW_YEARS_EVE_22, type, deadline);
          const label = `${type.key} ${startMode} ${days}`;
          expect({ label, days: safeDayKeysBetween(window.startsAt, window.endsAt, IST).length }).toEqual({
            label,
            days,
          });
          expect({ label, deadlines: playableDeadlines(window, deadline) }).toEqual({ label, deadlines: days });
        }
      }
    }
  });
});

describe('every other çelınc', () => {
  it('keeps "Yarın 09:00" and a "Hemen" that starts now, evening or not', () => {
    for (const type of [ADIM, undefined]) {
      expect(computeWindow('tomorrow', 3, IST, NEW_YEARS_EVE_22, type)).toEqual({
        startsAt: '2027-01-01T06:00:00.000Z',
        endsAt: '2027-01-03T20:59:59.999Z',
        startsTomorrow: false,
      });
      expect(computeWindow('now', 3, IST, NEW_YEARS_EVE_22, type)).toEqual({
        startsAt: NEW_YEARS_EVE_22.toISOString(),
        endsAt: '2027-01-02T20:59:59.999Z',
        startsTomorrow: false,
      });
    }
  });

  it('still runs a one-day "Hemen" opened just before midnight for 24 hours', () => {
    const lateNight = new Date('2026-12-31T20:58:00.000Z'); // 23:58
    expect(computeWindow('now', 1, IST, lateNight, ADIM).endsAt).toBe('2027-01-01T20:58:00.000Z');
  });
});
