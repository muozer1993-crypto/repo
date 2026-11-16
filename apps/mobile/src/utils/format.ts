import { diffDayKeys, formatDayKeyTr, formatNumberTr } from '@koydum/shared';

import { safeDayKey } from '@/utils/datetime';

/** Turkish-locale formatting helpers shared by every screen. */

/**
 * `12430` -> "12.430", `2.25` -> "2,25": the shared formatter the standings,
 * the feed, the push and the taunts print with. Rounding to one decimal here
 * put "Yazıldı 2,3 km" under a feed row saying "2,25 km".
 */
export function formatNumber(value: number): string {
  return formatNumberTr(value);
}

/**
 * A sum or a difference of typed numbers without JavaScript's float noise:
 * 14,4 + 59,7 + 15,9 km is 90.00000000000001 here, which left 9.99999... of a
 * 100 km day: shown as "9,99", greying out a "+10" and refusing the 10 the
 * server takes (its SUM is exactly 90); 100 - 57,7 put "42,300000000000004" in
 * the field. Six decimals is far finer than anything typed and far coarser
 * than the noise.
 */
export function dropFloatNoise(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** 90 -> "1sa 30dk", 45 -> "45dk" */
export function formatMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h}sa ${m}dk`;
  if (h) return `${h}sa`;
  return `${m}dk`;
}

/** seconds -> "24:59" */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * "3 dakika önce" / "2 gün sonra", written by hand.
 *
 * Not `Intl.RelativeTimeFormat`: Hermes on Android does not ship it, so
 * `new Intl.RelativeTimeFormat(...)` throws "undefined cannot be used as a
 * constructor" on a real phone — which took the inbox and every challenge
 * screen down while the web build, on V8, was fine. Turkish needs no plural
 * agreement here, so a table is all it takes.
 */
const RELATIVE_STEPS: [limitSeconds: number, divisor: number, unitTr: string][] = [
  [60, 1, 'saniye'],
  [3600, 60, 'dakika'],
  [86400, 3600, 'saat'],
  [604800, 86400, 'gün'],
  [2629800, 604800, 'hafta'],
  [31557600, 2629800, 'ay'],
  [Infinity, 31557600, 'yıl'],
];

function relativePhrase(count: number, unit: string, past: boolean): string {
  if (count === 1 && unit === 'gün') return past ? 'dün' : 'yarın';
  return past ? `${count} ${unit} önce` : `${count} ${unit} sonra`;
}

/**
 * Pass the zone the date beside it is written in (the feed's "Dün", the
 * inbox's day header, the results' range) and a gap of a day or more counts
 * the calendar days there instead of rounding hours: 22:00 on 31 Aralık read
 * at 08:00 on 2 Ocak is 34 hours, which rounded to "dün" under "31 Aralık",
 * and 09:00 the day before read at 21:00 was "2 gün önce" under "Dün".
 */
export function relativeTime(iso: string, now: Date = new Date(), tz?: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const deltaSeconds = (then - now.getTime()) / 1000;
  const past = deltaSeconds < 0;
  const abs = Math.abs(deltaSeconds);
  if (abs < 45) return 'az önce';
  const step = RELATIVE_STEPS.find(([limit]) => abs < limit) ?? RELATIVE_STEPS[RELATIVE_STEPS.length - 1];
  const [, divisor, unit] = step;
  if (unit === 'gün' && tz) {
    const thenKey = safeDayKey(iso, tz);
    const nowKey = safeDayKey(now, tz);
    if (thenKey && nowKey) {
      const days = Math.abs(diffDayKeys(thenKey, nowKey));
      // the 25-hour day the clocks go back on holds two instants a day apart
      if (days === 0) return relativePhrase(Math.round(abs / 3600), 'saat', past);
      return relativePhrase(days, 'gün', past);
    }
  }
  return relativePhrase(Math.max(1, Math.round(abs / divisor)), unit, past);
}

/**
 * Whole hours from `iso` to `now` (epoch ms), never below 0; null when `iso`
 * cannot be read. The caller hands in `now` (the last fetch), so a screen does
 * not read the clock during render.
 */
export function hoursSince(iso: string, now: number): number | null {
  const then = Date.parse(iso);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return null;
  return Math.max(0, Math.floor((now - then) / 3_600_000));
}

/**
 * How long something has been going on: "5 saattir", "3 gündür". Past two
 * days a count of hours stops meaning anything to a reader, so it counts days.
 */
export function forHoursTr(hours: number): string {
  if (hours < 48) return `${hours} saattir`;
  return `${Math.floor(hours / 24)} gündür`;
}

/**
 * A gap between two clocks, either way round: "20 dakika", "3 saat", "3 saat
 * 5 dakika", "4 gün". Whole minutes, and past two days whole days, like
 * forHoursTr.
 */
export function clockGapTr(ms: number): string {
  const minutes = Math.round(Math.abs(ms) / 60_000);
  if (minutes < 60) return `${minutes} dakika`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 48) return `${Math.round(hours / 24)} gün`;
  const rest = minutes % 60;
  return rest ? `${hours} saat ${rest} dakika` : `${hours} saat`;
}

/**
 * "2026-09-08" -> "8 Eylül" / "8 Eylül Salı". The table lives in the shared
 * package, so a day reads the same on screen and in the server's push copy.
 */
export const formatDayKey = formatDayKeyTr;

/** "2026-01-05".."2026-01-11" -> "5 – 11 Ocak"; across months "29 Eylül – 5 Ekim" */
export function formatWeekRange(startKey: string, endKey: string): string {
  const start = formatDayKey(startKey);
  const end = formatDayKey(endKey);
  const [startDay, ...startMonth] = start.split(' ');
  const [, ...endMonth] = end.split(' ');
  if (startMonth.length > 0 && startMonth.join(' ') === endMonth.join(' ')) return `${startDay} – ${end}`;
  return `${start} – ${end}`;
}

/** "1 Eylül – 8 Eylül" in the reader's timezone. */
export function dateRange(startsAt: string, endsAt: string, tz: string): string {
  const startKey = safeDayKey(startsAt, tz);
  const endKey = safeDayKey(endsAt, tz);
  if (!startKey || !endKey) return '';
  if (startKey === endKey) return formatDayKey(startKey);
  return `${formatDayKey(startKey)} – ${formatDayKey(endKey)}`;
}

/** "2026-09-08" -> "Bugün" / "Dün" / "8 Eylül" */
export function formatDayKeyFriendly(dayKey: string, todayKey: string, yesterdayKey: string): string {
  if (dayKey === todayKey) return 'Bugün';
  if (dayKey === yesterdayKey) return 'Dün';
  return formatDayKey(dayKey);
}

/**
 * The same day as an adjective before a noun: "bugünkü", "dünkü", "8 Eylül
 * günkü" girişin. A bare "Bugün girişine" reads as "to Today's entry" with the
 * suffix glued to the wrong word.
 */
export function formatDayKeyAttributive(dayKey: string, todayKey: string, yesterdayKey: string): string {
  if (dayKey === todayKey) return 'bugünkü';
  if (dayKey === yesterdayKey) return 'dünkü';
  return `${formatDayKey(dayKey)} günkü`;
}

/**
 * "14:30" from an ISO timestamp. Pass the account's IANA zone whenever the time
 * is read against something the server decided in that zone (a check-in
 * deadline, a challenge window); without it the device zone is used, which can
 * show "07:15" next to a 07:30 deadline the server already counted as late.
 */
export function formatTime(iso: string, tz?: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
  if (tz) {
    try {
      return date.toLocaleTimeString('tr-TR', { ...options, timeZone: tz });
    } catch {
      // an unusable zone from the wire: fall back to the device
    }
  }
  return date.toLocaleTimeString('tr-TR', options);
}

/** Turkish plural-free unit joining: 12.430 adım */
export function withUnit(value: number, unit: string): string {
  return `${formatNumber(value)} ${unit}`;
}
