/**
 * Readings the phone takes on its own — steps today, screen time on Android —
 * arrive as a list of days (`POST /me/steps`, `POST /me/screen-time`) and the
 * server fans each day out into an entry for every open çelınc of the matching
 * type the user is playing. The app never has to know which çelınclar exist.
 *
 * The fan-out obeys exactly the same day rules as `POST /challenges/:id/entries`
 * (`dayWindowIssue`): a day outside the challenge window, in the future, or older
 * than the device backfill limit is skipped instead of banked — otherwise a phone
 * could pre-fill a whole 30-day race with the daily maximum on day one. The one
 * exception is the age limit for a reading the server already holds, put back on
 * a typed day friends threw out (`restoreFromPhone`): an itiraz may be upheld on
 * any day of the race, and day one's phone number must not become a 0 because it
 * was upheld on day ten. The window is read in the timezone pinned when the user
 * joined that challenge, and on screen time it is the days the player is scored
 * on (`scoringWindow`): a sliver of a day another zone's end cut short is not
 * written when it would be one day more than the creator's. Past the end (the
 * phones' hour, a dispute's wait) only days that were over by `ends_at` still
 * move (`dayOverByEnd`): a later reading of a day the end cut in half would add
 * the steps walked after the whistle.
 *
 * On a higher-is-better metric (steps) a device reading only ever raises a
 * day's entry; on lower-is-better (screen time) it replaces a typed value
 * whatever its size — the phone is the honest one — but never lowers what a
 * phone already read: one phone's count of a day only grows, so a lower one is a
 * second phone or a purged usage history. A typed value may never replace a
 * device reading there (`device_locked` in `validateAndUpsertEntry`).
 *
 * A typed day friends threw out (`rejected` after an upheld itiraz) is not a
 * day off for good: the phone's own reading takes its place, whatever its
 * size, and counts again — right when the itiraz is upheld if the phone
 * already reported that day (`restoreFromPhone`), else at its next sync, as
 * long as the day is inside the device backfill limit a sync sends (an older
 * day the phone never reported stays out). Only a typed one comes back — a
 * device row that was thrown out stays out, or a sync would undo the itiraz
 * on it. The upheld itirazlar stay on the row as
 * history, and their owners may file one again on the phone's number
 * (`recordDispute`); from then on only the phone writes that day
 * (`day_rejected` in `validateAndUpsertEntry`).
 *
 * While friends dispute a typed number the phone leaves that row alone: the
 * itiraz is about the number typed, and a reading written over it would turn
 * it into a "phone" row, which an upheld itiraz throws out for good.
 *
 * A friend who accepts a running çelınc gets the days their phone already
 * reported right away (`backfillFromPhone`), through this same fan-out:
 * `steps_daily` and `screen_time_daily` hold every sync, çelınc or not, and
 * without it they sat at 0 and typed from memory what the server already had.
 */
import { challengeTypesForDevice, type DeviceMetric, type EntrySource } from '@koydum/shared';
import { newId, nowIso, type ChallengeRow, type Database, type EntryRow, type UserRow } from '../db/index.js';
import { getParticipant, getUserRow } from './challengeViews.js';
import { dayOverByEnd, participantTimezone, scoringWindow, typeForChallenge } from './challenges.js';
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
 * statement is its own. `storedReading`: the days come from what the server
 * already holds for a day friends threw out (`restoreFromPhone`), so their age
 * is no reason to skip them.
 */
export function fanOutDeviceDays(
  db: Database,
  user: UserRow,
  metric: DeviceMetric,
  days: readonly DeviceDay[],
  now: Date,
  onlyChallengeId?: string,
  options: { storedReading?: boolean } = {},
): number {
  const at = nowIso(now);
  const challenges = deviceChallengesFor(db, user.id, metric).filter(
    (challenge) => onlyChallengeId === undefined || challenge.id === onlyChallengeId,
  );
  if (challenges.length === 0 || days.length === 0) return 0;

  const rules = challenges.map((challenge) => {
    const tz = participantTimezone({ timezone: challenge.participant_timezone }, user);
    const type = typeForChallenge(challenge);
    return { challenge, tz, window: scoringWindow(db, challenge, tz), type };
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
      const issue = dayWindowIssue(window, type.metricType, tz, day.dayKey, now, day.source);
      // the backfill limit is for what a phone sends; a stored reading is already here
      if (issue !== null && !(options.storedReading && issue === 'day_too_old')) continue;
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
        // On lower-is-better (screen time) the phone beats a typed number either
        // way, but a phone's own reading only grows too: 5 after 300 is a second
        // phone or a purged history, and would hand the day to the wrong player.
        const keepExisting =
          type.direction === 'higher'
            ? Number(existing.value) >= value
            : isDeviceSource(existing.source) && Number(existing.value) >= value;
        if (!keepExisting) {
          updateEntry.run(value, day.source, at, existing.id);
          // a photo that answered an itiraz backed the old number; in a 1v1 the
          // rival is the only one who could ever challenge the new one
          if (Number(existing.value) !== value) forgetDismissedDisputes(db, existing.id);
        }
      } else {
        insertEntry.run(newId(), challenge.id, user.id, day.dayKey, value, day.source, at, at, at);
      }
      updated += 1;
    }
  }
  return updated;
}

