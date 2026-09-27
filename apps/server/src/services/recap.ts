/**
 * The weekly recap ("haftanın hesabı"): every Sunday evening, in the reader's
 * own timezone, one inbox row with how the week went — how many times they
 * koydu and yedi, how far they walked, and who among their kankalar was the
 * king of the week.
 *
 * It is the one notification that is about the group rather than one çelınc,
 * which is what makes Monday's trash talk start on Sunday night.
 *
 * Rules:
 *   - sent from 20:00 local on Sunday; a server that was off all evening still
 *     sends it on Monday morning (until noon), never later — a recap that shows
 *     up on Wednesday is about nothing;
 *   - once per person per week: `recaps_sent (user_id, week_key)` is the claim,
 *     `week_key` being the local Sunday that ends the week;
 *   - the results window runs from the previous recap to now, so a çelınc
 *     finalised on Sunday at 23:59 is counted next week instead of never — also
 *     when one of the two recaps was a Monday make-up or a DST night sits in
 *     between; only after a skipped week does it shrink to the last 7 days;
 *   - a Monday make-up says "geçen hafta" and "bu hafta rövanş", because by
 *     then it is read in the new week;
 *   - nobody gets an empty recap: no finished çelınc, no steps, nothing running
 *     and no friend who did anything means no row.
 */
import {
  DEFAULT_TIMEZONE,
  addDays,
  dayKeyToUtcDate,
  formatScore,
  localHour,
  todayKey,
  type RecapData,
  type VulgarityLevel,
} from '@koydum/shared';
import { nowIso, type Database, type UserRow } from '../db/index.js';
import { asVulgarityLevel } from '../serialize.js';
import { friendRows } from './friends.js';
import { notify } from './notifications.js';

/** Sunday, 20:00 local: the week is over and the phone is in hand. */
export const RECAP_HOUR = 20;
/** A missed Sunday evening is made up on Monday morning, not later. */
export const RECAP_LATE_UNTIL_HOUR = 12;

const DAY_MS = 24 * 60 * 60_000;
const WEEK_MS = 7 * DAY_MS;
/**
 * How far back the previous recap still counts as "the last one": a week, plus
 * a Monday make-up (16 h), plus a DST hour, plus slack. A recap further back
 * than this means a week was skipped, and the window is just the last 7 days.
 */
const PREVIOUS_RECAP_REACH_MS = 9 * DAY_MS;

const WEEKDAY_TR = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];

/** 0 = Sunday … 6 = Saturday for a `YYYY-MM-DD` key (pure calendar arithmetic). */
function weekdayOf(dayKey: string): number {
  return dayKeyToUtcDate(dayKey).getUTCDay();
}

/**
 * The Sunday whose week is due for a recap at `now` in `timezone`, or null when
 * it is not recap time there. Throws on an unknown timezone (callers skip).
 */
export function recapWeekFor(now: Date, timezone: string): string | null {
  const today = todayKey(timezone, now);
  const hour = localHour(now, timezone);
  const weekday = weekdayOf(today);
  if (weekday === 0 && hour >= RECAP_HOUR) return today;
  if (weekday === 1 && hour < RECAP_LATE_UNTIL_HOUR) return addDays(today, -1);
  return null;
}

interface Candidate {
  id: string;
  displayName: string;
  wins: number;
  steps: number;
}

export interface WeeklyRecap {
  weekStart: string;
  weekEnd: string;
  wins: number;
  losses: number;
  ties: number;
  steps: number;
  bestDay: { dayKey: string; steps: number } | null;
  active: number;
  /** Most wins among the reader and their friends (several on an exact tie). */
  kings: { id: string; displayName: string }[];
  kingWins: number;
  /** Most steps among the reader and their friends, when anybody has a friend. */
  walker: { id: string; displayName: string; steps: number } | null;
}

/**
 * The numbers of one person's week. `since` / `until` bound the results
 * window (ISO instants); the step week is Monday–Sunday of `weekEnd`.
 */
