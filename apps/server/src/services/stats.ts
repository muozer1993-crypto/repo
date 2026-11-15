/**
 * User statistics and badges.
 *
 * `computeUserStats` is the single source for every number the app shows on the
 * profile, and the input `evaluateBadges` (shared) needs. Everything is derived
 * from the tables — nothing is denormalised, so a recount is always correct.
 */
import {
  DEFAULT_TIMEZONE,
  MORNING_CHECKIN_TYPE_KEYS,
  badgeTitle,
  diffDayKeys,
  evaluateBadges,
  getBadge,
  todayKey,
  type BadgeStats,
  type UserStats,
} from '@koydum/shared';
import { countOf, nowIso, type BadgeRow, type Database, type UserRow } from '../db/index.js';
import { asVulgarityLevel } from '../serialize.js';
import { notify } from './notifications.js';

/**
 * The stats the API returns. `UserStats` in @koydum/shared already carries every
 * field including `revengeWins`; the alias stays so route code reads clearly.
 */
export type ServerUserStats = UserStats;

/** Longest run of consecutive day keys (already sorted ascending, de-duplicated). */
function longestStreak(dayKeys: string[]): number {
  let best = 0;
  let current = 0;
  let previous: string | null = null;
  for (const key of dayKeys) {
    if (previous !== null && diffDayKeys(previous, key) === 1) current += 1;
    else current = 1;
    previous = key;
    if (current > best) best = current;
  }
  return best;
}

/**
 * Every `BadgeStats` field plus `stepsToday`, which is computed in the user's own
 * timezone (`users.timezone`), so "today" means the same thing on the phone.
 */
export function computeUserStats(db: Database, userId: string, now: Date = new Date()): ServerUserStats {
  const user = db.prepare('SELECT timezone FROM users WHERE id = ?').get(userId) as Pick<UserRow, 'timezone'> | undefined;
  const timezone = user?.timezone ?? DEFAULT_TIMEZONE;

  const wins = countOf(db, "SELECT COUNT(*) AS n FROM challenges WHERE status = 'finished' AND winner_id = ?", userId);

  // "Yediğini geri veriyorsun": a rematch counts only when its winner lost the
  // original (by `losses`' rule below). Winning the rematch of a win again, or one
  // joined later without playing the original, avenges nothing. A rung already
  // stored on the older count stays (badges are never taken back).
  const revengeWins = countOf(
    db,
    `SELECT COUNT(*) AS n FROM challenges c
       JOIN challenges o ON o.id = c.rematch_of_id AND o.status = 'finished'
       JOIN challenge_participants op ON op.challenge_id = o.id AND op.user_id = c.winner_id AND op.status = 'accepted'
      WHERE c.status = 'finished' AND c.is_tie = 0 AND c.winner_id = ?
        AND ((o.is_tie = 0 AND o.winner_id IS NOT NULL AND o.winner_id <> c.winner_id)
          OR (o.is_tie = 1 AND COALESCE(op.final_rank, 1) > 1))`,
    userId,
  );

  // A tie is only a tie for the players sharing first place (`final_rank` 1);
  // whoever finished behind them lost to all of them. A row from before
  // final_rank was written (NULL) keeps counting as the tie it always did.
  const losses = countOf(
    db,
    `SELECT COUNT(*) AS n FROM challenges c
       JOIN challenge_participants p ON p.challenge_id = c.id AND p.user_id = ?
      WHERE c.status = 'finished' AND p.status = 'accepted'
        AND ((c.is_tie = 0 AND c.winner_id IS NOT NULL AND c.winner_id <> ?)
          OR (c.is_tie = 1 AND COALESCE(p.final_rank, 1) > 1))`,
    userId,
    userId,
  );

  const ties = countOf(
    db,
    `SELECT COUNT(*) AS n FROM challenges c
       JOIN challenge_participants p ON p.challenge_id = c.id AND p.user_id = ?
      WHERE c.status = 'finished' AND p.status = 'accepted' AND c.is_tie = 1
        AND COALESCE(p.final_rank, 1) = 1`,
    userId,
  );

  const challengesPlayed = countOf(
    db,
    `SELECT COUNT(*) AS n FROM challenges c
       JOIN challenge_participants p ON p.challenge_id = c.id AND p.user_id = ?
      WHERE p.status = 'accepted' AND c.status IN ('active', 'finished')`,
    userId,
  );

  const tauntsSent = countOf(db, 'SELECT COUNT(*) AS n FROM taunts WHERE from_user_id = ?', userId);
  const tauntsReceived = countOf(db, 'SELECT COUNT(*) AS n FROM taunts WHERE to_user_id = ?', userId);
  const pokesSent = countOf(db, 'SELECT COUNT(*) AS n FROM pokes WHERE from_user_id = ?', userId);
  // `won_before`: a won itiraz filed again on the phone's reading that replaced the number
  const disputesWon = countOf(
    db,
    "SELECT COUNT(*) AS n FROM disputes WHERE by_user_id = ? AND (status = 'upheld' OR won_before = 1)",
    userId,
  );

  const stepsSingleDayMax = countOf(db, 'SELECT COALESCE(MAX(steps), 0) AS n FROM steps_daily WHERE user_id = ?', userId);

  const focusTotalMinutes = countOf(
    db,
    "SELECT COALESCE(SUM(value), 0) AS n FROM entries WHERE user_id = ? AND source = 'focus' AND status <> 'rejected'",
    userId,
  );

  // The "erken kalkma" ladder ("… zamanında kalktın") counts mornings only: an
  // Erken Yatma Sözü night is a check-in too, but seven of them do not make
  // somebody who sleeps till noon a Horoz, and nights must not stitch a run of
  // mornings together. A rung already earned on nights stays (badges are never
  // taken back).
  const morningTypes = MORNING_CHECKIN_TYPE_KEYS.map(() => '?').join(', ');
  const checkinDays = (
    db
      .prepare(
        `SELECT DISTINCT e.day_key FROM entries e
           JOIN challenges c ON c.id = e.challenge_id
          WHERE e.user_id = ? AND e.source = 'checkin' AND e.value > 0 AND e.status <> 'rejected'
            AND c.type_key IN (${morningTypes})
          ORDER BY e.day_key ASC`,
      )
      .all(userId, ...MORNING_CHECKIN_TYPE_KEYS) as { day_key: string }[]
  ).map((row) => row.day_key);

  // A `users.timezone` this runtime does not know (an ICU downgrade, an image
  // rollback, a restored row) throws inside Intl. It must degrade one number, not
  // 500 `/users/:id` and `/leaderboard` for every friend who reads the profile —
  // the same guard the scheduler and the steps sync already use.
  let today: string;
  try {
    today = todayKey(timezone, now);
  } catch {
    today = todayKey(DEFAULT_TIMEZONE, now);
  }
  const stepsToday = countOf(
    db,
    'SELECT COALESCE(steps, 0) AS n FROM steps_daily WHERE user_id = ? AND day_key = ?',
    userId,
    today,
  );

  return {
    wins,
    losses,
    ties,
    tauntsSent,
    tauntsReceived,
    stepsSingleDayMax,
    focusTotalMinutes: Math.round(focusTotalMinutes),
    checkinsStreakMax: longestStreak(checkinDays),
    disputesWon,
    challengesPlayed,
    pokesSent,
    revengeWins,
    stepsToday,
  };
}

