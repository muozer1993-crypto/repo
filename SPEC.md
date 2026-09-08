# KOYDUM — Technical Specification (single source of truth)

KOYDUM is a friends-only challenge ("çelinç") app for iOS + Android. Friends compete on
measurable habits (steps, focus time, early wake-ups, water, no-smoking days, ...). The
winner earns the right to "KOYDUM MU?" — a vulgar-comedy taunt delivered as a push
notification + in-app inbox item to every loser. All UI copy is Turkish; the tone is
crude banter between friends, scaled by a per-user vulgarity level (1 nazik, 2 argo,
3 ağır abi). The RECIPIENT's max level always wins (server clamps).

Monorepo (npm workspaces):

```
packages/shared   @koydum/shared  — pure TS: types, zod schemas, catalog, taunts, scoring, copy
apps/server       @koydum/server  — Fastify 5 + better-sqlite3 (Node >= 20), tsx runtime
apps/mobile       mobile          — Expo SDK 57, expo-router, TypeScript, React 19
```

Rules for every implementer:
- Do NOT run `npm install`. All dependencies are already installed at the repo root. If a
  package is genuinely missing, report it in your final output instead of installing.
- Only touch files inside your assigned directory unless the task says otherwise.
- `@koydum/shared` is imported as `@koydum/shared` (workspace symlink, source TS via `main`).
- Every user-facing string is Turkish. Code identifiers, comments, commit messages: English.
- Typecheck must pass: `npm run typecheck -w packages/shared`, `-w apps/server`, and in
  `apps/mobile`: `npx tsc --noEmit`.
- Times are stored as ISO-8601 UTC strings; "day keys" are `YYYY-MM-DD` in the USER's IANA
  timezone (`users.timezone`).

---------------------------------------------------------------------------------------

## 1. Shared package (`packages/shared/src`)

```
index.ts          re-exports everything
types.ts          domain types (User, Challenge, Participant, Entry, Notification, Taunt...)
schemas.ts        zod schemas for every API request body + shared enums
catalog.ts        CHALLENGE_TYPES: ChallengeType[] (from design JSON) + lookup helpers
taunts.ts         TAUNTS: TauntTemplate[], pickTaunt(), renderTaunt(), clampLevel()
copy.ts           MICROCOPY (keyed, 3 levels), BADGES, TAGLINE, t(key, level)
scoring.ts        computeScores(), rankParticipants(), day helpers, validation constants
banned.ts         BANNED_PATTERNS (regex list) + containsBanned(text)
time.ts           dayKeyInTz(date, tz), localTimeHHmm(date, tz), dayKeysBetween(), isValidDayKey()
```

### 1.1 Enums

```ts
export type MetricType =
  | 'auto_steps' | 'focus_minutes' | 'checkin_deadline'
  | 'manual_count' | 'manual_lower_is_better' | 'daily_boolean';
export type Direction = 'higher' | 'lower';
export type VulgarityLevel = 1 | 2 | 3;
export type ChallengeStatus = 'pending' | 'active' | 'finished' | 'cancelled';
export type ParticipantStatus = 'invited' | 'accepted' | 'declined' | 'left';
export type EntrySource = 'pedometer' | 'health_connect' | 'manual' | 'focus' | 'checkin';
export type EntryStatus = 'ok' | 'disputed' | 'rejected';
export type FriendshipStatus = 'pending' | 'accepted' | 'blocked';
export type NotificationType =
  | 'friend_request' | 'friend_accepted' | 'challenge_invite' | 'challenge_started'
  | 'challenge_cancelled' | 'challenge_finished' | 'taunt' | 'poke' | 'dispute'
  | 'entry_rejected' | 'reminder' | 'badge' | 'rematch';
export type TauntContext = 'win' | 'win_big' | 'win_close' | 'tie' | 'poke' | 'streak' | 'revenge';
```

### 1.2 ChallengeType (catalog)

