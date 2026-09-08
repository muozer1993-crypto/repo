/**
 * Challenge lifecycle: standings, activation, finalization, cancellation, reminders.
 *
 * Timezone policy for standings (SPEC: day keys live in the USER's timezone):
 *   - a participant's OWN entries are written with their own local day key, so the
 *     score of a participant is always computed from their own days;
 *   - the day WINDOW handed to `computeScore` is the UNION of every accepted
 *     participant's `dayKeysBetween(startsAt, endsAt, tz)`. The window only affects
 *     the `manual_lower_is_better` missing-day penalty, and using the union means
 *     everybody is measured against the same number of days — otherwise a friend in
 *     a different timezone could face a different denominator for the same challenge.
 *     (Across timezones the window differs by at most one day.)
 */
import {
  DEFAULT_TIMEZONE,
  dayKeysBetween,
  localHour,
  rankParticipants,
  requireChallengeType,
  scoreLabel,
  t,
  todayKey,
  type ChallengeType,
  type ParticipantView,
  type ScoreInput,
  type VulgarityLevel,
} from '@koydum/shared';
import {
  nowIso,
  type ChallengeRow,
  type Database,
  type EntryRow,
  type ParticipantRow,
  type UserRow,
} from '../db/index.js';
import { asVulgarityLevel, toPublicUser } from '../serialize.js';
import { notify } from './notifications.js';
import { awardBadges } from './stats.js';

export interface SchedulerSummary {
  activated: number;
  finalized: number;
  cancelled: number;
  reminders: number;
}

