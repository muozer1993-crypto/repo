/**
 * Friendship graph helpers (social group).
 *
 * One row in `friendships` describes the relationship between an ORDERED pair
 * (`requester_id`, `addressee_id`) and there is at most one row per unordered pair —
 * the routes below never create a second, mirrored row:
 *
 *   pending  — `requester_id` asked, `addressee_id` has to answer
 *   accepted — direction no longer matters, both are friends
 *   blocked  — `requester_id` is the BLOCKER, `addressee_id` the blocked one
 *
 * A declined request is deleted rather than kept, so asking again is possible.
 * Everything here is a pure read except `upsertBlock`, which is the one place a
 * relationship is forcibly replaced.
 */
import { newId, nowIso, type Database, type FriendshipRow, type UserRow } from '../db/index.js';

/** The single row describing `a`↔`b`, whichever direction it was created in. */
export function friendshipBetween(db: Database, a: string, b: string): FriendshipRow | undefined {
  return db
    .prepare(
      `SELECT * FROM friendships
        WHERE (requester_id = ? AND addressee_id = ?)
           OR (requester_id = ? AND addressee_id = ?)
        LIMIT 1`,
    )
    .get(a, b, b, a) as FriendshipRow | undefined;
}

/** True when either side has blocked the other. */
export function isBlockedBetween(db: Database, a: string, b: string): boolean {
  return friendshipBetween(db, a, b)?.status === 'blocked';
}

/** True when the pair is an accepted friendship. */
export function areFriends(db: Database, a: string, b: string): boolean {
  return friendshipBetween(db, a, b)?.status === 'accepted';
}

/** Ids of everyone `userId` has blocked or been blocked by (both directions). */
export function blockedUserIds(db: Database, userId: string): string[] {
  const rows = db
    .prepare(
      `SELECT requester_id, addressee_id FROM friendships
        WHERE status = 'blocked' AND (requester_id = ? OR addressee_id = ?)`,
    )
    .all(userId, userId) as { requester_id: string; addressee_id: string }[];
  return rows.map((row) => (row.requester_id === userId ? row.addressee_id : row.requester_id));
}

/** Accepted friends of `userId`, newest friendship first. Soft-deleted users are hidden. */
export function friendRows(db: Database, userId: string): UserRow[] {
  return db
    .prepare(
      `SELECT u.* FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
        WHERE f.status = 'accepted' AND (f.requester_id = ? OR f.addressee_id = ?)
          AND u.deleted_at IS NULL
        ORDER BY f.updated_at DESC, u.display_name ASC`,
    )
    .all(userId, userId, userId) as UserRow[];
}

/** Ids of the accepted friends of `userId` (the invite whitelist for challenges). */
export function friendIds(db: Database, userId: string): string[] {
  return friendRows(db, userId).map((row) => row.id);
}

export interface PendingRequest {
  friendship: FriendshipRow;
  user: UserRow;
}

/** Pending requests waiting for `userId` to answer (they asked). */
export function incomingRequests(db: Database, userId: string): PendingRequest[] {
  return joinRequests(
    db,
    `SELECT f.*, u.id AS u_id FROM friendships f
       JOIN users u ON u.id = f.requester_id
      WHERE f.status = 'pending' AND f.addressee_id = ? AND u.deleted_at IS NULL
      ORDER BY f.created_at DESC`,
    userId,
  );
}

/** Pending requests `userId` sent and nobody answered yet. */
export function outgoingRequests(db: Database, userId: string): PendingRequest[] {
  return joinRequests(
    db,
    `SELECT f.*, u.id AS u_id FROM friendships f
       JOIN users u ON u.id = f.addressee_id
      WHERE f.status = 'pending' AND f.requester_id = ? AND u.deleted_at IS NULL
      ORDER BY f.created_at DESC`,
    userId,
  );
}

/** Shared body of the two queries above: re-reads the joined user by its id. */
function joinRequests(db: Database, sql: string, userId: string): PendingRequest[] {
  const rows = db.prepare(sql).all(userId) as (FriendshipRow & { u_id: string })[];
  const selectUser = db.prepare('SELECT * FROM users WHERE id = ?');
  const out: PendingRequest[] = [];
  for (const row of rows) {
    const user = selectUser.get(row.u_id) as UserRow | undefined;
    if (user) out.push({ friendship: row, user });
  }
  return out;
}

/**
 * Creates (or replaces) the blocked relationship with `blockerId` as the requester.
 *
 * Any previous relationship between the two — pending request, accepted friendship,
 * or a block in the other direction — is removed first, so a block always wins and
 * the unordered pair keeps exactly one row.
 */
export function upsertBlock(db: Database, blockerId: string, blockedId: string, now: Date = new Date()): FriendshipRow {
  const at = nowIso(now);
  const existing = friendshipBetween(db, blockerId, blockedId);

  if (existing && existing.requester_id === blockerId) {
    db.prepare("UPDATE friendships SET status = 'blocked', updated_at = ? WHERE id = ?").run(at, existing.id);
    return { ...existing, status: 'blocked', updated_at: at };
  }

  const run = db.transaction(() => {
    if (existing) db.prepare('DELETE FROM friendships WHERE id = ?').run(existing.id);
    const row: FriendshipRow = {
      id: newId(),
      requester_id: blockerId,
      addressee_id: blockedId,
      status: 'blocked',
      created_at: existing?.created_at ?? at,
      updated_at: at,
    };
    db.prepare(
      `INSERT INTO friendships (id, requester_id, addressee_id, status, created_at, updated_at)
       VALUES (@id, @requester_id, @addressee_id, @status, @created_at, @updated_at)`,
    ).run(row);
    return row;
  });
  return run();
}

/** Removes the block `blockerId` → `blockedId`. Returns false when there was none. */
export function removeBlock(db: Database, blockerId: string, blockedId: string): boolean {
  const info = db
    .prepare("DELETE FROM friendships WHERE requester_id = ? AND addressee_id = ? AND status = 'blocked'")
    .run(blockerId, blockedId);
  return info.changes > 0;
}