export function buildWeeklyRecap(
  db: Database,
  user: Pick<UserRow, 'id' | 'display_name'>,
  weekEnd: string,
  since: string,
  until: string,
): WeeklyRecap {
  const weekStart = addDays(weekEnd, -6);

  const finished = db
    .prepare(
      `SELECT c.winner_id, c.is_tie FROM challenges c
         JOIN challenge_participants p ON p.challenge_id = c.id AND p.user_id = ? AND p.status = 'accepted'
        WHERE c.status = 'finished' AND c.finalized_at > ? AND c.finalized_at <= ?`,
    )
    .all(user.id, since, until) as { winner_id: string | null; is_tie: number }[];

  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (const row of finished) {
    if (row.is_tie) ties += 1;
    else if (row.winner_id === user.id) wins += 1;
    else if (row.winner_id) losses += 1;
  }

  const stepDays = db
    .prepare('SELECT day_key, steps FROM steps_daily WHERE user_id = ? AND day_key >= ? AND day_key <= ?')
    .all(user.id, weekStart, weekEnd) as { day_key: string; steps: number }[];
  let steps = 0;
  let bestDay: WeeklyRecap['bestDay'] = null;
  for (const day of stepDays) {
    const value = Math.max(0, Number(day.steps) || 0);
    steps += value;
    if (value > 0 && (!bestDay || value > bestDay.steps)) bestDay = { dayKey: day.day_key, steps: value };
  }

  const active = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM challenges c
           JOIN challenge_participants p ON p.challenge_id = c.id AND p.user_id = ? AND p.status = 'accepted'
          WHERE c.status = 'active'`,
      )
      .get(user.id) as { n: number }
  ).n;

  const friends = friendRows(db, user.id);
  const winsOf = db.prepare(
    `SELECT COUNT(*) AS n FROM challenges
      WHERE status = 'finished' AND is_tie = 0 AND winner_id = ? AND finalized_at > ? AND finalized_at <= ?`,
  );
  const stepsOf = db.prepare(
    'SELECT COALESCE(SUM(steps), 0) AS n FROM steps_daily WHERE user_id = ? AND day_key >= ? AND day_key <= ?',
  );
  const candidates: Candidate[] = [
    { id: user.id, displayName: user.display_name, wins, steps },
    ...friends.map((friend) => ({
      id: friend.id,
      displayName: friend.display_name,
      wins: (winsOf.get(friend.id, since, until) as { n: number }).n,
      steps: Math.max(0, Number((stepsOf.get(friend.id, weekStart, weekEnd) as { n: number }).n) || 0),
    })),
  ];

  // the crown goes by wins, then steps; an exact tie on both is shared
  let kings: WeeklyRecap['kings'] = [];
  let kingWins = 0;
  const topWins = Math.max(...candidates.map((c) => c.wins));
  if (topWins > 0) {
    const byWins = candidates.filter((c) => c.wins === topWins);
    const topSteps = Math.max(...byWins.map((c) => c.steps));
    kings = byWins.filter((c) => c.steps === topSteps).map((c) => ({ id: c.id, displayName: c.displayName }));
    kingWins = topWins;
  }

  let walker: WeeklyRecap['walker'] = null;
  if (friends.length > 0) {
    const topSteps = Math.max(...candidates.map((c) => c.steps));
    const walkers = candidates.filter((c) => c.steps === topSteps);
    // a shared first place is not a story; only a clear leader is named
    if (topSteps > 0 && walkers.length === 1) {
      walker = { id: walkers[0].id, displayName: walkers[0].displayName, steps: topSteps };
    }
  }

  return { weekStart, weekEnd, wins, losses, ties, steps, bestDay, active, kings, kingWins, walker };
}

/** True when there is nothing worth telling. */
function isEmpty(recap: WeeklyRecap): boolean {
  return (
    recap.wins + recap.losses + recap.ties === 0 &&
    recap.steps === 0 &&
    recap.active === 0 &&
    recap.kings.length === 0 &&
    recap.walker === null
  );
}

/** "Ali", "Ali ve Veli", "Ali, Veli ve Can". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} ve ${names[names.length - 1]}`;
}

function recapTitle(level: VulgarityLevel): string {
  if (level === 1) return '📊 Haftanın özeti';
  if (level === 3) return '📊 HAFTANIN HESABI 🍆';
  return '📊 Haftanın hesabı';
}

/**
 * How the copy points at weeks. On Sunday evening the week being summed up is
 * "bu hafta" and the next one "haftaya"; a recap that goes out on Monday
 * morning is read in the NEW week, where the same words point one week off.
 */
