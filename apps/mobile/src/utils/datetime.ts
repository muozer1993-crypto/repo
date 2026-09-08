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

import { DEFAULT_TIMEZONE, dayKeyInTz, dayKeysBetween, isValidTimeZone, todayKey } from '@koydum/shared';

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
