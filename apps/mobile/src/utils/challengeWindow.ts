import {
  LIMITS,
  addDays,
  effectiveDeadline,
  hhmmToMinutes,
  isBeforeOrEqualHHmm,
  localTimeHHmm,
  nextDayStartTime,
  type ChallengeType,
} from '@koydum/shared';

import { endOfDayInTz, resolveTimezone, safeDayKey, safeTodayKey, zonedInstant } from '@/utils/datetime';

const DAY_MS = 24 * 60 * 60 * 1000;

export type StartMode = 'now' | 'tomorrow';

export interface ChallengeWindow {
  startsAt: string;
  endsAt: string;
  /** "Hemen" was moved to the next day: today's check-in deadline is already gone. */
  startsTomorrow: boolean;
}

/**
 * Start/end as ISO strings; "Hemen" means `now` (the server allows a 5 dk grace).
 *
 * `now` is the SERVER's clock (utils/serverClock): the server refuses a start
 * more than 5 dk in its own past, so a phone running 20 minutes slow could
 * never open a "Hemen" çelınc, and "yarın" is the server's tomorrow.
 *
 * The window is built in the ACCOUNT's zone, because that is the zone the
 * server slices into day keys — and the end is snapped to the last millisecond
 * of the final local day, so "3 gün" really covers three day keys instead of
 * four (which would quietly add a `missingDayPenalty` day to a lower-is-better
 * çelınc). A window too short to be legal falls back to plain 24 h steps.
 *
 * A check-in çelınc's days are its deadlines, so its first day has to be one
 * that can still be played. "Yarın" starts it when the type's window opens
 * (`nextDayStartTime`: erken_kus at 04:00, not 09:00, two hours after its 07:00
 * deadline), and a "Hemen" after today's deadline starts there too: either
 * way "5 gün" used to give four mornings, the first one lost before it began.
 * `deadlineTime` is what the wizard's field holds; while it is half typed the
 * type's own hour stands in, as the server would read it.
 */
export function computeWindow(
  startMode: StartMode,
  days: number,
  tz: string,
  now: Date,
  type?: ChallengeType,
  deadlineTime = ''
): ChallengeWindow {
  const todayKeyLocal = safeTodayKey(tz, now);
  const startsTomorrow =
    startMode === 'now' &&
    type?.metricType === 'checkin_deadline' &&
    !isBeforeOrEqualHHmm(
      localTimeHHmm(now, resolveTimezone(tz)),
      effectiveDeadline(type, deadlineTime.trim())
    );
  const opens = hhmmToMinutes(nextDayStartTime(type));
  const start =
    startMode === 'tomorrow' || startsTomorrow
      ? (zonedInstant(addDays(todayKeyLocal, 1), Math.floor(opens / 60), opens % 60, tz) ??
        new Date(now.getTime() + DAY_MS))
      : now;

  const startKey = safeDayKey(start, tz) ?? todayKeyLocal;
  const lastKey = addDays(startKey, Math.max(1, days) - 1);
  const snapped = endOfDayInTz(lastKey, tz);
  const fallback = new Date(start.getTime() + days * DAY_MS);
  const end =
    snapped && snapped.getTime() - start.getTime() > LIMITS.MIN_DURATION_MS ? snapped : fallback;
  return { startsAt: start.toISOString(), endsAt: end.toISOString(), startsTomorrow };
}
