/**
 * Timezone-safe wrappers around `@koydum/shared/time`.
 *
 * Every day-key helper in shared throws — `Intl.DateTimeFormat` raises a
 * RangeError for an unknown IANA zone, and `assertValidDate` raises one for a
 * malformed ISO string. Both inputs come off the wire (`me.timezone`,
 * `challenge.startsAt`), so a single bad row from the server would otherwise
 * take a whole screen down during render. These wrappers degrade instead:
 * a bad zone falls back to `Europe/Istanbul`, a bad date yields null / [].
 */

import {
  DEFAULT_TIMEZONE,
  addDays,
  dayKeyInTz,
  dayKeysBetween,
  isValidTimeZone,
  localParts,
  todayKey,
} from '@koydum/shared';

/** First usable IANA zone out of the candidates, else `Europe/Istanbul`. */
export function resolveTimezone(...candidates: (string | null | undefined)[]): string {
  for (const candidate of candidates) {
    if (isValidTimeZone(candidate)) return candidate;
  }
  return DEFAULT_TIMEZONE;
}

/** Today's `YYYY-MM-DD` in `tz`, never throwing. */
export function safeTodayKey(tz: string, now: Date = new Date()): string {
  try {
    return todayKey(tz, now);
  } catch {
    return todayKey(DEFAULT_TIMEZONE, now);
  }
}

/** `YYYY-MM-DD` for an ISO instant in `tz`; null when the instant is unusable. */
export function safeDayKey(iso: string | Date | null | undefined, tz: string): string | null {
  if (iso === null || iso === undefined) return null;
  const date = iso instanceof Date ? iso : new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    return dayKeyInTz(date, tz);
  } catch {
    try {
      return dayKeyInTz(date, DEFAULT_TIMEZONE);
    } catch {
      return null;
    }
  }
}

/** Every day key covered by a challenge window; empty when either end is unusable. */
export function safeDayKeysBetween(
  startIso: string | Date | null | undefined,
  endIso: string | Date | null | undefined,
  tz: string
): string[] {
  if (startIso === null || startIso === undefined || endIso === null || endIso === undefined) return [];
  try {
    return dayKeysBetween(startIso, endIso, tz);
  } catch {
    return [];
  }
}

/** Milliseconds `tz` is ahead of UTC at `date` (minute resolution). */
function offsetMs(date: Date, tz: string): number {
  const parts = localParts(date, tz);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
  // `localParts` has no seconds, so compare against the same truncated instant
  const truncated = Math.floor(date.getTime() / 60_000) * 60_000;
  return asUtc - truncated;
}

/**
 * The instant at which the clock in `tz` reads `dayKey` at `hour:minute`.
 *
 * The create wizard builds a challenge window the SERVER will slice into day
 * keys in the account's zone, so "yarın 09:00" has to mean 09:00 there — not
 * 09:00 wherever the phone happens to be. Null when the inputs are unusable.
 */
export function zonedInstant(
  dayKey: string,
  hour: number,
  minute: number,
  tz: string
): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) return null;
  const wall = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), hour, minute, 0, 0);
  const zone = isValidTimeZone(tz) ? tz : DEFAULT_TIMEZONE;
  try {
    // one refinement pass so a DST boundary resolves to the right side
    const first = wall - offsetMs(new Date(wall), zone);
    const second = wall - offsetMs(new Date(first), zone);
    return Number.isFinite(second) ? new Date(second) : null;
  } catch {
    return null;
  }
}

/** The last millisecond of `dayKey` in `tz`; null when it cannot be resolved. */
export function endOfDayInTz(dayKey: string, tz: string): Date | null {
  const nextMidnight = zonedInstant(addDays(dayKey, 1), 0, 0, tz);
  return nextMidnight ? new Date(nextMidnight.getTime() - 1) : null;
}
