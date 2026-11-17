/**
 * Challenge lifecycle: standings, activation, finalization, cancellation, reminders.
 *
 * Timezone policy for standings (SPEC: day keys live in the USER's timezone):
 *   - a participant's OWN entries are written with their own local day key, so the
 *     score of a participant is always computed from their own days;
 *   - the day WINDOW is per participant: `scoringWindow` is the very same
 *     expression `validateAndUpsertEntry` validates that participant's writes
 *     against. The window matters for the `manual_lower_is_better` missing-day
 *     penalty, and a shared (union) window would charge a friend whose local window
 *     is one day shorter for a day the API refuses to let them log — a perfect
 *     record could lose the challenge. On the metrics scored per day it never
 *     holds more days than the creator's: another zone's extra sliver of a day
 *     was a free yes/no point, and its extra deadline a free check-in. Scoring
 *     and write validation must therefore be derived from the same expression.
 *     Scoring may only cut it, never widen it:
 *     a late joiner is scored from the first day the app let them write
 *     (`lateJoinFloor`), and a running çelınc only up to the days that are over
 *     (`rankAccepted`), so nobody is charged for a day they could not, or could
 *     not yet, report;
 *   - that timezone is the one PINNED on `challenge_participants` when the player
 *     joined, so editing `users.timezone` mid-challenge cannot move anybody's days.
 */