```ts
export interface ChallengeType {
  key: string; nameTr: string; emoji: string; metricType: MetricType; unitTr: string;
  direction: Direction; descriptionTr: string; descriptionPoliteTr: string; howMeasuredTr: string;
  defaultDurationDays: number; defaultDeadlineTime?: string; // "HH:mm"
  suggestedRewardTr: string; antiCheatTr: string; proofRequired: boolean;
  category: 'hareket'|'ekran'|'uyku'|'beslenme'|'zihin'|'kotu_aliskanlik'|'diger';
  maxPerEntry: number;        // anti-abuse cap for a single manual value
  maxPerDay: number;          // cap for the daily sum
  missingDayPenalty?: number; // lower-is-better only: value assumed for unreported days
}
```
Metric semantics:
| metricType | entries/day | value | score |
|---|---|---|---|
| auto_steps | 1 (upsert) | steps | sum of days |
| focus_minutes | many | minutes of a completed focus session | sum |
| checkin_deadline | 1 | 1 if check-in happened before `deadlineTime` local, else 0 | count of 1s |
| daily_boolean | 1 (upsert) | 1 = did it / 0 = failed | count of 1s |
| manual_count | many | number (glasses, pages, km...) | sum |
| manual_lower_is_better | 1 (upsert) | number (e.g. screen hours) | sum + missingDays × missingDayPenalty; lowest wins |

### 1.3 Scoring (`scoring.ts`)

```ts
export interface ScoreInput { userId: string; entries: { dayKey: string; value: number; status: EntryStatus }[] }
export interface ScoreResult { userId: string; score: number; days: number; rank: number; isWinner: boolean }
export function computeScore(type: ChallengeType, dayKeys: string[], entries: ScoreInput['entries']): { score: number; days: number }
export function rankParticipants(type: ChallengeType, dayKeys: string[], inputs: ScoreInput[]): { results: ScoreResult[]; winnerId: string | null; isTie: boolean }
```
- Entries with `status === 'ok'` and `status === 'disputed'` count; a dispute only removes an entry once it is
  upheld, at which point the entry becomes `rejected` and stops counting.
- Ranking: sort by score (desc for higher, asc for lower). Rank 1 shared on equal score.
  `isTie` = top score shared by ≥2 participants → `winnerId = null`.
- `winMargin(type, winnerScore, loserScore)` returns `'big' | 'close' | 'normal'`:
  big if winner ≥ 2× loser (or loser 0 and winner > 0); close if difference ≤ 10% of winner; else normal.
  For `direction === 'lower'` the comparison is mirrored, because there the loser holds the larger
  number: big if loser ≥ 2× winner (or winner 0 and loser > 0); close if the difference is ≤ 10% of
  the loser's score.

### 1.4 Taunts (`taunts.ts`)

```ts
export interface TauntTemplate { id: string; level: VulgarityLevel; context: TauntContext; title: string; body: string }
export interface TauntVars { winner: string; loser: string; metric: string; winnerScore: string; loserScore: string; diff: string; unit: string; challenge: string }
export function renderTaunt(tpl: {title: string; body: string}, vars: TauntVars): { title: string; body: string }
export function tauntsFor(context: TauntContext, maxLevel: VulgarityLevel): TauntTemplate[]  // all with level <= maxLevel
export function pickTaunt(context: TauntContext, level: VulgarityLevel, seed?: number): TauntTemplate // deterministic when seed given
export function clampLevel(requested: VulgarityLevel, recipientMax: VulgarityLevel): VulgarityLevel
```
Placeholders: `{winner} {loser} {metric} {winnerScore} {loserScore} {diff} {unit} {challenge}`.
Unknown placeholders are left as-is. Numbers are formatted with `tr-TR` locale (12.430).

### 1.5 Copy (`copy.ts`)

`MICROCOPY: Record<MicrocopyKey, {level1,level2,level3}>`, `t(key, level)`. `BADGES` with machine `rule`
strings parsed by `evaluateBadges(stats)` → earned badge keys. `stats` shape:
`{ wins, losses, ties, tauntsSent, tauntsReceived, stepsSingleDayMax, focusTotalMinutes, checkinsStreakMax, disputesWon, challengesPlayed, pokesSent, revengeWins }`
(`revengeWins` = finished challenges won that were a rematch of an earlier one; the `revenge_master` badge needs it).
Rule grammar: `<statKey><op><number>` with op in `>=`, `>`, `==`, `<=`; multiple rules joined by `&&`.

### 1.6 Zod schemas (`schemas.ts`) — the API contract

