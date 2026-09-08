/** Turkish-locale formatting helpers shared by every screen. */

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.abs(value % 1) < 1e-9 ? Math.round(value) : Math.round(value * 10) / 10;
  return rounded.toLocaleString('tr-TR');
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

const RELATIVE_STEPS: [limitSeconds: number, divisor: number, unit: Intl.RelativeTimeFormatUnit][] = [
  [60, 1, 'second'],
  [3600, 60, 'minute'],
  [86400, 3600, 'hour'],
  [604800, 86400, 'day'],
  [2629800, 604800, 'week'],
  [31557600, 2629800, 'month'],
  [Infinity, 31557600, 'year'],
];

/** "3 dakika önce" / "2 gün önce" */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const deltaSeconds = (then - now.getTime()) / 1000;
  const abs = Math.abs(deltaSeconds);
  if (abs < 45) return 'az önce';
  const formatter = new Intl.RelativeTimeFormat('tr-TR', { numeric: 'auto' });
  for (const [limit, divisor, unit] of RELATIVE_STEPS) {
    if (abs < limit) return formatter.format(Math.round(deltaSeconds / divisor), unit);
  }
  return formatter.format(Math.round(deltaSeconds / 31557600), 'year');
}

const TR_MONTHS = [
  'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
  'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık',
];
const TR_DAYS = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];

/** "2026-09-08" -> "8 Eylül Salı" (no timezone maths: day keys are already local) */
export function formatDayKey(dayKey: string, opts: { withWeekday?: boolean } = {}): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!m) return dayKey;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  const label = `${Number(d)} ${TR_MONTHS[Number(mo) - 1]}`;
  return opts.withWeekday ? `${label} ${TR_DAYS[date.getUTCDay()]}` : label;
}

/** "2026-09-08" -> "Bugün" / "Dün" / "8 Eylül" */
export function formatDayKeyFriendly(dayKey: string, todayKey: string, yesterdayKey: string): string {
  if (dayKey === todayKey) return 'Bugün';
  if (dayKey === yesterdayKey) return 'Dün';
  return formatDayKey(dayKey);
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
