/**
 * Entry validation and writing (SPEC 2.3) plus the dispute rule and its answer window.
 *
 * Everything the client sends is advisory: the day window, the caps, the check-in
 * verdict and the entry `late` flag are all decided here from the SERVER clock and
 * the catalog type stored on the challenge, never from `clientTime`.
 *
 * Day keys always live in the WRITER's timezone — the one PINNED on
 * `challenge_participants` when they joined, not the editable `users.timezone` — so
 * two friends in different zones each log against their own calendar day and nobody
 * can move their own deadline mid-challenge.
 */
import {
  LIMITS,
  compareDayKeys,
  diffDayKeys,
  formatNumberTr,
  isBeforeOrEqualHHmm,
  localTimeHHmm,
  todayKey,
  type ChallengeType,
  type EntryBody,
  type EntrySource,
  type MetricType,
} from '@koydum/shared';
import {
  countOf,
  newId,
  nowIso,
  type ChallengeRow,
  type Database,
  type DisputeRow,
  type EntryRow,
  type UserRow,
} from '../db/index.js';
import { badRequest, conflict, forbidden, notFound, type HttpError } from '../errors.js';
import { challengeWindow, dayOverByEnd, participantTimezone, typeForChallenge } from './challenges.js';
import {
  acceptedCount,
  disputeMajorityCopy,
  entryRejectedCopy,
  getParticipant,
  getUserRow,
  levelOf,
} from './challengeViews.js';
import { notify } from './notifications.js';
import { awardBadges } from './stats.js';

export interface EntryWriteInput {
  challenge: ChallengeRow;
  /** The writer — day keys and the check-in deadline are read in THEIR timezone. */
  user: UserRow;
  body: EntryBody;
  now: Date;
}

export interface EntryWriteResult {
  entry: EntryRow;
  /** False when a focus session replayed its `sessionId` (idempotent no-op). */
  created: boolean;
}

/** Which `source` values each metric accepts (SPEC 2.3). */
const ALLOWED_SOURCES: Record<MetricType, readonly EntrySource[]> = {
  // "beyan": a phone without a step API may declare the number by hand.
  auto_steps: ['pedometer', 'health_connect', 'manual'],
  focus_minutes: ['focus'],
  checkin_deadline: ['checkin'],
  daily_boolean: ['manual'],
  manual_count: ['manual'],
  // Android reads screen time itself (`usage_stats`); iPhones still type it.
  manual_lower_is_better: ['manual', 'usage_stats'],
};

/** Sources the phone wrote on its own — never typed, so never "beyan". */
export const DEVICE_SOURCES: readonly EntrySource[] = ['pedometer', 'health_connect', 'usage_stats'];

export function isDeviceSource(source: string): boolean {
  return (DEVICE_SOURCES as readonly string[]).includes(source);
}

function unitLabel(type: ChallengeType, value: number): string {
  const unit = type.unitTr.trim();
  return unit ? `${formatNumberTr(value)} ${unit}` : formatNumberTr(value);
}

function selectDayEntry(db: Database, challengeId: string, userId: string, dayKey: string): EntryRow | undefined {
  return db
    .prepare(
      'SELECT * FROM entries WHERE challenge_id = ? AND user_id = ? AND day_key = ? ORDER BY created_at ASC, id ASC LIMIT 1',
    )
    .get(challengeId, userId, dayKey) as EntryRow | undefined;
}

export function getEntryRow(db: Database, entryId: string): EntryRow | undefined {
  return db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId) as EntryRow | undefined;
}

