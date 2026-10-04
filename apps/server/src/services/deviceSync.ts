/**
 * Readings the phone takes on its own — steps today, screen time on Android —
 * arrive as a list of days (`POST /me/steps`, `POST /me/screen-time`) and the
 * server fans each day out into an entry for every open çelınc of the matching
 * type the user is playing. The app never has to know which çelınclar exist.
 *
 * The fan-out obeys exactly the same day rules as `POST /challenges/:id/entries`
 * (`dayWindowIssue`): a day outside the challenge window, in the future, or older
 * than the device backfill limit is skipped instead of banked — otherwise a phone
 * could pre-fill a whole 30-day race with the daily maximum on day one. The window
 * is read in the timezone pinned when the user joined that challenge. Past the
 * end (the phones' hour, a dispute's wait) only days that were over by `ends_at`
 * still move (`dayOverByEnd`): a later reading of a day the end cut in half would
 * add the steps walked after the whistle.
 *
 * On a higher-is-better metric (steps) a device reading only ever raises a
 * day's entry; on lower-is-better (screen time) it overwrites whatever is there,
 * typed values included — the phone is the honest one. A typed value may never
 * replace a device reading there (`device_locked` in `validateAndUpsertEntry`).
 *
 * A typed day friends threw out (`rejected` after an upheld itiraz) is not a
 * day off for good: the phone's own reading takes its place, whatever its
 * size, and counts again — right when the itiraz is upheld if the phone
 * already reported that day (`restoreFromPhone`), else at its next sync. Only
 * a typed one comes back — a device row that was thrown out stays out, or a
 * sync would undo the itiraz on it. The upheld itirazlar stay on the row as
 * history, and their owners may file one again on the phone's number
 * (`recordDispute`); from then on only the phone writes that day
 * (`day_rejected` in `validateAndUpsertEntry`).
 *
 * While friends dispute a typed number the phone leaves that row alone: the
 * itiraz is about the number typed, and a reading written over it would turn
 * it into a "phone" row, which an upheld itiraz throws out for good.
 */
import { challengeTypesForDevice, type DeviceMetric, type EntrySource } from '@koydum/shared';
import { newId, nowIso, type ChallengeRow, type Database, type EntryRow, type UserRow } from '../db/index.js';
import { getUserRow } from './challengeViews.js';
import { challengeWindow, dayOverByEnd, participantTimezone, typeForChallenge } from './challenges.js';
import { dayWindowIssue, forgetDismissedDisputes, isDeviceSource } from './entries.js';

/** A challenge plus the timezone this user's days in it are measured in. */
type DeviceChallengeRow = ChallengeRow & { participant_timezone: string | null };

export interface DeviceDay {
  dayKey: string;
  value: number;
  source: EntrySource;
}

/**
 * Open challenges (`active` or `pending`, SPEC 2.2) of the catalog types this
 * reading feeds, that the user has accepted. A pending challenge that has not
 * started yet simply has no day in range yet, so the day rules keep it out.
 */
