/**
 * Inbox notifications.
 *
 * Every user-visible event writes a row here; the push sender (services/push.ts)
 * later picks up the rows that have not been delivered yet. Titles and bodies are
 * Turkish and already rendered at the RECIPIENT's vulgarity level by the caller.
 */
import { LIMITS, type NotificationType, type UnreadCount } from '@koydum/shared';
import { newId, nowIso, type Database, type NotificationRow } from '../db/index.js';

export interface NotifyInput {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /** Defaults to now — injectable so scheduler runs are deterministic in tests. */
  createdAt?: string;
}

export interface InboxQueryOptions {
  /** ISO instant: return notifications strictly older than this (cursor). */
  before?: string;
  limit?: number;
}

const INSERT_SQL = `
INSERT INTO notifications (id, user_id, type, title, body, data, read_at, created_at, pushed_at, push_error)
VALUES (@id, @user_id, @type, @title, @body, @data, NULL, @created_at, NULL, NULL)
`;

function toRow(input: NotifyInput): NotificationRow {
  return {
    id: newId(),
    user_id: input.userId,
    type: input.type,
    title: input.title,
    body: input.body,
    data: JSON.stringify(input.data ?? {}),
    read_at: null,
    created_at: input.createdAt ?? nowIso(),
    pushed_at: null,
    push_error: null,
  };
}

/** Inserts one notification and returns the stored row. */
export function notify(db: Database, input: NotifyInput): NotificationRow {
  const row = toRow(input);
  db.prepare(INSERT_SQL).run(row);
  return row;
}

/** Inserts many notifications in a single transaction. */
export function notifyMany(db: Database, inputs: NotifyInput[]): NotificationRow[] {
  if (inputs.length === 0) return [];
  const rows = inputs.map(toRow);
  const insert = db.prepare(INSERT_SQL);
  const run = db.transaction((list: NotificationRow[]) => {
    for (const row of list) insert.run(row);
  });
  run(rows);
  return rows;
}

/**
 * Marks notifications read. `target` is either the ids to mark or `{ all: true }`
 * (the `InboxReadBody` shape). Returns how many rows changed.
 */
export function markRead(db: Database, userId: string, target: string[] | { ids?: string[]; all?: boolean }): number {
  const ids = Array.isArray(target) ? target : (target.ids ?? []);
  const all = Array.isArray(target) ? false : target.all === true;
  const readAt = nowIso();

  if (all) {
    const info = db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(readAt, userId);
    return info.changes;
  }
  if (ids.length === 0) return 0;

  const update = db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id = ?');
  const run = db.transaction((list: string[]) => {
    let changed = 0;
    for (const id of list) changed += update.run(readAt, userId, id).changes;
    return changed;
  });
  return run(ids);
}

/** `{ count, latestId }` for the tab badge (SPEC: GET /me/inbox/unread). */
export function unreadCount(db: Database, userId: string): UnreadCount {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n,
              (SELECT id FROM notifications WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1) AS latest_id
         FROM notifications WHERE user_id = ? AND read_at IS NULL`,
    )
    .get(userId, userId) as { n: number | null; latest_id: string | null } | undefined;
  return { count: Number(row?.n ?? 0), latestId: row?.latest_id ?? null };
}

/**
 * Newest first, optionally paging backwards from `before`.
 *
 * Rows written in the same millisecond (one scheduler pass can finish a challenge,
 * hand out a badge and land a taunt at the same `created_at`) fall back to `rowid`,
 * i.e. the order they actually happened — `id` is a random UUID and would shuffle
 * the top of the inbox on every read.
 */
export function listInbox(db: Database, userId: string, options: InboxQueryOptions = {}): NotificationRow[] {
  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? LIMITS.INBOX_PAGE_DEFAULT)), LIMITS.INBOX_PAGE_MAX);
  if (options.before) {
    return db
      .prepare(
        'SELECT * FROM notifications WHERE user_id = ? AND created_at < ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
      )
      .all(userId, options.before, limit) as NotificationRow[];
  }
  return db
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(userId, limit) as NotificationRow[];
}

/** All notifications of one type for a user (used by tests and the results route). */
export function listByType(db: Database, userId: string, type: NotificationType): NotificationRow[] {
  return db
    .prepare('SELECT * FROM notifications WHERE user_id = ? AND type = ? ORDER BY created_at DESC, rowid DESC')
    .all(userId, type) as NotificationRow[];
}
