/**
 * When this server was not running, and the one thing that record vouches for:
 * a check-in a phone parked meanwhile (SPEC 2.3, 2.4).
 *
 * The owner's PC sleeps, is switched off, has its window closed. The friends'
 * phones park what they enter (the tunnel answers 530) and send it once the
 * server is back. Most entries do not care when they arrive; a check-in is
 * judged by the clock, and the server can only read its own. "Geldim" at 23:10
 * for a 23:30 deadline, parked while the PC slept and sent at 08:30, was
 * refused as not today's. The phone's `clientTime` says when it was tapped, and
 * it is believed only inside a pause the server itself wrote down: there,
 * nobody could have heard the tap; anywhere else the server was up and its own
 * clock decides.
 */
import type { Database } from '../db/index.js';

/**
 * How long after the server came back a pause still vouches for a tap inside
 * it: long enough for the night's check-in to be sent when the phone wakes,
 * short of a phone that turns up days later with a time nobody can check.
 */
export const PAUSE_TRUST_MS = 12 * 60 * 60_000;

/** Older pauses are deleted when a new one is written; the trust above never reaches back that far. */
const PAUSE_KEEP_MS = 7 * 24 * 60 * 60_000;

const LAST_BEAT = 'last_beat';

/** Writes down that the server was not running from `startedAt` to `endedAt`. */
export function recordPause(db: Database, startedAt: Date, endedAt: Date): void {
  db.transaction(() => {
    db.prepare('INSERT INTO server_pauses (started_at, ended_at) VALUES (?, ?)').run(
      startedAt.toISOString(),
      endedAt.toISOString(),
    );
    db.prepare('DELETE FROM server_pauses WHERE ended_at < ?').run(new Date(endedAt.getTime() - PAUSE_KEEP_MS).toISOString());
  })();
}

/** The scheduler's latest beat, kept so the next start knows how long it was off (`startScheduler`). */
export function writeLastBeat(db: Database, at: Date): void {
  db.prepare('INSERT INTO server_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    LAST_BEAT,
    at.toISOString(),
  );
}

export function readLastBeat(db: Database): Date | null {
  const row = db.prepare('SELECT value FROM server_state WHERE key = ?').get(LAST_BEAT) as { value: string } | undefined;
  const ms = row ? Date.parse(row.value) : Number.NaN;
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * `clientTime` as an instant when it falls inside a pause that ended at most
 * `PAUSE_TRUST_MS` before `now`, else null. Never earlier than the server went
 * away, never a moment it was up to hear the tap itself.
 */
export function tappedWhileDown(db: Database, clientTime: string, now: Date): Date | null {
  const tapped = Date.parse(clientTime);
  if (!Number.isFinite(tapped)) return null;
  // stored as toISOString(), so the strings compare as the instants do; the
  // phone's own string may carry an offset and is normalised first
  const at = new Date(tapped).toISOString();
  const hit = db
    .prepare('SELECT 1 AS hit FROM server_pauses WHERE ended_at >= ? AND started_at <= ? AND ended_at >= ? LIMIT 1')
    .get(new Date(now.getTime() - PAUSE_TRUST_MS).toISOString(), at, at);
  return hit ? new Date(tapped) : null;
}