import {
  DEFAULT_TIMEZONE,
  LIMITS,
  acceptClosesAt,
  addDays,
  compareDayKeys,
  computeScore,
  formatScore,
  dayKeyInTz,
  dayKeysBetween,
  effectiveDeadline,
  hhmmToMinutes,
  isBeforeOrEqualHHmm,
  isValidTimeZone,
  localHour,
  localInstant,
  localTimeHHmm,
  rankParticipants,
  requireChallengeType,
  scoreLabel,
  startOfDayInTz,
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
import { DEVICE_SOURCES, disputeAwaitingAnswer, isDeviceSource, resolveDisputes } from './entries.js';
import { isBlockedBetween } from './friends.js';
import { notify } from './notifications.js';
import { upSpanFrom } from './pauses.js';
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
  /** When this server started, or last woke from sleep (`startScheduler`); see `stillSettling`, `resolveDisputes` and `WAKE_GRACE_MS`. */
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
 * expression, trimmed by `scoringWindow` on the metrics scored per day: entry
 * validation, the phones' fan-out and the standings all build it exactly this way,
 * so the days a player may write and the days they are scored against can never
 * drift apart.
 */
export function challengeWindow(challenge: Pick<ChallengeRow, 'starts_at' | 'ends_at'>, tz: string): string[] {
  try {
    return dayKeysBetween(challenge.starts_at, challenge.ends_at, tz);
  } catch {
    return dayKeysBetween(challenge.starts_at, challenge.ends_at, DEFAULT_TIMEZONE);
  }
}

/**
 * The zone the creator's wizard snapped this çelınc's end in: the one pinned on
 * their own row when they made it, whatever became of that row since (they may
 * have left), else their profile's.
 */
export function creatorTimezone(db: Database, challenge: Pick<ChallengeRow, 'id' | 'creator_id'>): string {
  const participant = db
    .prepare('SELECT timezone FROM challenge_participants WHERE challenge_id = ? AND user_id = ?')
    .get(challenge.id, challenge.creator_id) as { timezone: string | null } | undefined;
  const user = db.prepare('SELECT timezone FROM users WHERE id = ?').get(challenge.creator_id) as
    | { timezone: string | null }
    | undefined;
  return participantTimezone(participant, user);
}

/**
 * Metrics scored per day key: one more day is one more yes, one more deadline
 * to beat, or one more day in the average (and its 1440-minute penalty when it
 * cannot be typed).
 */
const SCORED_PER_DAY: readonly MetricType[] = ['daily_boolean', 'checkin_deadline', 'manual_lower_is_better'];

const DAY_MS = 86_400_000;

/** the zone `challengeWindow` falls back to for one it cannot read */
function readableZone(tz: string): string {
  return isValidTimeZone(tz) ? tz : DEFAULT_TIMEZONE;
}

/**
 * One day's check-in slot in `zone` against the çelınc: how much of it the
 * çelınc covers (`cover`, ms, 0 or less for none), from the type's window
 * opening (`checkinWindowStart`) to the last second of the deadline's minute,
 * against `starts_at` up to `ends_at`, from which nothing is taken; and whether
 * the deadline's minute itself is still inside the çelınc (`deadlineIn`). The
 * slot never wraps past midnight (`deadlineFitsWindow`), so it lies inside its
 * own day.
 *
 * A covered slot whose deadline is not in can still be won, by tapping before
 * the end: a London friend's seventh evening in an Istanbul erken_yat ends at
 * 20:59 there, two hours before its 23:00.
 */
function checkinSlot(
  challenge: Pick<ChallengeRow, 'starts_at' | 'ends_at' | 'deadline_time'>,
  type: ChallengeType,
  zone: string,
): (key: string) => { cover: number; deadlineIn: boolean } {
  const start = Date.parse(challenge.starts_at);
  const end = Date.parse(challenge.ends_at);
  const opens = hhmmToMinutes(type.checkinWindowStart ?? '00:00');
  const deadline = hhmmToMinutes(effectiveDeadline(type, challenge.deadline_time));
  return (key) => {
    const from = localInstant(key, Math.floor(opens / 60), opens % 60, zone).getTime();
    const at = localInstant(key, Math.floor(deadline / 60), deadline % 60, zone).getTime();
    const to = at + 60_000;
    return { cover: Math.min(end, to) - Math.max(start, from), deadlineIn: at <= end && to > start };
  };
}

/**
 * The days of a check-in çelınc a player in `tz` can beat a deadline on: the
 * window's days whose slot (`checkinSlot`) the çelınc reaches.
 *
 * A day key alone says nothing here. An erken_yat made "Hemen" at 12:50 in
 * Istanbul for one day ends at 15:59 in New York, before its 19:00 opening:
 * one day key there, no evening. Seven days from that noon give Istanbul,
 * Berlin and London seven evenings and New York six.
 */
export function checkinPlayableDays(
  challenge: Pick<ChallengeRow, 'starts_at' | 'ends_at' | 'deadline_time'>,
  type: ChallengeType,
  tz: string,
): string[] {
  const slot = checkinSlot(challenge, type, readableZone(tz));
  return challengeWindow(challenge, tz).filter((key) => slot(key).cover > 0);
}

/**
 * The check-in days somebody in `tz` would get next to the creator's (in
 * `creatorTz`), when they are fewer: a check-in çelınc refuses that player
 * (400 `checkin_days_short` on accept, invite and create). Null on any other
 * metric, or with as many days. A player with more is let in and trimmed to the
 * creator's count (`scoringWindow`).
 */
export function checkinDaysShort(
  challenge: Pick<ChallengeRow, 'starts_at' | 'ends_at' | 'deadline_time'>,
  type: ChallengeType,
  creatorTz: string,
  tz: string,
): { days: number; creatorDays: number } | null {
  if (type.metricType !== 'checkin_deadline') return null;
  const days = checkinPlayableDays(challenge, type, tz).length;
  const creatorDays = checkinPlayableDays(challenge, type, creatorTz).length;
  return days < creatorDays ? { days, creatorDays } : null;
}

/**
 * The days a player in `tz` is scored on: `challengeWindow`, but on a metric
 * scored per day never more of them than the creator has.
 *
 * The wizard snaps the end in the creator's zone, so a friend in another one
 * gets an extra day key: a 3-day çelınc made in New York runs in Istanbul from
 * 16:00 on its first day to 08:00 on a fourth. On a yes/no çelınc that sliver
 * was one more point, and the friend won with equal play; on screen time it
 * was one more day to average, charged 1440 minutes once the end had passed
 * and nothing could be typed. Sums (steps, focus, counts) cover the same hours
 * in every zone and keep all their days.
 *
 * The end the çelınc covers less of goes, the last one on a tie. Not simply
 * the last: in an Istanbul friend's çelınc from 09:00, Los Angeles has a
 * 2-hour first day and a 13-hour last one. The creator's raw count is the bar,
 * also when their own end cuts a day in half: a 24-hour çelınc from noon is
 * two days for everybody. Entry writes, the phones' fan-out and the standings
 * all read it, so a day a player cannot write is never one they are scored on.
 * On screen time a last day the end cuts goes first, whatever its hours: it
 * can be typed only until `ends_at` and is then charged 1440 minutes, while a
 * first day the start cuts can be typed all evening and all of the next day
 * (`MANUAL_BACKFILL_DAYS`). New York in an Istanbul çelınc from Monday 00:00
 * keeps its Sunday from 17:00 and loses the Sunday that ends at 16:59.
 *
 * A check-in çelınc counts deadlines instead (`checkinPlayableDays`). A day
 * whose deadline the çelınc reaches outranks one it cuts before its deadline,
 * then the end whose slot it covers less of goes. An Istanbul "Hemen" erken_kus
 * opened at 00:30 has four mornings there and five in Tokyo: the first from
 * 06:30, its 07:00 still ahead, and the last from 04:00 until 05:59, its 07:00
 * after the end; the last goes. Days with no slot stay only where the creator
 * has the same day with none: a "Hemen" past the deadline still takes its late
 * 0, as it does for the creator, but New York's evening before an Istanbul
 * erken_kus from 04:00, or its Sunday that ends at 15:59 before its 19:00, is
 * no day of theirs to count or to be reminded of. Nobody is let in with fewer
 * (`checkinDaysShort`).
 */
export function scoringWindow(db: Database, challenge: ChallengeRow, tz: string): string[] {
  const window = challengeWindow(challenge, tz);
  const type = typeForChallenge(challenge);
  if (!SCORED_PER_DAY.includes(type.metricType)) return window;
  const zone = readableZone(tz);
  const creatorTz = creatorTimezone(db, challenge);
  // the creator's own zone has the creator's days, whatever the metric
  if (readableZone(creatorTz) === zone) return window;

  if (type.metricType === 'checkin_deadline') {
    const slot = checkinSlot(challenge, type, zone);
    const playable = window.filter((key) => slot(key).cover > 0);
    const days = checkinPlayableDays(challenge, type, creatorTz).length;
    if (challenge.window_rule === 0) return checkinWindowBefore019(window, playable, days, (key) => slot(key).cover);
    // a reachable deadline outranks any length of slot without one
    const kept = trimEnds(playable, days, (key) => {
      const { cover, deadlineIn } = slot(key);
      return cover + (deadlineIn ? DAY_MS : 0);
    });
    const first = kept[0];
    const last = kept[kept.length - 1];
    const creatorSlot = checkinSlot(challenge, type, readableZone(creatorTz));
    const creatorDays = new Set(challengeWindow(challenge, creatorTz));
    const bareForBoth = (key: string): boolean =>
      creatorDays.has(key) && slot(key).cover <= 0 && creatorSlot(key).cover <= 0;
    return window.filter(
      (key) => (first !== undefined && last !== undefined && key >= first && key <= last) || bareForBoth(key),
    );
  }

  const days = challengeWindow(challenge, creatorTz).length;
  if (days === 0 || window.length <= days) return window;

  const start = Date.parse(challenge.starts_at);
  const end = Date.parse(challenge.ends_at) + 1;
  const covered = (key: string): number =>
    Math.min(end, startOfDayInTz(addDays(key, 1), zone).getTime()) - Math.max(start, startOfDayInTz(key, zone).getTime());
  const lastKey = window[window.length - 1]!;
  if (challenge.window_rule !== 0 && type.metricType === 'manual_lower_is_better' && !dayOverByEnd(challenge, zone, lastKey)) {
    return trimEnds(window, days, (key) => (key === lastKey ? -DAY_MS : covered(key)));
  }
  return trimEnds(window, days, covered);
}

/**
 * A check-in çelınc made before migration 019 (`window_rule` 0) keeps the trim
 * it was played under: the end whose slot the çelınc covers less of goes,
 * whether or not its deadline is inside, with any slot-less day past it; a
 * slot-less day on a side nothing was cut from stays. Its players were told
 * their days by it and their entries refused or taken by it.
 */
function checkinWindowBefore019(
  window: string[],
  playable: string[],
  days: number,
  cover: (key: string) => number,
): string[] {
  if (playable.length <= days) return window;
  const kept = trimEnds(playable, days, cover);
  const first = kept[0];
  const last = kept[kept.length - 1];
  if (first === undefined || last === undefined) return [];
  return window.filter(
    (key) => (first === playable[0] || key >= first) && (last === playable[playable.length - 1] || key <= last),
  );
}

/** Drops ends off `days` until `count` are left: the one `covered` less, the last on a tie. */
function trimEnds(days: string[], count: number, covered: (key: string) => number): string[] {
  let kept = days;
  while (kept.length > count) {
    kept = covered(kept[0]!) < covered(kept[kept.length - 1]!) ? kept.slice(1) : kept.slice(0, -1);
  }
  return kept;
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
 * When a çelınc could first take a typed number (epoch ms).
 *
 * One created already running (a "Hemen" one) could from its start. One created
 * for later sat `pending` until its start AND a second yes
 * (`activateDueChallenges`), and `validateAndUpsertEntry` refuses every entry
 * while it is `pending`: a rematch nobody answered over the weekend, or a
 * "Yarın" çelınc whose friends said yes on day three, could not be played by
 * anybody before that, its creator included. That moment is the later of the
 * start and the second-earliest `joined_at`; a row accepted before `joined_at`
 * was always set counts as joined at creation. A yes taken back before the
 * start still counts (the row keeps no time of leaving), which at worst leaves
 * the whole window, as before. Fewer than two ever joined: it never started,
 * and the start stands.
 */
function playableFrom(db: Database, challenge: ChallengeRow): number {
  const startsAt = Date.parse(challenge.starts_at);
  if (!(Date.parse(challenge.created_at) < startsAt)) return startsAt;
  const joined = participantRows(db, challenge.id)
    .filter((p) => p.joined_at !== null || p.status === 'accepted')
    .map((p) => Date.parse(p.joined_at ?? challenge.created_at))
    .filter((at) => Number.isFinite(at))
    .sort((a, b) => a - b);
  const second = joined[1];
  return second === undefined ? startsAt : Math.max(startsAt, second);
}

/**
 * The first day a player is scored from, or null for everybody who could play
 * from the start.
 *
 * What counts is when the player COULD first have written, not when they said
 * yes: `invited_at` (the wizard's and a rematch's invitees get the creation
 * time, "Kanka ekle" the time of that invite, a declined friend asked again a
 * fresh one) or the moment the çelınc became playable (`playableFrom`),
 * whichever is later. An invitee who sits on the invite watching the standings
 * pays for the days they sat out, like anybody in from the start; an Android
 * phone's days come in with the yes anyway (`backfillFromPhone`).
 *
 * The floor is `LIMITS.MANUAL_PICKER_DAYS` (1) day before that day: the entry
 * picker offers it then and, on a lower-is-better çelınc, all of the next day
 * (`LIMITS.MANUAL_BACKFILL_DAYS`), so an evening yes still gets a whole day to
 * type it. Charging the missing-day penalty for the days before would hand the
 * çelınc to whoever was there first. Only a moment after `starts_at` counts as
 * late: a Hemen creator's invites go out a few seconds after the start, and a
 * floor on the day before the start day changes nothing.
 */
function lateJoinFloor(participant: ParticipantRow, challenge: ChallengeRow, tz: string, playable: number): string | null {
  const invitedAt = Date.parse(participant.invited_at);
  const from = Number.isFinite(invitedAt) ? Math.max(invitedAt, playable) : playable;
  if (!(from > Date.parse(challenge.starts_at))) return null;
  const at = new Date(from);
  let joinDay: string;
  try {
    joinDay = dayKeyInTz(at, tz);
  } catch {
    joinDay = dayKeyInTz(at, DEFAULT_TIMEZONE);
  }
  return addDays(joinDay, -LIMITS.MANUAL_PICKER_DAYS);
}

/**
 * One player's `scoringWindow`, and their entries without the days it left out.
 * Entries outside the full window are none of its business and stay as they were.
 */
function scoredDays(
  db: Database,
  challenge: ChallengeRow,
  tz: string,
  entries: ScoreInput['entries'],
): { window: string[]; entries: ScoreInput['entries'] } {
  const full = challengeWindow(challenge, tz);
  const window = scoringWindow(db, challenge, tz);
  if (window.length === full.length) return { window, entries };
  const dropped = new Set(full.filter((key) => !window.includes(key)));
  return { window, entries: entries.filter((entry) => !dropped.has(entry.dayKey)) };
}

/**
 * Ranks the accepted participants, each against their OWN day window.
 *
 * `rankParticipants` only knows a single shared window, so for
 * `manual_lower_is_better` — the one metric where the window matters — the score is
 * computed here per participant (sum + their own missing days × penalty) and handed
 * over as one pre-summed value. Every other metric ignores the window entirely and
 * is ranked from its raw entries.
 *
 * That window is `scoringWindow`, then cut twice more. A late joiner's starts at
 * `lateJoinFloor`, and their entries before it go with it (a phone syncs a week
 * back): `computeScore` divides every counted entry by the window's size, so a
 * dropped day whose entry stayed would skew the average. And until `ends_at` it
 * stops at the last day that is over: today, with its entries, only joins the
 * average tomorrow.
 *
 * A day `scoringWindow` leaves out takes its entries with it on a yes/no or
 * check-in çelınc too, where `computeScore` counts every day with a yes
 * whatever the window: one written before the trim existed would keep its
 * point. A finished çelınc keeps the days it was scored on: its results are
 * the stored ones (`computeStandings`), and `days` must not disagree with them.
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
  const trims = SCORED_PER_DAY.includes(type.metricType) && challenge.status !== 'finished';
  const days = new Map<string, number>();
  const playable = perUserWindow ? playableFrom(db, challenge) : 0;

  const inputs: ScoreInput[] = accepted.map((participant) => {
    const tz = participantTimezone(participant, users.get(participant.user_id));
    let entries = entriesByUser.get(participant.user_id) ?? [];
    let window: string[] = [];
    if (trims) ({ window, entries } = scoredDays(db, challenge, tz, entries));
    else if (perUserWindow) window = challengeWindow(challenge, tz);
    if (perUserWindow) {
      const floor = lateJoinFloor(participant, challenge, tz, playable);
      if (floor) {
        window = window.filter((key) => compareDayKeys(key, floor) >= 0);
        entries = entries.filter((entry) => compareDayKeys(entry.dayKey, floor) >= 0);
      }
      // While the çelınc runs, only the days that are over count: day 2 of 7
      // shows day 1, not five days of penalty for a future nobody has lived
      // yet. Today is left out, its entries too, until tomorrow: an Android
      // phone sends a half day at noon (40 dk so far) while an iPhone player
      // types theirs at night, and averaging the half day in would rank the
      // typer last and nudge them every afternoon. On day one there is no day
      // before, so today stays with what it has, and silence shows the worst
      // case instead of leading with 0. From `ends_at` on nothing can be typed
      // any more, so the full window applies, also to an end in the middle of
      // a day.
      if (challenge.status !== 'finished' && now.getTime() < Date.parse(challenge.ends_at)) {
        let today: string;
        try {
          today = todayKey(tz, now);
        } catch {
          today = todayKey(DEFAULT_TIMEZONE, now);
        }
        const over = window.filter((key) => compareDayKeys(key, today) < 0);
        if (over.length > 0) {
          window = over;
          entries = entries.filter((entry) => compareDayKeys(entry.dayKey, today) < 0);
        } else {
          // Today, or the first day scored when today is the sliver of a day
          // `scoringWindow` left out (Los Angeles in an Istanbul çelınc from
          // midnight): an empty window was a free 0 at the top for hours.
          window = window.includes(today) ? [today] : window.slice(0, 1);
        }
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
 * When each of these players' phone last reported, on a running çelınc the
 * phone counts. Every sync stamps each day it sends (`routes/me.ts`), changed
 * or not, so the newest stamp is the phone's last word, which the entries
 * cannot tell: a day's row is written at the first sync after midnight, and
 * a step day only moves when its number grows. Kept apart from `lastEntryAt`,
 * which the app's reminders read as "wrote today". Somebody who only types
 * never syncs and is left out; one whose phone once did (an Android since
 * swapped for an iPhone, usage access taken back) is left out by
 * `computeStandings` once they type here after the phone's last word.
 */
function lastPhoneSyncs(db: Database, challenge: ChallengeRow, type: ChallengeType, userIds: string[]): Map<string, string> {
  const metric = type.deviceMetric;
  if (!metric || challenge.status !== 'active' || userIds.length === 0) return new Map();
  const marks = userIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT user_id, MAX(updated_at) AS at FROM ${DEVICE_DAILY_TABLE[metric]}
        WHERE user_id IN (${marks}) GROUP BY user_id`,
    )
    .all(...userIds) as { user_id: string; at: string }[];
  return new Map(rows.map((row) => [row.user_id, row.at]));
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
  /** the newest number each player typed here, as opposed to one their phone sent */
  const lastTypedAt = new Map<string, string>();
  for (const entry of entries) {
    const list = byUser.get(entry.user_id) ?? [];
    list.push({ dayKey: entry.day_key, value: Number(entry.value), status: entry.status as ScoreInput['entries'][number]['status'] });
    byUser.set(entry.user_id, list);
    const previous = lastEntryAt.get(entry.user_id);
    if (!previous || entry.created_at > previous) lastEntryAt.set(entry.user_id, entry.created_at);
    if (!isDeviceSource(entry.source)) {
      const typed = lastTypedAt.get(entry.user_id);
      if (!typed || entry.updated_at > typed) lastTypedAt.set(entry.user_id, entry.updated_at);
    }
  }

  const accepted = participants.filter((p) => p.status === 'accepted');
  const { ranking, days } = rankAccepted(db, challenge, type, accepted, users, byUser, now);
  const byUserResult = new Map(ranking.results.map((r) => [r.userId, r]));
  const syncs = lastPhoneSyncs(db, challenge, type, accepted.map((p) => p.user_id));
  // A number typed after the phone's last word is the newest one here: the
  // player types now, and "telefonu sustu, sayı bayat" would sit under a number
  // they typed this morning.
  const lastSyncAt = (userId: string): string | null => {
    const sync = syncs.get(userId);
    const typed = lastTypedAt.get(userId);
    return sync !== undefined && (typed === undefined || sync > typed) ? sync : null;
  };

  const finished = challenge.status === 'finished';
  const views: ParticipantView[] = [];
  // a row with nobody in `invited_by` is the wizard's or a rematch's, and the creator's own has nobody
  const invitedBy = (participant: ParticipantRow): string | null =>
    participant.invited_by ?? (participant.user_id === challenge.creator_id ? null : challenge.creator_id);

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
      lastSyncAt: lastSyncAt(participant.user_id),
      invitedBy: invitedBy(participant),
      // A check-in's deadline is this zone's. Pinned at "Varım", so a profile
      // set to Tokyo for a minute took the mornings at 00:30 Istanbul for the
      // whole çelınc, and nothing on a rival's screen gave an itiraz a reason.
      timezone: participantTimezone(participant, user),
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
      lastSyncAt: null,
      invitedBy: invitedBy(participant),
      timezone: null,
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

export function startedCopy(level: VulgarityLevel, title: string): { title: string; body: string } {
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
 * The finish body for somebody behind a shared first place. The co-leaders drew
 * with each other, not with them: no winner to name and no laf on its way, but
 * the penalty is still theirs. Named when the çelınc has one; most have a
 * reward instead, and the results screen this opens says "Ceza yazılmamış".
 * No `leaders` (a block with one of them) says the same without a name.
 */
function behindTieBody(
  level: VulgarityLevel,
  vars: { title: string; leaders: string[]; leaderScore: string; rank: number; myScore: string; penalty: string | null },
): string {
  const { title, leaderScore, rank, myScore } = vars;
  const leaders = joinNames(vars.leaders);
  if (level === 1) {
    const top = leaders ? `${leaders} birinciliği paylaştı` : 'Birincilik paylaşıldı';
    return `${title} bitti. ${top} (${leaderScore}), sen ${rank}. oldun (${myScore}). İstersen rövanş aç.`;
  }
  const top = leaders ? `${leaders} berabere kaldı` : 'Birinciler berabere kaldı';
  const head = `${title} bitti. ${top} (${leaderScore}), sen ${rank}. oldun (${myScore}).`;
  // "Bulaşık sende." + "." would end it twice
  const penalty = vars.penalty?.trim().replace(/[.!…]+$/u, '') || null;
  if (level === 3) {
    return penalty ? `${head} Ceza sende 🍆 ${penalty}. Rövanşı aç da görelim.` : `${head} Yedin 🍆 Rövanşı aç da görelim.`;
  }
  return penalty ? `${head} Ceza sende: ${penalty}. Rövanş aç.` : `${head} Yine de yedin, rövanş aç.`;
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
 * follows the metric. `logged` is whether the reader already has an entry today:
 * on a count çelınc "girişini yapmayı unutma" to somebody who typed three
 * glasses this morning reads like the app did not see them.
 */
function nudgeAction(metricType: MetricType, level: VulgarityLevel, logged: boolean): string {
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
      if (logged) {
        if (polite) return 'Biraz daha eklersen fark kapanır.';
        return level === 3 ? 'Bu kadarla olmaz, biraz daha koy.' : 'Biraz daha yap da gir şuraya.';
      }
      return polite ? 'Bugünkü girişini yapmayı unutma.' : 'Bir şeyler yap da gir şuraya.';
  }
}

/**
 * The mid-day "somebody is ahead of you" notification the server sends by
 * itself, once per person per local day. `others` is how many more çelınclar
 * they are behind in today: the one buzz names the worst and counts the rest,
 * so a number never needs a suffix ("Başka 2 çelıncta da…"). `ahead` is null
 * when everybody ahead has a block with the reader: the gap still stands, the
 * name does not.
 */
function nudgeCopy(
  level: VulgarityLevel,
  ahead: string | null,
  gap: number,
  unit: string,
  metricType: MetricType,
  others: number,
  logged: boolean,
): { title: string; body: string } {
  const leader = ahead ?? 'Bir rakibin';
  const fark = `${formatScore(gap)} ${unit}`;
  const action = nudgeAction(metricType, level, logged);
  const count = others === 1 ? 'bir' : String(others);
  if (level === 1) {
    const more = others > 0 ? ` Başka ${count} çelıncta da gerideysin.` : '';
    return { title: 'Fark açılıyor', body: `${leader} önde, aradaki fark ${fark}. ${action}${more}` };
  }
  if (level === 3) {
    const more = others > 0 ? ` Başka ${count} çelıncta da yiyorsun 🍆` : '';
    return {
      title: 'O NE LAN 🍆',
      body: `${leader} sana ${fark} fark koymuş 🍆 ${action}${more}`,
    };
  }
  const more = others > 0 ? ` ${others === 1 ? 'Bir' : others} çelıncta daha gerideysin.` : '';
  return { title: 'O ne lan', body: `${leader} sana ${fark} fark koymuş. ${action}${more}` };
}

function reminderTitle(level: VulgarityLevel): string {
  if (level === 1) return '⏰ Günlük hatırlatma';
  if (level === 3) return '⏰ Kalk lan 🍆';
  return '⏰ Bugün ne yaptın?';
}

/**
 * The reminder for somebody whose phone has already written today (steps,
 * screen time): "Bugün hâlâ sıfırdasın" next to the 4.200 steps on their own
 * screen reads like the app did not see them, so it names the çelınc that is
 * still empty instead.
 */
function reminderBody(level: VulgarityLevel, title: string): string {
  if (level === 1) return `“${title}” için bugün henüz bir şey girmedin.`;
  if (level === 3) return `“${title}” bomboş lan. Kankalar bakıyor.`;
  return `“${title}” bugün boş kaldı. Gir şuraya.`;
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
 * A morning check-in çelınc starts when its window opens, 04:00 or 05:00
 * (`nextDayStartTime`), so that its first morning counts. Nobody wants to be
 * woken for that: before this hour where the player lives its "başladı" is not
 * sent, and the phone's check-in reminder half an hour before the deadline is
 * the first thing they hear (only where the phone has that reminder:
 * `startsQuietly`).
 */
const STARTED_QUIET_UNTIL_HOUR = 7;

function stillNight(now: Date, timezone: string): boolean {
  try {
    return localHour(now, timezone) < STARTED_QUIET_UNTIL_HOUR;
  } catch {
    return false;
  }
}

/** How long before a check-in deadline the phone's reminder rings (the app's services/reminders.ts). */
const PHONE_REMINDER_MINUTES = 30;

/**
 * Whether a check-in çelınc may start without a "başladı" to this player: it
 * is still night where they are (`stillNight`) AND their phone could have set
 * the reminder for the first deadline, which then speaks first.
 *
 * A phone sets that reminder only for a çelınc with a second yes (an invite,
 * or a `pending` one with only its creator in it, gets none), and only half
 * an hour before a deadline that comes after the start. So when the second yes
 * came after the start (Veli says yes at 05:45 to Ali's "Yarın 04:00"; this
 * step starts it within 30 s), Ali's phone had nothing for it, and when the
 * deadline is under half an hour after the start (erken_kus at 04:20 started
 * at 04:00), nobody's phone rings before it. Holding "başladı" back then left
 * the first morning to whoever happened to open the app: it goes out whatever
 * the hour.
 */
function startsQuietly(challenge: ChallengeRow, accepted: ParticipantRow[], timezone: string, now: Date): boolean {
  if (challenge.metric_type !== 'checkin_deadline' || !stillNight(now, timezone)) return false;
  const startsAt = Date.parse(challenge.starts_at);
  // a row from before `joined_at` was always set counts as in from the creation (`playableFrom`)
  const inBeforeStart = accepted.filter((p) => Date.parse(p.joined_at ?? challenge.created_at) <= startsAt);
  if (inBeforeStart.length < 2) return false;
  try {
    const minutes = hhmmToMinutes(effectiveDeadline(typeForChallenge(challenge), challenge.deadline_time));
    const deadlineOn = (dayKey: string) =>
      localInstant(dayKey, Math.floor(minutes / 60), minutes % 60, timezone).getTime();
    const startDay = dayKeyInTz(new Date(startsAt), timezone);
    let first = deadlineOn(startDay);
    // started after that day's deadline: its first one is the next morning
    if (first < startsAt) first = deadlineOn(addDays(startDay, 1));
    return first - PHONE_REMINDER_MINUTES * 60_000 >= startsAt;
  } catch {
    return false;
  }
}

/**
 * Step 1a — `pending` challenges whose start time has passed and that have at least
 * two accepted participants become `active` and notify everyone who accepted (on a
 * check-in çelınc, not before 07:00 where they are when their phone's reminder
 * speaks first: `startsQuietly`).
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
      for (const participant of accepted) {
        const user = users.get(participant.user_id);
        if (!user) continue;
        if (startsQuietly(challenge, accepted, participantTimezone(participant, user), now)) continue;
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
 * The çelınclar `inviterId` could call `friendId` into right now, soonest end
 * first: the rules of `POST /challenges/:id/invite`, read without refusing.
 * Somebody who just became a kanka is usually the friend a running group
 * çelınc was waiting for, and "Kanka oldunuz" used to say "Aç bir çelınc",
 * which split the group.
 */
export function invitableFor(db: Database, inviterId: string, friendId: string, now: Date): ChallengeRow[] {
  const mine = db
    .prepare(
      `SELECT c.* FROM challenges c
         JOIN challenge_participants p ON p.challenge_id = c.id
        WHERE p.user_id = ? AND p.status = 'accepted' AND c.status IN ('pending', 'active')
        ORDER BY c.ends_at ASC, c.created_at ASC`,
    )
    .all(inviterId) as ChallengeRow[];
  const friend = db.prepare('SELECT timezone FROM users WHERE id = ?').get(friendId) as
    | { timezone: string | null }
    | undefined;
  return mine.filter((challenge) => {
    if (!stillOpen(challenge, now) || now.getTime() >= acceptClosesAt(challenge.starts_at, challenge.ends_at)) {
      return false;
    }
    // fewer check-in days in their zone than the creator has
    const tz = participantTimezone(undefined, friend);
    if (checkinDaysShort(challenge, typeForChallenge(challenge), creatorTimezone(db, challenge), tz)) return false;
    const rows = participantRows(db, challenge.id);
    const theirs = rows.find((p) => p.user_id === friendId);
    if (theirs?.status === 'accepted' || theirs?.status === 'invited') return false;
    // played and walked out: the accept route would not let them back
    if (theirs?.status === 'left' && theirs.joined_at !== null) return false;
    const seated = rows.filter((p) => p.status === 'accepted' || p.status === 'invited');
    if (seated.filter((p) => p.user_id !== challenge.creator_id).length >= LIMITS.PARTICIPANTS_MAX) return false;
    // the creator even after leaving: the accept route would refuse them
    const others = [...seated.map((p) => p.user_id), challenge.creator_id].filter((id) => id !== inviterId);
    return !others.some((id) => isBlockedBetween(db, friendId, id));
  });
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
  // who shares first place in a tie, named to everybody who finished behind them,
  // in the final table's order (`participantRows`): the ranking breaks an equal
  // score by user id, a random UUID, so "Ali ve Veli" would read "Veli ve Ali"
  // on the next çelınc and disagree with the results screen and the share text
  const leaderUsers = isTie
    ? participantRows(db, challenge.id)
        .filter((p) => scoreById.get(p.user_id)?.rank === 1)
        .map((p) => users.get(p.user_id))
        .filter((leader): leader is UserRow => !!leader)
    : [];
  const leaders = leaderUsers.map((leader) => leader.display_name);
  const leaderScore = scoreLabel(type, ranking.results[0]?.score ?? 0);

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
      const myRank = mine?.rank ?? 1;

      if (isTie && myRank === 1) {
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

      if (isTie) {
        // Behind a shared first place is a loss like any other: the penalty is
        // this player's. Not `challenge_finished_lost`, whose lines promise a
        // winner's laf that no co-leader may send to somebody behind them.
        // A block with any of the co-leaders names none of them: "Ali ve bir
        // rakibin" would only point at the other one.
        const acrossBlock = leaderUsers.some((leader) => isBlockedBetween(db, user.id, leader.id));
        notify(db, {
          userId: user.id,
          type: 'challenge_finished',
          title: finishedTitle(level, 'loser'),
          body: behindTieBody(level, {
            title: challenge.title,
            leaders: acrossBlock ? [] : leaders,
            leaderScore,
            rank: myRank,
            myScore,
            penalty: challenge.penalty_text,
          }),
          data: { challengeId: challenge.id, role: 'loser', winnerId: null },
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
      // a block placed mid-race keeps both in it, but the lock screen does not
      // spell out the name the reader blocked (or was blocked by), nor open with
      // `challenge_finished_lost`: its "Rövanş isteyebilirsin." / "Kazanan ağzını
      // açarsa telefonun öter." promise a rematch and a laf the block refuses
      const acrossBlock = !!winnerUser && isBlockedBetween(db, user.id, winnerUser.id);
      const named = winnerUser && !acrossBlock ? winnerUser : undefined;
      notify(db, {
        userId: user.id,
        type: 'challenge_finished',
        title: finishedTitle(level, 'loser'),
        body: named
          ? `${t('challenge_finished_lost', level)} ${challenge.title} bitti. Kazanan ${named.display_name} (${winnerScore}), senin skorun ${myScore}.`
          : acrossBlock
            ? `${challenge.title} bitti, senin skorun ${myScore}.`
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
 * carries the final evening in full; nothing better is coming, and when none of
 * it moved a number (`movedAfterEnd`) making the group wait out the rest of the
 * hour would only delay the result.
 *
 * The day is the player's own (pinned timezone), the same window expression the
 * fan-out writes against (`scoringWindow`: on screen time a day another zone's
 * end cut short may not be one). A player whose last day the end cut in half is not
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
    const lastDay = scoringWindow(db, challenge, tz).at(-1);
    if (!lastDay) return false;
    if (!dayOverByEnd(challenge, tz, lastDay)) return true;
    const row = lastSync.get(participant.user_id, lastDay) as { updated_at: string } | undefined;
    return !!row && Date.parse(row.updated_at) > endedAt;
  });
}

/**
 * Whether a number was typed into the çelınc, or a typed one changed, in its
 * last `LIMITS.DEVICE_SETTLE_MS`. The entry route takes nothing from the end on,
 * so that hour is as late as typing gets; but an itiraz is the only check on a
 * typed number, and one posted at 23:59:30 left its rival thirty seconds to file
 * it: six 180-minute odak seansları, or 300 pages from the app's own form, were
 * crowned by the next pass. Such a çelınc keeps the hour after its end for
 * itirazlar (`disputesCloseAt`) and waits it out (`stillSettling`), whatever the
 * type: a "Beyan et" step day typed at the whistle needs it as much. A row the
 * phone wrote is not typed (`DEVICE_SOURCES`); its late numbers are
 * `movedAfterEnd`'s. An itiraz's turn moves `updated_at` on a typed row too,
 * which only gives the other players the same hour to join it. Only a turn
 * before the end counts: a photo answering an itiraz from the afternoon, or
 * the scheduler throwing out an unanswered one, comes after it, and on a
 * çelınc with nothing late it reopened itirazlar that had closed at the end
 * and held a result that only waited for that photo.
 */
function lateTypedEntry(db: Database, challenge: ChallengeRow): boolean {
  const from = nowIso(new Date(Date.parse(challenge.ends_at) - LIMITS.DEVICE_SETTLE_MS));
  const end = nowIso(new Date(Date.parse(challenge.ends_at)));
  const marks = DEVICE_SOURCES.map(() => '?').join(', ');
  const row = db
    .prepare(
      `SELECT 1 FROM entries WHERE challenge_id = ? AND source NOT IN (${marks})
          AND (created_at >= ? OR (updated_at >= ? AND updated_at < ?)) LIMIT 1`,
    )
    .get(challenge.id, ...DEVICE_SOURCES, from, from, end);
  return row !== undefined;
}

/**
 * Whether any entry of the çelınc changed after its end: a phone's late sync
 * raising a day (the fan-out stamps `updated_at` only on a row it changes, so a
 * sync that brings nothing new is not one), a day restored from the phone, an
 * itiraz's turn. Those are the numbers the phones' hour lets friends question,
 * so "every phone has reported" must not cut it short once one of them moved: a
 * player who kept his phone offline until his rival's post-midnight sync, then
 * raised three days, was crowned by the next pass with the rival's itiraz
 * refused.
 */
function movedAfterEnd(db: Database, challenge: ChallengeRow): boolean {
  const end = nowIso(new Date(Date.parse(challenge.ends_at)));
  const row = db.prepare('SELECT 1 FROM entries WHERE challenge_id = ? AND updated_at > ? LIMIT 1').get(challenge.id, end);
  return row !== undefined;
}

/**
 * Until when a friend may still file an itiraz (epoch ms). Past its end a çelınc
 * can still be `active`: the hour below, or an itiraz waiting for its photo.
 * Only that hour takes new ones, on a phone-counted type because the last
 * evening's numbers land in it, on any other one because a number was typed in
 * its last hour (`lateTypedEntry`); after that each new itiraz would hold the
 * result another `DISPUTE_ANSWER_MS`, and one after another could hold it for
 * days. A typed çelınc with nothing late closes them right at its end, as before.
 */
export function disputesCloseAt(db: Database, challenge: ChallengeRow): number {
  const held = !!typeForChallenge(challenge).deviceMetric || lateTypedEntry(db, challenge);
  return Date.parse(challenge.ends_at) + (held ? LIMITS.DEVICE_SETTLE_MS : 0);
}

/**
 * Until when an itiraz may be filed, as things stand at `now` (epoch ms):
 * `disputesCloseAt`, or the end of the hour while it still holds the çelınc
 * after the server started or woke past the end (`stillSettling` from
 * `bootAt`). The late numbers land in that hour wherever it falls: a reading a
 * phone sends at 08:05, after the PC slept through midnight, can be disputed
 * like one sent at 00:05, and so can a number typed at 23:59 that nobody could
 * see before the PC woke. Only that hour keeps it open, and only when the
 * server was down for some of the hour after the end; a restart does not
 * reopen a çelınc that only waits for an itiraz's photo, nor one every phone
 * has reported for with nothing moved after the end (the next pass crowns it).
 */
export function disputesOpenUntil(db: Database, challenge: ChallengeRow, now: Date, bootAt?: Date): number {
  const fixed = disputesCloseAt(db, challenge);
  if (!bootAt || !stillSettling(db, challenge, now, bootAt)) return fixed;
  return Math.max(fixed, settleFrom(db, challenge, bootAt) + LIMITS.DEVICE_SETTLE_MS);
}

/**
 * Where the hour an ended çelınc holds its result for starts (epoch ms): its
 * end, or, when the server was not running for some of the hour after it, the
 * first moment after which it then ran for a whole hour (`upSpanFrom`, over
 * the pauses the scheduler writes down). Without `bootAt` (no scheduler) the
 * end.
 */
function settleFrom(db: Database, challenge: ChallengeRow, bootAt?: Date): number {
  const endsAt = Date.parse(challenge.ends_at);
  return bootAt ? upSpanFrom(db, endsAt, LIMITS.DEVICE_SETTLE_MS) : endsAt;
}

/**
 * Whether an ended çelınc is still holding its result for an hour.
 *
 * Types the phone counts on its own wait for the phones: the final evening's
 * steps sit on the device until the next background sync, and a winner crowned
 * at midnight on a 22:15 reading cannot be taken back (the fan-out stops at
 * `finished`). They finish early once every phone has reported, unless a number
 * moved after the end (`movedAfterEnd`): friends get the hour to question it.
 * Any çelınc, typed or not, with a number typed in its last hour waits it out
 * too (`lateTypedEntry`). A typed çelınc with nothing late has nothing more to
 * receive and finishes on the dot.
 *
 * The hour runs from the end, or, when the server was not running for some of
 * the hour after the end, from where it came back (`settleFrom`, over the
 * pauses the scheduler writes down: a sleep or a stopped process): a server
 * that was off at midnight must not crown anybody on boot before a single phone
 * could reach it, nor before a friend could see the last typed number, and a
 * restart during that hour starts it again. A PC that slept through midnight
 * is the same server off at midnight (the phones' syncs failed all night), so
 * the hour runs from its wake. However it goes, the wait ends an hour
 * after that (an itiraz filed in it holds the result its own
 * `DISPUTE_ANSWER_MS` more, `disputeAwaitingAnswer`). A wake or restart long
 * after an hour the server was up for does not run it again: with an itiraz
 * holding the result for its photo, every sleep reopened itirazlar on it and
 * each new one held it 12 hours more.
 */
function stillSettling(db: Database, challenge: ChallengeRow, now: Date, bootAt?: Date): boolean {
  if (now.getTime() >= settleFrom(db, challenge, bootAt) + LIMITS.DEVICE_SETTLE_MS) return false;
  if (lateTypedEntry(db, challenge)) return true;
  const metric = typeForChallenge(challenge).deviceMetric;
  if (!metric) return false;
  if (movedAfterEnd(db, challenge)) return true;
  return !everyPhoneReported(db, challenge, metric);
}

/**
 * Step 2 — every `active` challenge whose end time has passed, once the phones
 * have had their chance to report and friends theirs to question the last
 * numbers (`stillSettling`), and no disputed entry is still inside its answer
 * window (`disputeAwaitingAnswer`): an owner told "12 saat içinde fotoğraf ekle"
 * keeps those hours even when the itiraz came at the last minute. Until then it
 * stays `active`, so a late device sync still fans out into it, an itiraz can
 * still be filed and a photo can still land; the entry route takes nothing from
 * `ends_at` on (`challenge_ended` in `validateAndUpsertEntry`).
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
 * their own timezone, only while they have typed nothing today and at least one
 * active challenge can still take an entry today, at most once per local day
 * (`reminders_sent`).
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
  // Where today's rows in the reader's live çelınclar came from. The reminder
  // is the one daily prompt to type something, and anything typed today means
  // they have been here. A row the phone wrote by itself (`DEVICE_SOURCES`: a
  // background step sync at 19:30, Android's screen time) does not: it used to
  // silence the reminder for every typed çelınc they also play, for the whole
  // of a step race.
  const sourcesToday = db.prepare(
    `SELECT DISTINCT e.source FROM entries e JOIN challenges c ON c.id = e.challenge_id
      WHERE e.user_id = ? AND e.day_key = ? AND c.status = 'active' AND e.status <> 'rejected'`,
  );
  // "Çelıncı unutma" has to point at something that still counts today. A
  // check-in past its deadline does not: the tap is stored late with 0, so an
  // erken_kus sleeper reminded at 20:00 would only meet "Bugünün check-in saati
  // geçti". Judged as entries.ts judges the tap, in the zone pinned at join time;
  // before its window opens (erken_yat before 19:00) the check-in is still ahead.
  // Nor does the sliver of a day `scoringWindow` leaves out of a friend's yes/no
  // or screen-time days, nor the extra deadline it leaves out of their check-in
  // days: the server refuses anything sent for it. Nor does a check-in day with
  // no slot (one that ends before its 19:00 opening). Nor does a çelınc the phone
  // counts by itself once a sync filled today: there is nothing to type. One
  // whose phone has sent nothing yet still does (an iPhone step racer: opening
  // the app is what sends the steps). Soonest end first: the one a reminder
  // names is the one with the least time left.
  const live = db.prepare(
    `SELECT c.*, p.timezone AS p_timezone FROM challenge_participants p
       JOIN challenges c ON c.id = p.challenge_id AND c.status = 'active' AND c.ends_at > ?
      WHERE p.user_id = ? AND p.status = 'accepted'
      ORDER BY c.ends_at, c.created_at`,
  );
  const filledToday = db.prepare(
    `SELECT 1 FROM entries WHERE challenge_id = ? AND user_id = ? AND day_key = ? AND status <> 'rejected' LIMIT 1`,
  );
  const stillToPlay = (user: UserRow): ChallengeRow[] =>
    (live.all(iso, user.id) as (ChallengeRow & { p_timezone: string | null })[]).filter((challenge) => {
      const type = typeForChallenge(challenge);
      try {
        const tz = participantTimezone({ timezone: challenge.p_timezone }, user);
        const today = todayKey(tz, now);
        if (type.deviceMetric && filledToday.get(challenge.id, user.id, today)) return false;
        if (!SCORED_PER_DAY.includes(type.metricType)) return true;
        if (!scoringWindow(db, challenge, tz).includes(today)) return false;
        if (type.metricType !== 'checkin_deadline') return true;
        // a day the çelınc gives no slot (it ends before the evening opens)
        if (!(checkinSlot(challenge, type, readableZone(tz))(today).cover > 0)) return false;
        const deadline = effectiveDeadline(type, challenge.deadline_time);
        return isBeforeOrEqualHHmm(localTimeHHmm(now, tz), deadline);
      } catch {
        // a zone this server cannot read: remind, as before
        return true;
      }
    });
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
    const sources = (sourcesToday.all(user.id, dayKey) as { source: string }[]).map((row) => row.source);
    if (sources.some((source) => !isDeviceSource(source))) continue;
    // before the claim: a çelınc accepted later this evening still gets today's
    const open = stillToPlay(user);
    if (open.length === 0) continue;

    const level = levelOf(user);
    // With the phone's own number already in today, "Bugün hâlâ sıfırdasın" is
    // false: the reminder names the çelınc still empty instead, and its tap opens it.
    const named = sources.length > 0 ? open[0] : null;
    // claim and write together: a disk that takes the small claim and not the
    // notification must not spend the day's one reminder
    const delivered = db.transaction(() => {
      if (claim.run(user.id, dayKey).changes === 0) return false;
      notify(db, {
        userId: user.id,
        type: 'reminder',
        title: reminderTitle(level),
        body: named ? reminderBody(level, named.title) : t('notification_daily_reminder', level),
        data: named ? { dayKey, challengeId: named.id } : { dayKey },
        createdAt: iso,
      });
      return true;
    })();
    if (delivered) sent += 1;
  }

  return sent;
}

/** Nobody wants a nudge at 3am, and after 22:00 the day is already lost. */
const NUDGE_FROM_HOUR = 12;
const NUDGE_UNTIL_HOUR = 22;
/** Below this the "fark" is noise — a 40-step gap is not a story. */
const NUDGE_MIN_RELATIVE_GAP = 0.1;

/** One çelınc where somebody is far enough behind to hear about it today. */
interface NudgeCandidate {
  challenge: ChallengeRow;
  user: UserRow;
  /** Who the nudge is about; both null when everybody ahead has a block with the reader. */
  aheadId: string | null;
  aheadName: string | null;
  gap: number;
  /** The gap next to the bigger of the two scores: 0..1 in either direction. */
  ratio: number;
  dayKey: string;
  /** The reader has a non-rejected entry in this çelınc today. */
  logged: boolean;
}

/**
 * The mid-day poke the server sends on its own: "o ne lan, {leader} sana fark
 * koymuş, kalk da iki dolaş".
 *
 * A friend can already poke by hand; this is the one that arrives when nobody
 * is looking, and it is what turns a çelınc from a scoreboard into something
 * that follows you around during the day.
 *
 * Four rules keep it from becoming spam: once per person per LOCAL day, however
 * many çelınclar they are behind in (being behind is the normal state, and
 * three buzzes at noon every day only teach the switch in Ayarlar), only
 * between noon and 22:00 where that person actually lives, only when somebody
 * is genuinely ahead, and never on a check-in çelınc — those have their own
 * deadline reminder and "you are behind" means nothing there. And somebody who
 * switched it off (`users.nudges_enabled`) gets none at all, nor does a
 * screen-time player with nothing reported yet: their gap is the missing-day
 * penalty. A yes/no çelınc the reader has already marked today is left out too,
 * and so is a count or focus çelınc whose daily cap they have already filled.
 *
 * The one nudge names the çelınc with the biggest gap for its size and counts
 * the others. All of them are claimed in `nudges_sent`, and any row of the
 * person's day means the day is used up, so a çelınc that falls behind later in
 * the afternoon does not buzz again. Returns the number of notifications sent.
 *
 * It is measured against the best player ahead whom the reader has no block
 * with: "Veli sana 9 bardak fark koymuş" in the name of somebody Ali blocked is
 * the poke the route refuses (403 blocked), arriving every afternoon anyway.
 * When everybody ahead is blocked the leader's gap still counts, the race is
 * still on, but the nudge names nobody ("Bir rakibin").
 */
export function sendNudges(db: Database, now: Date = new Date()): number {
  const iso = nowIso(now);
  const active = db.prepare(`SELECT * FROM challenges WHERE status = 'active'`).all() as ChallengeRow[];

  const candidates = new Map<string, NudgeCandidate[]>();
  const loggedOn = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(value), 0) AS total FROM entries
      WHERE challenge_id = ? AND user_id = ? AND day_key = ? AND status <> 'rejected'`,
  );

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
      // invited / declined / left rows ride along at rank 0 — not players to nudge
      if (view.status !== 'accepted') continue;
      // the leader, and whoever shares first place with them, has nobody ahead
      if (leader.rank >= view.rank) continue;
      // On screen time a player with nothing reported sits at the missing-day
      // penalty: that says "you have not entered anything yet", not "1.380 dk
      // fark koymuş".
      if (challenge.metric_type === 'manual_lower_is_better' && view.days === 0) continue;
      // standings run best first, so this is the best one ahead the reader may
      // still hear named; with none, the leader's gap goes out without a name
      const named = standings.find(
        (other) =>
          other.status === 'accepted' && other.rank < view.rank && !isBlockedBetween(db, view.user.id, other.user.id),
      );
      const ahead = named ?? leader;
      const gap = Math.abs(ahead.score - view.score);
      if (gap <= 0) continue;
      // a gap only counts when it is big next to what the one ahead has
      const reference = Math.abs(ahead.score) || Math.abs(view.score);
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
      // The sliver of a day `scoringWindow` leaves out of their yes/no or
      // screen-time days: "Bugünü kaçırma" would send them to a day the server
      // refuses (Los Angeles on the first afternoon of an Istanbul çelınc).
      const perDay = SCORED_PER_DAY.includes(typeForChallenge(challenge).metricType);
      if (perDay && !scoringWindow(db, challenge, timezone).includes(dayKey)) continue;
      const today = loggedOn.get(challenge.id, user.id, dayKey) as { n: number; total: number };
      const logged = today.n > 0;
      // A marked day is all a yes/no çelınc takes from today: nothing the reader
      // does this afternoon moves that gap, and "Bugünü işaretlemeyi unutma" at
      // noon to somebody who marked it at breakfast only teaches the switch in
      // Ayarlar. Before the claim, so the day stays free for a çelınc they can
      // still do something about.
      if (challenge.metric_type === 'daily_boolean' && logged) continue;
      // The same goes for a count çelınc whose daily cap is full: "Biraz daha
      // eklersen" would ask for a set the server refuses (daily_cap). Under a
      // cent left is what the entry form already calls "tavan doldu".
      if (challenge.metric_type === 'manual_count' && typeForChallenge(challenge).maxPerDay - today.total < 0.01) continue;
      // Likewise a focus çelınc at its daily minutes (360): "Kısa bir odak seansı
      // farkı kapatır" would send them to a timer the server cuts to nothing
      // (daily_cap). Under a minute left is a full day: the shortest session is one.
      if (challenge.metric_type === 'focus_minutes' && typeForChallenge(challenge).maxPerDay - today.total < 1) continue;

      const mine = candidates.get(user.id) ?? [];
      mine.push({
        challenge,
        user,
        aheadId: named ? named.user.id : null,
        aheadName: named ? named.user.displayName : null,
        gap,
        // Against the bigger score, not the leader's: on screen time the leader
        // has the SMALLER number, and 400 dk against their 60 would weigh 5.7,
        // beating 0 steps against 10.000 (1.0) every time.
        ratio: gap / Math.max(Math.abs(ahead.score), Math.abs(view.score)),
        dayKey,
        logged,
      });
      candidates.set(user.id, mine);
    }
  }

  const nudgedToday = db.prepare('SELECT 1 FROM nudges_sent WHERE user_id = ? AND day_key = ? LIMIT 1');
  const claim = db.prepare(
    'INSERT OR IGNORE INTO nudges_sent (challenge_id, user_id, day_key) VALUES (?, ?, ?)',
  );
  const nudge = db.transaction((mine: NudgeCandidate[]): boolean => {
    // Each çelınc keeps its own pinned zone, so the day is checked in every one
    // of them; they only differ for somebody who moved between joins.
    if (mine.some((candidate) => nudgedToday.get(candidate.user.id, candidate.dayKey))) return false;
    let best = mine[0];
    for (const candidate of mine) if (candidate.ratio > best.ratio) best = candidate;
    for (const candidate of mine) claim.run(candidate.challenge.id, candidate.user.id, candidate.dayKey);

    const copy = nudgeCopy(
      levelOf(best.user),
      best.aheadName,
      best.gap,
      best.challenge.unit,
      best.challenge.metric_type as MetricType,
      mine.length - 1,
      best.logged,
    );
    notify(db, {
      userId: best.user.id,
      type: 'nudge',
      title: copy.title,
      body: copy.body,
      // nobody's id where the body names nobody
      data: best.aheadId
        ? { challengeId: best.challenge.id, fromUserId: best.aheadId, dayKey: best.dayKey }
        : { challengeId: best.challenge.id, dayKey: best.dayKey },
      createdAt: iso,
    });
    return true;
  });

  let sent = 0;
  for (const mine of candidates.values()) if (nudge(mine)) sent += 1;
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

    const copy = tauntFollowupCopy(levelOf(winner), losers.map((loser) => loser.display_name));
    // claim and write together, as the daily reminder: once per çelınc, never lost to a half-done write
    const delivered = db.transaction(() => {
      if (claim.run(challenge.id, iso).changes === 0) return false;
      notify(db, {
        userId: winner.id,
        type: 'reminder',
        title: copy.title,
        body: copy.body,
        data: { challengeId: challenge.id, kind: 'taunt_followup' },
        createdAt: iso,
      });
      return true;
    })();
    if (delivered) sent += 1;
  }

  return sent;
}

