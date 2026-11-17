/**
 * Expo push delivery (SPEC 2.4 step 4).
 *
 * The inbox is the source of truth: every unread notification row with
 * `pushed_at IS NULL AND push_error IS NULL`, at most `PUSH_MAX_AGE_MS` old, whose
 * user has a push token is a pending delivery. Rows written before the phone
 * registered that token are marked `before_token` by POST /me/push-token.
 * `flush()` is safe to call on a machine with no network — every failure is
 * recorded as `push_error` on the row instead of being thrown, so the scheduler
 * never dies and a row is never retried forever.
 *
 * A row is claimed (`pushed_at`) before Expo hears of it, and given back with
 * its `push_error` when the send fails. Marked after the send, a write that
 * failed (a full disk) left it pending, and every 30-second pass rang the same
 * laf on the friend's phone again, about 120 times in its hour. Now a disk that
 * takes no write sends nothing, and one that fails after the send loses at most
 * that row's error.
 */
import { Expo, type ExpoPushMessage, type ExpoPushTicket } from 'expo-server-sdk';
import type { Config } from '../config.js';
import { nowIso, type Database } from '../db/index.js';

export interface FlushResult {
  sent: number;
  failed: number;
}

export interface PushSender {
  /** `now` is the scheduler's clock: it decides which rows are too old to push. */
  flush(db: Database, now?: Date): Promise<FlushResult>;
}

/** How many pending notifications one flush picks up. */
const BATCH_LIMIT = 200;

/**
 * A row older than this is never pushed; it stays in the inbox. A laf ringing an
 * hour late helps nobody, and without a limit the queue had no end: rows of every
 * account without a token waited forever, so the first token registered after
 * Firebase was turned on pulled that account's whole history, 200 rows a pass,
 * ahead of everybody's fresh "KOYDUM MU?".
 */
export const PUSH_MAX_AGE_MS = 60 * 60_000;

interface PendingRow {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string;
  data: string;
  push_token: string;
}

const PENDING_SQL = `
SELECT n.id, n.user_id, n.type, n.title, n.body, n.data, u.push_token
  FROM notifications n
  JOIN users u ON u.id = n.user_id
 WHERE n.pushed_at IS NULL
   AND n.push_error IS NULL
   AND n.read_at IS NULL
   AND n.created_at >= ?
   AND u.push_token IS NOT NULL
   AND u.deleted_at IS NULL
 ORDER BY n.created_at ASC
 LIMIT ?
`;

function parseData(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createPushSender(config: Config): PushSender {
  const expo = new Expo(config.expoAccessToken ? { accessToken: config.expoAccessToken, useFcmV1: true } : { useFcmV1: true });

  return {
    async flush(db: Database, now: Date = new Date()): Promise<FlushResult> {
      const claim = db.prepare('UPDATE notifications SET pushed_at = ? WHERE id = ? AND pushed_at IS NULL');
      const markFailed = db.prepare('UPDATE notifications SET push_error = ? WHERE id = ?');
      // a claimed row that did not go: not pushed, so the inbox does not say it was
      const giveBack = db.prepare('UPDATE notifications SET pushed_at = NULL, push_error = ? WHERE id = ?');
      const failClaimed = (row: PendingRow, error: string): void => {
        try {
          giveBack.run(error, row.id);
        } catch {
          // it stays claimed: never sent again, only not marked as failed
        }
      };
      const clearToken = db.prepare('UPDATE users SET push_token = NULL, push_platform = NULL WHERE id = ?');
      const cutoff = nowIso(new Date(now.getTime() - PUSH_MAX_AGE_MS));

      let pending: PendingRow[];
      try {
        // Marked rather than only skipped, so the queue (indexed on pushed_at,
        // push_error) stays the last hour and never walks the history again.
        // A read row is only skipped: it expires here within the hour.
        db.prepare(
          "UPDATE notifications SET push_error = 'expired' WHERE pushed_at IS NULL AND push_error IS NULL AND created_at < ?",
        ).run(cutoff);
        pending = db.prepare(PENDING_SQL).all(cutoff, BATCH_LIMIT) as PendingRow[];
      } catch {
        return { sent: 0, failed: 0 };
      }
      if (pending.length === 0) return { sent: 0, failed: 0 };

      let sent = 0;
      let failed = 0;

      // Rows whose token is not an Expo token can never be delivered: fail them now.
      const deliverable: PendingRow[] = [];
      for (const row of pending) {
        if (Expo.isExpoPushToken(row.push_token)) deliverable.push(row);
        else {
          markFailed.run('invalid_token', row.id);
          failed += 1;
        }
      }
      if (deliverable.length === 0) return { sent, failed };

      const messages: ExpoPushMessage[] = deliverable.map((row) => ({
        to: row.push_token,
        title: row.title,
        body: row.body,
        sound: 'default',
        channelId: 'koydum',
        priority: 'high',
        data: { ...parseData(row.data), notificationId: row.id, type: row.type },
      }));

      // Keep messages and their rows aligned across chunk boundaries.
      let offset = 0;
      for (const chunk of expo.chunkPushNotifications(messages)) {
        const chunkRows = deliverable.slice(offset, offset + chunk.length);
        offset += chunk.length;

        // Claimed in one write before anything is sent. A disk that takes no
        // write ends the flush here: nothing goes out that could go out again.
        const at = new Date().toISOString();
        let claimed: boolean[];
        try {
          claimed = db.transaction(() => chunkRows.map((row) => claim.run(at, row.id).changes > 0))();
        } catch {
          return { sent, failed };
        }
        const rows = chunkRows.filter((_, i) => claimed[i]);
        const toSend = chunk.filter((_, i) => claimed[i]);
        if (rows.length === 0) continue;

        let tickets: ExpoPushTicket[];
        try {
          tickets = await expo.sendPushNotificationsAsync(toSend);
        } catch (err) {
          const message = err instanceof Error ? err.message.slice(0, 200) : 'push_failed';
          for (const row of rows) {
            failClaimed(row, message);
            failed += 1;
          }
          continue;
        }

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i]!;
          const ticket = tickets[i];
          if (!ticket) {
            failClaimed(row, 'no_ticket');
            failed += 1;
            continue;
          }
          if (ticket.status === 'ok') {
            sent += 1;
            continue;
          }
          failClaimed(row, (ticket.details?.error ?? ticket.message ?? 'push_error').slice(0, 200));
          failed += 1;
          if (ticket.details?.error === 'DeviceNotRegistered') {
            try {
              clearToken.run(row.user_id);
            } catch {
              // the next failed ticket for this phone tries again
            }
          }
        }
      }

      return { sent, failed };
    },
  };
}