function insertEntry(
  db: Database,
  input: EntryWriteInput,
  value: number,
  late: boolean,
  /** Only `focus_minutes` stores one — see `validateAndUpsertEntry`. */
  sessionId: string | null = null,
): EntryRow {
  const { challenge, user, body, now } = input;
  const iso = nowIso(now);
  const row: EntryRow = {
    id: newId(),
    challenge_id: challenge.id,
    user_id: user.id,
    day_key: body.dayKey,
    value,
    source: body.source,
    note: body.note ?? null,
    proof_url: body.proofUrl ?? null,
    status: 'ok',
    client_time: body.clientTime,
    session_id: sessionId,
    late: late ? 1 : 0,
    created_at: iso,
    updated_at: iso,
  };
  db.prepare(
    `INSERT INTO entries (id, challenge_id, user_id, day_key, value, source, note, proof_url, status,
                          client_time, session_id, late, created_at, updated_at)
     VALUES (@id, @challenge_id, @user_id, @day_key, @value, @source, @note, @proof_url, @status,
             @client_time, @session_id, @late, @created_at, @updated_at)`,
  ).run(row);
  return row;
}

/**
 * Lets everybody whose itiraz on this entry was answered (a photo) or taken back
 * file one again. Called when the entry itself changes: the photo that closed
 * an itiraz backed the old number, and in a 1v1 the rival is the only one who
 * could ever challenge the new one. Upheld and open rows stay; stats only
 * count upheld ones.
 */
export function forgetDismissedDisputes(db: Database, entryId: string): void {
  db.prepare("DELETE FROM disputes WHERE entry_id = ? AND status = 'dismissed'").run(entryId);
}

/**
 * One row per (challenge, user, day) for the upsert metrics.
 *
 * The stored `status` is preserved on purpose: re-posting a day must not launder a
 * `rejected` entry back into the standings after friends upheld a dispute on it.
 * A new value or photo reopens the door for itirazlar already closed on it
 * (`forgetDismissedDisputes`).
 */
function upsertDayEntry(db: Database, input: EntryWriteInput, value: number, late: boolean): EntryWriteResult {
  const { challenge, user, body, now } = input;
  const existing = selectDayEntry(db, challenge.id, user.id, body.dayKey);
  if (!existing) return { entry: insertEntry(db, input, value, late), created: true };

  const iso = nowIso(now);
  const changed = Number(existing.value) !== value || (existing.proof_url ?? null) !== (body.proofUrl ?? null);
  db.transaction(() => {
    db.prepare(
      `UPDATE entries SET value = ?, source = ?, note = ?, proof_url = ?, client_time = ?, late = ?, updated_at = ?
        WHERE id = ?`,
    ).run(value, body.source, body.note ?? null, body.proofUrl ?? null, body.clientTime, late ? 1 : 0, iso, existing.id);
    if (changed) forgetDismissedDisputes(db, existing.id);
  })();

  return { entry: { ...existing, value, source: body.source, note: body.note ?? null, proof_url: body.proofUrl ?? null, client_time: body.clientTime, late: late ? 1 : 0, updated_at: iso }, created: false };
}

/**
 * How many days back this metric may be backfilled (SPEC 2.3). A reading the
 * phone took itself gets the device window (the phone remembers about a week);
 * anything typed by hand gets the short manual one, whatever the metric.
 */
export function backfillDaysFor(metricType: MetricType, source?: EntrySource): number {
  if (metricType === 'auto_steps') return LIMITS.STEPS_BACKFILL_DAYS;
  if (source === 'usage_stats') return LIMITS.SCREEN_TIME_BACKFILL_DAYS;
  return LIMITS.MANUAL_BACKFILL_DAYS;
}

export type DayWindowIssue = 'day_out_of_range' | 'day_in_future' | 'day_too_old';

/**
 * THE day rules of SPEC 2.3, in one place: the day must sit in the challenge window
 * (computed in the writer's pinned timezone), must not be in the future and must not
 * be older than the metric's backfill limit.
 *
 * `POST /challenges/:id/entries` turns the answer into a 400; `POST /me/steps` uses
 * the same function to skip a day instead of writing it — otherwise the fan-out
 * would happily bank days the entry endpoint refuses.
 */
