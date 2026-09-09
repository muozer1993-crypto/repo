/**
 * Entry validation and writing (SPEC 2.3) plus the dispute rule.
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
import { badRequest, conflict, forbidden, type HttpError } from '../errors.js';
import { challengeWindow, participantTimezone, typeForChallenge } from './challenges.js';
import { getParticipant } from './challengeViews.js';

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
  manual_lower_is_better: ['manual'],
};

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
 * One row per (challenge, user, day) for the upsert metrics.
 *
 * The stored `status` is preserved on purpose: re-posting a day must not launder a
 * `rejected` entry back into the standings after friends upheld a dispute on it.
 */
function upsertDayEntry(db: Database, input: EntryWriteInput, value: number, late: boolean): EntryWriteResult {
  const { challenge, user, body, now } = input;
  const existing = selectDayEntry(db, challenge.id, user.id, body.dayKey);
  if (!existing) return { entry: insertEntry(db, input, value, late), created: true };

  const iso = nowIso(now);
  db.prepare(
    `UPDATE entries SET value = ?, source = ?, note = ?, proof_url = ?, client_time = ?, late = ?, updated_at = ?
      WHERE id = ?`,
  ).run(value, body.source, body.note ?? null, body.proofUrl ?? null, body.clientTime, late ? 1 : 0, iso, existing.id);

  return { entry: { ...existing, value, source: body.source, note: body.note ?? null, proof_url: body.proofUrl ?? null, client_time: body.clientTime, late: late ? 1 : 0, updated_at: iso }, created: false };
}

/** How many days back this metric may be backfilled (SPEC 2.3). */
export function backfillDaysFor(metricType: MetricType): number {
  return metricType === 'auto_steps' ? LIMITS.STEPS_BACKFILL_DAYS : LIMITS.MANUAL_BACKFILL_DAYS;
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
): DayWindowIssue | null {
  if (!window.includes(dayKey)) return 'day_out_of_range';
  const today = todayKey(tz, now);
  if (compareDayKeys(dayKey, today) > 0) return 'day_in_future';
  if (diffDayKeys(dayKey, today) > backfillDaysFor(metricType)) return 'day_too_old';
  return null;
}

/** The Turkish 400 for a day the rules above rejected. */
export function dayWindowError(issue: DayWindowIssue, metricType: MetricType): HttpError {
  if (issue === 'day_out_of_range') return badRequest('day_out_of_range', 'Bu gün çelincin tarih aralığında değil.');
  if (issue === 'day_in_future') return badRequest('day_in_future', 'Gelecek bir gün için giriş yapamazsın.');
  return badRequest('day_too_old', `En fazla ${backfillDaysFor(metricType)} gün geriye giriş yapabilirsin.`);
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
    throw forbidden('not_participant', 'Bu çelince katılmadın.');
  }
  if (challenge.status !== 'active') {
    throw badRequest('challenge_not_active', 'Bu çelinç şu an aktif değil.');
  }

  // Day keys and the check-in deadline are read in the timezone PINNED when this
  // user joined, never in the one their profile currently says: `PATCH /me` must not
  // be able to turn a late check-in into an on-time one.
  const tz = participantTimezone(membership, user);

  // Focus sessions are idempotent on `sessionId`: a retried request (flaky network,
  // app relaunch) returns the row that was already written instead of double counting.
  // Only focus does this — for any other metric a repeated id must not swallow a
  // legitimate new entry, so the field is ignored (and never stored) there.
  const sessionId = type.metricType === 'focus_minutes' ? (body.sessionId ?? null) : null;
  if (sessionId) {
    const replay = db
      .prepare('SELECT * FROM entries WHERE challenge_id = ? AND user_id = ? AND session_id = ?')
      .get(challenge.id, user.id, sessionId) as EntryRow | undefined;
    if (replay) return { entry: replay, created: false };
  }

  const window = challengeWindow(challenge, tz);
  const issue = dayWindowIssue(window, type.metricType, tz, body.dayKey, now);
  if (issue) throw dayWindowError(issue, type.metricType);

  const allowed = ALLOWED_SOURCES[type.metricType];
  if (!allowed.includes(body.source)) {
    throw badRequest('invalid_source', 'Bu çelinç tipi için geçersiz giriş kaynağı.');
  }

  if (body.value > type.maxPerEntry) {
    throw badRequest('value_too_large', `Tek girişte en fazla ${unitLabel(type, type.maxPerEntry)} girebilirsin.`);
  }

  if (challenge.proof_required === 1 && body.source === 'manual' && !body.proofUrl) {
    throw badRequest('proof_required', 'Bu çelinçte kanıt fotoğrafı zorunlu.');
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
      const onTime = isBeforeOrEqualHHmm(localTimeHHmm(now, tz), deadline);
      return { entry: insertEntry(db, input, onTime ? 1 : 0, !onTime), created: true };
    }

    case 'daily_boolean': {
      if (body.value !== 0 && body.value !== 1) {
        throw badRequest('invalid_value', 'Bu çelinçte değer 0 ya da 1 olmalı.');
      }
      return upsertDayEntry(db, input, body.value, false);
    }

    case 'manual_lower_is_better': {
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
      return { entry: insertEntry(db, input, body.value, false), created: true };
    }
  }
}

