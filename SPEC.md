# KOYDUM — Technical Specification (single source of truth)

KOYDUM is a friends-only challenge ("çelınc") app for iOS + Android. Friends compete on
measurable habits (steps, focus time, early wake-ups, water, no-smoking days, ...). The
winner earns the right to "KOYDUM MU?" — a vulgar-comedy taunt delivered as a push
notification + in-app inbox item to every loser. All UI copy is Turkish; the tone is
crude banter between friends, scaled by a per-user vulgarity level — "adamlık
seviyesi" in the UI (1 nazik, 2 delikanlı,
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
export type EntrySource = 'pedometer' | 'health_connect' | 'manual' | 'focus' | 'checkin' | 'usage_stats';
export type DeviceMetric = 'steps' | 'screen_time'; // ChallengeType.deviceMetric: which phone reading fills the type in
export type EntryStatus = 'ok' | 'disputed' | 'rejected';
export type FriendshipStatus = 'pending' | 'accepted' | 'blocked';
export type NotificationType =
  | 'friend_request' | 'friend_accepted' | 'challenge_invite' | 'challenge_started'
  | 'challenge_cancelled' | 'challenge_finished' | 'taunt' | 'poke' | 'dispute'
  | 'entry_rejected' | 'reminder' | 'badge' | 'rematch' | 'nudge' | 'recap'
  | 'challenge_declined' | 'challenge_left';