export function dayWindowIssue(
  window: readonly string[],
  metricType: MetricType,
  tz: string,
  dayKey: string,
  now: Date,
  source?: EntrySource,
): DayWindowIssue | null {
  if (!window.includes(dayKey)) return 'day_out_of_range';
  const today = todayKey(tz, now);
  if (compareDayKeys(dayKey, today) > 0) return 'day_in_future';
  if (diffDayKeys(dayKey, today) > backfillDaysFor(metricType, source)) return 'day_too_old';
  return null;
}

/** The Turkish 400 for a day the rules above rejected. */
export function dayWindowError(issue: DayWindowIssue, metricType: MetricType, source?: EntrySource): HttpError {
  if (issue === 'day_out_of_range') return badRequest('day_out_of_range', 'Bu gün çelıncın tarih aralığında değil.');
  if (issue === 'day_in_future') return badRequest('day_in_future', 'Gelecek bir gün için giriş yapamazsın.');
  return badRequest('day_too_old', `En fazla ${backfillDaysFor(metricType, source)} gün geriye giriş yapabilirsin.`);
}

/** The Turkish 400 for a typed entry after the end; says what is still coming in. */
function challengeEndedError(type: ChallengeType): HttpError {
  if (type.deviceMetric === 'steps') {
    return badRequest('challenge_ended', 'Süre bitti, artık elle giriş yok. Telefonların saydığı son adımlar toplanıyor.');
  }
  if (type.deviceMetric === 'screen_time') {
    return badRequest('challenge_ended', 'Süre bitti, artık elle giriş yok. Telefonların ölçtüğü son ekran süreleri toplanıyor.');
  }
  return badRequest('challenge_ended', 'Süre bitti, artık giriş yok. Sonuç birazdan.');
}

/**
 * Validates one entry against SPEC 2.3 and writes it (insert or upsert, per metric).
 * Throws `HttpError`s carrying the documented codes; never returns an invalid write.
 */
