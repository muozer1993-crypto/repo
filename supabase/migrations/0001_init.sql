-- Ergoterapi v1 initial schema.
--
-- Five tables mirror the Isar collections on-device. Every row carries
-- profile_id so Row-Level-Security can scope reads/writes to the
-- signed-in device (anonymous auth yields a stable auth.uid() per
-- device-profile).
--
-- Design notes:
--   * `distractor_category` is an enum-via-CHECK rather than a
--     Postgres ENUM so new categories are a migration-free change
--     in future revisions.
--   * No server-generated timestamps on session rows — we preserve
--     the exact client-side timestamps the patient experienced,
--     since clinical reports summarize "what the patient did", not
--     "when the server ingested it".

-- -------------------------------------------------------------------
-- profiles
-- -------------------------------------------------------------------
create table if not exists profiles (
  id              uuid primary key,
  name            text not null,
  age_band        text not null check (
    age_band in ('under65', 'from65to74', 'from75to84', 'over85')
  ),
  therapist_email text not null,
  created_at      timestamptz not null default now()
);

-- -------------------------------------------------------------------
-- sessions (one row per scene attempt)
-- -------------------------------------------------------------------
create table if not exists sessions (
  id                       uuid primary key,
  profile_id               uuid not null references profiles(id) on delete cascade,
  scene_id                 text not null,
  started_at               timestamptz not null,
  finished_at              timestamptz,
  error_count              int  not null,
  completed                bool not null,

  -- Clinical revision #2: orthogonal axes, both snapshotted.
  sr_interval_start        int not null,
  sr_interval_end          int not null,
  difficulty_start         int not null,
  difficulty_end           int not null,

  -- Clinical revision #4: time-orientation card result.
  orientation_correct      bool,
  orientation_response_ms  int,

  -- Clinical revision #6: working-memory proxy.
  instruction_replay_count int not null default 0
);
create index if not exists sessions_profile_started_idx
  on sessions (profile_id, started_at desc);

-- -------------------------------------------------------------------
-- placements (one row per tap attempt — correct, distractor, sequence-
--            violation, all captured)
-- -------------------------------------------------------------------
create table if not exists placements (
  id                  bigserial primary key,
  profile_id          uuid not null references profiles(id) on delete cascade,
  session_id          uuid not null references sessions(id) on delete cascade,
  item_id             text not null,
  target_slot_id      text not null,
  correct             bool not null,
  tapped_distractor   bool not null default false,
  reaction_ms         int  not null,
  wait_ms             int  not null,
  at                  timestamptz not null,

  -- Clinical revision #5: report-critical context.
  item_count_at_scene int  not null,
  distractor_category text not null check (
    distractor_category in ('absent', 'far', 'near', 'functional')
  ),
  sequence_required   bool not null,
  difficulty_level    int  not null
);
create index if not exists placements_session_idx on placements (session_id);
create index if not exists placements_profile_at_idx on placements (profile_id, at desc);

-- -------------------------------------------------------------------
-- app_opens (engagement signal)
-- -------------------------------------------------------------------
create table if not exists app_opens (
  id          bigserial primary key,
  profile_id  uuid not null references profiles(id) on delete cascade,
  at          timestamptz not null,
  time_window text not null check (
    time_window in ('sabah', 'oglen', 'ikindi', 'aksam', 'dinlenme')
  )
);
create index if not exists app_opens_profile_at_idx on app_opens (profile_id, at desc);

-- -------------------------------------------------------------------
-- report_sends (fire-and-forget audit trail of weekly emails)
-- -------------------------------------------------------------------
create table if not exists report_sends (
  id          bigserial primary key,
  profile_id  uuid not null references profiles(id) on delete cascade,
  sent_at     timestamptz not null default now(),
  ok          bool not null,
  error       text
);
create index if not exists report_sends_profile_sent_idx
  on report_sends (profile_id, sent_at desc);

-- -------------------------------------------------------------------
-- Row-Level Security: devices read/write only their own profile_id.
-- -------------------------------------------------------------------
alter table profiles     enable row level security;
alter table sessions     enable row level security;
alter table placements   enable row level security;
alter table app_opens    enable row level security;
alter table report_sends enable row level security;

-- profiles policy: auth.uid() == id
drop policy if exists device_own_profile on profiles;
create policy device_own_profile on profiles
  for all
  using (id::text = auth.uid()::text)
  with check (id::text = auth.uid()::text);

-- Repeat the same per-profile_id policy for the other four tables.
drop policy if exists device_own_sessions on sessions;
create policy device_own_sessions on sessions
  for all
  using (profile_id::text = auth.uid()::text)
  with check (profile_id::text = auth.uid()::text);

drop policy if exists device_own_placements on placements;
create policy device_own_placements on placements
  for all
  using (profile_id::text = auth.uid()::text)
  with check (profile_id::text = auth.uid()::text);

drop policy if exists device_own_app_opens on app_opens;
create policy device_own_app_opens on app_opens
  for all
  using (profile_id::text = auth.uid()::text)
  with check (profile_id::text = auth.uid()::text);

-- report_sends: device can only READ its own rows (service role writes).
drop policy if exists device_read_report_sends on report_sends;
create policy device_read_report_sends on report_sends
  for select
  using (profile_id::text = auth.uid()::text);
