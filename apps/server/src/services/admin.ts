/**
 * The owner's tools behind `npm run yonet`: the few jobs the person running the
 * server had to do in a SQLite shell before.
 *
 * There is no email and no reset link — a friends-only server has nobody to send
 * one — so a forgotten password is fixed by the owner: a fresh one is set here and
 * handed over in a message. Reports land in the same place, since nothing in the
 * app reads them, and so does the answer to one: the invite link gets forwarded,
 * and a stranger who signed up with it is closed out here. Pure functions over a
 * Database, so the CLI stays a printer and the tests drive them against the
 * in-memory database.
 */
import { randomInt } from 'node:crypto';
import { foldUsername } from '@koydum/shared';
import { hashPassword } from '../auth/password.js';
import type { Database, UserRow } from '../db/index.js';
import { replacePassword, softDeleteUser } from './accounts.js';

export interface AdminUser {
  username: string;
  displayName: string;
  createdAt: string;
  lastSeenAt: string | null;
  deletedAt: string | null;
  /** Running çelınclar the user has accepted. */
  activeChallenges: number;
}

export interface AdminReport {
  reporter: string;
  reported: string;
  reason: string;
  createdAt: string;
}

/** An account as the owner knows it: the name before any anonymising. */
export interface AccountName {
  username: string;
  displayName: string;
}

export interface PasswordReset {
  username: string;
  displayName: string;
  /** Plain text, shown once to the owner and stored only as a hash. */
  password: string;
}

/**
 * Lowercase letters and digits minus the pairs that read alike in a chat bubble
 * (l/1, o/0) and minus i, which sits right next to ı on a Turkish keyboard. The
 * friend types it off a WhatsApp message, with nothing to shift for. 31^8 guesses
 * is plenty behind the login throttle.
 */
const TEMP_PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const TEMP_PASSWORD_LENGTH = 8;

function tempPassword(): string {
  let out = '';
  for (let i = 0; i < TEMP_PASSWORD_LENGTH; i++) out += TEMP_PASSWORD_ALPHABET[randomInt(TEMP_PASSWORD_ALPHABET.length)];
  return out;
}

/** The row the owner means, or the Turkish error the CLI prints as it is. */
function userNamed(db: Database, username: string): UserRow {
  // the spelling the app stores, so "sifre Şeyma" and "sifre @seyma" find seyma
  const name = foldUsername(username);
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(name) as UserRow | undefined;
  if (!row) throw new Error(`"${name}" diye bir kullanıcı yok. Liste için: npm run yonet -- kullanicilar`);
  return row;
}

/** Everybody, live accounts first; deleted ones keep their anonymised name. */
export function listUsers(db: Database): AdminUser[] {
  const rows = db
    .prepare(
      `SELECT u.username, u.display_name, u.created_at, u.last_seen_at, u.deleted_at,
              (SELECT COUNT(*) FROM challenge_participants p
                 JOIN challenges c ON c.id = p.challenge_id
                WHERE p.user_id = u.id AND p.status = 'accepted' AND c.status = 'active') AS active
         FROM users u
        ORDER BY u.deleted_at IS NOT NULL, u.username`,
    )
    .all() as (Pick<UserRow, 'username' | 'display_name' | 'created_at' | 'last_seen_at' | 'deleted_at'> & {
    active: number;
  })[];
  return rows.map((row) => ({
    username: row.username,
    displayName: row.display_name,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    deletedAt: row.deleted_at,
    activeChallenges: Number(row.active),
  }));
}

/**
 * How many reports `sikayetler` lists. Thousands of them (a script filed 3,000
 * before the per-account cap) were thousands of lines nobody reads past the top.
 */
export const REPORTS_LISTED = 200;

/** The newest `REPORTS_LISTED` reports, newest first (rowid breaks a tie within the same millisecond). */
export function listReports(db: Database): AdminReport[] {
  return db
    .prepare(
      `SELECT reporter.username AS reporter, reported.username AS reported, r.reason, r.created_at AS createdAt
         FROM reports r
         JOIN users reporter ON reporter.id = r.reporter_id
         JOIN users reported ON reported.id = r.reported_id
        ORDER BY r.created_at DESC, r.rowid DESC
        LIMIT ?`,
    )
    .all(REPORTS_LISTED) as AdminReport[];
}

/** All the reports `listReports` would show without its cap, so the owner knows when it stops short. */
export function countReports(db: Database): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM reports r
         JOIN users reporter ON reporter.id = r.reporter_id
         JOIN users reported ON reported.id = r.reported_id`,
    )
    .get() as { n: number };
  return Number(row.n);
}

/**
 * Gives `username` a new random password and returns it in plain text. Every
 * phone still signed in to the account is signed out, the friend's own included:
 * a reset is also how somebody gets their account back from a phone they lost
 * track of. They sign in again with the new password.
 */
export async function resetPassword(db: Database, username: string): Promise<PasswordReset> {
  const row = userNamed(db, username);
  if (row.deleted_at !== null) throw new Error(`"${row.username}" hesabını silmiş, sıfırlanacak bir şifre kalmadı.`);

  const password = tempPassword();
  // whichever phone holds the push token is signed out with the rest
  replacePassword(db, row.id, await hashPassword(password), { clearPush: true });
  return { username: row.username, displayName: row.display_name, password };
}

/** The live account `sil` would close, or why not. */
function closableUser(db: Database, username: string): UserRow {
  const row = userNamed(db, username);
  if (row.deleted_at !== null) throw new Error(`"${row.username}" hesabı zaten silinmiş.`);
  return row;
}

/** Who `deleteAccount` would close, so the CLI can ask about them by name first. Throws as it does. */
export function accountToDelete(db: Database, username: string): AccountName {
  const row = closableUser(db, username);
  return { username: row.username, displayName: row.display_name };
}

/**
 * Closes `username` the way "Hesabı sil" does (softDeleteUser): the phones
 * signed in to it get a 401 on their next request, it leaves its running
 * çelınclar (a 1v1 left with one player is cancelled) and its proof photos
 * leave `uploadDir`. For a stranger who got hold of the invite link, or a
 * friend who wants out and has no phone left. Returns the name it had.
 */
export function deleteAccount(db: Database, username: string, now: Date = new Date(), uploadDir?: string): AccountName {
  const row = closableUser(db, username);
  softDeleteUser(db, row, now, { uploadDir });
  return { username: row.username, displayName: row.display_name };
}