export function validateAndUpsertEntry(db: Database, input: EntryWriteInput): EntryWriteResult {
  const { challenge, user, body, now } = input;
  const type = typeForChallenge(challenge);

  // --- common rules --------------------------------------------------------
  const membership = getParticipant(db, challenge.id, user.id);
  if (!membership || membership.status !== 'accepted') {
    throw forbidden('not_participant', 'Bu çelınca katılmadın.');
  }
  if (challenge.status !== 'active') {
    throw badRequest('challenge_not_active', 'Bu çelınc şu an aktif değil.');
  }

  // Day keys and the check-in deadline are read in the timezone PINNED when this
  // user joined, never in the one their profile currently says: `PATCH /me` must not
  // be able to turn a late check-in into an on-time one.
  const tz = participantTimezone(membership, user);

  // Append metrics are idempotent on `sessionId`: a retried request (flaky network,
  // a timeout on the way back, the offline queue replaying) returns the row that was
  // already written instead of double counting. Focus sessions and manual counts
  // append, so they carry one; the upsert metrics key on the day already and ignore
  // (never store) the field.
  const appendsWithKey = type.metricType === 'focus_minutes' || type.metricType === 'manual_count';
  const sessionId = appendsWithKey ? (body.sessionId ?? null) : null;
  if (sessionId) {
    const replay = db
      .prepare('SELECT * FROM entries WHERE challenge_id = ? AND user_id = ? AND session_id = ?')
      .get(challenge.id, user.id, sessionId) as EntryRow | undefined;
    if (replay) return { entry: replay, created: false };
  }

  // Past its end a phone-counted çelınc stays `active` for up to an hour so the
  // last evening's device sync can land (`finalizeEndedChallenges`). That hour is
  // for the phones only: a number typed now could be picked after seeing the
  // final standings. A replay above is still answered — it was written in time.
  if (now.getTime() >= Date.parse(challenge.ends_at) && !isDeviceSource(body.source)) {
    throw challengeEndedError(type);
  }

  const allowed = ALLOWED_SOURCES[type.metricType];
  if (!allowed.includes(body.source)) {
    throw badRequest('invalid_source', 'Bu çelınc tipi için geçersiz giriş kaynağı.');
  }

  const window = challengeWindow(challenge, tz);
  const issue = dayWindowIssue(window, type.metricType, tz, body.dayKey, now, body.source);
  if (issue) throw dayWindowError(issue, type.metricType, body.source);
  // the same rule as the fan-out: after the whistle a day the end cut in half
  // keeps what it had, or steps walked after the end would count
  if (now.getTime() >= Date.parse(challenge.ends_at) && !dayOverByEnd(challenge, tz, body.dayKey)) {
    throw challengeEndedError(type);
  }

  if (body.value > type.maxPerEntry) {
    throw badRequest('value_too_large', `Tek girişte en fazla ${unitLabel(type, type.maxPerEntry)} girebilirsin.`);
  }

  // A photo can back a NUMBER somebody typed. A yes/no day and a check-in have
  // no photo step in the app, so the flag must not lock them (it once made every
  // proof-required daily_boolean çelınc impossible to mark).
  const photoApplies = type.metricType === 'manual_count' || type.metricType === 'manual_lower_is_better' || type.metricType === 'auto_steps';
  if (photoApplies && challenge.proof_required === 1 && body.source === 'manual' && !body.proofUrl) {
    throw badRequest('proof_required', 'Bu çelıncta kanıt fotoğrafı zorunlu.');
  }

  // --- per metric ----------------------------------------------------------
  switch (type.metricType) {
    case 'auto_steps': {
      if (body.value > type.maxPerDay) {
        throw badRequest('daily_cap', `Günlük sınır ${unitLabel(type, type.maxPerDay)}.`);
      }
      return upsertDayEntry(db, input, body.value, false);
    }

    case 'focus_minutes': {
      if (!sessionId) {
        throw badRequest('session_required', 'Odak seansı için oturum kimliği gerekli.');
      }
      if (body.value < LIMITS.FOCUS_MIN_MINUTES || body.value > LIMITS.FOCUS_MAX_MINUTES) {
        throw badRequest(
          'invalid_value',
          `Odak seansı ${LIMITS.FOCUS_MIN_MINUTES}-${LIMITS.FOCUS_MAX_MINUTES} dakika arası olmalı.`,
        );
      }
      return { entry: insertEntry(db, input, body.value, false, sessionId), created: true };
    }

    case 'checkin_deadline': {
      if (body.dayKey !== todayKey(tz, now)) {
        throw badRequest('checkin_today_only', 'Check-in sadece bugün için yapılır.');
      }
      if (selectDayEntry(db, challenge.id, user.id, body.dayKey)) {
        throw conflict('already_checked_in', 'Bugün zaten check-in yaptın.');
      }
      // The verdict is the SERVER's wall-clock time in the zone pinned at join time:
      // neither a phone with its clock rolled back nor a profile timezone edited
      // mid-challenge can buy an extra hour.
      const deadline = challenge.deadline_time ?? type.defaultDeadlineTime ?? '23:59';
      const localNow = localTimeHHmm(now, tz);
      // "yattım" at 02:00 is not an early bedtime, it is last night's late one:
      // before the type's window opens the button does nothing for today.
      if (type.checkinWindowStart && isBeforeOrEqualHHmm(localNow, type.checkinWindowStart) && localNow !== type.checkinWindowStart) {
        throw badRequest('checkin_too_early', `Bu check-in ${type.checkinWindowStart}'den sonra sayılıyor. Biraz erken geldin.`);
      }
      const onTime = isBeforeOrEqualHHmm(localNow, deadline);
      return { entry: insertEntry(db, input, onTime ? 1 : 0, !onTime), created: true };
    }

    case 'daily_boolean': {
      if (body.value !== 0 && body.value !== 1) {
        throw badRequest('invalid_value', 'Bu çelıncta değer 0 ya da 1 olmalı.');
      }
      return upsertDayEntry(db, input, body.value, false);
    }

    case 'manual_lower_is_better': {
      // Once the phone has reported a day itself, a typed number (with whatever
      // screenshot) may not replace it — the device reading is the honest one.
      const existing = selectDayEntry(db, challenge.id, user.id, body.dayKey);
      if (existing && isDeviceSource(existing.source) && !isDeviceSource(body.source)) {
        throw conflict('device_locked', 'Bu günün değerini telefon kendisi okudu, elle değiştirilemez.');
      }
      return upsertDayEntry(db, input, body.value, false);
    }

    case 'manual_count':
    default: {
      const sum = countOf(
        db,
        `SELECT COALESCE(SUM(value), 0) AS n FROM entries
          WHERE challenge_id = ? AND user_id = ? AND day_key = ? AND status <> 'rejected'`,
        challenge.id,
        user.id,
        body.dayKey,
      );
      if (sum + body.value > type.maxPerDay) {
        throw badRequest(
          'daily_cap',
          `Günlük sınır ${unitLabel(type, type.maxPerDay)}. Bugün zaten ${unitLabel(type, sum)} girdin.`,
        );
      }
      return { entry: insertEntry(db, input, body.value, false, sessionId), created: true };
    }
  }
}