/** Badge keys the user already owns. */
export function getBadges(db: Database, userId: string): string[] {
  return (db.prepare('SELECT badge_key FROM badges WHERE user_id = ? ORDER BY earned_at ASC').all(userId) as BadgeRow[]).map(
    (row) => row.badge_key,
  );
}

/**
 * Recomputes stats, stores every newly earned badge and sends one `badge`
 * notification per new badge. Returns the newly earned keys (empty when nothing
 * changed), so callers can decide whether to react.
 */
export function awardBadges(db: Database, userId: string, now: Date = new Date()): string[] {
  const stats: BadgeStats = computeUserStats(db, userId, now);
  const earned = evaluateBadges(stats);
  if (earned.length === 0) return [];

  const owned = new Set(getBadges(db, userId));
  const fresh = earned.filter((key) => !owned.has(key));
  if (fresh.length === 0) return [];

  const insert = db.prepare('INSERT OR IGNORE INTO badges (user_id, badge_key, earned_at) VALUES (?, ?, ?)');
  const earnedAt = nowIso(now);
  const stored: string[] = [];
  const run = db.transaction((keys: string[]) => {
    for (const key of keys) {
      if (insert.run(userId, key, earnedAt).changes > 0) stored.push(key);
    }
  });
  run(fresh);

  // named at the recipient's level: this title is what the lock screen shows
  const user = db.prepare('SELECT vulgarity_max FROM users WHERE id = ?').get(userId) as
    | Pick<UserRow, 'vulgarity_max'>
    | undefined;
  const level = asVulgarityLevel(user?.vulgarity_max ?? 2);
  for (const key of stored) {
    const badge = getBadge(key);
    const named = badge ? badgeTitle(badge, level) : null;
    notify(db, {
      userId,
      type: 'badge',
      title: named ? `${named.emoji} Yeni rozet: ${named.name}` : '🏅 Yeni rozet',
      body: badge?.descriptionTr ?? 'Yeni bir rozet kazandın.',
      data: { badgeKey: key },
      createdAt: earnedAt,
    });
  }

  return stored;
}