```ts
RegisterBody { username: /^[a-z0-9_]{3,20}$/ (lowercased), password: min 6 max 72, displayName: 1..30, timezone: string (default 'Europe/Istanbul') }
LoginBody { username, password }
UpdateMeBody { displayName?, avatarEmoji? (1..4 chars), vulgarityMax? (1|2|3), timezone?, reminderHour? (0..23 | null) }
PushTokenBody { token: string, platform: 'ios'|'android'|'web' }
StepsSyncBody { days: { dayKey, steps: int 0..100000, source: 'pedometer'|'health_connect' }[] (max 14) }
FriendRequestBody { username?: string, inviteCode?: string } (exactly one)
CreateChallengeBody {
  typeKey: string; title?: string (max 40);
  startsAt: ISO (>= now-5min); endsAt: ISO (> startsAt + 1h, <= startsAt + 60d);
  participantIds: string[] (1..15, friends only, unique, not self);
  rewardText?: string (max 80); penaltyText?: string (max 80);
  deadlineTime?: 'HH:mm' (required when metricType === 'checkin_deadline');
  dailyTarget?: number; proofRequired?: boolean;
}
EntryBody { dayKey: 'YYYY-MM-DD'; value: number >= 0; source: EntrySource; note?: string(max 120); proofUrl?: string; clientTime: ISO; sessionId?: string (uuid, focus idempotency) }
DisputeBody { reason: string 1..140 }
PokeBody { toUserId: string; templateId?: string }
TauntBody { toUserId: string; templateId?: string; customBody?: string (max 140) } (one of)
ReportBody { reason: string 1..300 }
InboxReadBody { ids?: string[]; all?: boolean }
```

### 1.7 API response types (`types.ts`)

```ts
PublicUser { id, username, displayName, avatarEmoji, createdAt }
Me extends PublicUser { vulgarityMax, timezone, reminderHour, inviteCode, hasPushToken, stats: UserStats, badges: string[] }
UserStats { wins, losses, ties, tauntsSent, tauntsReceived, stepsSingleDayMax, focusTotalMinutes, checkinsStreakMax, disputesWon, challengesPlayed, pokesSent, revengeWins, stepsToday }
Challenge { id, creatorId, typeKey, metricType, direction, unit, title, startsAt, endsAt, status, rewardText, penaltyText, deadlineTime, dailyTarget, proofRequired, createdAt, finalizedAt, winnerId, isTie, rematchOfId }
ParticipantView { user: PublicUser, status, score, days, rank, lastEntryAt, isWinner }
ChallengeSummary { challenge: Challenge, participants: ParticipantView[], me: ParticipantView | null, unreadTaunts: number }
ChallengeDetail extends ChallengeSummary { myEntries: Entry[], feed: FeedItem[], disputes: Dispute[], taunts: Taunt[], canTaunt: { toUserId: string; done: boolean }[], canPoke: boolean }
Entry { id, challengeId, userId, dayKey, value, source, note, proofUrl, status, createdAt, late?: boolean }
FeedItem { id, userId, displayName, dayKey, value, source, status, createdAt, proofUrl }
Dispute { id, entryId, byUserId, reason, status: 'open'|'upheld'|'dismissed', createdAt }
Taunt { id, challengeId, fromUserId, toUserId, level, title, body, createdAt }
Notification { id, type, title, body, data: Record<string, unknown>, readAt, createdAt }
FriendsView { friends: PublicUser[], incoming: {id, user}[], outgoing: {id, user}[] }
```

---------------------------------------------------------------------------------------

## 2. Server (`apps/server`)

Stack: Fastify 5, `@fastify/cors`, `@fastify/multipart`, `@fastify/static`, better-sqlite3,
`expo-server-sdk`, zod (from shared). Runtime `tsx`. No ORM: a thin `db.ts` with prepared
statements and SQL migrations applied at boot (`migrations/001_init.sql` ... embedded as
strings in `src/db/migrations.ts` — no filesystem reads for migrations so it works from any cwd).

```
src/index.ts            boot: buildApp() + listen(PORT, HOST 0.0.0.0) + start scheduler
src/app.ts              buildApp(opts): registers plugins, routes, error handler; exported for tests
src/config.ts           env: PORT=4000, HOST=0.0.0.0, DATA_DIR=./data, UPLOAD_DIR=./uploads, JWT_SECRET (auto-generated & persisted to DATA_DIR/secret if missing), PUBLIC_URL, LOG_LEVEL
src/db/index.ts         openDb(path|':memory:'), migrations, helpers (nowIso, newId = crypto.randomUUID)
src/db/migrations.ts    SQL strings
src/auth/jwt.ts         sign/verify HS256 with node:crypto (header.payload.sig, exp 90d)
src/auth/password.ts    scrypt hash/verify (salt:hash hex)
src/plugins/auth.ts     fastify decorator `authenticate` preHandler → request.user = {id}
src/routes/auth.ts      /auth/register, /auth/login
src/routes/me.ts        /me, PATCH /me, DELETE /me, /me/push-token, /me/steps, /me/inbox*
src/routes/users.ts     /users/search, /users/:id, block/unblock/report
src/routes/friends.ts   /friends*
src/routes/challenges.ts/challenges*, entries, disputes, poke, taunt, rematch, results
src/routes/uploads.ts   POST /uploads (multipart image ≤ 5MB, jpg/png/webp) → { url }
src/routes/catalog.ts   GET /catalog → { types, taunts (levels 1-3, contexts), microcopy, badges, version }
src/services/challenges.ts  lifecycle: activate(), finalize(), computeStandings(), cancelIfUnderfilled()
src/services/entries.ts     validateAndUpsertEntry() per metric type (see 2.3)
src/services/notifications.ts  notify(userId, type, title, body, data) → inbox insert + push queue
src/services/push.ts        Expo push sender (batch, handles DeviceNotRegistered → clears token)
src/services/stats.ts       computeUserStats(userId), evaluate & award badges
src/services/scheduler.ts   setInterval 30s: activate due, finalize ended, cancel underfilled, reminders
src/services/taunts.ts      sendTaunt() with clamp + one-per-loser rule; sendPoke() rate limit
```