// ---------------------------------------------------------------------------
// Disputes
// ---------------------------------------------------------------------------

/**
 * How many open disputes it takes to put an entry on the clock.
 *
 * A simple majority of the OTHER accepted participants: `ceil((accepted - 1) / 2)`,
 * never below 1. Head to head (2 accepted) the single rival decides; with 3 or 4
 * accepted it takes 1 or 2; with 5 it takes 2 of the 4 rivals. The entry owner is
 * excluded from the count because they can never dispute their own row.
 */
export function disputeThreshold(acceptedParticipants: number): number {
  return Math.max(1, Math.ceil((acceptedParticipants - 1) / 2));
}

/**
 * Open itirazlar on each disputed entry of an accepted player in this çelınc,
 * counting only those filed by somebody still in the race: a row of somebody
 * who left scores nothing, so nothing waits on it, and an itiraz of somebody
 * who left is not a friend's vote any more.
 */
function disputedEntries(
  db: Database,
  challengeId: string,
  entryId?: string,
): (EntryRow & { open_count: number })[] {
  return db
    .prepare(
      `SELECT e.*, (
         SELECT COUNT(*) FROM disputes d
           JOIN challenge_participants dp
             ON dp.challenge_id = e.challenge_id AND dp.user_id = d.by_user_id AND dp.status = 'accepted'
          WHERE d.entry_id = e.id AND d.status = 'open'
       ) AS open_count
         FROM entries e
         JOIN challenge_participants p ON p.challenge_id = e.challenge_id AND p.user_id = e.user_id AND p.status = 'accepted'
        WHERE e.challenge_id = ? AND e.status = 'disputed' ${entryId ? 'AND e.id = ?' : ''}
        ORDER BY e.created_at ASC, e.id ASC`,
    )
    .all(...(entryId ? [challengeId, entryId] : [challengeId])) as (EntryRow & { open_count: number })[];
}

/**
 * Starts or stops the owner's answer clock (`entries.answer_by`) on the disputed
 * entries of one çelınc, from the majority as it stands NOW.
 *
 * The clock starts the moment the open itirazlar make a majority, with the full
 * `DISPUTE_ANSWER_MS` from then, and is stored: somebody leaving shrinks the
 * majority, and deriving the start from the itiraz's own time would put an
 * old one's clock hours in the past and throw the entry out on the next pass
 * without a word. It stops when the majority is gone (an itiraz taken back,
 * a disputer who left). Returns the entries whose clock started in this call;
 * the caller tells their owners (`recordDispute`'s route, or
 * `announceDisputeClocks`).
 */
export function syncDisputeClocks(db: Database, challengeId: string, now: Date, entryId?: string): EntryRow[] {
  const threshold = disputeThreshold(acceptedCount(db, challengeId));
  const setClock = db.prepare('UPDATE entries SET answer_by = ? WHERE id = ?');
  const started: EntryRow[] = [];
  for (const row of disputedEntries(db, challengeId, entryId)) {
    const { open_count: open, ...entry } = row;
    const onClock = entry.answer_by !== null && entry.answer_by !== undefined;
    if (open >= threshold && !onClock) {
      const answerBy = nowIso(new Date(now.getTime() + LIMITS.DISPUTE_ANSWER_MS));
      setClock.run(answerBy, entry.id);
      started.push({ ...entry, answer_by: answerBy });
    } else if (open < threshold && onClock) {
      setClock.run(null, entry.id);
    }
  }
  return started;
}

