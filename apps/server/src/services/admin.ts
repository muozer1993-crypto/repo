/**
 * The owner's tools behind `npm run yonet`: the few jobs the person running the
 * server had to do in a SQLite shell before.
 *
 * There is no email and no reset link — a friends-only server has nobody to send
 * one — so a forgotten password is fixed by the owner: a fresh one is set here and
 * handed over in a message. Reports land in the same place, since nothing in the
 * app reads them. Pure functions over a Database, so the CLI stays a printer and
 * the tests drive them against the in-memory database.
 */
import { randomInt } from 'node:crypto';
import { hashPassword } from '../auth/password.js';
import type { Database, UserRow } from '../db/index.js';

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

/** Every report, newest first (rowid breaks a tie within the same millisecond). */
export function listReports(db: Database): AdminReport[] {
  return db
    .prepare(
      `SELECT reporter.username AS reporter, reported.username AS reported, r.reason, r.created_at AS createdAt
         FROM reports r
         JOIN users reporter ON reporter.id = r.reporter_id
         JOIN users reported ON reported.id = r.reported_id
        ORDER BY r.created_at DESC, r.rowid DESC`,
    )
    .all() as AdminReport[];
}

/**
 * Gives `username` a new random password and returns it in plain text. Phones
 * already signed in stay signed in: tokens are stateless and outlive a new hash.
 */
export async function resetPassword(db: Database, username: string): Promise<PasswordReset> {
  const name = username.trim().replace(/^@/, '').toLowerCase();
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(name) as UserRow | undefined;
  if (!row) throw new Error(`"${name}" diye bir kullanıcı yok. Liste için: npm run yonet -- kullanicilar`);
  if (row.deleted_at !== null) throw new Error(`"${name}" hesabını silmiş, sıfırlanacak bir şifre kalmadı.`);

  const password = tempPassword();
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), row.id);
  return { username: row.username, displayName: row.display_name, password };
}
