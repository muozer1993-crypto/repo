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
  LIMITS,
  compareDayKeys,
  computeScore,
  formatScore,
  dayKeyInTz,
  dayKeysBetween,
  localHour,
  rankParticipants,
  requireChallengeType,
  scoreLabel,
  t,
  todayKey,
  type ChallengeType,
  type DeviceMetric,
  type MetricType,
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
import { disputeAwaitingAnswer, resolveDisputes } from './entries.js';
import { isBlockedBetween } from './friends.js';
import { notify } from './notifications.js';
import { joinNames, sendWeeklyRecaps } from './recap.js';
import { awardBadges } from './stats.js';

export interface SchedulerSummary {
  activated: number;
  /** Disputed entries thrown out because their owner never answered. */
  disputes: number;
  finalized: number;
  cancelled: number;
  reminders: number;
  nudges: number;
  recaps: number;
  /** Winners reminded that a loser is still waiting for their "KOYDUM MU?". */
  tauntFollowups: number;
}

export interface SchedulerDeps {
  /** Called for anything that goes wrong inside one step (never throws out). */
  onError?: (step: string, err: unknown) => void;
  /** When this server process started; see `finalizeEndedChallenges`. */
  bootAt?: Date;
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

/**
 * Day window of a challenge in one timezone; an unknown zone degrades to the default.
 *
 * `challengeWindow(challenge, participantTimezone(participant, user))` is THE window
 * expression: entry validation, the steps fan-out and the missing-day penalty all
 * build it exactly this way, so the days a player may write and the days they are
 * scored against can never drift apart.
 */
export function challengeWindow(challenge: Pick<ChallengeRow, 'starts_at' | 'ends_at'>, tz: string): string[] {
  try {
    return dayKeysBetween(challenge.starts_at, challenge.ends_at, tz);
  } catch {
    return dayKeysBetween(challenge.starts_at, challenge.ends_at, DEFAULT_TIMEZONE);
  }
}

/**
 * Whether `dayKey` in `tz` was over by the time the çelınc ended. The app snaps
 * an end to the last millisecond of a local day, so that millisecond counts as
 * over: `ends_at + 1 ms` is already the next day.
 *
 * After the whistle only such complete days may still move (the phones' hour,
 * a dispute's wait): a day the end cut in half keeps what it had at `ends_at`,
 * because a later reading of it would add steps walked after the end.
 */
export function dayOverByEnd(challenge: Pick<ChallengeRow, 'ends_at'>, tz: string, dayKey: string): boolean {
  const after = new Date(Date.parse(challenge.ends_at) + 1);
  let endKey: string;
  try {
    endKey = dayKeyInTz(after, tz);
  } catch {
    endKey = dayKeyInTz(after, DEFAULT_TIMEZONE);
  }
  return compareDayKeys(dayKey, endKey) < 0;
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
  now: Date,
): { ranking: RankingResult; days: Map<string, number> } {
  const perUserWindow = type.metricType === 'manual_lower_is_better';
  const days = new Map<string, number>();

  const inputs: ScoreInput[] = accepted.map((participant) => {
    const entries = entriesByUser.get(participant.user_id) ?? [];
    let window: string[] = [];
    if (perUserWindow) {
      const tz = participantTimezone(participant, users.get(participant.user_id));
      window = challengeWindow(challenge, tz);
      // While the çelınc runs, only the days that have started count as
      // "missing": day 2 of 7 shows the average of two days, not five days of
      // penalty for a future nobody has lived yet. Once it is over the clip is
      // a no-op and the full window applies.
      if (challenge.status !== 'finished') {
        let today: string;
        try {
          today = todayKey(tz, now);
        } catch {
          today = todayKey(DEFAULT_TIMEZONE, now);
        }
        window = window.filter((key) => compareDayKeys(key, today) <= 0);
      }
    }
    const scored = computeScore(type, window, entries);
    days.set(participant.user_id, scored.days);
    if (!perUserWindow) return { userId: participant.user_id, entries };
    // Lower-is-better is scored here (per-participant window), so one entry
    // carrying the finished score reproduces it exactly while keeping the window
    // out of `rankParticipants`. `dayKeys` is empty there, so no second averaging.
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
export function computeStandings(db: Database, challenge: ChallengeRow, now: Date = new Date()): ParticipantView[] {
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
  const { ranking, days } = rankAccepted(db, challenge, type, accepted, users, byUser, now);
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
  if (level === 1) return { title: '🔔 Çelınc başladı', body: `${title} başladı. Bol şans.` };
  if (level === 3) return { title: '🍆 ÇELINC BAŞLADI', body: `${title} başladı. Bugün başlamazsan yersin.` };
  return { title: '🔥 Çelınc başladı', body: `${title} başladı. Hadi bakalım.` };
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

/**
 * `everyone_left`: the rivals were there and walked out (declined, left,
 * deleted their account). "Kimse kabul etmedi" would be a lie to somebody whose
 * rival accepted on Monday and quit on Tuesday.
 */
function cancelledCopy(
  level: VulgarityLevel,
  title: string,
  reason?: 'everyone_left',
): { title: string; body: string } {
  if (reason === 'everyone_left') {
    if (level === 1) return { title: 'Çelınc iptal edildi', body: `${title} iptal edildi, rakibin kalmadı.` };
    if (level === 3) return { title: 'Çelınc iptal 🍆', body: `Herkes kaçtı, ${title} yattı. Tek başına koyamazsın 🍆` };
    return { title: 'Çelınc iptal oldu', body: `${title} iptal oldu, herkes kaçtı.` };
  }
  if (level === 1) return { title: 'Çelınc iptal edildi', body: `${title} yeterli katılımcı olmadığı için iptal edildi.` };
  if (level === 3) return { title: 'Çelınc iptal 🍆', body: `${title} iptal oldu. Kimse kabul etmedi, korkaklar.` };
  return { title: 'Çelınc iptal oldu', body: `${title} iptal oldu, kimse kabul etmedi.` };
}

/**
 * What to actually do about being behind. "Kalk da iki dolaş" is the line the
 * app was designed around, but it is nonsense on a focus çelınc, so the tail
 * follows the metric.
 */
function nudgeAction(metricType: MetricType, level: VulgarityLevel): string {
  const polite = level === 1;
  switch (metricType) {
    case 'auto_steps':
      return polite ? 'Bugün biraz yürüsen kapanır.' : 'Kalk da iki dolaş.';
    case 'focus_minutes':
      return polite ? 'Kısa bir odak seansı farkı kapatır.' : 'Telefonu bırak da bir seans yap.';
    case 'manual_lower_is_better':
      return polite ? 'Telefonu biraz kenara koy, ortalaman düşer.' : 'Telefonu bırak da ortalaman düşsün.';
    case 'daily_boolean':
      return polite ? 'Bugünü işaretlemeyi unutma.' : 'Bugünü kaçırma.';
    default:
      return polite ? 'Bugünkü girişini yapmayı unutma.' : 'Bir şeyler yap da gir şuraya.';
  }
}

/**
 * The mid-day "somebody is ahead of you" notification the server sends by
 * itself, once per çelınc per person per local day.
 */
function nudgeCopy(
  level: VulgarityLevel,
  leader: string,
  gap: number,
  unit: string,
  metricType: MetricType
): { title: string; body: string } {
  const fark = `${formatScore(gap)} ${unit}`;
  const action = nudgeAction(metricType, level);
  if (level === 1) {
    return { title: 'Fark açılıyor', body: `${leader} önde, aradaki fark ${fark}. ${action}` };
  }
  if (level === 3) {
    return {
      title: 'O NE LAN 🍆',
      body: `${leader} sana ${fark} fark koymuş 🍆 ${action}`,
    };
  }
  return { title: 'O ne lan', body: `${leader} sana ${fark} fark koymuş. ${action}` };
}

function reminderTitle(level: VulgarityLevel): string {
  if (level === 1) return '⏰ Günlük hatırlatma';
  if (level === 3) return '⏰ Kalk lan 🍆';
  return '⏰ Bugün ne yaptın?';
}

/**
 * "Ali hâlâ bekliyor": the winner has not said a word to the people they beat.
 * `losers` are only the ones still waiting, runner-up first.
 */
function tauntFollowupCopy(level: VulgarityLevel, losers: string[]): { title: string; body: string } {
  const names = joinNames(losers);
  const several = losers.length > 1;
  if (level === 1) {
    return {
      title: `${names} hâlâ bekliyor`,
      body: several
        ? 'Kazandın ama onlara bir şey yazmadın. İki satır yaz, bitsin.'
        : 'Kazandın ama bir şey yazmadın. İki satır yaz, bitsin.',
    };
  }
  if (level === 3) {
    return {
      title: 'KOYMADIN DAHA 🍆',
      body: several ? `${names} sırada bekliyor, hadi hepsine koy.` : `${names} bekliyor, hadi koy şunu.`,
    };
  }
  return { title: 'Koymayacak mısın?', body: `${names} ağzını açmanı bekliyor.` };
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
 * Why a çelınc ending with fewer than two players is cancelled: somebody other
 * than `survivors` accepted at some point (and then left or deleted the
 * account) → `everyone_left`; nobody ever did → "kimse kabul etmedi".
 */
function cancelReason(db: Database, challengeId: string, survivors: readonly string[]): 'everyone_left' | undefined {
  const walkedOut = participantRows(db, challengeId).some(
    (p) => p.joined_at !== null && !survivors.includes(p.user_id),
  );
  return walkedOut ? 'everyone_left' : undefined;
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
    const reason = cancelReason(
      db,
      challenge.id,
      participants.filter((p) => p.status === 'accepted').map((p) => p.user_id),
    );

    const run = db.transaction(() => {
      db.prepare("UPDATE challenges SET status = 'cancelled', finalized_at = ? WHERE id = ? AND status = 'pending'").run(
        iso,
        challenge.id,
      );
      for (const user of users.values()) {
        const copy = cancelledCopy(levelOf(user), challenge.title, reason);
        notify(db, {
          userId: user.id,
          type: 'challenge_cancelled',
          title: copy.title,
          body: copy.body,
          data: reason ? { challengeId: challenge.id, reason } : { challengeId: challenge.id },
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
 * Whether a çelınc is still being played: open, and its end not reached. Past
 * `ends_at` an `active` one only waits for its result (the phones' hour, an
 * itiraz's photo), and what happens to it then is the scheduler's call.
 */
export function stillOpen(challenge: ChallengeRow, now: Date): boolean {
  return (
    (challenge.status === 'pending' || challenge.status === 'active') &&
    now.getTime() < Date.parse(challenge.ends_at)
  );
}

/**
 * Cancels a çelınc on the spot once nobody is left to race. Without it a
 * declined 1v1 ran on with its creator "leading" alone for a week, only to be
 * cancelled at the end as "kimse kabul etmedi".
 *
 * It counts who is in plus who could still say yes: while an invitee could
 * make it two, it waits. Whoever is still in or invited hears why
 * (`reason: 'everyone_left'`).
 *
 * Only while `stillOpen`: past the end nobody may walk out of a result (the
 * leave route refuses), and a çelınc that ends with one player is already
 * cancelled by `finalizeChallenge`. Runs inside the caller's transaction
 * (decline, leave, account deletion).
 */
export function cancelIfAbandoned(db: Database, challengeId: string, now: Date = new Date()): boolean {
  const challenge = getChallengeRow(db, challengeId);
  if (!challenge || !stillOpen(challenge, now)) return false;
  const remaining = participantRows(db, challengeId).filter(
    (p) => p.status === 'accepted' || p.status === 'invited',
  );
  if (remaining.length >= 2) return false;

  const iso = nowIso(now);
  db.prepare("UPDATE challenges SET status = 'cancelled', finalized_at = ? WHERE id = ?").run(iso, challengeId);
  for (const user of userMap(db, remaining.map((p) => p.user_id)).values()) {
    const copy = cancelledCopy(levelOf(user), challenge.title, 'everyone_left');
    notify(db, {
      userId: user.id,
      type: 'challenge_cancelled',
      title: copy.title,
      body: copy.body,
      data: { challengeId, reason: 'everyone_left' },
      createdAt: iso,
    });
  }
  return true;
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
  // A rival who accepted and walked out while a silent invitee kept it open is
  // not "kimse kabul etmedi".
  if (accepted.length < 2) {
    const reason = cancelReason(db, challenge.id, accepted.map((p) => p.user_id));
    const run = db.transaction(() => {
      db.prepare(
        "UPDATE challenges SET status = 'cancelled', finalized_at = ?, winner_id = NULL, is_tie = 0 WHERE id = ?",
      ).run(iso, challenge.id);
      for (const user of users.values()) {
        const copy = cancelledCopy(levelOf(user), challenge.title, reason);
        notify(db, {
          userId: user.id,
          type: 'challenge_cancelled',
          title: copy.title,
          body: copy.body,
          data: { challengeId: challenge.id, reason: reason ?? 'not_enough_players' },
          createdAt: iso,
        });
      }
    });
    run();
    return computeStandings(db, getChallengeRow(db, challenge.id) ?? challenge, now);
  }

  const entries = db.prepare('SELECT * FROM entries WHERE challenge_id = ?').all(challenge.id) as EntryRow[];
  const byUser = new Map<string, ScoreInput['entries']>();
  for (const entry of entries) {
    const list = byUser.get(entry.user_id) ?? [];
    list.push({ dayKey: entry.day_key, value: Number(entry.value), status: entry.status as ScoreInput['entries'][number]['status'] });
    byUser.set(entry.user_id, list);
  }

  const { ranking } = rankAccepted(db, challenge, type, accepted, users, byUser, now);

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
          body: `${challenge.title} berabere bitti. Senin skorun ${myScore}. İsteyen rövanş açsın.`,
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
          body: `${t('challenge_finished_won', level)} ${challenge.title} bitti, skorun ${myScore}.`,
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
  return computeStandings(db, updated, now);
}

/** Where each phone reading lands before the fan-out (`routes/me.ts`). */
const DEVICE_DAILY_TABLE: Record<DeviceMetric, string> = {
  steps: 'steps_daily',
  screen_time: 'screen_time_daily',
};

/**
 * True when every accepted player's phone has reported their LAST day of the
 * çelınc after it ended. Each sync sends the past week, so a sync after the end
 * carries the final evening in full; nothing better is coming, and making the
 * group wait out the rest of the hour would only delay the result.
 *
 * The day is the player's own (pinned timezone), the same window expression the
 * fan-out writes against. A player whose last day the end cut in half is not
 * waited for: the fan-out no longer moves that day (`dayOverByEnd`). Somebody
 * who declares steps by hand never syncs, so with them in the race the full
 * settle hour always runs.
 */
function everyPhoneReported(db: Database, challenge: ChallengeRow, metric: DeviceMetric): boolean {
  const accepted = acceptedParticipants(db, challenge.id);
  const users = userMap(db, accepted.map((p) => p.user_id));
  const endedAt = Date.parse(challenge.ends_at);
  const lastSync = db.prepare(`SELECT updated_at FROM ${DEVICE_DAILY_TABLE[metric]} WHERE user_id = ? AND day_key = ?`);

  return accepted.every((participant) => {
    const tz = participantTimezone(participant, users.get(participant.user_id));
    const lastDay = challengeWindow(challenge, tz).at(-1);
    if (!lastDay) return false;
    if (!dayOverByEnd(challenge, tz, lastDay)) return true;
    const row = lastSync.get(participant.user_id, lastDay) as { updated_at: string } | undefined;
    return !!row && Date.parse(row.updated_at) > endedAt;
  });
}

/**
 * Until when a friend may still file an itiraz (epoch ms). Past its end a çelınc
 * can still be `active`: the phones' hour below, or an itiraz waiting for its
 * photo. Only the phones' hour takes new ones, because the last evening's
 * numbers land in it; after that each new itiraz would hold the result another
 * `DISPUTE_ANSWER_MS`, and one after another could hold it for days.
 */
export function disputesCloseAt(challenge: ChallengeRow): number {
  const settle = typeForChallenge(challenge).deviceMetric ? LIMITS.DEVICE_SETTLE_MS : 0;
  return Date.parse(challenge.ends_at) + settle;
}

/**
 * Whether an ended çelınc is still waiting for the phones.
 *
 * Only types the phone counts on its own wait: the final evening's steps sit on
 * the device until the next background sync, and a winner crowned at midnight on
 * a 22:15 reading cannot be taken back (the fan-out stops at `finished`). Typed
 * çelınclar have nothing more to receive and finish on the dot.
 *
 * The hour runs from the end or from this process's start, whichever is later: a
 * server that was off at midnight must not crown anybody on boot before a single
 * phone could reach it, and a restart during the hour starts it again, which
 * needs no bookkeeping table.
 */
function stillSettling(db: Database, challenge: ChallengeRow, now: Date, bootAt?: Date): boolean {
  const metric = typeForChallenge(challenge).deviceMetric;
  if (!metric) return false;
  const settleFrom = Math.max(Date.parse(challenge.ends_at), bootAt?.getTime() ?? Number.NEGATIVE_INFINITY);
  if (now.getTime() >= settleFrom + LIMITS.DEVICE_SETTLE_MS) return false;
  return !everyPhoneReported(db, challenge, metric);
}

/**
 * Step 2 — every `active` challenge whose end time has passed, once the phones
 * have had their chance to report (`stillSettling`) and no disputed entry is
 * still inside its answer window (`disputeAwaitingAnswer`): an owner told "12 saat
 * içinde fotoğraf ekle" keeps those hours even when the itiraz came at the last
 * minute. Until then it stays `active`, so a late device sync still fans out into
 * it and a photo can still land; typed entries are refused from `ends_at` on
 * (`challenge_ended` in `validateAndUpsertEntry`).
 */
export function finalizeEndedChallenges(
  db: Database,
  now: Date = new Date(),
  options: { bootAt?: Date } = {},
): number {
  const ended = db
    .prepare("SELECT * FROM challenges WHERE status = 'active' AND ends_at <= ?")
    .all(nowIso(now)) as ChallengeRow[];
  let finalized = 0;
  for (const challenge of ended) {
    if (stillSettling(db, challenge, now, options.bootAt)) continue;
    if (disputeAwaitingAnswer(db, challenge.id, now)) continue;
    finalizeChallenge(db, challenge, now);
    finalized += 1;
  }
  return finalized;
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
  // `ends_at > now`: a çelınc waiting for the phones after its end is still
  // `active`, but there is nothing left to type into it
  const candidates = db
    .prepare(
      `SELECT DISTINCT u.* FROM users u
         JOIN challenge_participants p ON p.user_id = u.id AND p.status = 'accepted'
         JOIN challenges c ON c.id = p.challenge_id AND c.status = 'active' AND c.ends_at > ?
        WHERE u.deleted_at IS NULL AND u.reminder_hour IS NOT NULL`,
    )
    .all(iso) as UserRow[];

  const claim = db.prepare('INSERT OR IGNORE INTO reminders_sent (user_id, day_key) VALUES (?, ?)');
  // the reminder says "you have nothing today" — so it only goes to people for
  // whom that is true in at least... none of their live çelınclar has a row today
  const loggedToday = db.prepare(
    `SELECT 1 FROM entries e JOIN challenges c ON c.id = e.challenge_id
      WHERE e.user_id = ? AND e.day_key = ? AND c.status = 'active' AND e.status <> 'rejected' LIMIT 1`,
  );
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
    if (loggedToday.get(user.id, dayKey)) continue;
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

/** Nobody wants a nudge at 3am, and after 22:00 the day is already lost. */
const NUDGE_FROM_HOUR = 12;
const NUDGE_UNTIL_HOUR = 22;
/** Below this the "fark" is noise — a 40-step gap is not a story. */
const NUDGE_MIN_RELATIVE_GAP = 0.1;

/**
 * The mid-day poke the server sends on its own: "o ne lan, {leader} sana fark
 * koymuş, kalk da iki dolaş".
 *
 * A friend can already poke by hand; this is the one that arrives when nobody
 * is looking, and it is what turns a çelınc from a scoreboard into something
 * that follows you around during the day.
 *
 * Four rules keep it from becoming spam: once per çelınc per person per LOCAL
 * day (the primary key of `nudges_sent` IS the rate limit), only between noon
 * and 22:00 where that person actually lives, only when somebody is genuinely
 * ahead, and never on a check-in çelınc — those have their own deadline
 * reminder and "you are behind" means nothing there. And somebody who switched
 * it off (`users.nudges_enabled`) gets none at all.
 */
export function sendNudges(db: Database, now: Date = new Date()): number {
  const iso = nowIso(now);
  const active = db.prepare(`SELECT * FROM challenges WHERE status = 'active'`).all() as ChallengeRow[];

  const claim = db.prepare(
    'INSERT OR IGNORE INTO nudges_sent (challenge_id, user_id, day_key) VALUES (?, ?, ?)',
  );
  let sent = 0;

  for (const challenge of active) {
    if (challenge.metric_type === 'checkin_deadline') continue;
    // the final hour has its own warning on the device; do not pile on
    if (Date.parse(challenge.ends_at) - now.getTime() < 60 * 60_000) continue;

    const standings = computeStandings(db, challenge, now);
    if (standings.length < 2) continue;
    const leader = standings[0];

    const participants = new Map(
      acceptedParticipants(db, challenge.id).map((row) => [row.user_id, row]),
    );
    const users = userMap(db, standings.map((view) => view.user.id));

    for (const view of standings) {
      if (view.user.id === leader.user.id) continue;
      // invited / declined / left rows ride along at rank 0 — not players to nudge
      if (view.status !== 'accepted') continue;
      const gap = Math.abs(leader.score - view.score);
      if (gap <= 0) continue;
      // a gap only counts when it is big next to what the leader has
      const reference = Math.abs(leader.score) || Math.abs(view.score);
      if (reference > 0 && gap / reference < NUDGE_MIN_RELATIVE_GAP) continue;

      const user = users.get(view.user.id);
      if (!user || user.deleted_at) continue;
      // switched off in Ayarlar; checked before the claim, so switching it back
      // on the same afternoon still gets today's nudge
      if (user.nudges_enabled === 0) continue;

      const timezone = participantTimezone(participants.get(user.id), user);
      let hour: number;
      let dayKey: string;
      try {
        hour = localHour(now, timezone);
        dayKey = todayKey(timezone, now);
      } catch {
        continue;
      }
      if (hour < NUDGE_FROM_HOUR || hour >= NUDGE_UNTIL_HOUR) continue;
      if (claim.run(challenge.id, user.id, dayKey).changes === 0) continue;

      const copy = nudgeCopy(
        levelOf(user),
        leader.user.displayName,
        gap,
        challenge.unit,
        challenge.metric_type as MetricType,
      );
      notify(db, {
        userId: user.id,
        type: 'nudge',
        title: copy.title,
        body: copy.body,
        data: { challengeId: challenge.id, fromUserId: leader.user.id, dayKey },
        createdAt: iso,
      });
      sent += 1;
    }
  }

  return sent;
}

/** Give the winner a moment to gloat by themselves before anybody reminds them. */
const TAUNT_FOLLOWUP_AFTER_MS = 2 * 60 * 60_000;
/** Two days on, a "KOYDUM MU?" is about nothing; the loser's screen gave up after one. */
const TAUNT_FOLLOWUP_UNTIL_MS = 48 * 60 * 60_000;

/**
 * "Ali hâlâ bekliyor": the one reminder a winner gets when a loser is still
 * waiting for their "KOYDUM MU?".
 *
 * Taunts only exist when the winner opens the app and sends one, and the loser
 * was told it is coming. A çelınc that ends at 23:59 while the winner sleeps, or
 * a lazy winner, would leave the loser staring at "daha ağzını açmadı" forever.
 *
 * Once per çelınc (`taunt_followups` is the claim), from two hours after the
 * finish until two days after, and only inside the nudge's waking hours where
 * the winner lives now: this is about their day, not the çelınc's days, so it
 * reads the profile timezone, not the one pinned at join. The hour is checked
 * BEFORE the claim, so a midnight finish keeps its slot until noon.
 * Losers already taunted, deleted, or on the other side of a block are not
 * waiting for anything, and with none of them left nothing is sent. It never
 * taunts in the winner's name: a "KOYDUM MU?" is theirs to send.
 */
export function sendTauntFollowups(db: Database, now: Date = new Date()): number {
  const iso = nowIso(now);
  const due = db
    .prepare(
      `SELECT c.* FROM challenges c
         LEFT JOIN taunt_followups f ON f.challenge_id = c.id AND f.stage = 1
        WHERE c.status = 'finished' AND c.winner_id IS NOT NULL AND c.is_tie = 0
          AND c.finalized_at <= ? AND c.finalized_at > ?
          AND f.challenge_id IS NULL`,
    )
    .all(
      nowIso(new Date(now.getTime() - TAUNT_FOLLOWUP_AFTER_MS)),
      nowIso(new Date(now.getTime() - TAUNT_FOLLOWUP_UNTIL_MS)),
    ) as ChallengeRow[];

  const waiting = db.prepare(
    `SELECT u.* FROM challenge_participants p
       JOIN users u ON u.id = p.user_id AND u.deleted_at IS NULL
      WHERE p.challenge_id = ? AND p.status = 'accepted' AND p.user_id <> ?
        AND NOT EXISTS (
          SELECT 1 FROM taunts t
           WHERE t.challenge_id = p.challenge_id AND t.from_user_id = ? AND t.to_user_id = p.user_id
        )
      ORDER BY p.final_rank ASC, p.rowid ASC`,
  );
  const claim = db.prepare(
    'INSERT OR IGNORE INTO taunt_followups (challenge_id, stage, created_at) VALUES (?, 1, ?)',
  );
  let sent = 0;

  for (const challenge of due) {
    const winnerId = challenge.winner_id;
    if (!winnerId) continue;
    const winner = userMap(db, [winnerId]).get(winnerId);
    if (!winner || winner.deleted_at) continue;

    const losers = (waiting.all(challenge.id, winnerId, winnerId) as UserRow[]).filter(
      (loser) => !isBlockedBetween(db, winnerId, loser.id),
    );
    if (losers.length === 0) continue;

    let hour: number;
    try {
      hour = localHour(now, winner.timezone || DEFAULT_TIMEZONE);
    } catch {
      continue;
    }
    if (hour < NUDGE_FROM_HOUR || hour >= NUDGE_UNTIL_HOUR) continue;
    if (claim.run(challenge.id, iso).changes === 0) continue;

    const copy = tauntFollowupCopy(levelOf(winner), losers.map((loser) => loser.display_name));
    notify(db, {
      userId: winner.id,
      type: 'reminder',
      title: copy.title,
      body: copy.body,
      data: { challengeId: challenge.id, kind: 'taunt_followup' },
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
  const summary: SchedulerSummary = {
    activated: 0,
    disputes: 0,
    finalized: 0,
    cancelled: 0,
    reminders: 0,
    nudges: 0,
    recaps: 0,
    tauntFollowups: 0,
  };
  const step = <T>(name: string, fn: () => T, apply: (value: T) => void): void => {
    try {
      apply(fn());
    } catch (err) {
      deps.onError?.(name, err);
    }
  };

  step('activate', () => activateDueChallenges(db, now), (n) => (summary.activated = n));
  // before finalize, so a çelınc that only waited on an unanswered itiraz ends without that entry
  step('disputes', () => resolveDisputes(db, now), (n) => (summary.disputes = n));
  step('finalize', () => finalizeEndedChallenges(db, now, { bootAt: deps.bootAt }), (n) => (summary.finalized = n));
  step('cancel', () => cancelUnderfilled(db, now), (n) => (summary.cancelled = n));
  step('reminders', () => sendReminders(db, now), (n) => (summary.reminders = n));
  step('nudges', () => sendNudges(db, now), (n) => (summary.nudges = n));
  step('tauntFollowups', () => sendTauntFollowups(db, now), (n) => (summary.tauntFollowups = n));
  // after finalize, so a çelınc that ended this minute is already in the count
  step('recaps', () => sendWeeklyRecaps(db, now), (n) => (summary.recaps = n));

  return summary;
}