export interface SchedulerDeps {
  /** Called for anything that goes wrong inside one step (never throws out). */
  onError?: (step: string, err: unknown) => void;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Line-up order: the creator first, then everybody in the order they were invited.
 *
 * The last tiebreak is `rowid` (insertion order) rather than `user_id`, because
 * user ids are random UUIDs — with an equal timestamp that would shuffle the
 * line-up on every run, and `computeStandings` sorts on rank alone (a stable
 * sort), so two tied players would swap places between two reads of the same
 * finished challenge.
 */
export function participantRows(db: Database, challengeId: string): ParticipantRow[] {
  return db
    .prepare('SELECT * FROM challenge_participants WHERE challenge_id = ? ORDER BY invited_at ASC, rowid ASC')
    .all(challengeId) as ParticipantRow[];
}

export function acceptedParticipants(db: Database, challengeId: string): ParticipantRow[] {
  return db
    .prepare("SELECT * FROM challenge_participants WHERE challenge_id = ? AND status = 'accepted' ORDER BY joined_at ASC, rowid ASC")
    .all(challengeId) as ParticipantRow[];
}

export function getChallengeRow(db: Database, challengeId: string): ChallengeRow | undefined {
  return db.prepare('SELECT * FROM challenges WHERE id = ?').get(challengeId) as ChallengeRow | undefined;
}

/**
 * The catalog type of a challenge. Falls back to a synthetic type built from the
 * columns so an unknown/retired catalog key can still be scored and displayed.
 */
export function typeForChallenge(challenge: ChallengeRow): ChallengeType {
  try {
    return requireChallengeType(challenge.type_key);
  } catch {
    return {
      key: challenge.type_key,
      nameTr: challenge.title,
      emoji: '🎯',
      metricType: challenge.metric_type as ChallengeType['metricType'],
      unitTr: challenge.unit,
      direction: challenge.direction as ChallengeType['direction'],
      descriptionTr: '',
      descriptionPoliteTr: '',
      howMeasuredTr: '',
      defaultDurationDays: 7,
      suggestedRewardTr: '',
      antiCheatTr: '',
      proofRequired: challenge.proof_required === 1,
      category: 'diger',
      maxPerEntry: Number.MAX_SAFE_INTEGER,
      maxPerDay: Number.MAX_SAFE_INTEGER,
    };
  }
}

function userMap(db: Database, ids: string[]): Map<string, UserRow> {
  const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
  const map = new Map<string, UserRow>();
  for (const id of ids) {
    const row = stmt.get(id) as UserRow | undefined;
    if (row) map.set(id, row);
  }
  return map;
}

/**
 * Union of every accepted participant's local day window (see the file header).
 * Falls back to the creator's timezone when nobody has accepted yet.
 */
export function challengeDayKeys(db: Database, challenge: ChallengeRow): string[] {
  const accepted = acceptedParticipants(db, challenge.id);
  const users = userMap(
    db,
    accepted.length > 0 ? accepted.map((p) => p.user_id) : [challenge.creator_id],
  );
  const timezones = new Set<string>();
  for (const user of users.values()) timezones.add(user.timezone || DEFAULT_TIMEZONE);
  if (timezones.size === 0) timezones.add(DEFAULT_TIMEZONE);

  const keys = new Set<string>();
  for (const tz of timezones) {
    try {
      for (const key of dayKeysBetween(challenge.starts_at, challenge.ends_at, tz)) keys.add(key);
    } catch {
      for (const key of dayKeysBetween(challenge.starts_at, challenge.ends_at, DEFAULT_TIMEZONE)) keys.add(key);
    }
  }
  return [...keys].sort();
}

/**
 * Standings for one challenge.
 *
 * Accepted participants are ranked with the shared `rankParticipants`; invited /
 * declined / left participants are appended with `rank: 0` (unranked) so the app
 * can still show them. A finished challenge reports the scores stored at
 * finalization time, so results never drift.
 */
export function computeStandings(db: Database, challenge: ChallengeRow): ParticipantView[] {
  const type = typeForChallenge(challenge);
  const participants = participantRows(db, challenge.id);
  const users = userMap(db, participants.map((p) => p.user_id));

  const entries = db
    .prepare('SELECT * FROM entries WHERE challenge_id = ?')
    .all(challenge.id) as EntryRow[];

  const byUser = new Map<string, ScoreInput['entries']>();
  const lastEntryAt = new Map<string, string>();
  for (const entry of entries) {
    const list = byUser.get(entry.user_id) ?? [];
    list.push({ dayKey: entry.day_key, value: Number(entry.value), status: entry.status as ScoreInput['entries'][number]['status'] });
    byUser.set(entry.user_id, list);
    const previous = lastEntryAt.get(entry.user_id);
    if (!previous || entry.created_at > previous) lastEntryAt.set(entry.user_id, entry.created_at);
  }

  const accepted = participants.filter((p) => p.status === 'accepted');
  const dayKeys = challengeDayKeys(db, challenge);
  const ranking = rankParticipants(
    type,
    dayKeys,
    accepted.map((p) => ({ userId: p.user_id, entries: byUser.get(p.user_id) ?? [] })),
  );
  const byUserResult = new Map(ranking.results.map((r) => [r.userId, r]));

  const finished = challenge.status === 'finished';
  const views: ParticipantView[] = [];

  for (const participant of accepted) {
    const user = users.get(participant.user_id);
    if (!user) continue;
    const computed = byUserResult.get(participant.user_id);
    const useStored = finished && participant.final_rank !== null;
    views.push({
      user: toPublicUser(user),
      status: 'accepted',
      score: useStored ? Number(participant.final_score ?? 0) : (computed?.score ?? 0),
      days: computed?.days ?? 0,
      rank: useStored ? Number(participant.final_rank) : (computed?.rank ?? 0),
      lastEntryAt: lastEntryAt.get(participant.user_id) ?? null,
      isWinner: finished ? challenge.winner_id === participant.user_id : (computed?.isWinner ?? false),
    });
  }

  views.sort((a, b) => a.rank - b.rank);

  for (const participant of participants) {
    if (participant.status === 'accepted') continue;
    const user = users.get(participant.user_id);
    if (!user) continue;
    views.push({
      user: toPublicUser(user),
      status: participant.status as ParticipantView['status'],
      score: 0,
      days: 0,
      rank: 0,
      lastEntryAt: lastEntryAt.get(participant.user_id) ?? null,
      isWinner: false,
    });
  }

  return views;
}

// ---------------------------------------------------------------------------
// Notification copy (always rendered at the RECIPIENT's vulgarity level)
// ---------------------------------------------------------------------------

function levelOf(user: UserRow): VulgarityLevel {
  return asVulgarityLevel(user.vulgarity_max);
}

function startedCopy(level: VulgarityLevel, title: string): { title: string; body: string } {
  if (level === 1) return { title: '🔔 Çelinç başladı', body: `${title} başladı. Bol şans, elinden geleni yap.` };
  if (level === 3) return { title: '🍆 ÇELİNÇ BAŞLADI', body: `${title} başladı. Ya koyarsın ya yersin, üçüncü yol yok.` };
  return { title: '🔥 Çelinç başladı', body: `${title} başladı lan. Koymaya bak, gevşeme.` };
}

/**
 * Short, punchy titles for the finish notification. `challenge_finished_won` /
 * `_lost` are full sentences meant for a screen; a lock screen truncates them to
 * nothing useful, so they go in the body instead.
 */
function finishedTitle(level: VulgarityLevel, role: 'winner' | 'loser'): string {
  if (role === 'winner') {
    if (level === 1) return 'Kazandın 🏆';
    if (level === 3) return 'KOYDUN! 👑🍆';
    return 'KOYDUN! 👑';
  }
  if (level === 1) return 'Bu tur bitti';
  if (level === 3) return 'YEDİN 🍆';
  return 'Yedin lan';
}

function cancelledCopy(level: VulgarityLevel, title: string): { title: string; body: string } {
  if (level === 1) return { title: 'Çelinç iptal edildi', body: `${title} yeterli katılımcı olmadığı için iptal edildi.` };
  if (level === 3) return { title: 'Çelinç iptal 🍆', body: `${title} iptal. Kimse cesaret edemedi, boşuna beklettin.` };
  return { title: 'Çelinç iptal oldu', body: `${title} iptal lan, kimse kabul etmedi.` };
}

function reminderTitle(level: VulgarityLevel): string {
  if (level === 1) return '⏰ Günlük hatırlatma';
  if (level === 3) return '⏰ Kalk lan 🍆';
  return '⏰ Bugün ne yaptın?';
}

// ---------------------------------------------------------------------------
// Lifecycle (SPEC 2.4)
// ---------------------------------------------------------------------------

/**
 * Step 1a — `pending` challenges whose start time has passed and that have at least
 * two accepted participants become `active` and notify everyone who accepted.
 */
export function activateDueChallenges(db: Database, now: Date = new Date()): number {
  const iso = nowIso(now);
  const due = db
    .prepare("SELECT * FROM challenges WHERE status = 'pending' AND starts_at <= ?")
    .all(iso) as ChallengeRow[];

  let activated = 0;
  for (const challenge of due) {
    const accepted = acceptedParticipants(db, challenge.id);
    if (accepted.length < 2) continue;

    const users = userMap(db, accepted.map((p) => p.user_id));
    const run = db.transaction(() => {
      db.prepare("UPDATE challenges SET status = 'active' WHERE id = ? AND status = 'pending'").run(challenge.id);
      for (const user of users.values()) {
        const copy = startedCopy(levelOf(user), challenge.title);
        notify(db, {
          userId: user.id,
          type: 'challenge_started',
          title: copy.title,
          body: copy.body,
          data: { challengeId: challenge.id },
          createdAt: iso,
        });
      }
    });
    run();
    activated += 1;
  }
  return activated;
}

/**
 * Step 1b — a `pending` challenge that reached its end without ever starting is
 * cancelled and everyone who was invited hears about it.
 */
export function cancelUnderfilled(db: Database, now: Date = new Date()): number {
  const iso = nowIso(now);
  const expired = db
    .prepare("SELECT * FROM challenges WHERE status = 'pending' AND ends_at <= ?")
    .all(iso) as ChallengeRow[];

  let cancelled = 0;
  for (const challenge of expired) {
    const participants = participantRows(db, challenge.id).filter(
      (p) => p.status === 'accepted' || p.status === 'invited',
    );
    const users = userMap(db, participants.map((p) => p.user_id));

    const run = db.transaction(() => {
      db.prepare("UPDATE challenges SET status = 'cancelled', finalized_at = ? WHERE id = ? AND status = 'pending'").run(
        iso,
        challenge.id,
      );
      for (const user of users.values()) {
        const copy = cancelledCopy(levelOf(user), challenge.title);
        notify(db, {
          userId: user.id,
          type: 'challenge_cancelled',
          title: copy.title,
          body: copy.body,
          data: { challengeId: challenge.id },
          createdAt: iso,
        });
      }
    });
    run();
    cancelled += 1;
  }
  return cancelled;
}

/**
 * Finalizes one challenge: writes final scores/ranks, the winner (or the tie),
 * notifies every accepted participant at their own vulgarity level and awards
 * badges. Exported so the dev-only force-finish route can reuse it.
 */
export function finalizeChallenge(db: Database, challenge: ChallengeRow, now: Date = new Date()): ParticipantView[] {
  const iso = nowIso(now);
  const type = typeForChallenge(challenge);
  const accepted = acceptedParticipants(db, challenge.id);
  const users = userMap(db, accepted.map((p) => p.user_id));

  const entries = db.prepare('SELECT * FROM entries WHERE challenge_id = ?').all(challenge.id) as EntryRow[];
  const byUser = new Map<string, ScoreInput['entries']>();
  for (const entry of entries) {
    const list = byUser.get(entry.user_id) ?? [];
    list.push({ dayKey: entry.day_key, value: Number(entry.value), status: entry.status as ScoreInput['entries'][number]['status'] });
    byUser.set(entry.user_id, list);
  }

  const dayKeys = challengeDayKeys(db, challenge);
  const ranking = rankParticipants(
    type,
    dayKeys,
    accepted.map((p) => ({ userId: p.user_id, entries: byUser.get(p.user_id) ?? [] })),
  );

  const winnerId = ranking.winnerId;
  const isTie = ranking.isTie;
  const winnerUser = winnerId ? users.get(winnerId) : undefined;
  const scoreById = new Map(ranking.results.map((r) => [r.userId, r]));

  const run = db.transaction(() => {
    const updateParticipant = db.prepare(
      'UPDATE challenge_participants SET final_score = ?, final_rank = ? WHERE challenge_id = ? AND user_id = ?',
    );
    for (const result of ranking.results) {
      updateParticipant.run(result.score, result.rank, challenge.id, result.userId);
    }
    db.prepare(
      "UPDATE challenges SET status = 'finished', finalized_at = ?, winner_id = ?, is_tie = ? WHERE id = ?",
    ).run(iso, winnerId, isTie ? 1 : 0, challenge.id);

    for (const participant of accepted) {
      const user = users.get(participant.user_id);
      if (!user) continue;
      const level = levelOf(user);
      const mine = scoreById.get(user.id);
      const myScore = scoreLabel(type, mine?.score ?? 0);

      if (isTie) {
        notify(db, {
          userId: user.id,
          type: 'challenge_finished',
          title: level === 1 ? 'Berabere' : level === 3 ? 'BERABERE 🍆' : 'Berabere kaldınız',
          body: `${challenge.title} berabere bitti. Skor: ${myScore}. Kimse kimseye koyamadı, rövanş şart.`,
          data: { challengeId: challenge.id, role: 'tie' },
          createdAt: iso,
        });
        continue;
      }

      if (winnerId === user.id) {
        notify(db, {
          userId: user.id,
          type: 'challenge_finished',
          title: finishedTitle(level, 'winner'),
          body: `${t('challenge_finished_won', level)} ${challenge.title} bitti, skorun ${myScore}. Kaybedenlere "KOYDUM MU?" deme sırası sende.`,
          data: { challengeId: challenge.id, role: 'winner' },
          createdAt: iso,
        });
        continue;
      }

      const winnerScore = winnerId ? scoreLabel(type, scoreById.get(winnerId)?.score ?? 0) : '';
      notify(db, {
        userId: user.id,
        type: 'challenge_finished',
        title: finishedTitle(level, 'loser'),
        body: winnerUser
          ? `${t('challenge_finished_lost', level)} ${challenge.title} bitti. Kazanan ${winnerUser.display_name} (${winnerScore}), senin skorun ${myScore}.`
          : `${t('challenge_finished_lost', level)} ${challenge.title} bitti, senin skorun ${myScore}.`,
        data: { challengeId: challenge.id, role: 'loser', winnerId },
        createdAt: iso,
      });
    }
  });
  run();

  for (const participant of accepted) {
    awardBadges(db, participant.user_id, now);
  }

  const updated = getChallengeRow(db, challenge.id) ?? challenge;
  return computeStandings(db, updated);
}

/** Step 2 — every `active` challenge whose end time has passed. */
export function finalizeEndedChallenges(db: Database, now: Date = new Date()): number {
  const ended = db
    .prepare("SELECT * FROM challenges WHERE status = 'active' AND ends_at <= ?")
    .all(nowIso(now)) as ChallengeRow[];
  for (const challenge of ended) finalizeChallenge(db, challenge, now);
  return ended.length;
}

/**
 * Step 3 — one daily reminder per user, at their own `reminder_hour` in their own
 * timezone, only while they have at least one active challenge, at most once per
 * local day (`reminders_sent`).
 */
export function sendReminders(db: Database, now: Date = new Date()): number {
  const iso = nowIso(now);
  const candidates = db
    .prepare(
      `SELECT DISTINCT u.* FROM users u
         JOIN challenge_participants p ON p.user_id = u.id AND p.status = 'accepted'
         JOIN challenges c ON c.id = p.challenge_id AND c.status = 'active'
        WHERE u.deleted_at IS NULL AND u.reminder_hour IS NOT NULL`,
    )
    .all() as UserRow[];

  const claim = db.prepare('INSERT OR IGNORE INTO reminders_sent (user_id, day_key) VALUES (?, ?)');
  let sent = 0;

  for (const user of candidates) {
    const timezone = user.timezone || DEFAULT_TIMEZONE;
    let hour: number;
    let dayKey: string;
    try {
      hour = localHour(now, timezone);
      dayKey = todayKey(timezone, now);
    } catch {
      continue;
    }
    if (hour !== Number(user.reminder_hour)) continue;
    if (claim.run(user.id, dayKey).changes === 0) continue;

    const level = levelOf(user);
    notify(db, {
      userId: user.id,
      type: 'reminder',
      title: reminderTitle(level),
      body: t('notification_daily_reminder', level),
      data: { dayKey },
      createdAt: iso,
    });
    sent += 1;
  }

  return sent;
}

/**
 * One scheduler pass. Every step is isolated: a failure in one is reported through
 * `deps.onError` and the others still run.
 */
export function runSchedulerOnce(db: Database, now: Date = new Date(), deps: SchedulerDeps = {}): SchedulerSummary {
  const summary: SchedulerSummary = { activated: 0, finalized: 0, cancelled: 0, reminders: 0 };
  const step = <T>(name: string, fn: () => T, apply: (value: T) => void): void => {
    try {
      apply(fn());
    } catch (err) {
      deps.onError?.(name, err);
    }
  };

  step('activate', () => activateDueChallenges(db, now), (n) => (summary.activated = n));
  step('finalize', () => finalizeEndedChallenges(db, now), (n) => (summary.finalized = n));
  step('cancel', () => cancelUnderfilled(db, now), (n) => (summary.cancelled = n));
  step('reminders', () => sendReminders(db, now), (n) => (summary.reminders = n));

  return summary;
}
