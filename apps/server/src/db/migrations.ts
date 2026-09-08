/**
 * Schema migrations, embedded as strings so the server works from any cwd
 * (no filesystem reads — SPEC 2).
 *
 * Migrations are applied in array order inside one transaction and recorded in
 * `_migrations`; adding a new entry at the end is the only supported change.
 */

export interface Migration {
  id: string;
  sql: string;
}

const INIT = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_emoji  TEXT NOT NULL DEFAULT '🍆',
  vulgarity_max INTEGER NOT NULL DEFAULT 2,
  timezone      TEXT NOT NULL DEFAULT 'Europe/Istanbul',
  invite_code   TEXT NOT NULL UNIQUE,
  push_token    TEXT,
  push_platform TEXT,
  reminder_hour INTEGER DEFAULT 20,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT,
  deleted_at    TEXT
);

CREATE TABLE IF NOT EXISTS friendships (
  id           TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE(requester_id, addressee_id)
);

CREATE TABLE IF NOT EXISTS challenges (
  id             TEXT PRIMARY KEY,
  creator_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type_key       TEXT NOT NULL,
  metric_type    TEXT NOT NULL,
  direction      TEXT NOT NULL,
  unit           TEXT NOT NULL,
  title          TEXT NOT NULL,
  starts_at      TEXT NOT NULL,
  ends_at        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  reward_text    TEXT,
  penalty_text   TEXT,
  deadline_time  TEXT,
  daily_target   REAL,
  proof_required INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  finalized_at   TEXT,
  winner_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  is_tie         INTEGER NOT NULL DEFAULT 0,
  rematch_of_id  TEXT REFERENCES challenges(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS challenge_participants (
  challenge_id TEXT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'invited',
  invited_at   TEXT NOT NULL,
  joined_at    TEXT,
  final_score  REAL,
  final_rank   INTEGER,
  PRIMARY KEY (challenge_id, user_id)
);

-- \`late\` is not in the SPEC table list but the Entry API shape carries it
-- (check-ins recorded after the deadline); storing it keeps the flag stable
-- across restarts instead of re-deriving it from value + source.
CREATE TABLE IF NOT EXISTS entries (
  id           TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_key      TEXT NOT NULL,
  value        REAL NOT NULL DEFAULT 0,
  source       TEXT NOT NULL,
  note         TEXT,
  proof_url    TEXT,
  status       TEXT NOT NULL DEFAULT 'ok',
  client_time  TEXT,
  session_id   TEXT,
  late         INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS steps_daily (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_key    TEXT NOT NULL,
  steps      INTEGER NOT NULL DEFAULT 0,
  source     TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, day_key)
);

CREATE TABLE IF NOT EXISTS disputes (
  id         TEXT PRIMARY KEY,
  entry_id   TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason     TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  UNIQUE(entry_id, by_user_id)
);

CREATE TABLE IF NOT EXISTS taunts (
  id           TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_id  TEXT,
  level        INTEGER NOT NULL DEFAULT 1,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE(challenge_id, from_user_id, to_user_id)
);

CREATE TABLE IF NOT EXISTS pokes (
  id           TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  data       TEXT NOT NULL DEFAULT '{}',
  read_at    TEXT,
  created_at TEXT NOT NULL,
  pushed_at  TEXT,
  push_error TEXT
);

CREATE TABLE IF NOT EXISTS badges (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_key TEXT NOT NULL,
  earned_at TEXT NOT NULL,
  PRIMARY KEY (user_id, badge_key)
);

CREATE TABLE IF NOT EXISTS reports (
  id          TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reminders_sent (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_key TEXT NOT NULL,
  PRIMARY KEY (user_id, day_key)
);
`;

const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_users_username           ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_invite_code        ON users(invite_code);

CREATE INDEX IF NOT EXISTS idx_friendships_requester    ON friendships(requester_id, status);
CREATE INDEX IF NOT EXISTS idx_friendships_addressee    ON friendships(addressee_id, status);

CREATE INDEX IF NOT EXISTS idx_challenges_status_starts ON challenges(status, starts_at);
CREATE INDEX IF NOT EXISTS idx_challenges_status_ends   ON challenges(status, ends_at);
CREATE INDEX IF NOT EXISTS idx_challenges_creator       ON challenges(creator_id);
CREATE INDEX IF NOT EXISTS idx_challenges_winner        ON challenges(winner_id);
CREATE INDEX IF NOT EXISTS idx_challenges_rematch_of    ON challenges(rematch_of_id);

CREATE INDEX IF NOT EXISTS idx_participants_user        ON challenge_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_participants_user_status ON challenge_participants(user_id, status);

CREATE INDEX IF NOT EXISTS idx_entries_challenge_user_day ON entries(challenge_id, user_id, day_key);
CREATE INDEX IF NOT EXISTS idx_entries_challenge_day       ON entries(challenge_id, day_key);
CREATE INDEX IF NOT EXISTS idx_entries_user                ON entries(user_id, day_key);
CREATE INDEX IF NOT EXISTS idx_entries_challenge_created   ON entries(challenge_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_session       ON entries(challenge_id, user_id, session_id) WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_steps_daily_user          ON steps_daily(user_id, day_key);

CREATE INDEX IF NOT EXISTS idx_disputes_entry            ON disputes(entry_id);
CREATE INDEX IF NOT EXISTS idx_disputes_by_user          ON disputes(by_user_id, status);

CREATE INDEX IF NOT EXISTS idx_taunts_challenge          ON taunts(challenge_id);
CREATE INDEX IF NOT EXISTS idx_taunts_to_user            ON taunts(to_user_id);
CREATE INDEX IF NOT EXISTS idx_taunts_from_user          ON taunts(from_user_id);

CREATE INDEX IF NOT EXISTS idx_pokes_pair                ON pokes(challenge_id, from_user_id, to_user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_unread       ON notifications(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_notifications_push_queue   ON notifications(pushed_at, push_error);

CREATE INDEX IF NOT EXISTS idx_badges_user               ON badges(user_id);
CREATE INDEX IF NOT EXISTS idx_reports_reported          ON reports(reported_id);
`;

/**
 * The timezone a participant's day keys are measured in, frozen when they join.
 *
 * `users.timezone` is editable at any time (PATCH /me), and both the check-in
 * verdict and the day window are read from it — so without this snapshot a player
 * could hop to a zone where the deadline has not passed yet and turn a late
 * check-in into an on-time one. NULL means "not pinned": the code falls back to
 * `users.timezone` for rows written before this migration.
 */
const PARTICIPANT_TIMEZONE = `
ALTER TABLE challenge_participants ADD COLUMN timezone TEXT;
`;

export const MIGRATIONS: Migration[] = [
  { id: '001_init', sql: INIT },
  { id: '002_indexes', sql: INDEXES },
  { id: '003_participant_timezone', sql: PARTICIPANT_TIMEZONE },
];
