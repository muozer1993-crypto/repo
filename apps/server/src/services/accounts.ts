import type { VulgarityLevel } from '@koydum/shared';
/**
 * Account lifecycle (social group): creation, invite codes and soft deletion.
 *
 * Kept out of the route modules because registration and `DELETE /me` both need
 * the same invariants — a unique invite code, a lowercase unique username, and a
 * deletion that anonymises instead of dropping rows (finished challenges, taunts
 * and standings must survive so nobody's history rots when a friend leaves).
 */
import { newId, newInviteCode, nowIso, type Database, type UserRow } from '../db/index.js';

/** How many times we retry a random invite code before giving up (collision odds are ~0). */
const INVITE_CODE_ATTEMPTS = 20;

/** A code that is not in use yet. Throws only if the RNG collides 20 times in a row. */
export function uniqueInviteCode(db: Database): string {
  const exists = db.prepare('SELECT 1 FROM users WHERE invite_code = ?');
  for (let attempt = 0; attempt < INVITE_CODE_ATTEMPTS; attempt++) {
    const code = newInviteCode();
    if (!exists.get(code)) return code;
  }
  throw new Error('Could not generate a unique invite code');
}

/** True when the username is already taken (soft-deleted users release theirs). */
export function usernameTaken(db: Database, username: string): boolean {
  return db.prepare('SELECT 1 FROM users WHERE username = ?').get(username) !== undefined;
}

export interface CreateUserInput {
  username: string;
  displayName: string;
  passwordHash: string;
  timezone: string;
  /** Chosen on the sign-up screen; defaults to 2 ("delikanlı"). */
  vulgarityMax?: VulgarityLevel;
}

/** Inserts a fresh user with a unique invite code and returns the stored row. */
export function createUser(db: Database, input: CreateUserInput, now: Date = new Date()): UserRow {
  const id = newId();
  const createdAt = nowIso(now);
  const row: UserRow = {
    id,
    username: input.username,
    display_name: input.displayName,
    password_hash: input.passwordHash,
    avatar_emoji: '🍆',
    vulgarity_max: input.vulgarityMax ?? 2,
    timezone: input.timezone,
    invite_code: uniqueInviteCode(db),
    push_token: null,
    push_platform: null,
    reminder_hour: 20,
    created_at: createdAt,
    last_seen_at: createdAt,
    deleted_at: null,
  };

  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, avatar_emoji, vulgarity_max, timezone,
                        invite_code, push_token, push_platform, reminder_hour, created_at, last_seen_at, deleted_at)
     VALUES (@id, @username, @display_name, @password_hash, @avatar_emoji, @vulgarity_max, @timezone,
             @invite_code, @push_token, @push_platform, @reminder_hour, @created_at, @last_seen_at, @deleted_at)`,
  ).run(row);

  return row;
}

/** `deleted_<first 8 hex chars of the id>` — the SPEC's anonymised username. */
export function anonymizedUsername(userId: string): string {
  return `deleted_${userId.replace(/-/g, '').slice(0, 8)}`;
}

/**
 * Soft deletes an account (SPEC 2.2 `DELETE /me`):
 *
 * - username → `deleted_<id8>` (freeing the old one) and display name → "Silinen kanka";
 * - credentials, push token and reminder cleared, so nothing can be pushed or logged in;
 * - every participation in a challenge that has NOT finished becomes `left`, which drops
 *   the user out of standings and stops the scheduler from waiting for them;
 * - finished/cancelled challenges, their entries, taunts and badges are untouched.
 *
 * Returns the anonymised row.
 */
export function softDeleteUser(db: Database, user: UserRow, now: Date = new Date()): UserRow {
  const at = nowIso(now);
  let username = anonymizedUsername(user.id);
  // Defensive: a re-used prefix would violate the UNIQUE index and kill the request.
  if (db.prepare('SELECT 1 FROM users WHERE username = ? AND id <> ?').get(username, user.id)) {
    username = `${username}_${user.id.replace(/-/g, '').slice(8, 12)}`;
  }

  const run = db.transaction(() => {
    db.prepare(
      `UPDATE users
          SET username = ?, display_name = 'Silinen kanka', password_hash = '',
              push_token = NULL, push_platform = NULL, reminder_hour = NULL, deleted_at = ?
        WHERE id = ?`,
    ).run(username, at, user.id);

    db.prepare(
      `UPDATE challenge_participants
          SET status = 'left'
        WHERE user_id = ?
          AND status IN ('invited', 'accepted')
          AND challenge_id IN (SELECT id FROM challenges WHERE status IN ('pending', 'active'))`,
    ).run(user.id);

    // Pending friend requests in either direction are meaningless now.
    db.prepare("DELETE FROM friendships WHERE status = 'pending' AND (requester_id = ? OR addressee_id = ?)").run(
      user.id,
      user.id,
    );
  });
  run();

  return db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as UserRow;
}
