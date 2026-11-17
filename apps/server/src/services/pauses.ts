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

/**
 * Pauses the scheduler could not write down (a PC that woke on a full disk),
 * per database, until a later beat can (`writeHeldPauses`). They vouch for a
 * tap all the same: the phones send the night's "Geldim" the moment the tunnel
 * answers again, before anybody has freed any room, and that check-in was
 * judged at its arrival and refused as not today's.
 */
const held = new WeakMap<Database, { startedAt: Date; endedAt: Date }[]>();

/** Keeps a pause `recordPause` could not write, for the next beat to try again. */
export function holdPause(db: Database, startedAt: Date, endedAt: Date): void {
  const list = held.get(db) ?? [];
  list.push({ startedAt, endedAt });
  held.set(db, list);
}

/** Writes down the held pauses, oldest first; one that fails again stays held, with those after it. */
export function writeHeldPauses(db: Database): void {
  const list = held.get(db);
  while (list && list.length > 0) {
    const pause = list[0]!;
    recordPause(db, pause.startedAt, pause.endedAt);
    list.shift();
  }
}

/**
 * Where the first `span` ms after `from` that the server was up for all along
 * begins (epoch ms): `from` itself when no pause (written down or still held)
 * cuts into the span after it, else the end of the latest one that does, and
 * so on from there. A night's sleep over a çelınc's end puts the phones' hour
 * at the wake; a later sleep, after that hour ran with the PC on, moves
 * nothing, however often the PC sleeps afterwards.
 */
export function upSpanFrom(db: Database, from: number, span: number): number {
  const latest = db.prepare('SELECT MAX(ended_at) AS until FROM server_pauses WHERE started_at < ? AND ended_at > ?');
  let at = from;
  for (;;) {
    const row = latest.get(new Date(at + span).toISOString(), new Date(at).toISOString()) as { until: string | null };
    let next = row.until ? Date.parse(row.until) : Number.NaN;
    for (const pause of held.get(db) ?? []) {
      if (pause.startedAt.getTime() < at + span && pause.endedAt.getTime() > at) {
        next = Number.isNaN(next) ? pause.endedAt.getTime() : Math.max(next, pause.endedAt.getTime());
      }
    }
    if (!(next > at)) return at;
    at = next;
  }
}

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
 * `PAUSE_TRUST_MS` before `now` (written down, or still held), else null. Never earlier than the server went
 * away, never a moment it was up to hear the tap itself.
 */
export function tappedWhileDown(db: Database, clientTime: string, now: Date): Date | null {
  const tapped = Date.parse(clientTime);
  if (!Number.isFinite(tapped)) return null;
  // stored as toISOString(), so the strings compare as the instants do; the
  // phone's own string may carry an offset and is normalised first
  const at = new Date(tapped).toISOString();
  const trustFrom = now.getTime() - PAUSE_TRUST_MS;
  const hit = db
    .prepare('SELECT 1 AS hit FROM server_pauses WHERE ended_at >= ? AND started_at <= ? AND ended_at >= ? LIMIT 1')
    .get(new Date(trustFrom).toISOString(), at, at);
  if (hit) return new Date(tapped);
  const inHeld = (held.get(db) ?? []).some(
    (pause) =>
      pause.endedAt.getTime() >= trustFrom && pause.startedAt.getTime() <= tapped && pause.endedAt.getTime() >= tapped,
  );
  return inHeld ? new Date(tapped) : null;
}
