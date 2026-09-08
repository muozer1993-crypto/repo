/**
 * SQLite access layer: `openDb()` plus the row types every service and route uses.
 *
 * There is no ORM — routes use `db.prepare(...)` directly. The row interfaces below
 * mirror the columns exactly (snake_case, SQLite types: INTEGER booleans are 0/1),
 * so `db.prepare(sql).get(id) as UserRow | undefined` is the whole mapping story.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { MIGRATIONS } from './migrations.js';

export type Database = BetterSqlite3.Database;
export type Statement = BetterSqlite3.Statement;

export const MEMORY_PATH = ':memory:';

/** New primary key. */
export function newId(): string {
  return randomUUID();
}

/** Current instant as an ISO-8601 UTC string — the only time format we store. */
export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 confusion

/** Short, human-readable, shareable invite code (e.g. "K7QF2M"). */
export function newInviteCode(length = 6): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += INVITE_ALPHABET[bytes[i]! % INVITE_ALPHABET.length];
  return out;
}

/**
 * Opens (and migrates) the database.
 *
 * - `':memory:'` → private in-memory database (tests), no WAL.
 * - anything else → file, with the parent directory created if missing.
 */
export function openDb(dbPath: string = MEMORY_PATH): Database {
  if (dbPath !== MEMORY_PATH) {
    const dir = path.dirname(path.resolve(dbPath));
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new BetterSqlite3(dbPath);
  if (dbPath !== MEMORY_PATH) db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  migrate(db);
  return db;
}

/** Applies every pending migration in one transaction. Safe to call repeatedly. */
export function migrate(db: Database): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');

  const applied = new Set(
    (db.prepare('SELECT id FROM _migrations').all() as { id: string }[]).map((row) => row.id),
  );
  const pending = MIGRATIONS.filter((m) => !applied.has(m.id));
  if (pending.length === 0) return [];

  const record = db.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)');
  const run = db.transaction((migrations: typeof pending) => {
    for (const migration of migrations) {
      db.exec(migration.sql);
      record.run(migration.id, nowIso());
    }
  });
  run(pending);

  return pending.map((m) => m.id);
}

// ---------------------------------------------------------------------------
// Row types (SPEC 2.1)
// ---------------------------------------------------------------------------

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  avatar_emoji: string;
  vulgarity_max: number;
  timezone: string;
  invite_code: string;
  push_token: string | null;
  push_platform: string | null;
  reminder_hour: number | null;
  created_at: string;
  last_seen_at: string | null;
  deleted_at: string | null;
}

export interface FriendshipRow {
  id: string;
  requester_id: string;
  addressee_id: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface ChallengeRow {
  id: string;
  creator_id: string;
  type_key: string;
  metric_type: string;
  direction: string;
  unit: string;
  title: string;
  starts_at: string;
  ends_at: string;
  status: string;
  reward_text: string | null;
  penalty_text: string | null;
  deadline_time: string | null;
  daily_target: number | null;
  /** 0 | 1 */
  proof_required: number;
  created_at: string;
  finalized_at: string | null;
  winner_id: string | null;
  /** 0 | 1 */
  is_tie: number;
  rematch_of_id: string | null;
}

export interface ParticipantRow {
  challenge_id: string;
  user_id: string;
  status: string;
  invited_at: string;
  joined_at: string | null;
  final_score: number | null;
  final_rank: number | null;
}

export interface EntryRow {
  id: string;
  challenge_id: string;
  user_id: string;
  day_key: string;
  value: number;
  source: string;
  note: string | null;
  proof_url: string | null;
  status: string;
  client_time: string | null;
  session_id: string | null;
  /** 0 | 1 — check-in recorded after the deadline. */
  late: number;
  created_at: string;
  updated_at: string;
}

export interface StepsDailyRow {
  user_id: string;
  day_key: string;
  steps: number;
  source: string;
  updated_at: string;
}

export interface DisputeRow {
  id: string;
  entry_id: string;
  by_user_id: string;
  reason: string;
  status: string;
  created_at: string;
}

export interface TauntRow {
  id: string;
  challenge_id: string;
  from_user_id: string;
  to_user_id: string;
  template_id: string | null;
  level: number;
  title: string;
  body: string;
  created_at: string;
}

export interface PokeRow {
  id: string;
  challenge_id: string;
  from_user_id: string;
  to_user_id: string;
  created_at: string;
}

export interface NotificationRow {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string;
  /** JSON object as text. */
  data: string;
  read_at: string | null;
  created_at: string;
  pushed_at: string | null;
  push_error: string | null;
}

export interface BadgeRow {
  user_id: string;
  badge_key: string;
  earned_at: string;
}

export interface ReportRow {
  id: string;
  reporter_id: string;
  reported_id: string;
  reason: string;
  created_at: string;
}

export interface ReminderSentRow {
  user_id: string;
  day_key: string;
}

// ---------------------------------------------------------------------------
// Tiny query helpers (used by the services; routes may use them too)
// ---------------------------------------------------------------------------

/** `SELECT COUNT(*)`-style scalar. Returns 0 when the query yields no row. */
export function countOf(db: Database, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...(params as never[])) as { n: number | null } | undefined;
  return Number(row?.n ?? 0);
}

/** Live (non soft-deleted) user by id. */
export function getUserById(db: Database, id: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(id) as UserRow | undefined;
}

/** Live user by username (usernames are stored lowercase). */
export function getUserByUsername(db: Database, username: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ? AND deleted_at IS NULL').get(username) as UserRow | undefined;
}
