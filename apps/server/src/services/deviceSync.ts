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
 * is read in the timezone pinned when the user joined that challenge.
 *
 * On a higher-is-better metric (steps) a device reading only ever raises a
 * day's entry; on lower-is-better (screen time) it overwrites whatever is there,
 * typed values included — the phone is the honest one. A typed value may never
 * replace a device reading there (`device_locked` in `validateAndUpsertEntry`).
 */
import { challengeTypesForDevice, type DeviceMetric, type EntrySource } from '@koydum/shared';
import { newId, nowIso, type ChallengeRow, type Database, type UserRow } from '../db/index.js';
import { challengeWindow, participantTimezone, typeForChallenge } from './challenges.js';
import { dayWindowIssue } from './entries.js';

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
 * Mirrors the given days into every matching challenge as an upserted entry.
 * Returns how many entries were touched. Runs inside the caller's transaction
 * when there is one; otherwise each statement is its own.
 */
export function fanOutDeviceDays(
  db: Database,
  user: UserRow,
  metric: DeviceMetric,
  days: readonly DeviceDay[],
  now: Date,
): number {
  const at = nowIso(now);
  const challenges = deviceChallengesFor(db, user.id, metric);
  if (challenges.length === 0 || days.length === 0) return 0;

  const rules = challenges.map((challenge) => {
    const tz = participantTimezone({ timezone: challenge.participant_timezone }, user);
    const type = typeForChallenge(challenge);
    return { challenge, tz, window: challengeWindow(challenge, tz), type };
  });

  const findEntry = db.prepare('SELECT id, value, source FROM entries WHERE challenge_id = ? AND user_id = ? AND day_key = ?');
  const updateEntry = db.prepare('UPDATE entries SET value = ?, source = ?, updated_at = ? WHERE id = ?');
  const insertEntry = db.prepare(
    `INSERT INTO entries (id, challenge_id, user_id, day_key, value, source, note, proof_url, status,
                          client_time, session_id, late, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'ok', ?, NULL, 0, ?, ?)`,
  );

  let updated = 0;
  for (const day of days) {
    for (const { challenge, tz, window, type } of rules) {
      if (dayWindowIssue(window, type.metricType, tz, day.dayKey, now, day.source) !== null) continue;
      const value = Math.min(day.value, type.maxPerDay);
      const existing = findEntry.get(challenge.id, user.id, day.dayKey) as
        | { id: string; value: number; source: string }
        | undefined;
      if (existing) {
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