// ---------------------------------------------------------------------------
// Disputes
// ---------------------------------------------------------------------------

/**
 * How many open disputes it takes to throw an entry out.
 *
 * A simple majority of the OTHER accepted participants: `ceil((accepted - 1) / 2)`,
 * never below 1. Head to head (2 accepted) the single rival decides; with 3 or 4
 * accepted it takes 1 or 2; with 5 it takes 2 of the 4 rivals. The entry owner is
 * excluded from the count because they can never dispute their own row.
 */
export function disputeThreshold(acceptedParticipants: number): number {
  return Math.max(1, Math.ceil((acceptedParticipants - 1) / 2));
}

export interface DisputeOutcome {
  dispute: DisputeRow;
  entry: EntryRow;
  /** True when this dispute reached the threshold and the entry was rejected. */
  upheld: boolean;
  openCount: number;
  threshold: number;
  /** Everyone whose dispute was upheld (their `disputesWon` just went up). */
  disputerIds: string[];
}

/**
 * Records one dispute and applies the threshold rule. Callers are responsible for
 * the notifications (they need the recipients' vulgarity levels) and badges.
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

  const accepted = countOf(
    db,
    "SELECT COUNT(*) AS n FROM challenge_participants WHERE challenge_id = ? AND status = 'accepted'",
    challenge.id,
  );
  const threshold = disputeThreshold(accepted);

  let openCount = 0;
  let upheld = false;
  let disputerIds: string[] = [];

  const run = db.transaction(() => {
    db.prepare(
      'INSERT INTO disputes (id, entry_id, by_user_id, reason, status, created_at) VALUES (@id, @entry_id, @by_user_id, @reason, @status, @created_at)',
    ).run(dispute);

    openCount = countOf(db, "SELECT COUNT(*) AS n FROM disputes WHERE entry_id = ? AND status = 'open'", entry.id);

    if (openCount >= threshold) {
      db.prepare("UPDATE disputes SET status = 'upheld' WHERE entry_id = ? AND status = 'open'").run(entry.id);
      db.prepare("UPDATE entries SET status = 'rejected', updated_at = ? WHERE id = ?").run(iso, entry.id);
      upheld = true;
      disputerIds = (
        db.prepare("SELECT by_user_id FROM disputes WHERE entry_id = ? AND status = 'upheld'").all(entry.id) as {
          by_user_id: string;
        }[]
      ).map((row) => row.by_user_id);
    } else if (entry.status === 'ok') {
      db.prepare("UPDATE entries SET status = 'disputed', updated_at = ? WHERE id = ?").run(iso, entry.id);
    }
  });
  run();

  const updated = getEntryRow(db, entry.id) ?? entry;
  return {
    dispute: upheld ? { ...dispute, status: 'upheld' } : dispute,
    entry: updated,
    upheld,
    openCount,
    threshold,
    disputerIds,
  };
}
