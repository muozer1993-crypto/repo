/**
 * Timezone-aware day/time helpers.
 *
 * Instants are ISO-8601 UTC strings; "day keys" are `YYYY-MM-DD` in the user's IANA
 * timezone. Everything here is pure; functions that need "now" take it as a parameter.
 */

export const DAY_KEY_REGEX = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const HHMM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export const DEFAULT_TIMEZONE = 'Europe/Istanbul';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(tz, fmt);
  }
  return fmt;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function assertValidDate(date: Date): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new RangeError('Invalid date');
  }
}

/** Break an instant into local wall-clock parts in `tz`. */
export function localParts(date: Date, tz: string): LocalParts {
  assertValidDate(date);
  const fmt = getFormatter(tz);
  const parts: Partial<LocalParts> = {};

  if (typeof fmt.formatToParts === 'function') {
    for (const p of fmt.formatToParts(date)) {
      switch (p.type) {
        case 'year':
          parts.year = Number(p.value);
          break;
        case 'month':
          parts.month = Number(p.value);
          break;
        case 'day':
          parts.day = Number(p.value);
          break;
        case 'hour':
          parts.hour = Number(p.value);
          break;
        case 'minute':
          parts.minute = Number(p.value);
          break;
        default:
          break;
      }
    }
  } else {
    // Engines without formatToParts: en-US renders "MM/DD/YYYY, HH:mm".
    const m = /(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{1,2}):(\d{2})/.exec(fmt.format(date));
    if (!m) throw new Error(`Cannot parse local time for timezone ${tz}`);
    parts.month = Number(m[1]);
    parts.day = Number(m[2]);
    parts.year = Number(m[3]);
    parts.hour = Number(m[4]);
    parts.minute = Number(m[5]);
  }

  const { year, month, day, minute } = parts;
  let { hour } = parts;
  if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined) {
    throw new Error(`Cannot resolve local time for timezone ${tz}`);
  }
  if (hour === 24) hour = 0; // some engines render midnight as 24 with hour12: false
  return { year, month, day, hour, minute };
}

/** `YYYY-MM-DD` of `date` as seen in timezone `tz`. */
export function dayKeyInTz(date: Date, tz: string): string {
  const { year, month, day } = localParts(date, tz);
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

/** `HH:mm` wall-clock time of `date` in `tz`. */
export function localTimeHHmm(date: Date, tz: string): string {
  const { hour, minute } = localParts(date, tz);
  return `${pad2(hour)}:${pad2(minute)}`;
}

/** Local hour (0-23) of `date` in `tz`. */
export function localHour(date: Date, tz: string): number {
  return localParts(date, tz).hour;
}

/** Today's day key in `tz`. `now` is injectable for tests. */
export function todayKey(tz: string, now: Date = new Date()): string {
  return dayKeyInTz(now, tz);
}

/** Strict `YYYY-MM-DD` check including calendar validity (rejects 2023-02-30). */
export function isValidDayKey(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY_KEY_REGEX.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const utc = new Date(Date.UTC(y, m - 1, d));
  return utc.getUTCFullYear() === y && utc.getUTCMonth() === m - 1 && utc.getUTCDate() === d;
}

export function isValidHHmm(value: unknown): value is string {
  return typeof value === 'string' && HHMM_REGEX.test(value);
}

/** True when `tz` is an IANA timezone this runtime understands. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parseDayKey(dayKey: string): [number, number, number] {
  if (!DAY_KEY_REGEX.test(dayKey)) throw new RangeError(`Invalid day key: ${dayKey}`);
  const [y, m, d] = dayKey.split('-').map(Number) as [number, number, number];
  return [y, m, d];
}

/** Midnight UTC of the calendar date named by `dayKey` (pure calendar arithmetic). */
export function dayKeyToUtcDate(dayKey: string): Date {
  const [y, m, d] = parseDayKey(dayKey);
  return new Date(Date.UTC(y, m - 1, d));
}

function utcDateToDayKey(date: Date): string {
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** Add `n` calendar days to a day key (n may be negative). Pure string arithmetic. */
export function addDays(dayKey: string, n: number): string {
  const [y, m, d] = parseDayKey(dayKey);
  return utcDateToDayKey(new Date(Date.UTC(y, m - 1, d + Math.trunc(n))));
}

/** -1 / 0 / 1 like a comparator (`YYYY-MM-DD` sorts lexicographically). */
export function compareDayKeys(a: string, b: string): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Number of calendar days from `a` to `b` (positive when `b` is later). */
export function diffDayKeys(a: string, b: string): number {
  return Math.round((dayKeyToUtcDate(b).getTime() - dayKeyToUtcDate(a).getTime()) / MS_PER_DAY);
}

/**
 * Every day key from the local day of `startIso` through the local day of `endIso`
 * (both boundary days included), computed in `tz`. Empty when end is before start.
 */
export function dayKeysBetween(startIso: string | Date, endIso: string | Date, tz: string): string[] {
  const start = startIso instanceof Date ? startIso : new Date(startIso);
  const end = endIso instanceof Date ? endIso : new Date(endIso);
  assertValidDate(start);
  assertValidDate(end);

  const startKey = dayKeyInTz(start, tz);
  const endKey = dayKeyInTz(end, tz);
  const keys: string[] = [];
  if (compareDayKeys(startKey, endKey) > 0) return keys;

  const count = diffDayKeys(startKey, endKey) + 1;
  for (let i = 0; i < count; i++) keys.push(addDays(startKey, i));
  return keys;
}

/** Minutes since midnight for an `HH:mm` string. */
export function hhmmToMinutes(hhmm: string): number {
  if (!HHMM_REGEX.test(hhmm)) throw new RangeError(`Invalid HH:mm: ${hhmm}`);
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

/** `a <= b` for two `HH:mm` strings (e.g. check-in time vs deadline). */
export function isBeforeOrEqualHHmm(a: string, b: string): boolean {
  return hhmmToMinutes(a) <= hhmmToMinutes(b);
}