interface WeekWords {
  /** the week being summed up */
  summed: string;
  /** the week the reader can still do something about */
  coming: string;
}

function weekWords(late: boolean): WeekWords {
  return late ? { summed: 'Geçen hafta', coming: 'Bu hafta' } : { summed: 'Bu hafta', coming: 'Haftaya' };
}

/** "Bu hafta 2 kere koydun, 1 kere yedin." at the reader's level. */
function recordLine(recap: WeeklyRecap, level: VulgarityLevel, week: WeekWords): string {
  const { wins, losses, ties, active } = recap;
  const finished = wins + losses + ties;
  const running = active > 0 ? ` ${active} çelınc hâlâ sürüyor.` : '';
  const when = week.summed;

  if (finished === 0) {
    if (active > 0) {
      return level === 1 ? `${when} biten çelınc olmadı.${running}` : `${when} bir şey bitmedi.${running}`;
    }
    if (level === 1) return `${when} çelınc yoktu.`;
    // "yattın" next to the reader's own step count would be the bot contradicting itself
    if (level === 3) return recap.steps > 0 ? `${when} ne koydun ne yedin, sadece yürüdün 🍆` : `${when} ne koydun ne yedin, yattın 🍆`;
    return `${when} ne koydun ne yedin.`;
  }

  if (level === 1) {
    const parts = [`${wins} galibiyet`, `${losses} mağlubiyet`];
    if (ties > 0) parts.push(`${ties} berabere`);
    return `${when} ${finished} çelınc bitti: ${parts.join(', ')}.${running}`;
  }

  let line: string;
  if (wins > 0 && losses === 0) line = `${when} ${wins} kere koydun, bir kere bile yemedin`;
  else if (wins === 0 && losses > 0) line = `${when} ${losses} kere yedin, bir kere bile koyamadın`;
  else if (wins > 0) line = `${when} ${wins} kere koydun, ${losses} kere yedin`;
  else line = `${when} ${ties} çelınc berabere bitti`;
  if (ties > 0 && (wins > 0 || losses > 0)) line += `, ${ties} berabere`;
  return `${line}${level === 3 ? ' 🍆' : '.'}${running}`;
}

function stepsLine(recap: WeeklyRecap, level: VulgarityLevel): string | null {
  if (recap.steps <= 0) return null;
  const total = formatScore(recap.steps);
  const best = recap.bestDay ? `${WEEKDAY_TR[weekdayOf(recap.bestDay.dayKey)]} (${formatScore(recap.bestDay.steps)})` : null;
  if (level === 1) return `Toplam ${total} adım attın.${best ? ` En iyi günün ${best}.` : ''}`;
  return `${total} adım yürümüşsün${best ? `, en iyi günün ${best}` : ''}.`;
}

function kingLine(recap: WeeklyRecap, readerId: string, level: VulgarityLevel, week: WeekWords): string | null {
  if (recap.kings.length === 0) return null;
  const wins = `${recap.kingWins} galibiyet`;
  const mine = recap.kings.some((king) => king.id === readerId);
  const others = recap.kings.filter((king) => king.id !== readerId).map((king) => king.displayName);

  if (mine && others.length === 0) {
    if (level === 1) return `👑 Haftanın kralı sensin (${wins}).`;
    if (level === 3) return '👑 Haftanın kralı sensin, hepsine koydun 🍆';
    return '👑 Haftanın kralı sensin. Kankalar sana çalışsın.';
  }
  if (mine) return `👑 Tahtı ${joinNames(others)} ile paylaşıyorsun (${wins}).`;
  if (others.length > 1) return `👑 Taht paylaşıldı: ${joinNames(others)} (${wins}).`;
  if (level === 1) return `👑 Haftanın kralı: ${others[0]} (${wins}).`;
  if (level === 3) return `👑 Haftanın kralı ${others[0]}, ${recap.kingWins} kere koydu 🍆 ${week.coming} tahtı sen al.`;
  return `👑 Haftanın kralı ${others[0]}, ${recap.kingWins} kere koydu.`;
}