/**
 * `syncDisputeClocks` for a çelınc whose player count just changed (a leave,
 * an account deletion, the scheduler's pass): every owner whose entry went on
 * the clock hears "12 saat" at their own level. Only while it is `active`;
 * runs inside the caller's transaction when there is one.
 */
export function announceDisputeClocks(db: Database, challengeId: string, now: Date): number {
  const challenge = db.prepare('SELECT * FROM challenges WHERE id = ?').get(challengeId) as ChallengeRow | undefined;
  if (!challenge || challenge.status !== 'active') return 0;
  const started = syncDisputeClocks(db, challengeId, now);
  const iso = nowIso(now);
  for (const entry of started) {
    const owner = getUserRow(db, entry.user_id);
    if (!owner || owner.deleted_at !== null) continue;
    const copy = disputeMajorityCopy(levelOf(owner), challenge.title, entry.day_key);
    notify(db, {
      userId: owner.id,
      type: 'dispute',
      title: copy.title,
      body: copy.body,
      data: { challengeId, entryId: entry.id, answerBy: entry.answer_by },
      createdAt: iso,
    });
  }
  return started.length;
}

/**
 * When each entry on the clock is thrown out unless its owner adds a photo
 * first (epoch ms, by entry id): the stored `answer_by` of disputed entries of
 * players still in the race.
 */
