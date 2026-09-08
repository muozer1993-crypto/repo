/**
 * Challenge lifecycle: standings, activation, finalization, cancellation, reminders.
 *
 * Timezone policy for standings (SPEC: day keys live in the USER's timezone):
 *   - a participant's OWN entries are written with their own local day key, so the
 *     score of a participant is always computed from their own days;
 *   - the day WINDOW is per participant: `participantDayKeys` is the very same
 *     expression `validateAndUpsertEntry` validates that participant's writes
 *     against. The window only matters for the `manual_lower_is_better` missing-day
 *     penalty, and a shared (union) window would charge a friend whose local window
 *     is one day shorter for a day the API refuses to let them log — a perfect
 *     record could lose the challenge. Scoring and write validation must therefore
 *     be derived from the same expression;
 *   - that timezone is the one PINNED on `challenge_participants` when the player
 *     joined, so editing `users.timezone` mid-challenge cannot move anybody's days.
 */
import {
  DEFAULT_TIMEZONE,
  computeScore,
  dayKeysBetween,
  localHour,
  rankParticipants,
  requireChallengeType,
  scoreLabel,
  t,
  todayKey,
  type ChallengeType,
  type ParticipantView,
  type RankingResult,
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
 * The timezone one participant's days are measured in.
 *
 * The value pinned at join time wins; rows written before the column existed (and
 * users who never had one) fall back to the profile timezone, then to the default.
 */
export function participantTimezone(
  participant: { timezone?: string | null } | undefined,
  user: { timezone?: string | null } | undefined,
): string {
  const pinned = participant?.timezone ?? user?.timezone ?? DEFAULT_TIMEZONE;
  return typeof pinned === 'string' && pinned.trim() !== '' ? pinned : DEFAULT_TIMEZONE;
}

/** Day window of a challenge in one timezone; an unknown zone degrades to the default. */
export function challengeWindow(challenge: Pick<ChallengeRow, 'starts_at' | 'ends_at'>, tz: string): string[] {
  try {
    return dayKeysBetween(challenge.starts_at, challenge.ends_at, tz);
  } catch {
    return dayKeysBetween(challenge.starts_at, challenge.ends_at, DEFAULT_TIMEZONE);
  }
}

/**
 * The days one participant may write — and is scored against. THE window: every
 * other caller (entry validation, the steps fan-out, the missing-day penalty) goes
 * through this function so the two can never drift apart.
 */
export function participantDayKeys(db: Database, challenge: ChallengeRow, userId: string): string[] {
  const participant = db
    .prepare('SELECT * FROM challenge_participants WHERE challenge_id = ? AND user_id = ?')
    .get(challenge.id, userId) as ParticipantRow | undefined;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
  return challengeWindow(challenge, participantTimezone(participant, user));
}

/**
 * Ranks the accepted participants, each against their OWN day window.
 *
 * `rankParticipants` only knows a single shared window, so for
 * `manual_lower_is_better` — the one metric where the window matters — the score is
 * computed here per participant (sum + their own missing days × penalty) and handed
 * over as one pre-summed value. Every other metric ignores the window entirely and
 * is ranked from its raw entries.
 */
function rankAccepted(
  db: Database,
  challenge: ChallengeRow,
  type: ChallengeType,
  accepted: ParticipantRow[],
  users: Map<string, UserRow>,
  entriesByUser: Map<string, ScoreInput['entries']>,
): { ranking: RankingResult; days: Map<string, number> } {
  const perUserWindow = type.metricType === 'manual_lower_is_better';
  const days = new Map<string, number>();

  const inputs: ScoreInput[] = accepted.map((participant) => {
    const entries = entriesByUser.get(participant.user_id) ?? [];
    const window = perUserWindow
      ? challengeWindow(challenge, participantTimezone(participant, users.get(participant.user_id)))
      : [];
    const scored = computeScore(type, window, entries);
    days.set(participant.user_id, scored.days);
    if (!perUserWindow) return { userId: participant.user_id, entries };
    // Lower-is-better is a sum metric, so one entry carrying the finished score
    // reproduces it exactly while keeping the window out of `rankParticipants`.
    return { userId: participant.user_id, entries: [{ dayKey: 'total', value: scored.score, status: 'ok' }] };
  });

  return { ranking: rankParticipants(type, [], inputs), days };
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
  const { ranking, days } = rankAccepted(db, challenge, type, accepted, users, byUser);
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
      days: days.get(participant.user_id) ?? 0,
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

  // A race needs two runners. When everybody else left or deleted their account the
  // challenge ends without a contest: crowning the sole survivor would hand out a
  // free win (plus badges) for logging nothing, and `winner_id = NULL, is_tie = 0`
  // would be a fourth results state the app has no screen for.
  if (accepted.length < 2) {
    const run = db.transaction(() => {
      db.prepare(
        "UPDATE challenges SET status = 'cancelled', finalized_at = ?, winner_id = NULL, is_tie = 0 WHERE id = ?",
      ).run(iso, challenge.id);
      for (const user of users.values()) {
        const copy = cancelledCopy(levelOf(user), challenge.title);
        notify(db, {
          userId: user.id,
          type: 'challenge_cancelled',
          title: copy.title,
          body: copy.body,
          data: { challengeId: challenge.id, reason: 'not_enough_players' },
          createdAt: iso,
        });
      }
    });
    run();
    return computeStandings(db, getChallengeRow(db, challenge.id) ?? challenge);
  }

  const entries = db.prepare('SELECT * FROM entries WHERE challenge_id = ?').all(challenge.id) as EntryRow[];
  const byUser = new Map<string, ScoreInput['entries']>();
  for (const entry of entries) {
    const list = byUser.get(entry.user_id) ?? [];
    list.push({ dayKey: entry.day_key, value: Number(entry.value), status: entry.status as ScoreInput['entries'][number]['status'] });
    byUser.set(entry.user_id, list);
  }

  const { ranking } = rankAccepted(db, challenge, type, accepted, users, byUser);

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
 * Step 3 — one daily reminder per user, at (or after) their own `reminder_hour` in
 * their own timezone, only while they have at least one active challenge, at most
 * once per local day (`reminders_sent`).
 *
 * The check is `localHour >= reminder_hour`, not equality: on a DST spring-forward
 * day the target hour never happens locally (02:xx does not exist in New York on
 * the second Sunday of March), and a scheduler outage spanning that hour would
 * silently swallow the reminder too. The `reminders_sent` claim row is what keeps
 * it to one per local day.
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
    if (hour < Number(user.reminder_hour)) continue;
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