### 2.1 Tables (SQLite, WAL mode, foreign keys ON)

```sql
users(id TEXT PK, username TEXT UNIQUE, display_name TEXT, password_hash TEXT, avatar_emoji TEXT DEFAULT '🍆',
      vulgarity_max INTEGER DEFAULT 2, timezone TEXT DEFAULT 'Europe/Istanbul', invite_code TEXT UNIQUE,
      push_token TEXT, push_platform TEXT, reminder_hour INTEGER DEFAULT 20, created_at TEXT, last_seen_at TEXT, deleted_at TEXT)
friendships(id TEXT PK, requester_id TEXT, addressee_id TEXT, status TEXT, created_at TEXT, updated_at TEXT, UNIQUE(requester_id, addressee_id))
challenges(id TEXT PK, creator_id TEXT, type_key TEXT, metric_type TEXT, direction TEXT, unit TEXT, title TEXT,
      starts_at TEXT, ends_at TEXT, status TEXT, reward_text TEXT, penalty_text TEXT, deadline_time TEXT, daily_target REAL,
      proof_required INTEGER DEFAULT 0, created_at TEXT, finalized_at TEXT, winner_id TEXT, is_tie INTEGER DEFAULT 0, rematch_of_id TEXT)
challenge_participants(challenge_id TEXT, user_id TEXT, status TEXT, invited_at TEXT, joined_at TEXT,
      final_score REAL, final_rank INTEGER, PRIMARY KEY(challenge_id, user_id))
entries(id TEXT PK, challenge_id TEXT, user_id TEXT, day_key TEXT, value REAL, source TEXT, note TEXT, proof_url TEXT,
      status TEXT DEFAULT 'ok', client_time TEXT, session_id TEXT, created_at TEXT, updated_at TEXT)
  -- indexes: (challenge_id, user_id, day_key); UNIQUE(challenge_id, user_id, session_id) WHERE session_id IS NOT NULL
steps_daily(user_id TEXT, day_key TEXT, steps INTEGER, source TEXT, updated_at TEXT, PRIMARY KEY(user_id, day_key))
disputes(id TEXT PK, entry_id TEXT, by_user_id TEXT, reason TEXT, status TEXT, created_at TEXT, UNIQUE(entry_id, by_user_id))
taunts(id TEXT PK, challenge_id TEXT, from_user_id TEXT, to_user_id TEXT, template_id TEXT, level INTEGER, title TEXT, body TEXT,
      created_at TEXT, UNIQUE(challenge_id, from_user_id, to_user_id))
pokes(id TEXT PK, challenge_id TEXT, from_user_id TEXT, to_user_id TEXT, created_at TEXT)
notifications(id TEXT PK, user_id TEXT, type TEXT, title TEXT, body TEXT, data TEXT (json), read_at TEXT, created_at TEXT, pushed_at TEXT, push_error TEXT)
badges(user_id TEXT, badge_key TEXT, earned_at TEXT, PRIMARY KEY(user_id, badge_key))
reports(id TEXT PK, reporter_id TEXT, reported_id TEXT, reason TEXT, created_at TEXT)
reminders_sent(user_id TEXT, day_key TEXT, PRIMARY KEY(user_id, day_key))
```

### 2.2 Endpoints (all JSON; errors `{ error: { code, message } }`, message in Turkish)

Auth: `Authorization: Bearer <jwt>`; 401 `unauthorized`. Validation errors → 400 `validation` with zod issues.
Several endpoints take no request body. A JSON content type with an empty payload is parsed as `{}`
rather than rejected, so a client that always sets `Content-Type: application/json` still works.

