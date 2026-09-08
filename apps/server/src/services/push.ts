/**
 * Expo push delivery (SPEC 2.4 step 4).
 *
 * The inbox is the source of truth: every notification row with
 * `pushed_at IS NULL AND push_error IS NULL` whose user has a push token is a
 * pending delivery. `flush()` is safe to call on a machine with no network — every
 * failure is recorded as `push_error` on the row instead of being thrown, so the
 * scheduler never dies and a row is never retried forever.
 */
import { Expo, type ExpoPushMessage, type ExpoPushTicket } from 'expo-server-sdk';
import type { Config } from '../config.js';
import type { Database } from '../db/index.js';

export interface FlushResult {
  sent: number;
  failed: number;
}

export interface PushSender {
  flush(db: Database): Promise<FlushResult>;
}

/** How many pending notifications one flush picks up. */
const BATCH_LIMIT = 200;

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
    async flush(db: Database): Promise<FlushResult> {
      const markSent = db.prepare('UPDATE notifications SET pushed_at = ? WHERE id = ?');
      const markFailed = db.prepare('UPDATE notifications SET push_error = ? WHERE id = ?');
      const clearToken = db.prepare('UPDATE users SET push_token = NULL, push_platform = NULL WHERE id = ?');

      let pending: PendingRow[];
      try {
        pending = db.prepare(PENDING_SQL).all(BATCH_LIMIT) as PendingRow[];
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
        const rows = deliverable.slice(offset, offset + chunk.length);
        offset += chunk.length;

        let tickets: ExpoPushTicket[];
        try {
          tickets = await expo.sendPushNotificationsAsync(chunk);
        } catch (err) {
          const message = err instanceof Error ? err.message.slice(0, 200) : 'push_failed';
          for (const row of rows) {
            markFailed.run(message, row.id);
            failed += 1;
          }
          continue;
        }

        const at = new Date().toISOString();
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i]!;
          const ticket = tickets[i];
          if (!ticket) {
            markFailed.run('no_ticket', row.id);
            failed += 1;
            continue;
          }
          if (ticket.status === 'ok') {
            markSent.run(at, row.id);
            sent += 1;
            continue;
          }
          markFailed.run((ticket.details?.error ?? ticket.message ?? 'push_error').slice(0, 200), row.id);
          failed += 1;
          if (ticket.details?.error === 'DeviceNotRegistered') clearToken.run(row.user_id);
        }
      }

      return { sent, failed };
    },
  };
}