/**
 * How long after `bootAt` (a start, or the PC waking) the passes send no daily
 * reminder and no nudge. While the server was away the phones parked what
 * their owners entered, and they send it only when they next reach it: an open
 * app at once, a phone in a pocket on its next background run, every 15
 * minutes at the soonest (`minimumInterval` in the app's
 * services/background.ts). Before that lands, "Bugün hâlâ sıfırdasın" goes to
 * somebody who logged at 10:30, the day's one nudge is spent on a lead that
 * is gone a minute later, and the weekly recap names a walker from hours-old
 * steps. Nothing is claimed meanwhile (both check everything
 * before their `reminders_sent` / `nudges_sent` claim), so the first pass after
 * it sends them with the parked entries counted, and the claims still keep them
 * to one a day. A phone that takes longer than this can still be reminded.
 */
export const WAKE_GRACE_MS = 20 * 60_000;

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
  step('disputes', () => resolveDisputes(db, now, { bootAt: deps.bootAt }), (n) => (summary.disputes = n));
  step('finalize', () => finalizeEndedChallenges(db, now, { bootAt: deps.bootAt }), (n) => (summary.finalized = n));
  step('cancel', () => cancelUnderfilled(db, now), (n) => (summary.cancelled = n));
  // the phones' parked entries land first (`WAKE_GRACE_MS`)
  const graceEnds = deps.bootAt ? new Date(deps.bootAt.getTime() + WAKE_GRACE_MS) : null;
  const justBack = graceEnds !== null && now.getTime() < graceEnds.getTime();
  if (!justBack) {
    step('reminders', () => sendReminders(db, now), (n) => (summary.reminders = n));
    step('nudges', () => sendNudges(db, now), (n) => (summary.nudges = n));
  }
  step('tauntFollowups', () => sendTauntFollowups(db, now), (n) => (summary.tauntFollowups = n));
  // After finalize, so a çelınc that ended this minute is already in the count,
  // and after the grace, so the steps the phones parked while the PC slept are
  // too: one week's walker line is never corrected. A window closing within
  // the grace (a Sunday evening at midnight, a Monday make-up at noon) goes now
  // rather than never.
  step(
    'recaps',
    () => sendWeeklyRecaps(db, now, justBack ? { closingBy: graceEnds } : {}),
    (n) => (summary.recaps = n),
  );

  return summary;
}