| Method & path | Notes |
|---|---|
| GET /health | `{ ok: true, version, time }` |
| POST /auth/register | 409 `username_taken`. Returns `{ token, me }` |
| POST /auth/login | 401 `bad_credentials` |
| GET /me | `Me` |
| PATCH /me | partial update |
| DELETE /me | soft delete: anonymize username → `deleted_<id8>`, clear push token, leave active challenges |
| POST /me/push-token | store |
| DELETE /me/push-token | clear (logout) |
| POST /me/steps | upsert steps_daily; for every active/pending `auto_steps` challenge the user has accepted and whose day range contains dayKey → upsert entry(source). Returns `{ updated: number }` |
| GET /me/inbox?before=<iso>&limit=30 | newest first |
| POST /me/inbox/read | `{ ids }` or `{ all: true }` |
| GET /me/inbox/unread | `{ count, latestId }` |
| GET /users/search?q= | prefix match on username or display_name, excludes self, blocked; max 20 |
| GET /users/:id | `PublicUser` + public stats (wins/losses/tauntsSent/tauntsReceived/badges) |
| POST /users/:id/block, /unblock, /report | block sets/creates friendship row status 'blocked' with requester = blocker; blocked users can't see or invite each other |
| GET /friends | `FriendsView` |
| POST /friends/request | by username or inviteCode; if the target already requested you → auto accept. 404 `user_not_found`, 409 `already_friends` |
| POST /friends/:friendshipId/accept, /decline | addressee only |
| DELETE /friends/:userId | remove friendship |
| GET /catalog | shared catalog dump |
| GET /challenges?status=active,pending,finished | mine (accepted or invited), `ChallengeSummary[]`, ordered: active by endsAt asc, pending by startsAt, finished by finalizedAt desc |
| POST /challenges | 201. Returns the bare `Challenge` — the wizard navigates straight to `/challenge/<id>`. Creator auto `accepted`; others `invited` + `challenge_invite` notification. If startsAt <= now → status `active` immediately |
| GET /challenges/:id | `ChallengeDetail`; participants only (404 otherwise) |
| POST /challenges/:id/accept, /decline, /leave | Returns the refreshed `ChallengeDetail`. Accept while status ∈ pending/active and now is before `endsAt − cutoff`, where `cutoff = min(1h, duration/4)` so a minimum-length challenge stays joinable; leave only while pending/active (marks `left`) |
| POST /challenges/:id/cancel | creator, only pending; notifies. Returns the refreshed `ChallengeDetail` |
| POST /challenges/:id/entries | see 2.3; returns `{ entry, standings }` |
| DELETE /challenges/:id/entries/:entryId | own manual entries only, while active |
| POST /challenges/:id/entries/:entryId/dispute | not own; one per user per entry; threshold rule → entry `rejected` + `entry_rejected` notification to owner; disputers get `disputesWon` |
| POST /challenges/:id/poke | active only; target must be participant; rate limit 1 per (from,to,challenge) per 2h → 429 `poke_cooldown`. Template from `poke` context clamped to target's level (or default pick). Notification type `poke` |
| POST /challenges/:id/taunt | finished only; sender must be winner (`winnerId`), target must be a loser (accepted, not winner); one per target (409 `already_taunted`); template clamped to target's `vulgarity_max` — if requested template level > target max, pick deterministic template same context at target max; `customBody` allowed (level = sender-chosen ≤ target max, checked by `containsBanned` → 400 `banned_content`). Notification type `taunt` with data `{ challengeId, tauntId }` |
| POST /challenges/:id/rematch | 201, returns the new bare `Challenge`. Finished only, any accepted participant; clones settings (same type, duration, reward), startsAt = now + 5 min, invites all previous accepted participants, `rematch_of_id`; notification `rematch` |
| GET /challenges/:id/results | `{ challenge, standings: ParticipantView[], taunts, tauntTemplatesForWinner?: TauntTemplate[] (rendered previews per loser) }` |
| GET /leaderboard | friends + me ranked by wins, then tauntsSent |
| POST /uploads | multipart field `file`; returns `{ url: PUBLIC_URL + '/uploads/<uuid>.<ext>' }` |
| GET /uploads/* | static |

### 2.3 Entry validation (`services/entries.ts`)

Common: user must be `accepted` participant; challenge `active`; `dayKey` must be in
`dayKeysBetween(startsAt, endsAt, user.tz)`; `dayKey <= todayKey(user.tz)`; `dayKey >= todayKey − 2 days`
(manual types) / `− 7 days` (steps); value ≤ `type.maxPerEntry`; proof required when
`challenge.proofRequired` and source is manual (400 `proof_required`).

Per type:
- `auto_steps`: source `manual` allowed (marks entry as beyan). Upsert by (challenge,user,day). Value ≤ maxPerDay.
- `focus_minutes`: source must be `focus`; `sessionId` required; duplicate sessionId → idempotent return of existing entry; value 1..180.
- `checkin_deadline`: source `checkin`; dayKey must equal user's local today; server computes `localTimeHHmm(now, tz)`; if ≤ deadlineTime → value 1 else value 0 and `late: true`. One per day (409 `already_checked_in`).
- `daily_boolean`: value 0 or 1; upsert per day.
- `manual_count`: append; daily sum must stay ≤ maxPerDay (400 `daily_cap`).
- `manual_lower_is_better`: upsert per day; value ≤ maxPerEntry.

After every write: recompute standings (in memory via shared `rankParticipants`) and return.

### 2.4 Lifecycle (scheduler, every 30 s; also callable directly for tests: `runSchedulerOnce(db, now)`)

1. `pending` with `starts_at <= now`: if accepted count ≥ 2 → `active` + `challenge_started` notification to accepted;
   else if `ends_at <= now` → `cancelled` (`challenge_cancelled`). (Single-participant challenges wait; others can still accept.)
2. `active` with `ends_at <= now` → finalize: accepted participants with `rankParticipants`; write final_score/rank,
   winner_id/is_tie, `finished`, `finalized_at`; notifications: winner → `challenge_finished` with data `{ role: 'winner' }`
   (title from copy `challenge_finished_won`), losers → `{ role: 'loser', winnerId }`, tie → `{ role: 'tie' }`.
   Award badges (stats recompute) for all participants.
3. Reminders: for each user with `reminder_hour` not null and an active challenge, when `localHour(now, tz) === reminder_hour`
   and no `reminders_sent` row for today → `reminder` notification with copy `notification_daily_reminder`.
4. Push queue: every notification row with `pushed_at IS NULL AND push_error IS NULL` for users with a token → Expo push
   (batched); mark `pushed_at` or `push_error`. Uses `Expo.isExpoPushToken`.

### 2.5 Tests (`apps/server/test/*.test.ts`, vitest, in-memory DB, `app.inject`)

Cover: register/login/duplicate; friends request/accept/auto-accept/block; create challenge (immediate + future start),
accept, entries per metric type incl. validation errors and caps, checkin late logic (inject `now` via `app.decorate('now')`
or an injectable clock in `buildApp({ clock })`), steps sync fan-out, scheduler activation/finalization/tie/underfilled
cancel, taunt: winner only / one per loser / level clamp / banned content, poke cooldown, dispute threshold, rematch,
inbox read/unread, account deletion, uploads (multipart), badges awarded.

### 2.6 Ops

`.env.example`, `Dockerfile` (node:22-alpine, `npm ci --workspaces`, `CMD npm start -w apps/server`), `docker-compose.yml`
(volume for data+uploads), `README` section on deploying (Railway/Fly/any VPS) and on LAN usage (`HOST=0.0.0.0`,
server URL `http://<LAN-IP>:4000` in the app).

---------------------------------------------------------------------------------------

## 3. Mobile app (`apps/mobile`)

Expo SDK 57, expo-router (file routes in `src/app`), TypeScript strict, React 19.2, React Compiler enabled.
Installed: expo-notifications, expo-sensors, expo-secure-store, expo-image-picker, expo-haptics, expo-task-manager,
expo-background-task, expo-build-properties, expo-clipboard, expo-linear-gradient, expo-application, expo-dev-client,
expo-localization, @react-native-async-storage/async-storage, @tanstack/react-query, zustand, zod, react-native-svg,
react-native-health-connect, @expo/vector-icons, react-native-reanimated, react-native-gesture-handler.

Web build MUST work (`npx expo export --platform web`) — it is our automated smoke-test target. Every native-only
module is isolated behind `src/services/*.native.ts` / `*.web.ts` pairs or `Platform.OS` guards.

### 3.1 App identity (`app.json`)

name `KOYDUM`, slug `koydum`, scheme `koydum`, `ios.bundleIdentifier` `com.koydum.app`, `android.package` `com.koydum.app`,
`userInterfaceStyle: 'dark'`, icons/splash generated in `assets/brand/` (dark background `#0B0B0F`, accent `#FF3D71`,
secondary `#FFD400`). Plugins: expo-router, expo-splash-screen, expo-notifications (icon, color, defaultChannel `koydum`),
expo-secure-store, expo-image-picker (camera + photos Turkish permission strings), expo-sensors (`motionPermission` Turkish),
expo-background-task, expo-localization, expo-build-properties (android minSdkVersion 26, compile/target 36),
react-native-health-connect. iOS `infoPlist.NSMotionUsageDescription` Turkish; Android permissions include
`ACTIVITY_RECOGNITION`, `android.permission.health.READ_STEPS`. `extra.eas.projectId` placeholder documented in README
(user runs `eas init`). `eas.json` with `development` (dev client, internal), `preview` (apk, internal), `production`.

### 3.2 State & services (`src/`)

```
lib/api.ts             ApiClient: baseUrl + token; request<T>(method, path, body?); typed helpers for every endpoint; ApiError { code, message, status }
lib/storage.ts         key-value: SecureStore on native, localStorage on web (token, serverUrl, level cache)
lib/query.ts           QueryClient + query keys
store/auth.ts          zustand: { token, me, serverUrl, hydrated, setToken, setMe, logout, setServerUrl }; hydrate on boot
store/ui.ts            vulgarity level used for UI copy (mirrors me.vulgarityMax), onboarding done flag
hooks/*.ts             useMe, useChallenges(status), useChallenge(id), useFriends, useInbox, useUnreadCount (30 s poll while foreground), mutations
services/steps.ts      getDailySteps(days: number): Promise<{ dayKey, steps, source }[]> + syncSteps(); platform files: steps.native.ts (ios Pedometer.getStepCountAsync per day; android: try Health Connect aggregate per day, else Pedometer.watchStepCount accumulate persisted per day in AsyncStorage), steps.web.ts (returns [])
services/notifications.ts  registerForPush() → token or null (never throws; web returns null); setNotificationHandler; Android channel; response listener → router.push to challenge/inbox
services/localNotify.ts  fireLocal(title, body, data) — used when a new inbox item arrives that was not pushed (device without push)
services/background.ts   BackgroundTask (15 min): sync steps + fetch unread inbox → fire local notifications for new items (skip on web / Expo Go gracefully)
services/focus.ts        focus session engine: start/stop, AppState listener → abandon when app leaves foreground > 10 s (grace), persists in-progress session to survive reload
theme/                   colors, spacing, typography (dark neon), components: Screen, Button, Card, Avatar, Chip, Stat, ProgressBar, Countdown, EmptyState, Toast, TauntBubble, Confetti (reanimated, optional), Sheet
utils/format.ts          formatNumber (tr-TR), formatDuration, relativeTime (tr), dayKey helpers (re-export shared/time)
```

### 3.3 Routes (`src/app`)

```
_layout.tsx                 providers (QueryClientProvider, GestureHandlerRootView, SafeAreaProvider), hydrate auth,
                            notifications setup, Stack with <Stack.Protected guard={!token}> (auth) and guard={!!token} (app)
(auth)/login.tsx            username/password, link to register, "Sunucu adresi" link
(auth)/register.tsx         + display name, vulgarity level picker (with live preview of a taunt at that level)
(auth)/server.tsx           edit server URL, "Bağlantıyı test et" → GET /health
onboarding.tsx              3 slides (copy onboarding_1..3), shown once after register
(app)/(tabs)/_layout.tsx    Tabs: index "Çelinçler", friends "Kankalar", inbox "Gelen Kutusu" (badge = unread), profile "Ben"
(app)/(tabs)/index.tsx      header: today's steps + sync button + level chip; sections: Davetler (accept/decline inline),
                            Aktif (cards: emoji, title, countdown, mini standings, my rank; losing → red "yiyorsun" chip),
                            Bekleyen, Biten (last 5); FAB "Çelinç Aç"
(app)/(tabs)/friends.tsx    list friends (tap → user/[id]), incoming/outgoing requests, search by username, my invite code (copy/share)
(app)/(tabs)/inbox.tsx      inbox list grouped by day; taunt items rendered as TauntBubble (big, red, shame); tap → challenge or friends; "Hepsini okundu yap"
(app)/(tabs)/profile.tsx    me: avatar emoji picker, stats grid (Koydum / Yedin / Berabere / Kankalar), badges, leaderboard preview, settings link, logout
(app)/challenge/new.tsx     4-step wizard: 1) tip seç (grouped by category, each shows emoji + name + desc at my level)
                            2) ayarlar (title, start now / tomorrow, duration days 1/3/7/14/30 or custom, deadline time for checkin, proof toggle, reward, penalty)
                            3) kankalar seç (multi-select friends) 4) özet + "KOY BAKALIM" create
(app)/challenge/[id].tsx    detail: hero (emoji, title, status/countdown, reward), standings (ranked bars with scores + "koyuyor/yiyor" labels),
                            my action area per metric type (see 3.4), feed of recent entries with dispute button, poke buttons per rival,
                            leave/cancel; finished → button to results
(app)/challenge/[id]/results.tsx   winner view: podium + "KOYDUM MU?" CTA per loser (or "Hepsine koy") → taunt picker; loser view: shame screen
                            (big TauntBubble if received, else "bekliyor..." ), rewards/penalty text, "Rövanş" button; tie view
(app)/challenge/[id]/taunt.tsx     picker: target chip(s), list of templates rendered with real names/scores (levels ≤ target max; higher ones shown locked with
                            "X bunu kaldıramaz" note), custom text field (banned-word check client side), preview, "GÖNDER" → success animation
(app)/challenge/[id]/entry.tsx     modal: log manual value (numeric pad, quick +1/+5 chips per unit), note, proof photo (camera/gallery → /uploads), day selector (today/yesterday)
(app)/focus/[id].tsx        full-screen timer (pick 15/25/45/60 min), big countdown, "elini telefondan çek" copy, leaving app → abandoned state with copy focus_abandoned; completion posts entry
(app)/user/[id].tsx         public profile + head-to-head record vs me + "Çelinç aç" shortcut
(app)/settings.tsx          vulgarity level (with preview), reminder hour, timezone (auto), server URL, push status + "yeniden dene", delete account (double confirm), about
```

### 3.4 Per-metric action area (challenge detail)

- auto_steps: "Bugün: 6.421 adım" + "Senkronla" (calls syncSteps → POST /me/steps → invalidate). Android w/o Health Connect:
  shows "Yaklaşık (uygulama açıkken sayılıyor)" + manual "Beyan et" entry.
- focus_minutes: "Odak seansı başlat" → focus/[id]; today's total.
- checkin_deadline: big "GELDİM" button visible only today; shows deadline; after tap → success or late copy.
- daily_boolean: two buttons "Yaptım ✅ / Yapmadım ❌" for today (and yesterday if missing).
- manual_count: "+ Giriş" → entry modal; quick-add chips.
- manual_lower_is_better: "Bugünkü değeri gir" → entry modal (proof photo emphasized).

### 3.5 Notifications & polling

- On login/boot: `registerForPush()`; if token → POST /me/push-token. Handler shows banner+list+sound.
- `useUnreadCount` polls every 30 s in foreground, plus refetch on AppState active. When `latestId` changes and the new
  items have `pushedAt == null` (server includes `pushed` flag) and app is in background → `fireLocal`. In foreground → in-app Toast.
- Tapping a notification response routes: taunt/challenge_* → `/challenge/[id]/results` or `/challenge/[id]`, friend_* → friends tab.

### 3.6 Tests

`jest-expo` unit tests for: `lib/api` (fetch mocked), `services/focus` (state machine), `utils/format`, one render test for
`TauntBubble`. Keep them fast; they must pass with `npx jest` in `apps/mobile`.

### 3.7 Visual language

Dark background `#0B0B0F`, surfaces `#16161D`, accent hot pink `#FF3D71`, secondary yellow `#FFD400`, success `#2EE59D`,
danger `#FF4D4D`, text `#F5F5F7`, muted `#9A9AA5`. Big bold headings (uppercase for CTAs: "KOY BAKALIM", "GELDİM",
"KOYDUM MU?"). Emoji-heavy. Haptics on key actions. Loading skeletons/spinners; every list has an EmptyState with level copy.

---------------------------------------------------------------------------------------

## 4. Verification pipeline (what "done" means)

1. `npm run typecheck` at root passes (shared, server) and `npx tsc --noEmit` in apps/mobile passes.
2. `npm test -w packages/shared`, `npm test -w apps/server` pass; `npx jest` in apps/mobile passes.
3. `npx expo export --platform web` and `npx expo export --platform ios --platform android` succeed in apps/mobile.
4. Playwright smoke: serve the web export, run the server on :4000, register two users, add friends, create a challenge
   starting now, log entries, force finalize via test-only endpoint `POST /dev/finalize/:id` (enabled only when
   `ENABLE_DEV_ROUTES=1`), send a taunt, assert it appears in the loser's inbox. Screenshots saved to `docs/screens/`.
5. README (Turkish) explains: server run, LAN URL, Expo Go run, dev build with EAS for push + Health Connect, deploy.