/**
 * What the phone already reported between two day keys (both included), the
 * way a sync hands it to the fan-out: a step day keeps the source it came
 * from, a screen-time day is always the phone's own reading.
 */
export function phoneDays(db: Database, userId: string, metric: DeviceMetric, fromDay: string, toDay: string): DeviceDay[] {
  const rows = (
    metric === 'steps'
      ? db
          .prepare(
            `SELECT day_key AS dayKey, steps AS value, source FROM steps_daily
              WHERE user_id = ? AND day_key BETWEEN ? AND ? ORDER BY day_key ASC`,
          )
          .all(userId, fromDay, toDay)
      : db
          .prepare(
            `SELECT day_key AS dayKey, minutes AS value, 'usage_stats' AS source FROM screen_time_daily
              WHERE user_id = ? AND day_key BETWEEN ? AND ? ORDER BY day_key ASC`,
          )
          .all(userId, fromDay, toDay)
  ) as DeviceDay[];
  return rows.map((row) => ({ dayKey: row.dayKey, value: Number(row.value), source: row.source }));
}

/**
 * The phone's reading for a typed day friends just threw out (`upholdDisputes`),
 * from what it already reported (`steps_daily`, `screen_time_daily`). Without
 * it the day waits for the next sync, and an itiraz upheld past the end would
 * never get one: the same pass finishes the çelınc, and the fan-out stops at
 * `finished`. Same rules as a sync (`fanOutDeviceDays`) but the device backfill
 * limit: an itiraz upheld more than a week after its day (a 14-day race, a PC
 * asleep from Sunday night to Tuesday) still gets the phone's number, and no
 * later sync could bring it back, the day being too old for one as well. The
 * window and the end still apply. True when it counts again.
 */
export function restoreFromPhone(db: Database, challenge: ChallengeRow, entry: EntryRow, now: Date): boolean {
  const metric = typeForChallenge(challenge).deviceMetric;
  if (!metric || isDeviceSource(entry.source)) return false;
  const owner = getUserRow(db, entry.user_id);
  if (!owner || owner.deleted_at !== null) return false;
  const reading = phoneDays(db, owner.id, metric, entry.day_key, entry.day_key);
  if (reading.length === 0) return false;
  fanOutDeviceDays(db, owner, metric, reading, now, challenge.id, { storedReading: true });
  const after = db.prepare('SELECT status FROM entries WHERE id = ?').get(entry.id) as { status: string } | undefined;
  return after?.status === 'ok';
}

/**
 * The days `user`'s phone already reported, written into a çelınc they just
 * accepted. A friend added on day three (`/invite`), or one taking a "Reddet"
 * back, otherwise sat at 0 until the next sync, and the app offered "Eksik
 * günü yaz" for days whose real reading was already here: typed from memory,
 * they became disputable beyan rows. Same rules as a sync (`fanOutDeviceDays`):
 * the day window in the zone pinned at the accept, the device backfill limit,
 * no future day, steps only ever raised, a rejected device row left alone.
 * Runs inside the accept's transaction. Returns how many entries were touched.
 */
export function backfillFromPhone(db: Database, user: UserRow, challenge: ChallengeRow, now: Date): number {
  const metric = typeForChallenge(challenge).deviceMetric;
  if (!metric) return 0;
  const window = scoringWindow(db, challenge, participantTimezone(getParticipant(db, challenge.id, user.id), user));
  const first = window[0];
  const last = window.at(-1);
  if (first === undefined || last === undefined) return 0;
  return fanOutDeviceDays(db, user, metric, phoneDays(db, user.id, metric, first, last), now, challenge.id);
}
