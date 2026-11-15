import type { VulgarityLevel } from '@koydum/shared';
/**
 * Account lifecycle (social group): creation, invite codes, password changes and
 * soft deletion.
 *
 * Kept out of the route modules because registration, `DELETE /me` and the owner's
 * CLI need the same invariants — a unique invite code, a lowercase unique username,
 * and a deletion that anonymises instead of dropping rows (finished challenges,
 * taunts and standings must survive so nobody's history rots when a friend leaves).
 */
import fs from 'node:fs';
import path from 'node:path';
import { newId, newInviteCode, nowIso, type Database, type EntryRow, type UserRow } from '../db/index.js';
import { cancelIfAbandoned, getChallengeRow, stillOpen } from './challenges.js';
import { announceDisputeClocks } from './entries.js';
import { seedFrom } from './taunts.js';

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

/**
 * The face a new account starts with, until its owner picks one on the profile.
 * 🍆 is the app's mascot, but it is also what every friend sees next to the
 * name: only somebody who chose "Ağır Abi" starts with it. Everybody else gets
 * one of the picker's tamer faces, chosen from the id so it never changes.
 */
const DEFAULT_AVATARS = ['😎', '🔥', '👑', '🐐', '🦅', '🚀', '🎯', '💪'] as const;

function defaultAvatar(id: string, level: VulgarityLevel): string {
  return level === 3 ? '🍆' : DEFAULT_AVATARS[seedFrom(id) % DEFAULT_AVATARS.length];
}

