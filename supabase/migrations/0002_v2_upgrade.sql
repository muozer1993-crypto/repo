-- Ergoterapi v2 upgrade — 4 dilim × 2 oyun + bonus.
--
-- Additive migration: every new column is nullable or has a default so
-- already-pushed v1 rows remain valid. Two new tables (bonus_plays,
-- missed_slots) capture events that the v1 schema had no place for.
--
-- No data migration is required. If you rolled v1 into production with
-- real patient data, this migration can be applied live — it only adds
-- columns and tables.

-- -------------------------------------------------------------------
-- sessions: add per-game split columns + rotation bookkeeping.
--
-- The top-level error_count / completed fields stay as the session-
-- wide total (Game-1 + Game-2) so v1 report queries keep working. The
-- new g1/g2 mirrors let v2 reports decompose the total.
-- -------------------------------------------------------------------
alter table sessions
  add column if not exists game1_error_count int  not null default 0,
  add column if not exists game1_completed   bool not null default false,
  add column if not exists game2_error_count int  not null default 0,
  add column if not exists game2_completed   bool not null default false,
  add column if not exists game2_type        text check (
    game2_type in (
      'plate_matching', 'sequence_ordering',
      'quantity_counting', 'next_step_planning'
    )
  ),
  add column if not exists item_combo_hash   text;

-- -------------------------------------------------------------------
-- placements: tag which game produced the tap. 'game1' default keeps
-- existing rows consistent with v1 behaviour.
-- -------------------------------------------------------------------
alter table placements
  add column if not exists game_type text not null default 'game1' check (
    game_type in ('game1', 'game2', 'bonus')
  );

-- -------------------------------------------------------------------
-- bonus_plays — every time a patient starts a bonus scene.
--
-- Intentionally *not* keyed by session_id: bonus plays can occur
-- standalone (night) or be offered after a session's end. The weekly
-- report joins on profile_id + started_at window.
-- -------------------------------------------------------------------
create table if not exists bonus_plays (
  id              uuid primary key,
  profile_id      uuid not null references profiles(id) on delete cascade,
  bonus_scene_id  text not null,
  bonus_type      text not null check (
    bonus_type in ('find_item', 'tap_sequence', 'pair_match', 'free_explore')
  ),
  started_at      timestamptz not null,
  finished_at     timestamptz,
  tap_count       int  not null default 0,
  night_bonus     bool not null default false,
  time_window     text not null check (
    time_window in ('sabah', 'oglen', 'ikindi', 'aksam', 'dinlenme')
  )
);
create index if not exists bonus_plays_profile_started_idx
  on bonus_plays (profile_id, started_at desc);

-- -------------------------------------------------------------------
-- missed_slots — one row per time-window the patient never opened
-- during play hours. Written lazily by the scheduler when it detects a
-- previous window closed without a session.
-- -------------------------------------------------------------------
create table if not exists missed_slots (
  id           bigserial primary key,
  profile_id   uuid not null references profiles(id) on delete cascade,
  time_window  text not null check (
    time_window in ('sabah', 'oglen', 'ikindi', 'aksam')
  ),
  scene_id     text not null,
  missed_on    date not null,
  detected_at  timestamptz not null,
  unique (profile_id, time_window, missed_on)
);
create index if not exists missed_slots_profile_missed_idx
  on missed_slots (profile_id, missed_on desc);

-- -------------------------------------------------------------------
-- RLS
-- -------------------------------------------------------------------
alter table bonus_plays  enable row level security;
alter table missed_slots enable row level security;

-- Postgres has no `CREATE POLICY IF NOT EXISTS`; mirror the v1
-- migration's drop-then-create pattern so re-running the migration
-- on a partially-applied DB stays idempotent.
drop policy if exists "device_own_bonus_plays" on bonus_plays;
create policy "device_own_bonus_plays" on bonus_plays
  for all using (profile_id::text = auth.uid()::text)
  with check (profile_id::text = auth.uid()::text);

drop policy if exists "device_own_missed_slots" on missed_slots;
create policy "device_own_missed_slots" on missed_slots
  for all using (profile_id::text = auth.uid()::text)
  with check (profile_id::text = auth.uid()::text);