export function deviceChallengesFor(db: Database, userId: string, metric: DeviceMetric): DeviceChallengeRow[] {
  const typeKeys = challengeTypesForDevice(metric).map((type) => type.key);
  if (typeKeys.length === 0) return [];
  const marks = typeKeys.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT c.*, p.timezone AS participant_timezone FROM challenges c
         JOIN challenge_participants p ON p.challenge_id = c.id AND p.user_id = ? AND p.status = 'accepted'
        WHERE c.type_key IN (${marks})
          AND c.status IN ('active', 'pending')`,
    )
    .all(userId, ...typeKeys) as DeviceChallengeRow[];
}

/**
 * Mirrors the given days into every matching challenge as an upserted entry
 * (only `onlyChallengeId` when given). Returns how many entries were touched.
 * Runs inside the caller's transaction when there is one; otherwise each
 * statement is its own.
 */
export function fanOutDeviceDays(
  db: Database,
  user: UserRow,
  metric: DeviceMetric,
  days: readonly DeviceDay[],
  now: Date,
  onlyChallengeId?: string,
): number {
  const at = nowIso(now);
  const challenges = deviceChallengesFor(db, user.id, metric).filter(
    (challenge) => onlyChallengeId === undefined || challenge.id === onlyChallengeId,
  );
  if (challenges.length === 0 || days.length === 0) return 0;

  const rules = challenges.map((challenge) => {
    const tz = participantTimezone({ timezone: challenge.participant_timezone }, user);
    const type = typeForChallenge(challenge);
    return { challenge, tz, window: challengeWindow(challenge, tz), type };
  });

  const findEntry = db.prepare(
    'SELECT id, value, source, status FROM entries WHERE challenge_id = ? AND user_id = ? AND day_key = ?',
  );
  const updateEntry = db.prepare('UPDATE entries SET value = ?, source = ?, updated_at = ? WHERE id = ?');
  // the photo backed the typed number and the answer clock ran for it: neither
  // belongs to the phone's reading
  const restoreEntry = db.prepare(
    "UPDATE entries SET value = ?, source = ?, status = 'ok', proof_url = NULL, answer_by = NULL, updated_at = ? WHERE id = ?",
  );
  const insertEntry = db.prepare(
    `INSERT INTO entries (id, challenge_id, user_id, day_key, value, source, note, proof_url, status,
                          client_time, session_id, late, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'ok', ?, NULL, 0, ?, ?)`,
  );

  let updated = 0;
  for (const day of days) {
    for (const { challenge, tz, window, type } of rules) {
      if (dayWindowIssue(window, type.metricType, tz, day.dayKey, now, day.source) !== null) continue;
      if (now.getTime() >= Date.parse(challenge.ends_at) && !dayOverByEnd(challenge, tz, day.dayKey)) continue;
      const value = Math.min(day.value, type.maxPerDay);
      const existing = findEntry.get(challenge.id, user.id, day.dayKey) as
        | { id: string; value: number; source: string; status: string }
        | undefined;
      if (existing && existing.status === 'rejected') {
        // The typed number was the lie, not the day. A rejected device row
        // stays rejected, and a 0 says nothing a rejected row does not.
        if (isDeviceSource(existing.source)) continue;
        if (type.direction === 'higher' && value <= 0) continue;
        restoreEntry.run(value, day.source, at, existing.id);
        // a new value reopens the door for itirazlar taken back or answered
        // on the old one; the upheld ones are what friends won, they stay
        forgetDismissedDisputes(db, existing.id);
      } else if (existing) {
        // a typed number friends are disputing is the itiraz's to settle (see above)
        if (existing.status === 'disputed' && !isDeviceSource(existing.source)) continue;
        // A day's steps only ever grow. A LOWER reading for a day that already
        // has a value is a partial source, never a correction: a typed
        // declaration the foreground counter has not caught up with, a phone
        // that was reinstalled and started recording this afternoon, a second
        // phone. So on a higher-is-better metric the device can raise a day but
        // never lower it. (Friends can still dispute a fantasy number.)
        // Lower-is-better readings (screen time) always win: the phone is the
        // honest one there.
        const keepExisting = type.direction === 'higher' && Number(existing.value) >= value;
        if (!keepExisting) updateEntry.run(value, day.source, at, existing.id);
      } else {
        insertEntry.run(newId(), challenge.id, user.id, day.dayKey, value, day.source, at, at, at);
      }
      updated += 1;
    }
  }
  return updated;
}

/**
 * The phone's reading for a typed day friends just threw out (`resolveDisputes`),
 * from what it already reported (`steps_daily`, `screen_time_daily`). Without
 * it the day waits for the next sync, and an itiraz upheld past the end would
 * never get one: the same pass finishes the çelınc, and the fan-out stops at
 * `finished`. Same rules as a sync (`fanOutDeviceDays`). True when it counts again.
 */
export function restoreFromPhone(db: Database, challenge: ChallengeRow, entry: EntryRow, now: Date): boolean {
  const metric = typeForChallenge(challenge).deviceMetric;
  if (!metric || isDeviceSource(entry.source)) return false;
  const owner = getUserRow(db, entry.user_id);
  if (!owner || owner.deleted_at !== null) return false;
  const reading =
    metric === 'steps'
      ? (db.prepare('SELECT steps AS value, source FROM steps_daily WHERE user_id = ? AND day_key = ?').get(owner.id, entry.day_key) as
          | { value: number; source: EntrySource }
          | undefined)
      : (db
          .prepare("SELECT minutes AS value, 'usage_stats' AS source FROM screen_time_daily WHERE user_id = ? AND day_key = ?")
          .get(owner.id, entry.day_key) as { value: number; source: EntrySource } | undefined);
  if (!reading) return false;
  fanOutDeviceDays(db, owner, metric, [{ dayKey: entry.day_key, value: Number(reading.value), source: reading.source }], now, challenge.id);
  const after = db.prepare('SELECT status FROM entries WHERE id = ?').get(entry.id) as { status: string } | undefined;
  return after?.status === 'ok';
}