/** Inserts a fresh user with a unique invite code and returns the stored row. */
export function createUser(db: Database, input: CreateUserInput, now: Date = new Date()): UserRow {
  const id = newId();
  const createdAt = nowIso(now);
  const level = input.vulgarityMax ?? 2;
  const row: UserRow = {
    id,
    username: input.username,
    display_name: input.displayName,
    password_hash: input.passwordHash,
    avatar_emoji: defaultAvatar(id, level),
    vulgarity_max: level,
    timezone: input.timezone,
    invite_code: uniqueInviteCode(db),
    push_token: null,
    push_platform: null,
    reminder_hour: 20,
    created_at: createdAt,
    last_seen_at: createdAt,
    deleted_at: null,
    nudges_enabled: 1,
    recap_enabled: 1,
    token_version: 0,
  };

  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, avatar_emoji, vulgarity_max, timezone,
                        invite_code, push_token, push_platform, reminder_hour, created_at, last_seen_at, deleted_at,
                        nudges_enabled, recap_enabled, token_version)
     VALUES (@id, @username, @display_name, @password_hash, @avatar_emoji, @vulgarity_max, @timezone,
             @invite_code, @push_token, @push_platform, @reminder_hour, @created_at, @last_seen_at, @deleted_at,
             @nudges_enabled, @recap_enabled, @token_version)`,
  ).run(row);

  return row;
}

/**
 * Stores a new password hash and signs out every session the account has: the
 * token version moves on, so each token signed before it is refused
 * (plugins/auth.ts). Shared by `POST /me/password` and the owner's reset.
 *
 * With `clearPush` the push token goes too, because the phone it belongs to is
 * one of those sessions and its own logout can no longer clear it (it gets a
 * 401). The owner's reset always clears it; a change made on a phone clears it
 * unless that phone says the token is its own (see the route). Returns the row
 * as stored now.
 */
export function replacePassword(
  db: Database,
  userId: string,
  passwordHash: string,
  options: { clearPush: boolean },
): UserRow {
  db.prepare(
    options.clearPush
      ? `UPDATE users
            SET password_hash = ?, token_version = token_version + 1, push_token = NULL, push_platform = NULL
          WHERE id = ?`
      : 'UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?',
  ).run(passwordHash, userId);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow;
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
 *   the user out of standings and stops the scheduler from waiting for them; a çelınc
 *   that leaves nobody to race is cancelled right away (`cancelIfAbandoned`). There is
 *   no "havlu attı" for it: it would come from "Silinen kanka", who cannot hear back.
 *   The exception is a çelınc that is already over but still waiting (the phones' hour,
 *   a dispute's 12 hours): there an accepted player stays in, exactly as the leave route
 *   refuses to let them out — otherwise a loser could delete the account to turn a lost
 *   1v1 into "not enough players";
 * - every entry of theirs loses its note and proof photo, in every çelınc but the ones
 *   they stay in above (an itiraz there may still be waiting on that photo). Values and
 *   statuses stay, so no standing or result moves. Those few go once their çelınc is
 *   decided (`clearDeletedTraces`, on the scheduler's pass);
 * - with `uploadDir`, the photo files those entries pointed at are deleted from it,
 *   unless some entry still points at one (`removeUnusedPhotos`);
 * - finished/cancelled challenges, the rest of their entries, taunts and badges are
 *   untouched.
 *
 * Shared by `DELETE /me` and the owner's `npm run yonet -- sil`. Returns the anonymised row.
 */
export function softDeleteUser(
  db: Database,
  user: UserRow,
  now: Date = new Date(),
  options: { uploadDir?: string } = {},
): UserRow {
  const at = nowIso(now);
  let username = anonymizedUsername(user.id);
  // Defensive: a re-used prefix would violate the UNIQUE index and kill the request.
  if (db.prepare('SELECT 1 FROM users WHERE username = ? AND id <> ?').get(username, user.id)) {
    username = `${username}_${user.id.replace(/-/g, '').slice(8, 12)}`;
  }

  const photos = new Set<string>();
  const run = db.transaction(() => {
    db.prepare(
      `UPDATE users
          SET username = ?, display_name = 'Silinen kanka', password_hash = '',
              push_token = NULL, push_platform = NULL, reminder_hour = NULL, deleted_at = ?
        WHERE id = ?`,
    ).run(username, at, user.id);

    const open = db
      .prepare(
        `SELECT p.challenge_id, p.status FROM challenge_participants p
          WHERE p.user_id = ?
            AND p.status IN ('invited', 'accepted')
            AND p.challenge_id IN (SELECT id FROM challenges WHERE status IN ('pending', 'active'))`,
      )
      .all(user.id) as { challenge_id: string; status: string }[];
    const leave = db.prepare("UPDATE challenge_participants SET status = 'left' WHERE challenge_id = ? AND user_id = ?");
    for (const { challenge_id: challengeId, status } of open) {
      const challenge = getChallengeRow(db, challengeId);
      // over but not yet decided: the result stands with them in it
      if (status === 'accepted' && challenge && !stillOpen(challenge, now)) continue;
      leave.run(challengeId, user.id);
      // one player fewer is a smaller itiraz majority (see the leave route)
      if (!cancelIfAbandoned(db, challengeId, now)) announceDisputeClocks(db, challengeId, now);
    }

    // "Hesabı sil" promises the photos and notes go. The value stays, so a
    // finished çelınc still adds up to the result everybody was told. The
    // çelınclar they stayed in above are the ones `takeTraces` leaves alone.
    for (const url of takeTraces(db, user.id).photos) photos.add(url);

    // Pending friend requests in either direction are meaningless now.
    db.prepare("DELETE FROM friendships WHERE status = 'pending' AND (requester_id = ? OR addressee_id = ?)").run(
      user.id,
      user.id,
    );
  });
  run();
  // after the commit: a file deleted for a rolled-back delete would be gone for good
  if (options.uploadDir) removeUnusedPhotos(db, photos, options.uploadDir);

  return db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as UserRow;
}

/**
 * Takes the note and proof photo off every entry of a deleted account (only
 * `userId`'s when given) that nothing needs them for any more: all of them but
 * the ones in a çelınc the account stayed in while it is decided, i.e. one
 * still `pending`/`active` with the account `accepted` in it (softDeleteUser
 * moves every other open participation to `left`). Runs inside the caller's
 * transaction and returns how many entries it cleared and the photo addresses
 * it took off, for `removeUnusedPhotos` once that commits.
 */
function takeTraces(db: Database, userId?: string): { cleared: number; photos: Set<string> } {
  const traces = db
    .prepare(
      `SELECT e.id, e.proof_url FROM entries e
         JOIN users u ON u.id = e.user_id
         JOIN challenges c ON c.id = e.challenge_id
        WHERE u.deleted_at IS NOT NULL
          AND (@userId IS NULL OR e.user_id = @userId)
          AND (e.proof_url IS NOT NULL OR e.note IS NOT NULL)
          AND NOT (
            c.status IN ('pending', 'active')
            AND EXISTS (SELECT 1 FROM challenge_participants p
                         WHERE p.challenge_id = e.challenge_id AND p.user_id = e.user_id AND p.status = 'accepted')
          )`,
    )
    .all({ userId: userId ?? null }) as Pick<EntryRow, 'id' | 'proof_url'>[];
  const clear = db.prepare('UPDATE entries SET proof_url = NULL, note = NULL WHERE id = ?');
  const photos = new Set<string>();
  for (const entry of traces) {
    clear.run(entry.id);
    if (entry.proof_url) photos.add(entry.proof_url);
  }
  return { cleared: traces.length, photos };
}

/**
 * What `softDeleteUser` had to leave, cleared once nothing needs it: the notes
 * and proof photos of a deleted account in a çelınc that was still being
 * decided when the account went, after that çelınc finishes or is cancelled,
 * and those of every account deleted before deleting cleared them at all (the
 * first pass after the upgrade). The scheduler runs it on every pass; with
 * nothing left to clear it is one query. Returns how many entries it cleared.
 */
export function clearDeletedTraces(db: Database, uploadDir?: string): number {
  const { cleared, photos } = db.transaction(() => takeTraces(db))();
  // after the commit, as in softDeleteUser
  if (uploadDir) removeUnusedPhotos(db, photos, uploadDir);
  return cleared;
}

/**
 * A proof photo's address as `POST /uploads` hands it out (`/uploads/<uuid>.<ext>`),
 * or with a server address in front, as older apps stored it. The file name is
 * the random one the server gave it, so nothing else (a `../`, a file the owner
 * keeps in the folder) can ever match.
 */
const UPLOADED_PHOTO = /\/uploads\/([0-9a-f-]{36}\.(?:jpg|png|webp))$/;

/**
 * Deletes the files behind `urls` from `uploadDir`, except one that an entry
 * still points at. The API takes any address as a proof, so somebody else's
 * entry can carry the same URL, and their photo must not vanish with this
 * account. A file already gone, or one the disk will not let go of, is skipped:
 * the account is deleted either way, and what stays is a file nothing links to.
 */
function removeUnusedPhotos(db: Database, urls: Iterable<string>, uploadDir: string): void {
  const names = new Set<string>();
  for (const url of urls) {
    const name = UPLOADED_PHOTO.exec(url)?.[1];
    if (name) names.add(name);
  }
  const stillShown = db.prepare("SELECT 1 FROM entries WHERE proof_url LIKE '%/uploads/' || ? LIMIT 1");
  for (const name of names) {
    if (stillShown.get(name)) continue;
    try {
      fs.rmSync(path.join(uploadDir, name), { force: true });
    } catch {
      // a folder by that name, or a locked file on Windows: leave it
    }
  }
}