// data of a 'recap' notification (the inbox draws it as a card):
export interface RecapData {
  weekStart: string; weekEnd: string; // Monday..Sunday, reader's local day keys
  wins: number; losses: number; ties: number; steps: number; active: number;
  highlights: string[]; // "👑 Haftanın kralı ...", already at the reader's level
}
export type TauntContext = 'win' | 'win_big' | 'win_close' | 'tie' | 'poke' | 'streak' | 'revenge';
```

### 1.2 ChallengeType (catalog)

```ts
export interface ChallengeType {
  key: string; nameTr: string; emoji: string; metricType: MetricType; unitTr: string;
  direction: Direction; descriptionTr: string; descriptionPoliteTr: string; howMeasuredTr: string;
  defaultDurationDays: number; defaultDeadlineTime?: string; // "HH:mm"
  suggestedRewardTr: string; antiCheatTr: string; proofRequired: boolean;
  deviceMetric?: DeviceMetric;   // 'steps' (adim_yarisi) | 'screen_time' (ekran_suresi_beyani): the phone fills it in where it can
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
  upheld — a majority disputed it and its owner added no photo within `LIMITS.DISPUTE_ANSWER_MS` (12 h, 2.4) —
  at which point the entry becomes `rejected` and stops counting.
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
(`revengeWins` = finished challenges won that were a rematch of an earlier one; the `rovans_*` ladder needs it).
Badges are LADDERS, not a flat wall: each `BadgeDef` carries a `family` and a 1-based `tier`,
and `badgeLadder(stats)` returns every earned rung plus exactly one locked rung per family —
the rungs above that stay hidden until they are reached.
Rule grammar: `<statKey><op><number>` with op in `>=`, `>`, `==`, `<=`; multiple rules joined by `&&`.

### 1.6 Zod schemas (`schemas.ts`) — the API contract

```ts
RegisterBody { username: /^[a-z0-9_]{3,20}$/ (lowercased), password: min 6 max 72, displayName: 1..30, timezone: string (default 'Europe/Istanbul') }
LoginBody { username, password }
ChangePasswordBody { currentPassword: 1..72 (login rule), newPassword: min 6 max 72 (sign-up rule) }
UpdateMeBody { displayName?, avatarEmoji? (1..4 chars), vulgarityMax? (1|2|3), timezone?, reminderHour? (0..23 | null), nudgesEnabled? (boolean), recapEnabled? (boolean) }
PushTokenBody { token: string, platform: 'ios'|'android'|'web' }
StepsSyncBody { days: { dayKey, steps: int 0..100000, source: 'pedometer'|'health_connect' }[] (max 14) }
ScreenTimeSyncBody { days: { dayKey, minutes: int 0..1440 }[] (max 14) }   // Android usage access; entries get source 'usage_stats'
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
EntryProofBody { proofUrl: string } (same rules as EntryBody.proofUrl: http(s) address or a server path, max 500)
PokeBody { toUserId: string; templateId?: string }
TauntBody { toUserId: string; templateId?: string; customBody?: string (max 140) } (one of)
ReportBody { reason: string 1..300 }
InboxReadBody { ids?: string[]; all?: boolean }
```

### 1.7 API response types (`types.ts`)

```ts
PublicUser { id, username, displayName, avatarEmoji, createdAt }
Me extends PublicUser { vulgarityMax, timezone, reminderHour, nudgesEnabled, recapEnabled, inviteCode, hasPushToken, stats: UserStats, badges: string[] }
UserStats { wins, losses, ties, tauntsSent, tauntsReceived, stepsSingleDayMax, focusTotalMinutes, checkinsStreakMax, disputesWon, challengesPlayed, pokesSent, revengeWins, stepsToday }
Challenge { id, creatorId, typeKey, metricType, direction, unit, title, startsAt, endsAt, status, rewardText, penaltyText, deadlineTime, dailyTarget, proofRequired, createdAt, finalizedAt, winnerId, isTie, rematchOfId }
ParticipantView { user: PublicUser, status, score, days, rank, lastEntryAt, isWinner }
ChallengeSummary { challenge: Challenge, participants: ParticipantView[], me: ParticipantView | null, unreadTaunts: number }
ChallengeDetail extends ChallengeSummary { myEntries: Entry[], feed: FeedItem[], disputes: Dispute[], taunts: Taunt[], canTaunt: { toUserId: string; done: boolean }[], canPoke: boolean, pokeTargets: { toUserId: string; done: boolean }[] }
  -- pokeTargets: while a çelınc runs, talking is earned. Only whoever is AHEAD gets entries,
     and only for the rivals they are strictly ahead of (a tie earns nothing). `done` = still
     inside the 2h cooldown, so canPoke = pokeTargets.some(t => !t.done).
Entry { id, challengeId, userId, dayKey, value, source, note, proofUrl, status, createdAt, late?: boolean }
FeedItem { id, userId, displayName, dayKey, value, source, status, createdAt, proofUrl, answerBy?: string | null }
  -- feed: the 40 most recent entries plus every `disputed` one, however old (it is where the owner answers).
     answerBy: set while a majority disputes the entry — the instant it is thrown out unless its owner adds a photo.
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
src/index.ts            boot: loadDotEnv() + buildApp() + listen(PORT, HOST 0.0.0.0) + start scheduler (after listen);
                        clean shutdown (see 2.6)
src/env.ts              loadDotEnv(): apps/server/.env into process.env, never over a variable already set; entry
                        points only (index.ts, cli/yonet.ts; scripts/env.mjs for the .mjs scripts), not loadConfig
src/app.ts              buildApp(opts): registers plugins, routes, error handler; exported for tests
src/config.ts           env: PORT=4000, HOST=0.0.0.0, DATA_DIR=./data, UPLOAD_DIR=<DATA_DIR>/uploads (so one
                        volume holds the database and the photos), JWT_SECRET (auto-generated & persisted to
                        DATA_DIR/secret if missing), PUBLIC_URL, LOG_LEVEL
src/db/index.ts         openDb(path|':memory:'), migrations, helpers (nowIso, newId = crypto.randomUUID)
src/db/migrations.ts    SQL strings
src/auth/jwt.ts         sign/verify HS256 with node:crypto (header.payload.sig, exp 90d, extended by POST /auth/refresh)
src/auth/password.ts    scrypt hash/verify (salt:hash hex)
src/plugins/auth.ts     fastify decorator `authenticate` preHandler → request.user = {id}
src/routes/auth.ts      /auth/register, /auth/login, /auth/refresh
src/routes/me.ts        /me, PATCH /me, DELETE /me, POST /me/password, /me/push-token, /me/steps, /me/screen-time, /me/inbox*
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
src/services/scheduler.ts   setInterval 30s: activate due, finalize ended, cancel underfilled, reminders; the stop
                            function awaits a pass in flight (≤ 10 s) so a push flush marks its rows first
src/services/taunts.ts      sendTaunt() with clamp + one-per-loser rule; sendPoke() rate limit
src/services/admin.ts       owner tools: listUsers(), listReports(), resetPassword() (8-char readable temp password)
src/cli/yonet.ts            `npm run yonet -- kullanicilar | sikayetler | sifre <kullanici>` on the server's own DB file
```

### 2.1 Tables (SQLite, WAL mode, foreign keys ON)

```sql
users(id TEXT PK, username TEXT UNIQUE, display_name TEXT, password_hash TEXT, avatar_emoji TEXT DEFAULT '🍆',
      vulgarity_max INTEGER DEFAULT 2, timezone TEXT DEFAULT 'Europe/Istanbul', invite_code TEXT UNIQUE,
      push_token TEXT, push_platform TEXT, reminder_hour INTEGER DEFAULT 20, created_at TEXT, last_seen_at TEXT, deleted_at TEXT,
      nudges_enabled INTEGER DEFAULT 1, recap_enabled INTEGER DEFAULT 1)
  -- the two notifications the reader can switch off (Ayarlar → Bildirim tercihleri); taunts, pokes, invites and results have no switch
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
screen_time_daily(user_id TEXT, day_key TEXT, minutes INTEGER, updated_at TEXT, PRIMARY KEY(user_id, day_key))
disputes(id TEXT PK, entry_id TEXT, by_user_id TEXT, reason TEXT, status TEXT, created_at TEXT, UNIQUE(entry_id, by_user_id))
taunts(id TEXT PK, challenge_id TEXT, from_user_id TEXT, to_user_id TEXT, template_id TEXT, level INTEGER, title TEXT, body TEXT,
      created_at TEXT, UNIQUE(challenge_id, from_user_id, to_user_id))
pokes(id TEXT PK, challenge_id TEXT, from_user_id TEXT, to_user_id TEXT, created_at TEXT)
notifications(id TEXT PK, user_id TEXT, type TEXT, title TEXT, body TEXT, data TEXT (json), read_at TEXT, created_at TEXT, pushed_at TEXT, push_error TEXT)
badges(user_id TEXT, badge_key TEXT, earned_at TEXT, PRIMARY KEY(user_id, badge_key))
nudges_sent(challenge_id TEXT, user_id TEXT, day_key TEXT, PRIMARY KEY(challenge_id, user_id, day_key))
  -- the primary key IS the rate limit for the mid-day nudge: one per çelınc per person per local day
reports(id TEXT PK, reporter_id TEXT, reported_id TEXT, reason TEXT, created_at TEXT)
reminders_sent(user_id TEXT, day_key TEXT, PRIMARY KEY(user_id, day_key))
recaps_sent(user_id TEXT, week_key TEXT, sent_at TEXT, PRIMARY KEY(user_id, week_key))
  -- one weekly recap per person; week_key = the local Sunday ending the week, sent_at = where the next window starts
taunt_followups(challenge_id TEXT, stage INTEGER, created_at TEXT, PRIMARY KEY(challenge_id, stage))
  -- the claim for the winner's "hâlâ bekliyor" reminder (2.4); stage 1 is the only one
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
| POST /auth/refresh | authenticated, no body. Returns `{ token }` with a fresh 90 days. An expired token gets the usual 401: renewal keeps a live session alive, it never revives a dead one. The app calls it about once a week |
| GET /me | `Me` |
| PATCH /me | partial update |
| DELETE /me | soft delete: anonymize username → `deleted_<id8>`, clear push token, leave active challenges (each one then goes through the abandoned check of 2.4, without a `challenge_left`) |
| POST /me/password | `ChangePasswordBody`. Wrong current password → **400** `wrong_password` (never 401: the app logs out on any 401), new equal to current (after NFKC) → 400 `same_password`, 8 wrong ones per account in 15 min (login's per-account budget) → 429 `too_many_attempts`. Returns `{ token, me }` like login. Tokens are stateless JWTs and nothing is revoked: other phones already signed in stay signed in |
| POST /me/push-token | store |
| DELETE /me/push-token | clear (logout) |
| POST /me/steps | upsert steps_daily; for every active/pending challenge with `deviceMetric: 'steps'` the user has accepted and whose day range contains dayKey → upsert entry(source). Returns `{ updated: number }` (`services/deviceSync.ts`) |
| POST /me/screen-time | upsert screen_time_daily; same fan-out for `deviceMetric: 'screen_time'` types, entries written with source `usage_stats` (7-day device backfill window, capped at maxPerDay). A device reading overwrites a typed value for that day. Returns `{ updated: number }` |
| GET /me/inbox?before=<iso>&limit=30 | newest first |
| POST /me/inbox/read | `{ ids }` or `{ all: true }` |
| (scheduler) reminders | daily reminder only to users with no non-rejected entry today in any active challenge; nudges only to `accepted` participants with `nudges_enabled` (checked before the `nudges_sent` claim, so switching it back on the same day still gets that day's nudge) |
| (scheduler) recaps | weekly `recap` to users with `recap_enabled` (switched off → no row, no `recaps_sent` claim) from Sunday 20:00 until Monday 12:00 in the reader's timezone, once per week (`recaps_sent`): wins/losses/ties of çelınclar finalized since the previous recap (that recap's `sent_at` when it is ≤ 9 days back — covers a Monday make-up and a DST night — otherwise the last 7 days), Monday–Sunday steps, the king of the week among the reader and their friends (most wins, then steps; exact ties share) and the clear step leader. A Monday make-up says "geçen hafta" / "bu hafta rövanş". Nothing to tell → no row |
| GET /me/inbox/unread | `{ count, latestId }` |
| GET /users/search?q= | prefix match on username or display_name, excludes self, blocked; max 20 |
| GET /users/blocked | `PublicUser[]`: the people I blocked, newest block first (Ayarlar → Engellediklerin). Only blocks I placed, never the ones placed on me; deleted accounts left out |
| GET /users/:id | `PublicUser` + public stats (wins/losses/challengesPlayed) + badges |
| POST /users/:id/block, /unblock, /report | block sets/creates friendship row status 'blocked' with requester = blocker; blocked users can't see or invite each other. unblock lifts only my own block (`{ status: 'none', userId, removed }`, idempotent) and does not bring a friendship back. report stores a `reports` row and logs a `warn` line (`YENİ ŞİKAYET`) for the owner; nothing in the app reads reports |
| GET /friends | `FriendsView` |
| POST /friends/request | by username or inviteCode; if the target already requested you → auto accept. 404 `user_not_found`, 409 `already_friends` |
| POST /friends/:friendshipId/accept, /decline | addressee only |
| DELETE /friends/:userId | remove an accepted friendship (`{ status: 'removed', userId }`), or withdraw my own unanswered request (`{ status: 'withdrawn', userId }`): the row goes, and so does the addressee's unread `friend_request` notification for it (a read one stays as history). A request sent to me → 404 `friendship_not_found`; that one is answered with /decline. `?only=request` (the app's "Geri çek") only ever withdraws: a friendship accepted while the confirm was open → 409 `already_friends` and stays, nothing of mine pending → 404 `friendship_not_found` |
| GET /catalog | shared catalog dump |
| GET /challenges?status=active,pending,finished | mine (accepted or invited), `ChallengeSummary[]`, ordered: active by endsAt asc, pending by startsAt, finished by finalizedAt desc |
| POST /challenges | 201. Returns the bare `Challenge` — the wizard navigates straight to `/challenge/<id>`. Creator auto `accepted`; others `invited` + `challenge_invite` notification. If startsAt <= now → status `active` immediately |
| GET /challenges/:id | `ChallengeDetail`; participants only (404 otherwise) |
| POST /challenges/:id/accept, /decline, /leave | Returns the refreshed `ChallengeDetail`. Accept while status ∈ pending/active and now is before `endsAt − cutoff`, where `cutoff = min(1h, duration/4)` so a minimum-length challenge stays joinable; leave only while pending/active (marks `left`); an accepted player cannot leave an `active` çelınc past `endsAt` (400 `challenge_ended`): it is only waiting (2.4), and head to head leaving would cancel a result already seen. A declined invite may still accept (same window): that is the app's way back from an accidental "Reddet". Before `endsAt`, a decline notifies the creator (`challenge_declined`, data `{ challengeId, fromUserId }`, "Ali tırstı, reddetti") and a leave every other accepted player (`challenge_left`, same data, "Ali havlu attı"); an invitee's leave counts as a decline. Each at the reader's level, only while they are still `accepted`, never across a block (either direction). Then the abandoned check of 2.4 runs, all in one transaction. Past `endsAt` both only change the row |
| POST /challenges/:id/cancel | creator, only pending; notifies. Returns the refreshed `ChallengeDetail` |
| POST /challenges/:id/entries | see 2.3; returns `{ entry, standings }` |
| DELETE /challenges/:id/entries/:entryId | own manual entries only, while active |
| POST /challenges/:id/entries/:entryId/dispute | 201 `{ dispute, entry, answerBy, standings }`. Not own (403 `own_entry`); one per user per entry, whatever became of it (409 `already_disputed`); a `rejected` entry → 409 `already_rejected`. The entry becomes `disputed` and keeps counting. Threshold = a majority of the OTHER accepted players, `max(1, ceil((accepted − 1) / 2))`. Once the open disputes reach it, the owner has `LIMITS.DISPUTE_ANSWER_MS` (12 h) from the dispute that made the majority to add a photo; `answerBy` says until when (null below the threshold). Notification `dispute` to the owner (data `{ challengeId, entryId, disputeId, answerBy }`); the one that makes the majority says "12 saat içinde fotoğraf ekle, yoksa bu giriş yanar" at the owner's level. Upholding happens in the scheduler (2.4) |
| DELETE /challenges/:id/entries/:entryId/dispute | the caller takes back their own OPEN dispute (404 `dispute_not_found` otherwise): it becomes `dismissed`, and the entry goes back to `ok` when no open dispute is left. Active only (the settle wait included). Returns `{ dispute, entry, standings }`. A withdrawn dispute cannot be filed again |
| POST /challenges/:id/entries/:entryId/proof | `EntryProofBody`. Entry owner only (403 `not_your_entry`), entry `disputed` (409 `not_disputed`, 409 `already_rejected`), çelınc `active` (the settle wait included, 400 `challenge_not_active`). Sets `proof_url`, marks every open dispute `dismissed`, entry back to `ok`; each disputer (not deleted, not blocked) gets a `dispute` notification with data `{ challengeId, entryId, kind: 'proof' }` ("{ad} kanıt ekledi, bir bak."). Returns `{ entry, standings }` |
| POST /challenges/:id/poke | active only; target must be a participant the sender is strictly AHEAD of, else 403 `not_ahead`; rate limit 1 per (from,to,challenge) per 2h → 429 `poke_cooldown`. Template from `poke` context clamped to target's level (or default pick). Notification type `poke` |
| POST /challenges/:id/taunt | finished only; sender must be winner (`winnerId`), target must be a loser (accepted, not winner); one per target (409 `already_taunted`); template clamped to target's `vulgarity_max` — if requested template level > target max, pick deterministic template same context at target max; `customBody` allowed (level = sender-chosen ≤ target max, checked by `containsBanned` → 400 `banned_content`). Notification type `taunt` with data `{ challengeId, tauntId }` |
| POST /challenges/:id/rematch | 201, returns the new bare `Challenge`. Finished only, any accepted participant; clones settings (same type, duration, reward), startsAt = now + 5 min, invites the previous accepted participants who are still friends (no block either way, not deleted; nobody left → 400 `no_participants`), `rematch_of_id`; notification `rematch` |
| GET /challenges/:id/results | `{ challenge, standings: ParticipantView[], taunts, tauntTemplatesForWinner?: TauntTemplate[] (rendered previews per loser), tauntContexts?: Record<userId, TauntContext> (winner only: each accepted loser's context, 2.3), rematchLeftOut?: string[] (accepted players of a finished çelınc: the others a rematch opened by the reader would skip for not being friends; deleted accounts and blocks are skipped too but never listed) }` |
| GET /leaderboard | friends + me ranked by wins, then tauntsSent |
| POST /uploads | multipart field `file`; returns `{ url: PUBLIC_URL + '/uploads/<uuid>.<ext>' }` |
| GET /uploads/* | static; `POST /uploads` answers a path (`/uploads/<uuid>.jpg`) that each phone resolves against its own server address |
| GET /davet/:code | public HTML invite page (no auth): inviter's display name + emoji, OpenGraph tags, "KOYDUM'da aç" (Android: `intent://davet/CODE?server=<origin>#Intent;scheme=koydum;package=com.koydum.app;S.browser_fallback_url=<origin>/indir?kod=CODE;end`, others: `koydum://davet/CODE?server=<origin>`), APK download when published; 404 page for unknown codes. `<origin>` is PUBLIC_URL when set, else built from the request's Host (+ X-Forwarded-Proto). Strict CSP, no scripts. Rate-limited with /invites (120 per IP per 10 min) |
| GET /indir?kod= | same page without an inviter |
| GET /invites/:code | public JSON `{ code, inviter: { username, displayName, avatarEmoji } }`, 404 `invite_not_found`; rate-limited (429 `too_many_lookups`) |
| GET /koydum.apk | the build published with `npm run apk:yayinla` (`<APP_DIR>/koydum.apk` + `latest.json`), `application/vnd.android.package-archive`; 404 `apk_not_found` |
| GET /health | also `app: { latestVersion, downloadUrl, notes } \| null` — the app shows "Yeni sürüm var" when latestVersion > its native version — and `publicUrl: string \| null` (PUBLIC_URL when set and not loopback; `npm run internet` sets it to the Cloudflare quick-tunnel address). The friends tab builds invite links from `publicUrl ?? serverUrl`. And `serverId`: the first 16 hex chars of HMAC-SHA256(jwtSecret, 'koydum-server-id'), computed once per start. It stays the same across restarts and addresses and changes exactly when old tokens stop working (a new secret); it reveals nothing about the secret. The app uses it to tell "same server, new tunnel address" from "another server" (services/serverMove.ts). |
| POST /uploads | one image per request (jpg/png/webp, ≤ 5 MB); at most 60 per account per hour (429 `upload_limit`) |

### 2.3 Entry validation (`services/entries.ts`)

Common: user must be `accepted` participant; challenge `active`; from `endsAt` on only device sources
(`pedometer`, `health_connect`, `usage_stats`) are taken — a typed entry answers 400 `challenge_ended` while a
phone-counted çelınc waits for the last syncs (2.4); `dayKey` must be in
`dayKeysBetween(startsAt, endsAt, user.tz)`; `dayKey <= todayKey(user.tz)`; `dayKey >= todayKey − 2 days`
(manual types) / `− 7 days` (steps); value ≤ `type.maxPerEntry`; proof required when
`challenge.proofRequired` and source is manual (400 `proof_required`) — and only for metrics where a photo can back a typed number (`manual_count`, `manual_lower_is_better`, `auto_steps`); a `daily_boolean` mark or a `checkin` has no photo step and ignores the flag. Device sources (`pedometer`, `health_connect`, `usage_stats`) never need proof; `usage_stats` gets the 7-day device backfill window.

Per type:
- `auto_steps`: source `manual` allowed (marks entry as beyan). Upsert by (challenge,user,day). Value ≤ maxPerDay.
- `focus_minutes`: source must be `focus`; `sessionId` (a real v4 UUID — `z.uuid()`; the app generates it with `utils/ids.ts`, Hermes has no `crypto.randomUUID`) required; duplicate sessionId → idempotent return of existing entry; value 1..180.
- `checkin_deadline`: source `checkin`; dayKey must equal user's local today; server computes `localTimeHHmm(now, tz)`; before `type.checkinWindowStart` → 400 `checkin_too_early` (a "yattım" at 02:00 is not an early night); if ≤ deadlineTime → value 1 else value 0 and `late: true`. One per day (409 `already_checked_in`).
- `daily_boolean`: value 0 or 1; upsert per day.
- `manual_count`: append; daily sum must stay ≤ maxPerDay (400 `daily_cap`). Optional `sessionId` (UUID) is stored and makes the write idempotent — the app sends a fresh one per tap so a timed-out request replayed from the offline queue cannot count twice. Upsert metrics ignore the field.
- `manual_lower_is_better`: upsert per day; value ≤ maxPerEntry. Sources `manual` and `usage_stats`; once the day's row has a device source, a `manual` write is refused (409 `device_locked`) — the phone may keep correcting itself. Scored as the DAILY AVERAGE over the participant's own window (sum + missing days × penalty) / window days; while the çelınc is active the window is clipped to today, so day 2 of 7 shows two days' average, not five days of penalty.
- Device fan-out (`POST /me/steps`) never lowers a typed `manual` value on a higher-is-better metric: the Android foreground counter is partial by design and the user was told to declare the real number; a device value ≥ the typed one replaces it (source becomes the device's).
- Disputes: only while the challenge is `active` (400 `challenge_not_active`) and, past `endsAt`, only inside a phone-counted çelınc's settle hour (`endsAt + LIMITS.DEVICE_SETTLE_MS`, where the last evening lands; 400 `challenge_ended` otherwise — a new dispute during a wait would hold the result another 12 h, and a chain of them for days), and never across a block (403 `blocked`). Phone-counted entries may be disputed too. A dispute never rejects anything by itself: a majority starts the owner's 12-hour answer window (2.2), and only an unanswered one is upheld (2.4). Accepting an invite from someone who blocked you or whom you blocked → 403 `blocked`.
- Taunt context `revenge` only when the çelınc is a rematch AND the taunting winner lost the original; otherwise `streak` when the winner has won this çelınc and the two before it that both played (accepted, finished, newest first counting back from this one; a tie, a loss or a third player's win breaks the run), otherwise the margin. Templates carry an optional `metrics` list and are filtered by the challenge's metric (a "kalk yürü" line stays on step çelınclar).

After every write: recompute standings (in memory via shared `rankParticipants`) and return.

### 2.4 Lifecycle (scheduler, every 30 s; also callable directly for tests: `runSchedulerOnce(db, now, { bootAt? })`)

1. `pending` with `starts_at <= now`: if accepted count ≥ 2 → `active` + `challenge_started` notification to accepted;
   else if `ends_at <= now` → `cancelled` (`challenge_cancelled`). (Single-participant challenges wait; others can still accept.)
   Not a scheduler step but the same rule sooner: after a decline, a leave or an account deletion, a `pending`/`active`
   çelınc before its `ends_at` with fewer than two participants `accepted` or still `invited` is cancelled on the spot
   (`cancelIfAbandoned`: `finalized_at = now`, `challenge_cancelled` with data `{ challengeId, reason: 'everyone_left' }`
   to whoever is left, "herkes kaçtı" rather than "kimse kabul etmedi"). Past `ends_at` it is left to the scheduler.
1b. Disputes (`resolveDisputes`, before finalize): in every `active` çelınc, a `disputed` entry of an accepted player
   whose open disputes reached the threshold (2.2) and whose answer window ran out — `now >=` the created_at of the
   threshold-th oldest open dispute `+ LIMITS.DISPUTE_ANSWER_MS` — is upheld: open disputes → `upheld`, entry →
   `rejected`, `entry_rejected` to the owner (not when deleted), badges recomputed for the disputers (`disputesWon`).
   The window runs from the moment the majority was reached, so a second dispute ten hours after the first still
   gives the owner the full 12 hours. Below the threshold nothing is ever upheld.
2. `active` with `ends_at <= now` → finalize. A type with a `deviceMetric` (steps, screen time) first **settles**: the
   phone's last evening usually arrives with the next background sync (15+ minutes, longer under Doze), so it
   stays `active` until `now >= max(ends_at, bootAt) + LIMITS.DEVICE_SETTLE_MS` (1 h), or earlier once every
   accepted participant's `steps_daily` / `screen_time_daily` row for their own last window day
   (`challengeWindow(c, participantTimezone(p, u)).at(-1)`) has `updated_at > ends_at`. `bootAt` is when
   `startScheduler` started, so a server that was off at the end gives the phones the full hour after boot. While
   settling, device syncs still fan out into the last day and typed entries get `challenge_ended` (2.3); the
   app shows "Sonuç birazdan" instead of the countdown, hides the entry buttons and sends its own count once.
   Every other type finalizes right at `ends_at` — unless, whatever the type, one of its entries is inside a
   dispute answer window (1b): the owner was promised those hours even when the dispute came a minute before the
   end, so it stays `active` (the same wait) until a photo (2.2) or the window running out; the app says it is
   waiting for proof. Finalize: accepted participants with `rankParticipants`; write final_score/rank,
   winner_id/is_tie, `finished`, `finalized_at`; notifications: winner → `challenge_finished` with data
   `{ role: 'winner' }`, losers → `{ role: 'loser', winnerId }`, tie → `{ role: 'tie' }`. The TITLE is a short
   lock-screen phrase per level ("Kazandın 🏆" / "KOYDUN! 👑" / "KOYDUN! 👑🍆", and "Bu tur bitti" / "Yedin lan" /
   "YEDİN 🍆"); the `challenge_finished_won` / `_lost` sentence opens the BODY, because a phone truncates a long
   title to nothing useful. Award badges (stats recompute) for all participants.
3. Reminders: for each user with `reminder_hour` not null and an active challenge whose `ends_at` is still ahead (a settling one has nothing left to type), when `localHour(now, tz) === reminder_hour`
   and no `reminders_sent` row for today → `reminder` notification with copy `notification_daily_reminder`.
3b. Taunt follow-up (`sendTauntFollowups`): a `finished` çelınc with a winner (not a tie), finalized between 48 h and
   2 h ago, where some accepted, non-deleted loser who is not blocked with the winner (either way) has no `taunts` row
   from the winner → one `reminder` to the winner, data `{ challengeId, kind: 'taunt_followup' }`, at the winner's
   level, naming only the losers still waiting ("Veli hâlâ bekliyor" / "Koymayacak mısın? Veli ağzını açmanı
   bekliyor." / "KOYMADIN DAHA 🍆"; several → "Veli ve Ayşe …"). Only while the winner's local hour (profile
   timezone) is within the nudge window, 12:00–22:00, and checked before the `taunt_followups (challenge_id, 1)`
   claim, so a midnight finish is reminded at noon instead of losing its slot. Once per çelınc; nothing is ever sent
   in the winner's name.
4. Push queue: every notification row with `pushed_at IS NULL AND push_error IS NULL` for users with a token → Expo push
   (batched); mark `pushed_at` or `push_error`. Uses `Expo.isExpoPushToken`.

### 2.5 Tests (`apps/server/test/*.test.ts`, vitest, in-memory DB, `app.inject`)

Cover: register/login/duplicate; friends request/accept/auto-accept/block; create challenge (immediate + future start),
accept, entries per metric type incl. validation errors and caps, checkin late logic (inject `now` via `app.decorate('now')`
or an injectable clock in `buildApp({ clock })`), steps sync fan-out, scheduler activation/finalization/tie/underfilled
cancel, taunt: winner only / one per loser / level clamp / banned content, poke cooldown, dispute threshold, rematch,
inbox read/unread, account deletion, uploads (multipart), badges awarded.

### 2.6 Ops

Daily backup (`services/backup.ts`, run from the scheduler tick): `db.backup()` into `<DATA_DIR>/backups/koydum-YYYY-MM-DD.db` (Istanbul date) once per day, written aside and renamed, last 7 kept; skipped for `:memory:`.

Owner CLI (`npm run yonet`, root script → workspace script, so the cwd is `apps/server` and the default `./data` is the server's database): `kullanicilar` (username, name, created, last seen in Istanbul time, accepted active çelınclar, deleted last), `sikayetler` (reporter, reported, reason, newest first), `sifre <kullanici>` (new random password from `abcdefghjkmnpqrstuvwxyz23456789`, stored as scrypt, printed once; unknown or deleted → Turkish error, exit 1). No argument → Turkish help (exit 0); unknown command → help on stderr, exit 1. Refuses when the DB file does not exist rather than creating one, and never writes a JWT secret. Safe beside a running server (WAL + busy_timeout). There is no email and no reset endpoint: a forgotten password is reset by the owner; existing tokens stay valid. A signed-in user changes their own (including the temporary one) in Ayarlar → Hesap → "Şifreni değiştir" (`POST /me/password`).

Shutdown (`src/index.ts`): SIGINT, SIGTERM, SIGHUP (a closed console window, Windows too), SIGBREAK on Windows, an
IPC message `{ type: 'shutdown' }` and a lost IPC channel all run the same path: await the scheduler stop, `app.close()`,
`db.close()`, exit 0 (forced after 12 s). An unhandled rejection or uncaught exception is logged as fatal and takes the
same path with exit code 1. A busy port (EADDRINUSE) prints one Turkish line (`src/listenError.ts`) and exits 1 without
a stack; the scheduler starts only after `listen` succeeds.

Logging: no per-request lines (`LogController({ disableRequestLogging: true })`); an `onResponse` hook writes one `warn`
for a status ≥ 500 or a response slower than 2 s: method, path without the query string, status, ms.

`npm run internet` (`scripts/internet.mjs`) supervises: the server runs as `node --import tsx src/index.ts` (one process,
IPC channel). Stop = IPC shutdown, SIGKILL after 15 s. A server exit that was not asked for is restarted with the same
PUBLIC_URL after 1 / 5 / 15 s; the 5th crash within 10 min ends the script with exit code 1. A cloudflared that exits
after printing its address leaves the server running (LAN and scheduler still work) and is restarted with a 5 s → 60 s
backoff, forever; a new address restarts the server with it and prints the banner again. `.env` is read first
(`scripts/env.mjs`), so PORT from the file reaches the tunnel too.

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
lib/api.ts             ApiClient: baseUrl + token; request<T>(method, path, body?); typed helpers for every endpoint; ApiError { code, message, status }; any 401 calls onUnauthorized
lib/storage.ts         key-value: SecureStore on native, localStorage on web (token, serverUrl, level cache, tokenRenewedAt, serverId)
lib/query.ts           QueryClient + query keys
store/auth.ts          zustand: { token, me, serverUrl, serverId, hydrated, sessionEnded, setSession, setMe, logout, setServerUrl, rememberServerId }; hydrate on boot, then (once /me answered) renewTokenIfDue. A 401 from the store's client sets `sessionEnded` (only when there was a token) before logging out; setSession stamps tokenRenewedAt, logout removes it. serverId is /health's id of the server the session lives on: learned right after setSession (fire-and-forget /health) and from every useServerInfo fetch, kept only while signed in and only for the address still in use (rememberServerId(id, forUrl)); logout removes it
services/serverMove.ts moveSession(url) → 'moved' | 'different' | 'unreachable': the same server at a new address keeps the session. /health on a bare client (8 s; no answer, or a page that is not JSON such as a Wi-Fi login, → 'unreachable'); a stored serverId the server does not repeat → 'different' without the token ever being sent; else a bare /me with the token (no onUnauthorized): 401/other 4xx or another user id → 'different', network/5xx → 'unreachable'; else setServerUrl + rememberServerId + setMe, invalidate every query, flush the offline queue → 'moved'. Only ever run on a tap (the invite screen, Ayarlar → Sunucu)
components/OfflineBanner.tsx shown after two failed /health probes (hooks/useConnection.ts); tap → Ayarlar (signed in) or the server screen. Signed in, on an editable build, and unreachable for 2 minutes in a row (`longOffline`): "Adres değişmiş olabilir. Kankandan yeni bağlantıyı iste →"
services/session.ts    renewTokenIfDue(client, onToken?): when tokenRenewedAt is missing, in the future or ≥ 7 days old → POST /auth/refresh, store the token (only if the stored one is still the token that asked, so a logout mid-request is not undone), stamp tokenRenewedAt, onToken(token). Never throws. Called from hydrate and from the headless task
store/ui.ts            vulgarity level used for UI copy (mirrors me.vulgarityMax), onboarding done flag
hooks/*.ts             useMe, useChallenges(status), useChallenge(id), useFriends, useInbox, useUnreadCount (30 s poll while foreground), mutations
services/steps.ts      getDailySteps(days: number): Promise<{ dayKey, steps, source }[]> + syncSteps(); platform files: steps.native.ts (ios Pedometer.getStepCountAsync per day; android: try Health Connect aggregate per day, else Pedometer.watchStepCount accumulate persisted per day in AsyncStorage), steps.web.ts (returns [])
services/recordingSteps.ts Android steps recorded by Google Play services' Recording API (local module `KoydumSteps`, modules/koydum-steps, play-services-fitness 21.3.0): status() / subscribe() / dailySteps(days ≤ 10). Used by steps.native.ts after Health Connect and before the foreground counter; per day the larger of recording and foreground count wins (both undercount; never summed). Since Android 9 a background app gets no step-sensor events, so this is the only way to count while the app is closed.
services/screenTime.ts   getScreenTimeAvailability() / requestScreenTimePermission() / getDailyScreenMinutes(days): looks up the local Expo module `KoydumScreenTime` by name (requireOptionalNativeModule); Android + usage access → real numbers, everywhere else `available: false` with a reason (ios | web | needs-native-module | permission | error)
services/screenTimeSync.ts syncScreenTimeNow(): POST /me/screen-time with the last 7 days when the phone can read them; twin of stepSync.ts, called from the same places
modules/koydum-screen-time/  local Expo module (Kotlin): UsageStatsManager.queryEvents → foreground minutes per local day; app.plugin.js adds PACKAGE_USAGE_STATS (tools:ignore=ProtectedPermissions) to the manifest
services/notifications.ts  registerForPush() → token or null (never throws; web returns null); setNotificationHandler; Android channel; response listener → router.push to challenge/inbox (the route keeps `notificationId` so the tap marks the row read, 3.5)
services/notifications.ts fireLocal(title, body, data) — used when a new inbox item arrives that was not pushed (device without push). On Android it posts on the `koydum` channel (trigger `{ channelId }`); a `null` trigger would land in the library's English "Miscellaneous" fallback channel
services/background.ts   BackgroundTask (15 min): sync steps + fetch unread inbox → fire local notifications for new items (skip on web / Expo Go gracefully). With the app swiped away the task runs headless (services/backgroundWork.ts) and does the same from the stored session, renewing the token first when it is due (a phone only ever woken by the task must not lose its session at day 90). The app entry `index.ts` (package.json `main`) imports `expo-router/entry` and then this file, so the task is defined even in a headless run, where expo-router never renders `_layout`; an undefined task is unregistered by expo-task-manager.
services/inboxNotifier.ts deliverNewInbox(client, surface | () => surface) → { surface, items }: the one place that turns unread, un-pushed inbox items into phone notifications (or, when on screen, items for ONE in-app toast of the newest with "N bildirim daha"). The surface is resolved after the fetch. Shared by the foreground poll, the background handler and the headless task. Only rows newer than the stored lastInboxId count (one full page of 100 is fetched); delivered ids are remembered (last 100) so racing checks never show an item twice; the first check on an install replays nothing (an empty first inbox stores a sentinel so the first row that ever arrives is shown); more than 3 new items → 2 shown + one "N bildirim daha". A phone holding a registered push token only updates the badge: push delivers there, and a local copy shown before the server's next flush would ring twice. This is what makes "KOYDUM MU?" reach a closed phone on a build without Firebase (registerForPush reports reason 'no-fcm', settings says "Gecikmeli").
services/focus.ts        focus session engine: start/stop, AppState listener → abandon when app leaves foreground > 10 s (grace), persists in-progress session to survive reload
theme/                   colors, spacing, typography (dark neon), components: Screen, Button, Card, Avatar, Chip, Stat, ProgressBar, Countdown, EmptyState, Toast, TauntBubble, Confetti (reanimated, optional), Sheet
utils/format.ts          formatNumber (tr-TR), formatDuration, relativeTime (tr), dayKey helpers (re-export shared/time)
```

### 3.3 Routes (`src/app`)

```
_layout.tsx                 providers (QueryClientProvider, GestureHandlerRootView, SafeAreaProvider), hydrate auth,
                            notifications setup, Stack with <Stack.Protected guard={!token}> (auth) and guard={!!token} (app)
(auth)/login.tsx            username/password, link to register, forgot-password hint (ask the server's owner), "Sunucu adresi" link; after a 401 logout shows "Oturumun düşmüş, bir daha gir." once (store `sessionEnded`, cleared on mount)
(auth)/register.tsx         + display name, vulgarity level picker (with live preview of a taunt at that level)
(auth)/server.tsx           edit server URL, "Bağlantıyı test et" → GET /health
onboarding.tsx              3 slides (copy onboarding_1..3), shown once after register
(app)/(tabs)/_layout.tsx    Tabs: index "Çelınclar", friends "Kankalar", inbox "Gelen Kutusu" (badge = unread), profile "Ben"
(app)/(tabs)/index.tsx      header: today's steps + sync button + level chip; sections: Davetler (accept/decline inline;
                            "Reddet" asks first, and says so when the no would cancel the çelınc),
                            Aktif (cards: emoji, title, countdown, mini standings, my rank; losing → red "yiyorsun" chip),
                            Bekleyen, Biten (last 5); FAB "Çelınc Aç"
(app)/(tabs)/friends.tsx    list friends (tap → user/[id]), incoming/outgoing requests (an outgoing one has "Geri çek":
                            confirm → DELETE /friends/:userId?only=request), search by username, my invite code (copy/share)
(app)/(tabs)/inbox.tsx      inbox list grouped by day; taunt items rendered as TauntBubble (big, red, shame); tap → challenge or friends; "Hepsini okundu yap"
(app)/(tabs)/profile.tsx    me: avatar emoji picker, stats grid (Koydum / Yedin / Berabere / Kankalar), badges, leaderboard preview, settings link, logout
(app)/challenge/new.tsx     4-step wizard: 1) tip seç (grouped by category, each shows emoji + name + desc at my level)
                            2) ayarlar (title, start now / tomorrow, duration days 1/3/7/14/30 or custom, deadline time for checkin, proof toggle, reward, penalty)
                            3) kankalar seç (multi-select friends) 4) özet + "KOY BAKALIM" create;
                            Android back steps back like "Geri"; on step 1 with a type chosen it asks before closing
                            (nothing chosen → the modal closes)
(app)/challenge/[id].tsx    detail: hero (emoji, title, status/countdown, reward), standings (ranked bars with scores + "koyuyor/yiyor" labels;
                            every row but mine opens that player's profile),
                            my action area per metric type (see 3.4), feed of recent entries with dispute button (only while
                            the server takes one: `active` and before `endsAt`, plus the settle hour of a phone-counted type)
                            (every open dispute's `{ad}: “{reason}”` under a disputed row, an upheld one's under a rejected
                            row; a disputed row says "İtiraz var. {kalan} içinde kanıt gelmezse yanar." from `answerBy`,
                            or "henüz çoğunluk değil" without one; my own open dispute's chip is "Geri çek" (confirm →
                            DELETE); the owner's disputed row gets "Kanıt ekle", a sheet with the entry modal's camera /
                            gallery pick → /uploads → POST .../proof),
                            past `endsAt` but still `active` (settling, 2.4) → "Süre bitti / Sonuç birazdan" instead of the
                            countdown, no action area, "böyle devam" verdict or "Ayrıl", one device sync on open (the list card
                            says "Sonuç bekleniyor"),
                            "laf sok" per rival you lead — opens a sheet of rendered `poke` lines to choose from,
                            invited → "Varım" / "Yokum" ("Yokum" asks first, like the home card); declined while it
                            still runs → "Reddetmiştin..." card with "Katıl" (accept),
                            leave/cancel; finished → button to results
(app)/challenge/[id]/results.tsx   winner view: podium + "KOYDUM MU?" CTA per loser (or "Hepsine koy") → taunt picker; loser view: shame screen
                            (big TauntBubble if received, else "bekliyor..." — and 24 h after `finalizedAt`, counted from the
                            last fetch, "unuttu galiba, rövanş aç, bu sefer sen koy" instead; the header only says the laf is
                            "aşağıda" once there is one), rewards/penalty text, "Rövanş" button with a note naming `rematchLeftOut`
                            ("Veli kankan değil, rövanşa çağrılmaz. Tablodan adına dokun, ekle."; final-table rows open profiles),
                            and a success toast naming whoever the new çelınc really invited (read back from its detail); tie view
(app)/challenge/[id]/taunt.tsx     picker: target chip(s), a context chip per loser from `tauntContexts` (RÖVANŞ / SERİ / EZİCİ FARK / NORMAL FARK / KIL PAYI;
                            without the field, the margin), list of templates of that context rendered with real names/scores (levels ≤ target max; higher ones shown locked with
                            "X bunu kaldıramaz" note), custom text field (banned-word check client side), preview, "GÖNDER" → success animation
(app)/challenge/[id]/entry.tsx     modal: log manual value (numeric pad, quick +1/+5 chips per unit), note, proof photo (camera/gallery → /uploads), day selector (today/yesterday)
(app)/focus/[id].tsx        full-screen timer (pick 15/25/45/60 min), big countdown, "elini telefondan çek" copy, leaving app → abandoned state with copy focus_abandoned; completion posts entry;
                            while the timer runs, Android back (and any other pop: usePreventRemove) opens the same "Seansı bitirelim mi?" sheet as "Vazgeç" instead of leaving;
                            a failed refetch keeps the last detail and the timer (the "Seans açılmadı" screen is only for a çelınc never loaded)
(app)/user/[id].tsx         public profile + head-to-head record vs me + "Çelınc aç" shortcut; not friends yet →
                            "Kanka isteği gönder", "Kanka isteğini kabul et" for an incoming one, "İsteği geri çek"
                            (confirm) for my own; "Diğer seçenekler": copy username, remove friend, report, block
                            (the toast says it can be undone under Ayarlar → Engellediklerin)
(app)/settings.tsx          vulgarity level (with preview), "Bildirim tercihleri" (reminder hour chips; "Geride kalınca dürt beni" and "Pazar akşamı haftalık özet" switches → PATCH /me `nudgesEnabled` / `recapEnabled` with a short optimistic override; "Saatli çelınc uyarıları", phone only and hidden on web → `setDeviceRemindersEnabled` + `refreshReminders`; a note at the reader's level that "KOYDUM MU?", pokes, invites and results cannot be switched off), timezone (auto), server URL (editable builds only: a "Sunucu adresi" sheet taking a bare address or a pasted invite link — `koydum://…?server=` or `https://host/davet/CODE`, see serverFromInviteLink in services/invite.ts — and running moveSession: moved → level toast, different → confirm, logout, set the new address, login screen; unreachable → inline error), push status + "yeniden dene", "Engellediklerin" (my blocks from GET /users/blocked, "Engeli kaldır" → confirm → unblock; empty → "Kimseyi engellemedin."), "Şifreni değiştir" sheet (current / new / repeat; min length and mismatch checked inline, wrong_password and same_password shown under their field, success → setSession + level toast), delete account (double confirm), about (+ "Yeni sürümü indir" when the server offers a newer APK)
davet/[code].tsx            invite deep link (koydum://davet/CODE?server=...), reachable signed in or not. Signed in: shows the inviter and sends the friend request only on a tap (a waiting request from that person would be ACCEPTED by it). A fresh install still on the localhost fallback adopts the link's server (after /health) without a conflict warning. Signed out: parks the code (services/invite.ts) and goes to register/login; the bridge sends it right after sign-in. A `server` differing from the current one is shown and only switched to on an explicit tap (after a /health check); builds with a baked-in URL ignore it. Signed in, the screen also asks that server's /health for its serverId: unless it is known to differ from the stored one (or a tap already found another server), the card reads "Bu davet yeni bir adresten" and its primary button "Yeni adrese geç (çıkış yok)" runs moveSession; the logout buttons stay below as secondary. On 'moved' serverUrl is the link's, so the ordinary send-request card follows.
```

### 3.4 Per-metric action area (challenge detail)

- auto_steps: "Bugün: 6.421 adım" + "Senkronla" (calls syncSteps → POST /me/steps → invalidate). Android w/o Health Connect:
  shows "Yaklaşık (uygulama açıkken sayılıyor)" + manual "Beyan et" entry.
- focus_minutes: "Odak seansı başlat" → focus/[id]; today's total.
- checkin_deadline: big "GELDİM" button visible only today; shows deadline; after tap → success or late copy.
- daily_boolean: two buttons "Yaptım ✅ / Yapmadım ❌" for today (and yesterday if missing).
- manual_count: "+ Giriş" → entry modal; quick-add chips.
- manual_lower_is_better: for `deviceMetric: 'screen_time'` on Android with usage access → today's minutes from the phone + "Senkronla" (POST /me/screen-time), no manual button; permission missing → "Kullanım erişimi ver" (opens system usage-access page, re-checked on AppState active) + a ghost manual fallback; iPhone / Expo Go / other → "Bugünkü değeri gir" → entry modal (proof photo emphasized), and a day the phone already reported shows as locked (server 409 `device_locked`).

### 3.5 Notifications & polling

- On login/boot: `registerForPush()`; if token → POST /me/push-token. Handler shows banner+list+sound.
- `useUnreadCount` polls every 30 s in foreground, plus refetch on AppState active. When `latestId` changes and the new
  items have `pushedAt == null` (server includes `pushed` flag) and app is in background → `fireLocal`. In foreground → in-app Toast.
- Tapping a notification response routes: taunt/challenge_* → `/challenge/[id]/results` or `/challenge/[id]`, friend_* → friends tab.
  A `reminder` with `data.kind === 'taunt_followup'` (2.4, 3b) opens the results, where the laf is sent; the inbox row does the same.
  The in-app toast for a push received in the foreground opens the same place (`routeForNotificationData`).
- A tap also marks its inbox row read: the server's push and `fireLocal` both put `notificationId` in the data, the route keeps
  it, and the bridge sends `POST /me/inbox/read { ids: [id] }` (then refreshes unread + inbox) before navigating. The phone's own
  reminders carry no id.
- The phone's own reminders (services/reminders.ts): a check-in çelınc's slot 30 minutes before its deadline and a
  "son 1 saat" warning before every end. `refreshReminders(client, level, tz)` runs one at a time; with the
  "Saatli çelınc uyarıları" switch off (`StorageKeys.deviceRemindersOff`, on by default, this phone only) it clears
  every scheduled one without asking the server, otherwise it reads `GET /challenges?status=active,pending` and
  replaces them (`syncReminders`). The bridge calls it once signed in and on every foreground, Ayarlar right after the switch.
- New rows refresh what is on screen (`invalidateForNotifications` in hooks/queries): inbox + unread always, friends for
  friend_*, and for each `data.challengeId` the challenge lists, the detail and the results. Called by the received listener
  (push), by the inbox poll whenever it returns items (either surface) and by the background handler while the app is alive.
  The tabs stay mounted and `refetchOnWindowFocus` is off, so the two list tabs also catch up on their own: Gelen refetches
  when the unread poll's `latestId` is not its first row, and its "N yeni" chip / "Hepsini okundu yap" use the larger of the
  loaded page's unread and the server's `count`; Kankalar refetches on focus when its list is older than 20 s.

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