function walkerLine(recap: WeeklyRecap, readerId: string, level: VulgarityLevel): string | null {
  if (!recap.walker) return null;
  if (recap.walker.id === readerId) {
    return level === 1 ? '🚶 Kankalar arasında en çok sen yürüdün.' : '🚶 Kankalar arasında en çok sen yürüdün, bacaklara sağlık.';
  }
  return `🚶 En çok ${recap.walker.displayName} yürüdü: ${formatScore(recap.walker.steps)} adım.`;
}

/** The last word, only when the week had a verdict and the reader likes a push. */
function closerLine(recap: WeeklyRecap, level: VulgarityLevel, week: WeekWords): string | null {
  if (level === 1) return null;
  if (recap.wins > recap.losses) return level === 3 ? 'Böyle devam, koymaya doyma 🍆' : 'Böyle devam.';
  if (recap.losses > recap.wins) {
    return level === 3 ? `${week.coming} rövanşını al, yoksa yine yersin 🍆` : `${week.coming} rövanş.`;
  }
  return null;
}

/**
 * Title, body and the inbox card's data, all at the reader's level. `late`
 * means the recap goes out on Monday morning, after the week it sums up.
 */
export function recapCopy(
  recap: WeeklyRecap,
  readerId: string,
  level: VulgarityLevel,
  late = false,
): { title: string; body: string; data: RecapData } {
  const week = weekWords(late);
  const record = recordLine(recap, level, week);
  const highlights = [
    kingLine(recap, readerId, level, week),
    walkerLine(recap, readerId, level),
    closerLine(recap, level, week),
  ].filter((line): line is string => line !== null);
  const lines = [record, stepsLine(recap, level), ...highlights].filter((line): line is string => line !== null);
  return {
    title: recapTitle(level),
    body: lines.join('\n'),
    data: {
      weekStart: recap.weekStart,
      weekEnd: recap.weekEnd,
      wins: recap.wins,
      losses: recap.losses,
      ties: recap.ties,
      steps: recap.steps,
      active: recap.active,
      highlights,
    },
  };
}

/**
 * Scheduler step: writes the recap of everybody whose Sunday evening it is.
 * Returns how many were sent.
 */
export function sendWeeklyRecaps(db: Database, now: Date = new Date()): number {
  const until = nowIso(now);
  const floor = new Date(now.getTime() - WEEK_MS).toISOString();
  const reach = new Date(now.getTime() - PREVIOUS_RECAP_REACH_MS).toISOString();
  const users = db.prepare('SELECT * FROM users WHERE deleted_at IS NULL').all() as UserRow[];

  const alreadySent = db.prepare('SELECT 1 FROM recaps_sent WHERE user_id = ? AND week_key = ?');
  const previous = db.prepare('SELECT MAX(sent_at) AS at FROM recaps_sent WHERE user_id = ?');
  const claim = db.prepare('INSERT OR IGNORE INTO recaps_sent (user_id, week_key, sent_at) VALUES (?, ?, ?)');
  let sent = 0;

  for (const user of users) {
    const timezone = user.timezone || DEFAULT_TIMEZONE;
    let weekKey: string | null;
    try {
      weekKey = recapWeekFor(now, timezone);
    } catch {
      continue;
    }
    if (!weekKey || alreadySent.get(user.id, weekKey)) continue;

    // Normally the previous recap: its moment is where this window starts, even
    // when it is a little over 7 days back (a Monday make-up, the hour lost to
    // DST, a later scheduler tick). Only a skipped week falls back to 7 days.
    const last = (previous.get(user.id) as { at: string | null }).at;
    const since = last && last > reach ? last : floor;
    const late = weekKey !== todayKey(timezone, now);

    // claim and write together: a failure half-way must not burn the week
    const delivered = db.transaction(() => {
      if (claim.run(user.id, weekKey, until).changes === 0) return false;
      const recap = buildWeeklyRecap(db, user, weekKey, since, until);
      if (isEmpty(recap)) return false;
      const copy = recapCopy(recap, user.id, asVulgarityLevel(user.vulgarity_max), late);
      notify(db, {
        userId: user.id,
        type: 'recap',
        title: copy.title,
        body: copy.body,
        data: { ...copy.data, weekKey },
        createdAt: until,
      });
      return true;
    })();
    if (delivered) sent += 1;
  }

  return sent;
}