export function disputeDeadlines(db: Database, challengeId: string): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT e.id, e.answer_by FROM entries e
         JOIN challenge_participants p ON p.challenge_id = e.challenge_id AND p.user_id = e.user_id AND p.status = 'accepted'
        WHERE e.challenge_id = ? AND e.status = 'disputed' AND e.answer_by IS NOT NULL`,
    )
    .all(challengeId) as { id: string; answer_by: string }[];

  const deadlines = new Map<string, number>();
  for (const row of rows) {
    const at = Date.parse(row.answer_by);
    if (Number.isFinite(at)) deadlines.set(row.id, at);
  }
  return deadlines;
}

/** True while an entry of this çelınc is inside its answer window — its result must wait. */
export function disputeAwaitingAnswer(db: Database, challengeId: string, now: Date): boolean {
  for (const deadline of disputeDeadlines(db, challengeId).values()) {
    if (now.getTime() < deadline) return true;
  }
  return false;
}

export interface DisputeOutcome {
  dispute: DisputeRow;
  entry: EntryRow;
  openCount: number;
  threshold: number;
  /** Set once the open disputes are a majority: when the entry goes unless its owner answers. */
  answerBy: string | null;
  /** True when THIS dispute made it a majority, so the owner's clock starts now. */
  reachedThreshold: boolean;
}

/**
 * Records one dispute. Nothing is thrown out here: an entry the majority disputes
 * stays `disputed` — and keeps counting (SPEC 1.3) — for `DISPUTE_ANSWER_MS`,
 * so a losing rival cannot zero a day with one tap; its owner can answer with a
 * photo (`answerDisputeWithProof`) and only silence gets it rejected
 * (`resolveDisputes`). Callers send the notification (they need the owner's level).
 */
export function recordDispute(
  db: Database,
  input: { challenge: ChallengeRow; entry: EntryRow; byUserId: string; reason: string; now: Date },
): DisputeOutcome {
  const { challenge, entry, byUserId, reason, now } = input;

  if (entry.user_id === byUserId) {
    throw forbidden('own_entry', 'Kendi girişine itiraz edemezsin.');
  }
  if (entry.status === 'rejected') {
    throw conflict('already_rejected', 'Bu giriş zaten iptal edilmiş.');
  }
  // One per person per entry, whatever became of it: an itiraz taken back or
  // answered with a photo is not filed again.
  const existing = db
    .prepare('SELECT id FROM disputes WHERE entry_id = ? AND by_user_id = ?')
    .get(entry.id, byUserId) as { id: string } | undefined;
  if (existing) {
    throw conflict('already_disputed', 'Bu girişe zaten itiraz ettin.');
  }

  const iso = nowIso(now);
  const dispute: DisputeRow = {
    id: newId(),
    entry_id: entry.id,
    by_user_id: byUserId,
    reason,
    status: 'open',
    created_at: iso,
  };
  const threshold = disputeThreshold(acceptedCount(db, challenge.id));

  let openCount = 0;
  let reachedThreshold = false;
  const run = db.transaction(() => {
    db.prepare(
      'INSERT INTO disputes (id, entry_id, by_user_id, reason, status, created_at) VALUES (@id, @entry_id, @by_user_id, @reason, @status, @created_at)',
    ).run(dispute);
    if (entry.status === 'ok') {
      db.prepare("UPDATE entries SET status = 'disputed', updated_at = ? WHERE id = ?").run(iso, entry.id);
    }
    openCount = countOf(db, "SELECT COUNT(*) AS n FROM disputes WHERE entry_id = ? AND status = 'open'", entry.id);
    reachedThreshold = syncDisputeClocks(db, challenge.id, now, entry.id).length > 0;
  });
  run();

  const deadline = disputeDeadlines(db, challenge.id).get(entry.id);
  return {
    dispute,
    entry: getEntryRow(db, entry.id) ?? entry,
    openCount,
    threshold,
    answerBy: deadline === undefined ? null : new Date(deadline).toISOString(),
    reachedThreshold,
  };
}

/**
 * The disputer takes their itiraz back: it becomes `dismissed`, and once no open
 * dispute is left the entry is a plain `ok` row again. Only an OPEN one can be
 * taken back — an upheld itiraz already did its job.
 */
export function withdrawDispute(
  db: Database,
  input: { entry: EntryRow; byUserId: string; now: Date },
): { dispute: DisputeRow; entry: EntryRow } {
  const { entry, byUserId, now } = input;
  const dispute = db
    .prepare("SELECT * FROM disputes WHERE entry_id = ? AND by_user_id = ? AND status = 'open'")
    .get(entry.id, byUserId) as DisputeRow | undefined;
  if (!dispute) throw notFound('dispute_not_found', 'Bu girişte açık bir itirazın yok.');

  const run = db.transaction(() => {
    db.prepare("UPDATE disputes SET status = 'dismissed' WHERE id = ?").run(dispute.id);
    const open = countOf(db, "SELECT COUNT(*) AS n FROM disputes WHERE entry_id = ? AND status = 'open'", entry.id);
    if (open === 0 && entry.status === 'disputed') {
      db.prepare("UPDATE entries SET status = 'ok', answer_by = NULL, updated_at = ? WHERE id = ?").run(nowIso(now), entry.id);
    } else {
      // no longer a majority: the owner's clock stops
      syncDisputeClocks(db, entry.challenge_id, now, entry.id);
    }
  });
  run();

  return { dispute: { ...dispute, status: 'dismissed' }, entry: getEntryRow(db, entry.id) ?? entry };
}

/**
 * The owner answers with a photo: it goes on the entry, every open itiraz is
 * `dismissed` and the entry counts as `ok` again. The disputers cannot file the
 * same itiraz twice; they get told to have a look (by the caller, which knows
 * their levels), so a fake photo is still between friends.
 *
 * Returns who disputed.
 */
export function answerDisputeWithProof(
  db: Database,
  input: { entry: EntryRow; byUserId: string; proofUrl: string; now: Date },
): { entry: EntryRow; disputerIds: string[] } {
  const { entry, byUserId, proofUrl, now } = input;
  if (entry.user_id !== byUserId) {
    throw forbidden('not_your_entry', 'Kanıtı sadece girişin sahibi ekleyebilir.');
  }
  if (entry.status === 'rejected') {
    throw conflict('already_rejected', 'Bu giriş zaten iptal edilmiş.');
  }
  if (entry.status !== 'disputed') {
    throw conflict('not_disputed', 'Bu girişe itiraz yok, kanıta gerek yok.');
  }

  let disputerIds: string[] = [];
  const run = db.transaction(() => {
    disputerIds = (
      db.prepare("SELECT by_user_id FROM disputes WHERE entry_id = ? AND status = 'open'").all(entry.id) as {
        by_user_id: string;
      }[]
    ).map((row) => row.by_user_id);
    db.prepare("UPDATE disputes SET status = 'dismissed' WHERE entry_id = ? AND status = 'open'").run(entry.id);
    db.prepare("UPDATE entries SET proof_url = ?, status = 'ok', answer_by = NULL, updated_at = ? WHERE id = ?").run(
      proofUrl,
      nowIso(now),
      entry.id,
    );
  });
  run();

  return { entry: getEntryRow(db, entry.id) ?? entry, disputerIds };
}

/**
 * Throws out an entry whose owner let the answer window run out: the open
 * disputes become `upheld` (that is what `disputesWon` counts), the entry
 * `rejected`, the owner hears about it and every disputer's badges are
 * recounted (Yalan Dedektörü, Savcı).
 */
export function upholdDisputes(db: Database, challenge: ChallengeRow, entry: EntryRow, now: Date): string[] {
  const iso = nowIso(now);
  let disputerIds: string[] = [];
  const run = db.transaction(() => {
    disputerIds = (
      db.prepare("SELECT by_user_id FROM disputes WHERE entry_id = ? AND status = 'open'").all(entry.id) as {
        by_user_id: string;
      }[]
    ).map((row) => row.by_user_id);
    db.prepare("UPDATE disputes SET status = 'upheld' WHERE entry_id = ? AND status = 'open'").run(entry.id);
    db.prepare("UPDATE entries SET status = 'rejected', updated_at = ? WHERE id = ?").run(iso, entry.id);

    // an owner who deleted their account is simply not told
    const owner = getUserRow(db, entry.user_id);
    if (owner && owner.deleted_at === null) {
      const copy = entryRejectedCopy(levelOf(owner), challenge.title, entry.day_key);
      notify(db, {
        userId: owner.id,
        type: 'entry_rejected',
        title: copy.title,
        body: copy.body,
        data: { challengeId: challenge.id, entryId: entry.id, dayKey: entry.day_key },
        createdAt: iso,
      });
    }
  });
  run();

  for (const disputerId of disputerIds) awardBadges(db, disputerId, now);
  return disputerIds;
}

/**
 * Scheduler step: every disputed entry whose answer window ran out without a
 * photo is thrown out (`upholdDisputes`). It runs right before `finalize` in the
 * same pass, so a çelınc that was only waiting on this entry finishes without it.
 *
 * First it brings every clock up to date (`announceDisputeClocks`): that is
 * what starts one on a database written before `answer_by` existed, always with
 * a full window from now and a word to the owner, never one already run out.
 */
export function resolveDisputes(db: Database, now: Date = new Date()): number {
  const challenges = db
    .prepare(
      `SELECT DISTINCT c.* FROM challenges c
         JOIN entries e ON e.challenge_id = c.id AND e.status = 'disputed'
        WHERE c.status = 'active'`,
    )
    .all() as ChallengeRow[];

  let upheld = 0;
  for (const challenge of challenges) {
    db.transaction(() => announceDisputeClocks(db, challenge.id, now))();
    for (const [entryId, deadline] of disputeDeadlines(db, challenge.id)) {
      if (now.getTime() < deadline) continue;
      const entry = getEntryRow(db, entryId);
      if (!entry || entry.status !== 'disputed') continue;
      upholdDisputes(db, challenge, entry, now);
      upheld += 1;
    }
  }
  return upheld;
}
