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
  timezone (`users.timezone`), pinned per çelınc when they join it (`challenge_participants.timezone`,
  sent to the app as `ChallengeSummary.myTimezone`). On a metric scored per day (`daily_boolean`,
  `checkin_deadline`, `manual_lower_is_better`) a player is scored on no more days than the creator has
  (`scoringWindow`, 2.3; sent as `ChallengeSummary.myDays`), on a check-in çelınc counted in deadlines
  their zone can reach, and a friend who would get fewer of those is not let in (2.2 `checkin_days_short`).

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
banned.ts         BANNED_PATTERNS (regex list) + containsBanned(text) + containsBannedName(text): the same with a few real surnames that share a stem with a slur (Topal, Kıroğlu, Zencir, Zencirci…) spared as whole words, also with digits typed on ("mehmet_topal35") + containsBannedTitle(text): the name rule, and the threats that are also workout talk ("Şekeri keseceğim", "Öldürücü 10K", "geberene kadar", "kafa dağıt", "canını yakacak") only when the text also names someone (seni, onu, kaybedeni…) + maskSparedSurnames(name)
text.ts           stripInvisible(), stripEscapeSequences(), hasVisibleChar(), singleLine(), countGraphemes(), TURKISH_FOLD, foldUsername()
time.ts           dayKeyInTz(date, tz), localTimeHHmm(date, tz), dayKeysBetween(), isValidDayKey(),
                  localInstant(dayKey, hour, minute, tz) (startOfDayInTz is its 00:00; never midnight + hours, a DST day),
                  formatDayKeyTr(dayKey, { withWeekday? }) → "21 Ekim Salı" (a table, not Intl: Hermes)
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
  | 'challenge_declined' | 'challenge_left' | 'challenge_accepted';
// data of a 'recap' notification (the inbox draws it as a card):
export interface RecapData {
  weekStart: string; weekEnd: string; // Monday..Sunday, reader's local day keys
  wins: number; losses: number; ties: number; steps: number; active: number;
  highlights: string[]; // "👑 Haftanın kralı ...", already at the reader's level
}
export type TauntContext = 'win' | 'win_big' | 'win_close' | 'tie' | 'poke' | 'streak' | 'revenge' | 'reply';
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
  wholeNumbers?: true;        // a count with no fractions (adim_yarisi, sinav_sayisi, merdiven_kati, ekran_suresi_beyani, kitap_sayfa, dil_pratigi): 400 `not_whole` on a fraction (2.3); absent where half a unit means something (km, bardak, porsiyon)
  missingDayPenalty?: number; // lower-is-better only: value assumed for unreported days
  askTr?: string; yesTr?: string; noTr?: string; // daily_boolean only: the question and the two answers (no ✅/❌); yesTr = value 1
}
```
Metric semantics:
| metricType | entries/day | value | score |
|---|---|---|---|
| auto_steps | 1 (upsert) | steps | sum of days |
| focus_minutes | many | minutes of a completed focus session | sum |
| checkin_deadline | 1 | 1 if check-in happened before `deadlineTime` local, else 0 | count of 1s |
| daily_boolean | 1 (upsert) | 1 = the day that counts (clean day of a don't-do-it type, done day of the others) / 0 = failed | count of 1s |
| manual_count | many | number (glasses, pages, km...) | sum |
| manual_lower_is_better | 1 (upsert) | number (e.g. screen hours) | sum + missingDays × missingDayPenalty; lowest wins |

A check-in type with a `checkinWindowStart` (erken_kus 04:00, erken_yat 19:00, yatak_toplama 05:00) only takes a
deadline after it, up to 23:59 (`deadlineFitsWindow`): erken_yat at 00:00 would refuse every check-in before 19:00
and score every one after it 0. `effectiveDeadline(type, stored)` is the deadline actually enforced: the stored one
when it fits, else `defaultDeadlineTime` (a row written before the rule, and a rematch cloned from one).
A check-in çelınc's days are its deadlines, so its first day must be one that can still be played: one that cannot
start today starts the next day at `nextDayStartTime(type)`, the window's opening when that is before 09:00
(erken_kus 04:00, yatak_toplama 05:00), else 09:00 like every other type (erken_yat). The wizard (3.3) and a
rematch (2.2) start there; at 09:00 erken_kus' 07:00 was gone before the çelınc began and "5 gün" was four mornings.

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
- The server hands `computeScore` each player's own window (`scoringWindow`, 2.3), never more days
  than the creator's on `daily_boolean`, `checkin_deadline` (counted in deadlines) and
  `manual_lower_is_better`, and leaves out the entries of a day it cut: a friend in another zone must
  not win a "3 gün" Sigara Yok 4-3 on a sliver of a fourth day with equal play, nor an erken_kus on
  one more morning than the creator's.
- `winMargin(type, winnerScore, loserScore)` returns `'big' | 'close' | 'normal'`:
  big if winner ≥ 2× loser (or loser 0 and winner > 0); close if difference ≤ 10% of winner; else normal.
  For `direction === 'lower'` the comparison is mirrored, because there the loser holds the larger
  number: big if loser ≥ 2× winner (or winner 0 and loser > 0); close if the difference is ≤ 10% of
  the loser's score.
- `acceptClosesAt(startsAt, endsAt)` (epoch ms) is when a çelınc stops taking players:
  `endsAt − min(LIMITS.ACCEPT_CUTOFF_MS, duration / 4)`. The server refuses an accept or an invite
  from then on (2.2) and sends the instant with every çelınc (`Challenge.acceptClosesAt`, 1.7); the
  app hides "Kanka ekle", the home card's invite and the çelınc screen's "Varım" / "Katıl" by it (3.3),
  falling back to this function for a server that does not send it.

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
`reply` templates are the loser's answer, read by the winner: `{winner}` is still the winner (the reader)
and `{loser}` the one answering, whose name is in the title ("Veli boş durmadı").
Unknown placeholders are left as-is. Numbers are formatted by `formatScore`, which is `formatNumberTr`
(12.430, 66,67): the digits `scoreLabel`, the results screen and the app's taunt and poke previews print, so a
screen-time average reads the same in the preview and in the message that lands.
A score in a taunt or poke is the çelınc's own (a multi-day sum, the screen-time daily average, a day count),
never today's alone: no line says "sabahtan beri", and no line that reaches screen time asks for more. Every
metric keeps at least five `poke` lines at every level. A çelınc created without a title carries its type's name,
the same text as `{metric}`, so no line names both `{challenge}` and `{metric}`.

### 1.5 Copy (`copy.ts`)

`MICROCOPY: Record<MicrocopyKey, {level1,level2,level3}>`, `t(key, level)`. `BADGES` with machine `rule`
strings parsed by `evaluateBadges(stats)` → earned badge keys. `stats` shape:
`{ wins, losses, ties, tauntsSent, tauntsReceived, stepsSingleDayMax, focusTotalMinutes, checkinsStreakMax, disputesWon, challengesPlayed, pokesSent, revengeWins }`
(`revengeWins` = finished rematches won outright after losing the original: somebody else won it, or it was a tie I
finished behind (`final_rank` > 1), as `losses` counts below; winning the rematch of a win again, or one I was brought into
without playing the original, is no revenge. The `rovans_*` ladder needs it; a rung stored on the older count, every
rematch won, stays).
In the Karne (`computeUserStats`) a tie is only a tie for the players sharing first place: `losses` counts the finished
çelınclar I played (`accepted`) that somebody else won AND the ties I finished behind (`final_rank` > 1), `ties` only
the ties where my `final_rank` is 1 (a NULL `final_rank` counts as 1). The weekly recap counts the same way.
Badges are LADDERS, not a flat wall: each `BadgeDef` carries a `family` and a 1-based `tier`,
and `badgeLadder(stats)` returns every earned rung plus exactly one locked rung per family —
the rungs above that stay hidden until they are reached.
Rule grammar: `<statKey><op><number>` with op in `>=`, `>`, `==`, `<=`; multiple rules joined by `&&`.
The koyuş ladder is named in level-3 words ("Çırak Saplamacı" 🍆 … "Saplama Mühendisi"), so those rungs also carry
`namePoliteTr` / `emojiPolite` ("İlk Zafer" 🏆, "Kazanmaya Alıştın", "Grubun Ustası", "Çelınc Profesörü").
`badgeTitle(badge, level)` → `{ name, emoji }`: at level 1 the polite pair where there is one, else `nameTr` / `emoji`.
The `badge` notification is named at the recipient's level ("🏆 Yeni rozet: İlk Zafer"), the profile and a friend's
profile at the reader's; the key, and so every stored `badges` row, is the same at every level.
`checkinsStreakMax` is the longest run of consecutive day keys with an on-time check-in (`value` > 0, not `rejected`)
in a MORNING check-in type: `MORNING_CHECKIN_TYPE_KEYS` (catalog.ts) = the `checkin_deadline` types whose
`checkinWindowStart` is before 12:00 (erken_kus, yatak_toplama), by type and not by the çelınc's deadline. An erken_yat
night is not "zamanında kalktın". A badge already stored is never taken back when a rule changes.

### 1.6 Zod schemas (`schemas.ts`) — the API contract

```ts
RegisterBody { username: /^[a-z0-9_]{3,20}$/ after foldUsername (lowercase, Turkish letters to ASCII, İ/I → i, other accents, spaces and invisible chars dropped: "Şeyma" → seyma, "İsmail" → ismail), password: min 6 max 72, displayName: 1..30 (one line: invisible, control and bidi override/isolate chars dropped, line breaks folded into one space; a name of only Hangul fillers U+3164/U+FFA0/U+115F/U+1160 or blank braille U+2800 is "Görünen ad boş olamaz"; names stored before stay), timezone: string (default 'Europe/Istanbul') }
LoginBody { username (same fold), password }
ChangePasswordBody { currentPassword: 1..72 (login rule), newPassword: min 6 max 72 (sign-up rule), pushToken?: string 1..512 | null (the push token this phone registered, see POST /me/password) }
UpdateMeBody { displayName? (same rules), avatarEmoji? (1..4 chars, same cleaning), vulgarityMax? (1|2|3), timezone?, reminderHour? (0..23 | null), nudgesEnabled? (boolean), recapEnabled? (boolean) }
PushTokenBody { token: string, platform: 'ios'|'android'|'web' }
PushTokenDeleteBody { token?: string 1..512 | null (the push token this phone registered, see DELETE /me/push-token) }
StepsSyncBody { days: { dayKey, steps: int 0..100000, source: 'pedometer'|'health_connect' }[] (max 14) }
ScreenTimeSyncBody { days: { dayKey, minutes: int 0..1440 }[] (max 14) }   // Android usage access; entries get source 'usage_stats'
FriendRequestBody { username?: string (same fold), inviteCode?: string } (exactly one)
CreateChallengeBody {
  typeKey: string; title?: string (max 40; title, rewardText, penaltyText and TauntBody.customBody are one line
                  like a name, counted after the fold; a note keeps its line breaks);
  startsAt: ISO (>= now-5min); endsAt: ISO (> startsAt + 1h, <= startsAt + 60d + 1h: 60 local days across a fall-back are 60 × 24 h and one more);
  participantIds: string[] (1..15, friends only, unique, not self);
  rewardText?: string (max 80); penaltyText?: string (max 80);
  deadlineTime?: 'HH:mm' (required when metricType === 'checkin_deadline'; after the type's checkinWindowStart,
                          "Check-in saati 19:00 sonrası, en geç 23:59 olmalı");
  dailyTarget?: number; proofRequired?: boolean;
}
InviteToChallengeBody { userIds: string[] (1..15, unique; friends only, not self, checked by the server) }
EntryBody { dayKey: 'YYYY-MM-DD'; value: number >= 0; source: EntrySource; note?: string(max 120); proofUrl?: string; clientTime: ISO; sessionId?: string (uuid, focus idempotency) }
DisputeBody { reason: string 1..140 }
EntryProofBody { proofUrl: string } (same rules as EntryBody.proofUrl: http(s) address or a server path, max 500)
PokeBody { toUserId: string; templateId?: string }
TauntBody { toUserId: string; templateId?: string; customBody?: string (max 140) } (one of)
ReportBody { reason: string 1..300 } (terminal escape sequences, invisible characters and line breaks removed first: `stripEscapeSequences`, `stripInvisible`, `singleLine`)
InboxReadBody { ids?: string[]; all?: boolean }
```

### 1.7 API response types (`types.ts`)

```ts
PublicUser { id, username, displayName, avatarEmoji, createdAt }
Me extends PublicUser { vulgarityMax, timezone, reminderHour, nudgesEnabled, recapEnabled, inviteCode, hasPushToken, stats: UserStats, badges: string[] }
UserStats { wins, losses, ties, tauntsSent, tauntsReceived, stepsSingleDayMax, focusTotalMinutes, checkinsStreakMax, disputesWon, challengesPlayed, pokesSent, revengeWins, stepsToday }
Challenge { id, creatorId, typeKey, metricType, direction, unit, title, startsAt, endsAt, status, rewardText, penaltyText, deadlineTime, dailyTarget, proofRequired, createdAt, finalizedAt, winnerId, isTie, rematchOfId, acceptClosesAt?: string | null }
  -- acceptClosesAt: the ISO instant the accept and invite routes refuse from (1.3), on every çelınc the
     server returns; null only for dates it cannot read. Optional because an older server leaves it out.
ParticipantView { user: PublicUser, status, score, days, rank, lastEntryAt, isWinner, lastSyncAt?: string | null, invitedBy?: string | null, timezone?: string | null }
  -- lastSyncAt: on an `active` çelınc of a phone-counted type (`deviceMetric`), an accepted player's newest
     `steps_daily` / `screen_time_daily` `updated_at`: when their phone last reported, which every sync stamps
     whether or not a number moved. Null for a player whose phone never reported (they type), for one who
     typed an entry in this çelınc after it (the newest non-device entry's `updated_at` is later: an
     iPhone after an Android, usage access taken back), for everybody who is not accepted, and on every
     other çelınc. Not `lastEntryAt` (the time of the newest entry, which
     the reminders read as "wrote today"). Older servers leave it out.
  -- invitedBy: the player whose invite brought this one in (`challenge_participants.invited_by`; a row
     without one was the creator's: the wizard's and a rematch's invitees), null for the creator. Older
     servers leave it out, and the app takes the creator then.
  -- timezone: an accepted player's `participantTimezone` (the zone pinned at their yes, where their days and
     check-in deadline are counted), null for everybody else. The çelınc screen names it by a rival's name when it
     is not mine ("(Tokyo saati)") and prints a check-in's clock in it: a profile set to Tokyo just before "Varım"
     beats a 07:00 deadline at 00:30 Istanbul every night, and an itiraz needs to see that. Older servers leave it out.
ChallengeSummary { challenge: Challenge, participants: ParticipantView[], me: ParticipantView | null, unreadTaunts: number, myTimezone?: string | null, myDays?: { first: string; last: string } | null }
  -- myTimezone: the zone the reader's days are counted in on this çelınc (`participantTimezone`: the one pinned when
     they joined, their profile's while an invite is unanswered), null with no participant row. `PATCH /me { timezone }`
     (the login after travel, "Cihazdan güncelle") does not move it, so the app counts this çelınc's "today" with it:
     an app counting in the new zone sends a day the server refuses (`day_in_future`, `checkin_too_early`). Older
     servers leave it out; the app uses `me.timezone` then
  -- myDays: the reader's first and last scored day key in `myTimezone` (their `scoringWindow`, 2.3), null with no
     participant row. On a yes/no or screen-time çelınc a friend in another zone than the creator's counts one day
     more between `startsAt` and `endsAt`, on a check-in çelınc one deadline more, which the server refuses: the
     rules card's "📅 N gün", the entry form's days, the detail's "Bugün" and "Geldim" and the check-in pokes leave
     it out (`clampToMyDays`). Older servers leave it out; the app counts every day between the two then
ChallengeDetail extends ChallengeSummary { myEntries: Entry[], feed: FeedItem[], disputes: Dispute[], taunts: Taunt[], canTaunt: { toUserId: string; done: boolean }[], canTauntCoversTie?: boolean, canPoke: boolean, pokeTargets: { toUserId: string; done: boolean }[], disputesCloseAt?: string | null, feedCursor?: FeedCursor | null }
  -- disputesCloseAt: until when an itiraz may be filed (`disputesOpenUntil`, 2.3), the instant the app hides its itiraz chip from; an older server leaves it out and the app uses endsAt (+ DEVICE_SETTLE_MS on a phone-counted type)
  -- pokeTargets: while a çelınc runs, talking is earned. Only whoever is AHEAD gets entries,
     and only for the rivals they are strictly ahead of (a tie earns nothing). On
     manual_lower_is_better a rival with no counted day (`days` 0) is nobody's target: their
     score is only the missing-day penalty, the same rule as the mid-day nudge. Nor is a rival with a
     block between the two, either way (a block mid-race leaves both in; the poke route's 403 `blocked`
     stays as the backstop). `done` = still inside the 2h cooldown, so canPoke = pokeTargets.some(t => !t.done).
  -- canTaunt: for the winner of a finished çelınc, one row per accepted loser (`done` = already
     taunted); for an accepted player with `final_rank` 1 in a finished tie, one row per other accepted
     rank-1 player (the 'tie' mode of POST …/taunt); either leaving out anybody with a block between the
     two, either way (POST …/taunt answers 403 `blocked` there). The results screen and the picker offer
     the winner's laf and a tie's "Laf at" only to these once the finished detail is loaded; empty for
     everybody else. `canTauntCoversTie: true` says the tie rows are there: an older server leaves it out
     and lists nobody for a tie, and the app then offers every co-leader as before
Entry { id, challengeId, userId, dayKey, value, source, note, proofUrl, status, createdAt, late?: boolean }
FeedItem { id, userId, displayName, dayKey, value, source, status, createdAt, updatedAt?: string, proofUrl, note?: string | null, answerBy?: string | null, disputeVotes?: { open: number; needed: number } | null }
  -- updatedAt: the entry's `updated_at`, when the row last changed. A phone's row is created at the day's first
     sync and rewritten by later readings (steps only when they grow), so on one this is when its number came;
     an itiraz's turns (filed, taken back, answered, upheld) leave it alone there and move it on a typed row. The feed's order and cursor stay on `createdAt`. Older servers leave it out.
  -- note: the entry's `note`, what its owner wrote with it, for everybody who reads the feed (null without one; a
     deleted account's is cleared with its photos). Older servers leave it out.
  -- feed: the 40 most recent entries (`LIMITS.FEED_PAGE`) plus every `disputed` one, however old (it is where the owner answers).
     feedCursor: set when older entries exist than those 40: the `createdAt` and `id` of the 40th, where GET
     /challenges/:id/feed goes on (the feed's last item is no use for that, an old disputed row can sit there);
     null when the feed reaches the first entry. Older servers leave it out.
     answerBy: set while a majority disputes the entry — the instant it is thrown out unless its owner adds a photo.
     disputeVotes: set on a `disputed` entry of an accepted player with no clock yet — `open` disputes of players
     still accepted (at least one, fewer than `needed`) and `needed` the threshold (2.2 dispute); null otherwise.
     Older servers leave both out.
FeedCursor { before: string; beforeId: string }
FeedPage { items: FeedItem[], next: FeedCursor | null }   // GET /challenges/:id/feed; next null on the last page
Dispute { id, entryId, byUserId, reason, status: 'open'|'upheld'|'dismissed', createdAt }
Taunt { id, challengeId, fromUserId, toUserId, level, title, body, createdAt }
Notification { id, type, title, body, data: Record<string, unknown>, readAt, createdAt }
FriendsView { friends: PublicUser[], incoming: {id, user}[], outgoing: {id, user}[] }
FriendAcceptResult { status: 'accepted', friendshipId, user: PublicUser | null, invitable?: InvitableChallenge[] }
InvitableChallenge { id, title, endsAt }
```

---------------------------------------------------------------------------------------

## 2. Server (`apps/server`)

Stack: Fastify 5, `@fastify/cors`, `@fastify/multipart`, `@fastify/static`, better-sqlite3,
`expo-server-sdk`, zod (from shared). Runtime `tsx`. No ORM: a thin `db.ts` with prepared
statements and SQL migrations applied at boot (`migrations/001_init.sql` ... embedded as
strings in `src/db/migrations.ts` — no filesystem reads for migrations so it works from any cwd).

```
src/index.ts            entry: imports main.ts dynamically and reports a failed start (startupErrorMessage, see 2.6), so
                        a package missing after a pull gets the Turkish line too
src/main.ts             boot: loadDotEnv() + buildApp() + scrubUploadDir() (old proof photos, before listen, see 2.6)
                        + listen(PORT, HOST 0.0.0.0) + start scheduler (after listen) + startKeepAwake(); clean
                        shutdown (see 2.6)
src/keepAwake.ts        Windows only: a hidden PowerShell that keeps the PC from idle sleep while the server runs (see 2.6)
src/log.ts              ownerLogStream(): pino lines → one Turkish line each for the owner's console (see Logging);
                        wantsReadableLogs(): stdout is a TTY and LOG_FORMAT is not `json`
src/env.ts              loadDotEnv(): apps/server/.env into process.env, never over a variable already set; entry
                        points only (main.ts, cli/yonet.ts; scripts/env.mjs for the .mjs scripts), not loadConfig
src/app.ts              buildApp(opts): registers plugins, routes, error handler, JSON bodies ≤ 64 KB; exported for tests
src/config.ts           env: PORT=4000, HOST=0.0.0.0, DATA_DIR=./data, UPLOAD_DIR=<DATA_DIR>/uploads (so one
                        volume holds the database and the photos), UPLOAD_MIN_FREE_MB=2048 (POST /uploads stores
                        nothing below it), JWT_SECRET (auto-generated & persisted to DATA_DIR/secret if missing),
                        PUBLIC_URL, LOG_LEVEL
src/db/index.ts         openDb(path|':memory:'), migrations, helpers (nowIso, newId = crypto.randomUUID)
src/db/migrations.ts    SQL strings
src/auth/jwt.ts         sign/verify HS256 with node:crypto (header.payload.sig, claims { sub, ver, iat, exp }, exp 90d, extended by POST /auth/refresh; no `ver` reads as 0)
src/auth/password.ts    scrypt hash/verify (salt:hash hex)
src/plugins/auth.ts     fastify decorator `authenticate` preHandler → request.user = {id}
src/routes/auth.ts      /auth/register, /auth/login, /auth/refresh
src/routes/me.ts        /me, PATCH /me, DELETE /me, POST /me/password, /me/push-token, /me/steps, /me/screen-time, /me/inbox*
src/routes/users.ts     /users/search, /users/:id, block/unblock/report
src/routes/friends.ts   /friends*
src/routes/challenges.ts/challenges*, entries, disputes, poke, taunt, rematch, results
src/routes/uploads.ts   POST /uploads (multipart image ≤ 5MB, jpg/png/webp by content, metadata stripped) → { url }
src/routes/catalog.ts   GET /catalog → { types, taunts (levels 1-3, contexts), microcopy, badges, version }
src/services/challenges.ts  lifecycle: activate(), finalize(), computeStandings(), cancelIfUnderfilled()
src/services/entries.ts     validateAndUpsertEntry() per metric type (see 2.3)
src/services/notifications.ts  notify(userId, type, title, body, data) → inbox insert + push queue
src/services/push.ts        Expo push sender (batch, handles DeviceNotRegistered → clears token; never a row older than 1 h, read, or from before the token)
src/services/stats.ts       computeUserStats(userId), evaluate & award badges
src/services/scheduler.ts   setInterval 30s: activate due, finalize ended, cancel underfilled, reminders; the stop
                            function awaits a pass in flight (≤ 10 s) so a push flush marks its rows first; a beat
                            more than RESUME_GAP_MS (5 min) after the last one moves bootAt to now and, when the
                            machine's uptime (os.uptime: runs through a sleep, never jumps with the clock) moved as
                            much, writes the gap to server_pauses (services/pauses.ts); a gap the uptime did not see
                            is a clock put forward (warn 'clock moved forward', no pause). The first request more
                            than RESUME_GAP_MS after the last beat runs that beat itself before it is handled (an
                            onRequest hook in app.ts calls app.schedulerBootAt.catchUp; between beats one
                            subtraction, never a second pass while one runs). A start writes the whole
                            time since the last beat a stopped process left in server_state, however short, and
                            stop() writes a last beat itself; the first pass of each day sweeps the proof photos no
                            entry shows (services/photos.ts)
src/services/taunts.ts      sendTaunt() with clamp + one-per-loser rule; sendPoke() rate limit
src/services/moderation.ts  assertCleanTitle(): containsBannedTitle on çelınc titles and stakes, assertCleanName(): containsBannedName on usernames and display names → 400 banned_content
src/services/images.ts      sniffImage() (jpg/png/webp by magic bytes), stripMetadata() (JPEG APP1/APP13/COM, PNG
                            eXIf/tEXt/zTXt/iTXt/tIME, WebP EXIF/XMP; pure JS, pixels untouched), scrubUploadDir()
src/services/photos.ts      sweepOrphanPhotos(): deletes uploaded photos no entry shows, once they are a week old
src/services/admin.ts       owner tools: listUsers(), listReports() (newest 200), countReports(), resetPassword() (8-char readable temp password; signs out every session, like POST /me/password), deleteAccount() (softDeleteUser, as DELETE /me)
src/cli/yonet.ts            `npm run yonet -- kullanicilar | sikayetler | sifre <kullanici> | sil <kullanici>` on the server's own DB file
```

### 2.1 Tables (SQLite, WAL mode, foreign keys ON)

```sql
users(id TEXT PK, username TEXT UNIQUE, display_name TEXT, password_hash TEXT, avatar_emoji TEXT DEFAULT '🍆',
      vulgarity_max INTEGER DEFAULT 2, timezone TEXT DEFAULT 'Europe/Istanbul', invite_code TEXT UNIQUE,
      push_token TEXT, push_platform TEXT, reminder_hour INTEGER DEFAULT 20, created_at TEXT, last_seen_at TEXT, deleted_at TEXT,
      nudges_enabled INTEGER DEFAULT 1, recap_enabled INTEGER DEFAULT 1, token_version INTEGER DEFAULT 0)
  -- the two notifications the reader can switch off (Ayarlar → Bildirim tercihleri); taunts, pokes, invites and results have no switch
  -- token_version: a token whose `ver` differs is refused (migration 012); a password change or owner reset adds 1
friendships(id TEXT PK, requester_id TEXT, addressee_id TEXT, status TEXT, created_at TEXT, updated_at TEXT, UNIQUE(requester_id, addressee_id))
challenges(id TEXT PK, creator_id TEXT, type_key TEXT, metric_type TEXT, direction TEXT, unit TEXT, title TEXT,
      starts_at TEXT, ends_at TEXT, status TEXT, reward_text TEXT, penalty_text TEXT, deadline_time TEXT, daily_target REAL,
      proof_required INTEGER DEFAULT 0, created_at TEXT, finalized_at TEXT, winner_id TEXT, is_tie INTEGER DEFAULT 0, rematch_of_id TEXT)
challenge_participants(challenge_id TEXT, user_id TEXT, status TEXT, invited_at TEXT, joined_at TEXT,
      final_score REAL, final_rank INTEGER, invited_by TEXT, PRIMARY KEY(challenge_id, user_id))
  -- invited_by: the player whose /invite brought them in (migration 015); NULL means the creator
entries(id TEXT PK, challenge_id TEXT, user_id TEXT, day_key TEXT, value REAL, source TEXT, note TEXT, proof_url TEXT,
      status TEXT DEFAULT 'ok', client_time TEXT, session_id TEXT, created_at TEXT, updated_at TEXT, answer_by TEXT,
      answer_from TEXT)
  -- indexes: (challenge_id, user_id, day_key); UNIQUE(challenge_id, user_id, session_id) WHERE session_id IS NOT NULL
  -- answer_by: set once when a majority disputes the entry (the owner's 12 h clock, 2.4 1b), NULL otherwise
  -- answer_from: when that clock started (migration 011); NULL on an older clock, which started 12 h before answer_by
steps_daily(user_id TEXT, day_key TEXT, steps INTEGER, source TEXT, updated_at TEXT, PRIMARY KEY(user_id, day_key))
screen_time_daily(user_id TEXT, day_key TEXT, minutes INTEGER, updated_at TEXT, PRIMARY KEY(user_id, day_key))
disputes(id TEXT PK, entry_id TEXT, by_user_id TEXT, reason TEXT, status TEXT, created_at TEXT, won_before INTEGER DEFAULT 0,
      UNIQUE(entry_id, by_user_id))
  -- won_before: an upheld itiraz filed again on the phone reading that restored the day (migration 010); it still counts in disputesWon
taunts(id TEXT PK, challenge_id TEXT, from_user_id TEXT, to_user_id TEXT, template_id TEXT, level INTEGER, title TEXT, body TEXT,
      created_at TEXT, UNIQUE(challenge_id, from_user_id, to_user_id))
pokes(id TEXT PK, challenge_id TEXT, from_user_id TEXT, to_user_id TEXT, created_at TEXT)
notifications(id TEXT PK, user_id TEXT, type TEXT, title TEXT, body TEXT, data TEXT (json), read_at TEXT, created_at TEXT, pushed_at TEXT, push_error TEXT)
badges(user_id TEXT, badge_key TEXT, earned_at TEXT, PRIMARY KEY(user_id, badge_key))
nudges_sent(challenge_id TEXT, user_id TEXT, day_key TEXT, PRIMARY KEY(challenge_id, user_id, day_key))
  -- the çelınclar a person's one mid-day nudge of the local day covered; any (user_id, day_key) row means that day's
  -- nudge is gone (index (user_id, day_key), migration 013)
reports(id TEXT PK, reporter_id TEXT, reported_id TEXT, reason TEXT, created_at TEXT)
reminders_sent(user_id TEXT, day_key TEXT, PRIMARY KEY(user_id, day_key))
recaps_sent(user_id TEXT, week_key TEXT, sent_at TEXT, PRIMARY KEY(user_id, week_key))
  -- one weekly recap per person; week_key = the local Sunday ending the week, sent_at = where the next window starts
taunt_followups(challenge_id TEXT, stage INTEGER, created_at TEXT, PRIMARY KEY(challenge_id, stage))
  -- the claim for the winner's "hâlâ bekliyor" reminder (2.4); stage 1 is the only one
server_pauses(started_at TEXT, ended_at TEXT)
  -- when the server was not running (migration 014): a sleep between two scheduler beats, or the time since the last
  -- beat when it starts again; rows that ended over 7 days ago go when a new one is written. Read by the check-in rule (2.3)
friend_refusals(user_id TEXT, other_id TEXT, at TEXT, PRIMARY KEY(user_id, other_id))
  -- user_id said no to other_id (migration 016): removed an accepted friendship, declined their request or blocked
  -- them. An invite code from other_id is then an ordinary request, however new the account; the row goes when user_id
  -- asks or accepts other_id
server_state(key TEXT PK, value TEXT)
  -- 'last_beat': the scheduler's latest beat (ISO), written every 30 s and read back at start. A database migrated
  -- from before 014 gets it seeded once from the newest users.last_seen_at / entries.updated_at /
  -- notifications.created_at (migration 017; a new database has none of those yet), so the first start after that
  -- upgrade still writes the pause
```

### 2.2 Endpoints (all JSON; errors `{ error: { code, message } }`, message in Turkish)

Auth: `Authorization: Bearer <jwt>`; 401 `unauthorized`. The token's `ver` claim must equal the user's `token_version`
(a token without one, signed before versions existed, counts as 0, where every account starts): a password change
or an owner reset adds 1 and every older token gets the same 401 `unauthorized`, with the message "Şifren değişti, bu
telefondaki oturum kapandı. Yeni şifreyle gir." (the app's login screen shows the 401's message). A token of a deleted account
gets the same code with "Bu hesap kapatıldı, bununla bir daha giriş yapılamaz. Bir yanlışlık varsa sunucuyu kuran kişiye
sor." (no signing back in: the name is anonymised and the password gone). Validation errors → 400 `validation` with the first
20 zod issues (the app shows only the message); a capped list (`days`, `participantIds`, `userIds`, `ids`) is counted before
its items are read, so one too long is a single issue. A JSON body over 64 KB (`JSON_BODY_LIMIT`) is refused unread, signed
in or not: 413 `body_too_large` "Gönderdiğin veri çok büyük." The biggest a schema accepts, 500 ids to `/me/inbox/read`, is
about 33 KB; `POST /uploads` is multipart, outside that limit, and keeps its own 5 MB, with at most 4 text fields of 1 KB
beside the photo (`MULTIPART_LIMITS`; more is 400 `too_many_parts` "Fotoğrafın yanında çok fazla alan gönderdin."). A
request whose body has not arrived in 150 s (`REQUEST_TIMEOUT_MS`) is cut off. Any write that finds the disk full (SQLite's
`SQLITE_FULL`, a file's `ENOSPC`/`EDQUOT`; `services/disk.ts` `isDiskFull`) answers 507 `disk_full` "Sunucunun diski
doldu, şimdilik hiçbir şey kaydedilemiyor. Sunucuyu açan kankana haber ver." from the error handler: an entry, a step
sync, a sign-up, anything. Reads and `POST /auth/login` keep working: the last visit (`users.last_seen_at`, written by
`authenticate` at most once a minute and by a login) is skipped when the disk is full, and so is the start of a çelınc due
to start that `GET /challenges` and `GET /challenges/:id` make on the way (it stays `pending` until there is room; the
scheduler or the next read starts it then). The owner's window gets one `warn`
an hour (`warnDiskFull`, per app), with the free MB; freeing room is enough, the next write lands without a restart.
Several endpoints take no request body. A JSON content type with an empty payload is parsed as `{}`
rather than rejected, so a client that always sets `Content-Type: application/json` still works.

| Method & path | Notes |
|---|---|
| GET /health | `{ ok: true, version, time }` (`time` is the server's clock, which the app compares with its own: utils/serverClock.ts) |
| POST /auth/register | 409 `username_taken`. Returns `{ token, me }`. The new account's avatar is 🍆 only when `vulgarityMax` is 3; otherwise one of 😎 🔥 👑 🐐 🦅 🚀 🎯 💪 (the profile picker's set), picked from the id (`seedFrom`). 429 `too_many_attempts` after 20 sign-ups from one client in an hour (`registrationsPerHourPerClient`; "Çok fazla hesap açtın. N dakika sonra tekrar dene."), a client being its IPv4 address or its IPv6 /64 (`clientKey`); an attempt counts once its body is valid and its name free, before the password is hashed (a 400 or a 409 `username_taken` costs nothing: friends on one Wi-Fi share the budget). The name is looked up again after the hash, just before the insert: of two sign-ups for one free name sent at once, the second is a 409 `username_taken` and gets its attempt back, not a 500. There is no server-wide cap: one troll would keep every newcomer out. A username or display name that trips `containsBannedName` (`containsBanned` with those surnames spared) is 400 `banned_content` (services/moderation.ts), checked before the name's availability, with a message naming which: "Bu kullanıcı adı olmaz. Aile, tehdit ve nefret içeren sözler yasak. Başka bir tane dene." / "Bu ad olmaz. Aile, tehdit ve nefret içeren sözler yasak. Adını değiştirip tekrar dene." Both reach strangers' screens (search, a profile, a kanka request's push) |
| POST /auth/login | 401 `bad_credentials`. 429 `too_many_attempts` after 40 wrong attempts from one client or 8 from one client at one username in 15 min ("Çok fazla deneme yaptın. N dakika sonra tekrar dene."), and after 30 at one account from all clients together in an hour ("Bu hesaba çok fazla yanlış şifre denendi. N dakika sonra tekrar dene. Şifreni unuttuysan sunucuyu açan kankana söyle, npm run yonet -- sifre <username> ile sıfırlasın; yeni şifreyle beklemeden girersin."); the right password waits too. A client is its IPv4 address or its IPv6 /64 (`clientKey`; `::ffff:` IPv4 counts as plain IPv4). The per-account budget belongs to the account's current password (id + `token_version`), so a reset or a change opens it at once; an unknown username gets the same budget under its spelling. Every attempt is counted before scrypt and a success clears the client's and the account's counts. Sessions already signed in are not affected |
| POST /auth/refresh | authenticated, no body. Returns `{ token }` with a fresh 90 days at the same `ver`. An expired token, or one from before a password change, gets the usual 401: renewal keeps a live session alive, it never revives a dead one. The app calls it about once a week |
| POST /auth/prove | no auth. `ProveBody { claims, nonce }`: `claims` is a token's own `header.payload` (not secret), `nonce` 16–128 base64url chars. Returns `{ origin, proof }`: `origin` = `publicOrigin` (PUBLIC_URL when set, else the request's address), `proof` = base64url HMAC-SHA256(key = HMAC-SHA256(jwtSecret, claims), i.e. that token's signature, message = `proveMessage(nonce, origin)`). The app checks it before its token goes to a new address (services/serverMove.ts): only a holder of the secret can answer, and an answer relayed from the real server names the real address. The signature itself is never sent either way |
| GET /me | `Me` |
| PATCH /me | partial update. A new `displayName` goes through `containsBannedName` like a sign-up's (400 `banned_content` "Bu ad olmaz. …", nothing saved); a name stored before names were checked, sent back unchanged, is not, so it never stops the other fields saving |
| DELETE /me | soft delete: anonymize username → `deleted_<id8>`, clear push token, leave active challenges (each one then goes through the abandoned check of 2.4, without a `challenge_left`) — except a çelınc that is already past `ends_at` and still waiting (settle hour, dispute window): an accepted player stays in it, as the leave route refuses, so deleting the account cannot turn a lost result into a cancellation. Every entry of the user's outside such a çelınc loses `note` and `proof_url` (value and status stay, so no standing or result moves), and each photo file those entries pointed at (`…/uploads/<uuid>.<jpg\|png\|webp>`, relative or with a server address in front) is deleted from `UPLOAD_DIR` after the commit, unless an entry still points at it; a file already missing or that cannot be deleted is skipped. The ones kept for a çelınc still waiting go once it is `finished` or `cancelled`: every scheduler pass (2.4) clears `note` and `proof_url` of a deleted account's entries outside such a çelınc and deletes the files the same way (`clearDeletedTraces`), which on its first pass also takes those of accounts deleted before deleting cleared them. The owner's `yonet sil` does the same |
| POST /me/password | `ChangePasswordBody`. Wrong current password → **400** `wrong_password` (never 401: the app logs out on any 401), new equal to current (after NFKC) → 400 `same_password`, 8 wrong ones per account in 15 min (login's per-account budget) → 429 `too_many_attempts`. Every attempt is counted before the password is checked and a right one clears the count, so a burst sent at once cannot outrun the budget (login counts the same way). Returns `{ token, me }` like login, at the new `token_version`: every other phone signed in to the account gets 401 from then on. The body's optional `pushToken` is the push token the changing phone registered (null: none). The account's push token stays only when it is that one; otherwise it is cleared (the phone holding it is one of those signed out, and its own logout can no longer clear it), and the app sends its own again for the new session. Without the field (the 1.1.0 app, which sends a device token once per run, not per session) the push token stays as it is: cleared, that phone went without push and without its own notifications until a restart |
| POST /me/push-token | store. One phone, one account: the same token is cleared from every other account that holds it (the last account to sign in on the phone owns it; logout's DELETE is best effort and may never arrive). A token new to the account (not the one it already holds) marks the account's waiting rows `push_error = 'before_token'`: they were the phone's own inbox check's to show, or history a fresh sign-in does not replay, so they stay in the inbox and are never pushed. The same token again (the app sends it on every start) changes nothing |
| DELETE /me/push-token | logout's. `PushTokenDeleteBody`; returns `{ ok: true, hasPushToken }` as the account's slot stands afterwards. `token` is the one the logging-out phone registered, and the account's push token is cleared only when it is that one: a friend who moved to a new phone and signs out of the old one must not switch off the new one's push. `token: null` (a phone that never registered one: web, a refused permission) changes nothing. No body, or one without `token` (apps from before the field), clears whatever is stored, as before; the phone that loses its token that way sends it again at its next foreground (3.5). An invalid body → 400 |
| POST /me/steps | upsert steps_daily; for every active/pending challenge with `deviceMetric: 'steps'` the user has accepted and whose day range contains dayKey → upsert entry(source). From `endsAt` on only days that were over by `endsAt` in the player's pinned zone (`dayOverByEnd`) still move: a later reading of a day the end cut in half would carry steps taken after the end. Returns `{ updated: number }` (`services/deviceSync.ts`)  Then awards any badge the new steps earned (the step ladder reads `steps_daily`), so "Yola Çıktın" arrives with the sync that crossed 7.500, not at the next finish or laf. |
| POST /me/screen-time | upsert screen_time_daily keeping the day's highest reading (`MAX`: one phone's reading of a day only grows, so a lower one is a second phone or a purged usage history; `updated_at` is stamped on every sync all the same); same fan-out of that stored reading for `deviceMetric: 'screen_time'` types, entries written with source `usage_stats` (the player's `scoringWindow`, 2.3, and the 7-day device backfill window, capped at maxPerDay). A device reading replaces a typed value for that day whatever its size, but never lowers a device row. Returns `{ updated: number }` |
| GET /me/inbox?before=<iso>&limit=30 | newest first |
| POST /me/inbox/read | `{ ids }` or `{ all: true }` |
| (scheduler) reminders | reminders and nudges not within `WAKE_GRACE_MS` (20 min) of `bootAt` (a start or a wake, 2.4), so the phones' parked entries land first (a phone whose background task runs later than 20 min can still be reminded); nothing is claimed meanwhile. Daily reminder only to users with no typed (non-device: not `DEVICE_SOURCES`) non-rejected entry today in any active challenge, and a live çelınc still empty today that can still take an entry today (a phone-counted one, `deviceMetric`, only until its sync: with a non-rejected entry today from any source it is not; an un-synced iPhone step racer still is). A row the phone wrote by itself does not silence it; when there is one today the body names the first such çelınc (soonest `endsAt`) instead of `notification_daily_reminder`, whose "hâlâ sıfırdasın" would be false: "“Şekersiz Günler” için bugün henüz bir şey girmedin." / "“Şekersiz Günler” bugün boş kaldı. Gir şuraya." / "“Şekersiz Günler” bomboş lan. Kankalar bakıyor.", data `{ dayKey, challengeId }` (the tap opens it; otherwise `{ dayKey }`). A check-in çelınc counts only until its `effectiveDeadline` in the zone pinned at join time (before its window opens it is still ahead; past the deadline "Çelıncı unutma" would only lead to a late 0), a `daily_boolean`, `checkin_deadline` or `manual_lower_is_better` çelınc only on a day of the reader's `scoringWindow` (2.3: the sliver of a day, or the extra deadline, it leaves out takes no entry), checked before the `reminders_sent` claim, so a çelınc accepted later that evening still gets that day's reminder; nudges only to `accepted` participants with `nudges_enabled` (checked before the `nudges_sent` claim, so switching it back on the same day still gets that day's nudge), and on `manual_lower_is_better` only to somebody who has reported a day (`days > 0`): with nothing reported the gap is the missing-day penalty, not a lead; never on a `daily_boolean` çelınc the reader has already marked today (a non-rejected entry for their local `dayKey`, yes or no: nothing that afternoon moves the gap), also checked before the claim, so that çelınc is neither named nor counted and the day stays free for another; never on a `daily_boolean` or `manual_lower_is_better` çelınc whose today is not in the reader's `scoringWindow` (2.3), checked before the claim too; never on a `manual_count` çelınc whose daily sum for the reader is within a cent of `maxPerDay` (the entry form's "tavan doldu": more would be refused with `daily_cap`), checked before the claim too, nor on a `focus_minutes` çelınc whose minutes today are within a minute of its 360 (the shortest session is one; the server would cut it to nothing); on `manual_count` a reader with such an entry is asked for more instead of today's entry ("Biraz daha eklersen fark kapanır." / "Biraz daha yap da gir şuraya." / "Bu kadarla olmaz, biraz daha koy." where it would say "Bugünkü girişini yapmayı unutma." / "Bir şeyler yap da gir şuraya."); at most one nudge per person per local day across all their çelınclar: of the çelınclar due in that pass it names the one with the biggest gap ÷ the larger of the two scores (data `{ challengeId, fromUserId, dayKey }` of that one) and counts the rest in the body ("Başka 2 çelıncta da gerideysin." / "2 çelıncta daha gerideysin." / "Başka 2 çelıncta da yiyorsun 🍆"; a single other reads "Başka bir…" / "Bir çelıncta daha…"), claims every one of them, and sends nothing more that day once the person has any `nudges_sent` row for it. The gap (and its ≥ 10 % test) is to the best accepted player ahead with whom the reader has no block either way, who is the one named and the `fromUserId`; never across a block: when every one ahead is blocked the leader's gap still counts, but the body names nobody ("Bir rakibin sana 9 bardak fark koymuş." / L1 "Bir rakibin önde, aradaki fark 9 bardak.") and data has no `fromUserId` |
| (scheduler) recaps | weekly `recap` to users with `recap_enabled` (switched off → no row, no `recaps_sent` claim) on Sunday 20:00–24:00 in the reader's timezone, or as a make-up on Monday 07:00–12:00, not within `WAKE_GRACE_MS` of `bootAt` (the steps the phones parked while the PC slept land first, or the walker and the king are named from hours-old numbers for good; only a make-up whose noon falls within the grace goes then) (never in the night between: a friend west of the server misses Sunday evening whenever the PC sleeps through it, and the make-up would ring them at whatever night hour it woke), once per week (`recaps_sent`): wins/losses/ties of çelınclar finalized since the previous recap (that recap's `sent_at` when it is ≤ 9 days back — covers a Monday make-up and a DST night — otherwise the last 7 days), Monday–Sunday steps (each day the larger of the phone's reading and the user's non-rejected step-çelınc entry, so a "Beyan et" day counts; only an entry its çelınc still counts: the user still accepted in it and the çelınc active or finished, since a leaver's or a cancelled çelınc's typed day scores nothing and its itiraz never settles; the step badges keep reading the phone alone), the king of the week among the reader and their friends (most wins, then steps; exact ties share; level 3 tells a king "hepsine koydun" only with no loss and no tie that week, else "N kere koydun") and the clear step leader. A Monday make-up says "geçen hafta" / "bu hafta rövanş". Nothing to tell → no row |
| GET /me/inbox/unread | `{ count, latestId }` |
| GET /users/search?q= | prefix match on username or display_name (Turkish and plain casing), and the query folded like a username against the username ("Çağ" finds cagri); excludes self, blocked; max 20: the username equal to the query folded like a username first, then usernames starting with it, then display-name matches, each by username. The match and that order run inside the query (`koydum_search_match`, a SQLite function each app registers on its connection) before the limit, so no number of accounts can hide an exact username, and accounts that do not match at all hide nobody: it used to match only within the first 2,000 rows by username, so a query the ASCII-only LIKE cannot narrow ("Şey") found nobody past them, and 20 accounts with the display name "Seyma" sorting before @seyma hid her from "seyma". A short prefix ("şey") is shared by every name that starts with it, and the first 20 of those come back |
| GET /users/blocked | `PublicUser[]`: the people I blocked, newest block first (Ayarlar → Engellediklerin). Only blocks I placed, never the ones placed on me; deleted accounts left out |
| GET /users/:id | `PublicUser` + public stats (wins/losses/challengesPlayed) + badges |
| POST /users/:id/block, /unblock, /report | block sets/creates friendship row status 'blocked' with requester = blocker; blocked users can't see or invite each other. A request pending between the two, either way, ends with it, and the addressee's unread `friend_request` for it becomes read (`markAnsweredRead`, as an answer reads it; DELETE /me does the same for every request the deleted account sent or got): migration 018 reads those from before, and the Gelen badge kept counting new ones. A block between two players already `accepted` in a çelınc takes neither out, and each may still dispute the other's entries there (2.3). A block also records a refusal (`friend_refusals`, see /friends/request) and gives the blocker a new `invite_code` (`renewInviteCode`): the old code lives on in every davet link sent, and a fresh account's code is a friendship at once, so the blocked person would be back through a new account; the old link then finds nobody (404). The app reads the new code from /me (`refreshMe` after the block) and says the link changed. unblock lifts only my own block (`{ status: 'none', userId, removed }`, idempotent) and does not bring a friendship back. report stores a `reports` row and logs a `warn` line (`YENİ ŞİKAYET`) for the owner; nothing in the app reads reports. At most 10 stored reports per account per hour (`REPORTS_PER_USER`) → 429 `too_many_requests` ("Çok fazla şikayet gönderdin. N dakika sonra tekrar dene."); a report of somebody the same account already reported for the same reason in the last 24 h (`REPORT_REPEAT_WINDOW_MS`; a double tap, a retry) answers 201 `{ ok: true }` without a row, a log line or a count against the hour, while a new reason is stored like any report: one account had written 3,000 in 2.4 s, each a line in the owner's window |
| GET /friends | `FriendsView` |
| POST /friends/request | by username or inviteCode; if the target already requested you → auto accept (200 `{ status: 'accepted', friendshipId, user }`; my unread `friend_request` for theirs becomes read, as on /accept); a new request → 201 `{ status: 'pending', … }`. By inviteCode from an account at most a week old (`INVITE_AUTO_ACCEPT_MAX_AGE_MS`, the phone's pending-invite week): accepted at once (200) — the code is the inviter's own invite, shared by them, and a newcomer used to wait on a "Kabul" from a phone that might not get push for hours. A pending request of mine to the code's owner becomes the friendship, and the owner's unread `friend_request` for it is deleted (as on a withdraw). The owner gets `friend_accepted` (data `{ userId, friendshipId, via: 'invite' }`, "Mustafa davetinle geldi, artık kankasınız.", "… davetinle katıldı, artık arkadaşsınız.", "… davetine kandı, kurban hazır.…"; plus `challengeId` and its other last line when a çelınc of theirs could take the newcomer, see /accept below); an older account only asks, and so does anybody the code's owner said no to since (removed them, declined their request or blocked them: a `friend_refusals` row, however new the account; the people one removes are mostly the ones who came by the link, which still carries the code). Any request of mine to them ends a no I said to them. A block either way is still 403 `blocked`. A code that finds nobody counts against the account: 20 such per hour (`INVITE_CODE_MISSES_PER_USER`) → 429 `too_many_requests` for any code until the hour has passed, a right one too, since a guessed code is a friendship now; requests by username are not counted. 404 `user_not_found`, 409 `already_friends`, 409 `already_requested` (my own pending request, not by a young account's code). At most 3 new requests from one person to the same person per 24 h (withdrawing frees the row, not the budget; an accepted-at-once one counts too) → 429 `too_many_requests`. At most 15 new requests by username from one account per hour, to anybody (`NEW_FRIEND_REQUESTS_PER_USER`) → 429 `too_many_requests` ("Çok fazla kanka isteği gönderdin. N dakika sonra tekrar dene."); a request by invite code and the auto-accept of one asked first are not counted, and a refused one costs the pair budget nothing |
| POST /friends/:friendshipId/accept, /decline | addressee only. A decline deletes the row and records a refusal (`friend_refusals`); an accept ends one the accepter held. Either way the caller's unread `friend_request` for it becomes read (`markAnsweredRead`, in the same transaction; it stays in the inbox as history): a request is mostly answered on Kankalar or a profile, and its row kept the Gelen badge up for a request that was no longer there. Migration 018 read once the rows answered before this: a `friend_request` whose friendship is no longer `pending`, a `challenge_invite` or `rematch` whose reader is no longer `invited` in that çelınc (one still waiting, or never answered before the çelınc was called off or ran out, stays unread). Accept answers `FriendAcceptResult` and sends the requester `friend_accepted` (data `{ userId, friendshipId }`, at their level, not to a deleted account). Every `friend_accepted` (also the crossed request and the invite code above) looks for the çelınclar its reader could call the new kanka into right now (`invitableFor`: the reader `accepted` in it, `stillOpen` and before `acceptClosesAt`, the kanka not `accepted`/`invited` and not joined-and-left, a seat free, no block between the kanka and anybody `accepted`/`invited` in it or its creator, and on a check-in çelınc no fewer deadlines in the kanka's zone than in the creator's; soonest `endsAt` first). With one, data gets `challengeId` (the app opens it with the kanka ticked under "Kanka ekle") and the copy's last line names it instead of "Aç bir çelınc": 1 "“{başlık}” çelıncına davet edebilirsin.", 2 "… çağır, grubu bölme.", 3 "… çek, o da yesin 🍆" (the title in quotes before "çelıncına", so no suffix follows free text): the newcomer is usually who a running group çelınc was waiting for. The accept's own answer carries the accepter's side as `invitable` (`[]` when none) |
| DELETE /friends/:userId | remove an accepted friendship (`{ status: 'removed', userId }`, and a refusal is recorded: their invite code only asks from now on), or withdraw my own unanswered request (`{ status: 'withdrawn', userId }`): the row goes, and so does the addressee's unread `friend_request` notification for it (a read one stays as history). A request sent to me → 404 `friendship_not_found`; that one is answered with /decline. `?only=request` (the app's "Geri çek") only ever withdraws: a friendship accepted while the confirm was open → 409 `already_friends` and stays, nothing of mine pending → 404 `friendship_not_found` |
| GET /catalog | shared catalog dump |
| GET /challenges?status=active,pending,finished | mine (accepted or invited), `ChallengeSummary[]`, ordered: active by endsAt asc, pending by startsAt, finished by finalizedAt desc |
| POST /challenges | 201. Returns the bare `Challenge` — the wizard navigates straight to `/challenge/<id>`. Creator auto `accepted`; others `invited` + `challenge_invite` notification. If startsAt <= now → status `active` immediately; a startsAt less than a minute ahead of the server's now is "Hemen" too and is stored as now (the app's "Hemen" is the server's clock as the phone last measured it, right only to within half a round trip, and as a future start it would sit `pending` until a friend's yes). A check-in deadline outside the type's window (`deadlineFitsWindow`) is 400 `deadline_outside_window` with the reason as its message ("Check-in saati 19:00 sonrası, en geç 23:59 olmalı. Saati değiştirip tekrar dene."), checked before the schema: the 1.0/1.1 wizards allow any hour and show only the message, which a `validation` 400 keeps generic. Likewise, before the schema, a `startsAt` more than `START_GRACE_MS` (5 min) before the server's now is 400 `start_in_past` "Başlangıç sunucunun saatine göre geçmişte kalıyor. Telefonunun ya da sunucu bilgisayarının saati yanlış olabilir; ikisinde de otomatik saat açık olsun.": the wizards before utils/serverClock took "Hemen" from the phone's clock, and a slow phone or a server PC whose clock is off got every one refused. After the schema, `title`, `rewardText` and `penaltyText` go through `containsBannedTitle` (services/moderation.ts; "Sigarayı kesicem", "Öldürücü 10K haftası" and "Topal vs Kıroğlu" pass, "Seni keseceğim" does not): 400 `banned_content` with a message naming the field ("Bu başlık olmaz. Aile, tehdit ve nefret içeren sözler yasak. Başlığı değiştirip tekrar dene.", likewise "Bu ödül olmaz. … Ödülü …" and "Bu ceza olmaz. … Cezayı …"); nothing is stored and nobody invited. A rematch copies the stored ones as they are. On a check-in type, a friend whose profile zone reaches fewer deadlines between `startsAt` and `endsAt` than the creator's (`checkinDaysShort`: the window's days whose slot, from `checkinWindowStart` to the last minute of the `effectiveDeadline`, the çelınc reaches) is 400 `checkin_days_short` "Saat farkı yüzünden bu çelıncın check-in saati Mert için 6 güne denk geliyor, sende 7 gün. Eksik günle eklenemez." ("… hiçbir güne denk gelmiyor, …" for none; no suffix after the name), and nothing is created: a one-day erken_yat made "Hemen" at 12:50 in Istanbul ends at 15:59 in New York, before its 19:00 opening, and the New York friend could only lose it. A retry after a lost answer makes nothing new: when the same creator made a çelınc in the last 2 minutes (`RETRY_TWIN_MS`) that is still `pending` or `active` with them `accepted` in it, not a rematch, with the same type, title, reward, penalty, deadline time, daily target and proof rule, the same other participants (whatever they answered since), a start and an end each within 2 minutes of this one's and the start on the same side of now, the answer is that çelınc with 200, and nobody is invited again (`retryTwin`, looked up in the insert's transaction). A tunnel or a mobile link that delivered the first try and lost its answer had the app say "Sunucu cevap vermedi"; the second tap made a twin, every friend got a second invite, and a "Hemen" twin is live, beyond `/cancel`. The app's `computeWindow` snaps the end to the last local day, so a retry from any installed wizard sends the same end |
| GET /challenges/:id | `ChallengeDetail`; participants only (404 otherwise). Like GET /challenges, the entry route and cancel, it first starts every çelınc past its start with two yeses (`activateDueChallenges`), so a reachable server never answers `pending` for one that has started by rule: the screen refetches the moment its countdown runs out, up to 30 s before the scheduler's beat |
| GET /challenges/:id/feed?before=<iso>&beforeId=&userId=&limit=40 | `FeedPage`, who may read the detail only (404 otherwise): the çelınc's entries as `FeedItem`s (the detail feed's `answerBy` and `disputeVotes` included), newest first by (`createdAt`, `id`), only those after the cursor `{ before, beforeId }` (`created_at < before`, or equal with a smaller `id`: rows of one device sync share their millisecond) — without one, from the newest. `before` alone pages on the instant; `beforeId` without it → 400 `validation`. `userId` keeps one player's rows. `limit` 1..100 (`LIMITS.FEED_PAGE_MAX`), default 40. `next` is the last row's cursor when more rows follow, else null. How an itiraz reaches an entry past the detail's 40: it is open for the whole çelınc, and four players of a 14-day steps çelınc write 56 rows |
| POST /challenges/:id/accept, /decline, /leave | Returns the refreshed `ChallengeDetail`. Accept while status ∈ pending/active and now is before `endsAt − cutoff`, where `cutoff = min(1h, duration/4)` so a minimum-length challenge stays joinable (`acceptClosesAt`, 1.3); leave only while pending/active (marks `left`; an invitee's leave, which older apps offer beside "Varım" / "Yokum", is a decline and marks `declined`, so the way back and a second invite stay open); an accepted player cannot leave an `active` çelınc past `endsAt` (400 `challenge_ended`): it is only waiting (2.4), and head to head leaving would cancel a result already seen. A declined invite may still accept (same window): that is the app's way back from an accidental "Reddet". Somebody who had joined and left may not (409 `already_left`); an invitee's "Ayrıl" is a decline and may (so may a `left` row that never joined: an older server stored that "Ayrıl" as `left`). A block between the invitee and the creator, or whoever invited them (`invited_by`), placed after the invite → 403 `blocked`: the block wins. A block with any other player already `accepted` → 400 `blocked_in_challenge` "Bu çelınca katılamazsın." (names nobody): a player who was never asked about a late invitee has only the block to say no with, and a no taken back must not put two blocked people side by side; two blocked people are never both `accepted`, whoever says yes second. On a check-in çelınc, a profile zone (the one this yes pins) that reaches fewer deadlines than the creator's pinned one → 400 `checkin_days_short` "Saat farkı yüzünden bu çelıncın check-in saati sende 6 güne denk geliyor, çelıncı açan Ali için 7 gün. Eksik günle bu çelınca katılamazsın." (POST /challenges): an invite asked before a flight, or a rematch whose creator plays from elsewhere now. More deadlines than the creator's let the friend in, scored on the creator's number (`scoringWindow`, 2.3). Before `endsAt`, a decline notifies whoever invited the decliner (`invited_by`, else the creator; `challenge_declined`, data `{ challengeId, fromUserId }`, "Ali tırstı, reddetti") and a leave every other accepted player (`challenge_left`, same data, "Ali havlu attı"); an invitee's leave counts as a decline. Each at the reader's level, only while they are still `accepted`, never across a block (either direction). Then the abandoned check of 2.4 runs, all in one transaction. Past `endsAt` both only change the row. An accept, a decline and an invitee's leave also mark the caller's unread `challenge_invite` and `rematch` rows for this çelınc (`data.challengeId`; a rematch's names the rematch) read, in the same transaction: invites are mostly answered on the home card or the çelınc screen, and the Gelen badge kept counting them. An accept, in one transaction with its row: first the days the phone already reported (`steps_daily` / `screen_time_daily`, within the window in the zone just pinned) go into the çelınc through the device fan-out of 2.3 and all its rules (`backfillFromPhone`), so a late joiner is not at 0 and is not offered "Eksik günü yaz" for days the server already holds. Then who hears it: the yes that first makes an `active` çelınc two (a "Hemen" çelınc is `active` with only its creator in it, and 2.4 only starts `pending` ones; nobody else had joined before) sends `challenge_started` (data `{ challengeId }`, the scheduler's copy) to both players, on a check-in çelınc whatever the hour (nothing made the creator's phone set a reminder since the creation); a yes that makes a `pending` çelınc past its `startsAt` two sends nothing, 2.4 starts it within 30 s and says "başladı" to everyone, before 07:00 too (`startsQuietly`); any other yes sends `challenge_accepted` (data `{ challengeId, fromUserId }`, "Ali kabul etti" / "Ali \"varım\" dedi" / "Ali sahaya indi 🍆", the body says how many are in now; no suffix after the name) to the creator, and to whoever invited the newcomer when that is somebody else, while `pending`, and to every other accepted player while `active`, at the reader's level, never across a block or to a deleted account |
| POST /challenges/:id/cancel | creator, only pending (due çelınclar are activated first, as on the entry route, so one past its start with two yeses is 400 `challenge_started` even before the scheduler's pass); notifies every other accepted or invited participant (`challenge_cancelled`, data `{ challengeId }`, "Ali \"{başlık}\" çelıncını iptal etti." at the reader's level); never names the creator across a block (either way): "\"{başlık}\" çelıncı iptal edildi." / "… iptal oldu." / "… yattı, iptal 🍆". Returns the refreshed `ChallengeDetail` |
| POST /challenges/:id/invite | `InviteToChallengeBody`. Any player `accepted` in it (else 403 `not_participant`: "Bu çelınctan ayrıldın, kimseyi çağıramazsın." after joining and leaving, "Önce çelınca katıl, sonra kanka çağırırsın." to somebody still invited or who said no) brings their own friends into a çelınc that already exists: phones get the app over days, and a second çelınc would split the group. Not only the creator: the newcomer is usually the kanka of whoever handed out the link (an older server answered 403 `not_creator` to anybody else). Only while it is still being played (`stillOpen`: pending/active and before `endsAt`, else 400 `challenge_closed`, so never in the settle hour or an itiraz wait) and before `acceptClosesAt` (400 `accept_closed`): an invite nobody may accept is a push for nothing. Each id: a live account (404 `user_not_found`), not me (400 `self_participant`), an accepted friend with no block either way (400 `not_friends`), and nobody already `accepted` or `invited` in it (or invited in the same call) has a block with them either way, nor has the creator, even after leaving (the accept route would refuse them) (400 `blocked_in_challenge` "{ad} bu çelınca eklenemez.", which does not say who blocked whom); `accepted`/`invited` → 409 `already_in`; joined and left → 409 `already_left` (the accept route's rule); on a check-in çelınc fewer deadlines in their profile zone than in the creator's → 400 `checkin_days_short` (as POST /challenges, "…, sende 7 gün." to the creator, "…, çelıncı açan Ali için 7 gün." to anybody else). A declined invite (an invitee's "Ayrıl" included), or a `left` row that never joined (an older server's "Ayrıl"), becomes `invited` again with a fresh `invited_at`; anybody else gets an `invited` row (timezone pinned at accept, like any invitee). Either way `invited_by` is the caller, so their no goes back to them (2.2 /decline). Everybody but the creator who is `accepted` or `invited`, plus the new ones, stays ≤ 15 (400 `too_many_participants`). All or nothing: any refusal invites nobody. Each invitee, a re-asked one too, gets a `challenge_invite` (data `{ challengeId, fromUserId }`, from the caller and naming them) at their level, all in one transaction. /cancel stays the creator's (403 `not_creator`). Returns the refreshed `ChallengeDetail` |
| POST /challenges/:id/entries | see 2.3; returns `{ entry, standings }` |
| DELETE /challenges/:id/entries/:entryId | own manual entries only, while active, by a player still `accepted` (403 `not_participant` "Bu çelınca katılmadın." otherwise, the dispute route's rule too) |
| POST /challenges/:id/entries/:entryId/dispute | 201 `{ dispute, entry, answerBy, othersCalled, standings }` (`othersCalled`: how many other players this itiraz called to the entry, 0 when nobody was; the app's toast names that count instead of guessing from `answerBy`). Not own (403 `own_entry`); across a block only while the owner is still `accepted` too, else 403 `blocked` (2.3); one per user per entry, whatever became of it (409 `already_disputed`) — except that a dismissed one (answered with a photo, or taken back) is forgotten when the entry's value or photo changes afterwards, so its disputer may file again, and an upheld one on an entry the phone restored (2.3) is reopened on the same row; a `rejected` entry → 409 `already_rejected`. The entry becomes `disputed` and keeps counting. Threshold = a majority of the OTHER accepted players, `max(1, ceil((accepted − 1) / 2))`, counting only open disputes of players still accepted. Once they reach it, the owner has `LIMITS.DISPUTE_ANSWER_MS` (12 h) from that moment to add a photo, stored as `entries.answer_by` (`syncDisputeClocks`); `answerBy` says until when (null below the threshold). A running clock is measured against the players accepted when it started (`joined_at`): a friend brought in later (`/invite`) had no say and does not stop it. Notification `dispute` to the owner while they are still `accepted` (one who left or deleted the account is not told: their rows count for nothing, the itiraz still lands) (data `{ challengeId, entryId, disputeId, answerBy }`; across a block the body says "Bir rakibin" instead of the disputer's name); the one that makes the majority says "12 saat içinde fotoğraf ekle, yoksa bu giriş yanar" at the owner's level, plus "\"Kanıt ekle\" düğmesi yoksa önce uygulamayı güncelle" (1.0 has no such button). A majority reached without a new dispute (somebody left, or deleted the account) starts the clock then, with a `dispute` notification "…artık çoğunlukta. 12 saat içinde…" (data `{ challengeId, entryId, answerBy }`). When the threshold is 2 or more (four accepted and up), this dispute did not start a clock, it is the first `disputes` row the entry ever has (a withdrawn or photo-answered one still counts, so nobody is called twice; a value change that forgets the dismissed ones, 2.3, can make the next one first again) and the owner is still accepted, every other accepted player — not the owner, not the disputer, not deleted, no block either way with the owner or the disputer — gets a `dispute` notification at their own level with data `{ challengeId, entryId, kind: 'call' }`: "{ad}, "{başlık}" çelıncında bir girişe yalan dedi: {sahip} · {gün} · {değer}. Yalan diyenler {threshold} kişiyi bulursa 12 saat içinde kanıt lazım…" (no suffix on either name). Below a majority only the owner heard of it before, so in a big group the majority never formed. Upholding happens in the scheduler (2.4) |
| DELETE /challenges/:id/entries/:entryId/dispute | the caller takes back their own OPEN dispute (404 `dispute_not_found` otherwise): it becomes `dismissed`, and the entry goes back to `ok` when no open dispute is left; when open ones remain but no longer make a majority, the owner's clock stops. Active only (the settle wait included). Returns `{ dispute, entry, standings }`. A withdrawn dispute cannot be filed again until the entry's value or photo changes |
| POST /challenges/:id/entries/:entryId/proof | `EntryProofBody`. Entry owner only (403 `not_your_entry`), entry `disputed` (409 `not_disputed`, 409 `already_rejected`), çelınc `active` (the settle wait included, 400 `challenge_not_active`). Sets `proof_url`, marks every open dispute `dismissed`, entry back to `ok` (clock cleared); each disputer (not deleted, not blocked) gets a `dispute` notification with data `{ challengeId, entryId, kind: 'proof' }` ("{ad} kanıt ekledi, bir bak."). Returns `{ entry, standings }`. The 1.0 app has no button for it: its owner re-posting a `disputed` upsert day through `POST /challenges/:id/entries` with a `proofUrl` is the same answer (and when the value changed with it, the disputers may file again) |
| POST /challenges/:id/poke | active only and before `endsAt` (400 `challenge_ended` while a result waits; `pokeTargets` is empty then); target must be one of the sender's `pokeTargets` (strictly AHEAD of them; on `manual_lower_is_better` not one with no counted day yet), else 403 `not_ahead`; rate limit 1 per (from,to,challenge) per 2h → 429 `poke_cooldown`. Template from `poke` context clamped to target's level (or default pick). Notification type `poke` |
| POST /challenges/:id/taunt | finished only (400 `challenge_not_finished`, the settle hour and an itiraz's wait included); one row per (challenge, from, to). Three ways to talk: (a) the winner (`winnerId`) to a loser (accepted, not winner), context from 2.3 (409 `already_taunted`); (b) a loser's one answer: an accepted loser to the winner, only once the winner's taunt to them exists (403 `not_winner` "Önce o konuşsun, sonra cevap verirsin." before), context `reply` with `{winner}` kept the winner, a second one 409 `already_replied` ("Cevabını verdin, bir tane yeter."); (c) a tie (`isTie`): an accepted player with `final_rank` 1 to another rank-1 player, context `tie`, whose lines are one co-leader talking to the other (`{winner}` = the sender, `{loser}` = the reader, the sender's name in every title) (409 `already_taunted`; a rank-1 player at somebody behind → 403 `not_winner` "Berabere bitti, laf sadece berabere kalanlar arasında."). Anything else → 403 `not_winner`; a block either way → 403 `blocked`. In (b) and (c) a template of another context is swapped for one of the mode's own. Template clamped to target's `vulgarity_max` — if requested template level > target max, pick deterministic template same context at target max; `customBody` allowed (level = sender-chosen ≤ target max, checked by `containsBanned` → 400 `banned_content`, then the finished sentence again with the real names and title in it, only their spared surnames read as a neutral word (`maskSparedSurnames`), so "{loser}'a" for a Veli Topal is not refused while a name "Karını" with "{winner} sikerim" is; the word of a name a placeholder glues letters onto ("{loser}lar", "{loser}.lar") is read as it is, surname or not; its title by mode: "{ad} laf soktu" / "{ad} boş durmadı" / "{ad} laf attı" at level 2). Notification type `taunt` with data `{ challengeId, tauntId, fromUserId }`. `canTaunt`, `tauntContexts`, `tauntTemplatesForWinner` and the follow-up reminder (2.4, 3b) stay about the winner's own taunts |
| POST /challenges/:id/rematch | 201, returns the new bare `Challenge`. Finished only, any accepted participant; one open (not `cancelled`) rematch per creator per çelınc while the creator is still in it (409 `already_rematched`; one they left does not count, as for `rematch_exists`), and none while a rematch somebody else opened counts for the caller (not `cancelled`, the caller `accepted` or `invited` in it: 409 `rematch_exists`, "Ali rövanşı zaten açtı, davet sende." / "…, sen de içindesin.", once finished "Bu çelıncın rövanşı zaten oynandı. Yenisini onun sonucundan aç."; one the caller declined, left or was never invited to does not count, nor an invite the caller can no longer take, for accept refuses it: past the rematch's `acceptClosesAt` (so also once it is over: never played, it is no rematch to open a next one from), or from a creator the caller now has a block with, either way, or a check-in rematch whose deadlines the caller's profile zone gets fewer of than its creator's pinned one, `checkinDaysShort`); clones settings (same type, reward, the check-in deadline as `effectiveDeadline` (1.2), and number of local days: the original's window in its own creator's pinned zone, where the wizard snapped it, a day its end cut in half not counted), startsAt = now + 5 min (a check-in type whose `effectiveDeadline` has passed by then in the creator's zone: the next day at `nextDayStartTime` (1.2), so erken_kus asked for at 22:00 starts at 04:00, not at 22:05 on a day nobody can play), endsAt = the last millisecond of the last of those days in the rematch creator's zone, like the wizard (when that is not more than `MIN_DURATION_MS` away, the end of the next day), invites the previous accepted participants who are still friends (no block either way, not deleted; nobody left → 400 `no_participants`) and, on a check-in type, whose profile zone gets as many deadlines in the rematch's window as the caller's (`checkinDaysShort`, as accept checks it: an Istanbul erken_yat asked for at 14:00 runs to 15:59 on its last day in New York, six evenings to seven; that friend can open their own, with them the creator; when only such friends are left → 400 `checkin_days_short`, the wizard's message for the first of them), `rematch_of_id`; notification `rematch` at each invitee's level and by how they came out of the original: L3 "Yine mi yiyeceksin bakalım." only to one who lost it (behind a shared first place too), to its winner "Geçen sefer yedi, doymamış 🍆 Bir daha koy." (L2 "Kabul et de bir daha koy."), to a co-leader of a tie "Bu sefer biri yiyecek 🍆"; L1 the same line for all |
| GET /challenges/:id/results | `{ challenge, standings: ParticipantView[], taunts, tauntTemplatesForWinner?: TauntTemplate[] (rendered previews per loser), tauntContexts?: Record<userId, TauntContext> (winner only: each accepted loser's context, 2.3), rematchLeftOut?: string[] (accepted players of a finished çelınc: the others a rematch opened by the reader would skip for not being friends; deleted accounts and blocks are skipped too but never listed), rematchInvitable?: number (accepted players: how many such a rematch would invite; 0 means POST .../rematch would answer 400 no_participants), rematch?: RematchView or null (accepted players: the rematch of this çelınc that counts for the reader in POST .../rematch, their own first, else the newest; RematchView { id, status (never cancelled), creatorId, creatorName, myStatus: 'accepted' or 'invited' }) }` |
| GET /leaderboard | friends + me ranked by wins, then fewer losses, then name; equal (wins, losses) share a rank (1, 1, 3) |
| POST /uploads | multipart field `file`; returns `{ url: PUBLIC_URL + '/uploads/<uuid>.<ext>' }` |
| GET /uploads/* | static; `POST /uploads` answers a path (`/uploads/<uuid>.jpg`) that each phone resolves against its own server address. `Cache-Control: public, max-age=31536000, immutable` (a name is a fresh UUID, never reused), `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; img-src 'self'; sandbox` |
| GET /davet/:code | public HTML invite page (no auth): inviter's display name + emoji, OpenGraph tags, "KOYDUM'da aç" (Android: `intent://davet/CODE?server=<origin>#Intent;scheme=koydum;package=com.koydum.app;S.browser_fallback_url=<origin>/indir?kod=CODE;end`, others: `koydum://davet/CODE?server=<origin>`), APK download when published; 404 page for unknown codes. `<origin>` is PUBLIC_URL when set, else built from the request's Host (+ X-Forwarded-Proto). A step for whoever tapped the Android installer's own "Aç" (which opens the app with no link): a read-only field holding `<origin>/davet/CODE` (`<origin>/indir` without a code) and "Bağlantıyı kopyala" (clipboard API on https, else the text is selected and `execCommand('copy')` tried), to paste into the app's "Önce sunucuyu seç" card. The line under a named inviter speaks at the inviter's `vulgarity_max`, since the link is their message (1 "…kazanan belli olur, kaybeden rövanş ister.", 2 "…kazanan koyar, kaybeden yer.", 3 "…kazanan saplar, kaybeden yer 🍆"); without an inviter the brand line stays. After the steps, on every page, a closed `<details>` "Kurulmuyor mu?" says what to tap at Chrome's "dosya zararlı olabilir" (Yine de indir), Play Protect (tarat, or Ayrıntılar → Yine de yükle), a Xiaomi/Redmi/POCO scan, "Uygulama yüklenmedi" (an old KOYDUM from elsewhere: uninstall, reinstall, sign in) and, after the install, a **Kullanım erişimi** switch Android 15+ greys out as "Kısıtlanmış ayar" for an app from outside a store (tap it once, then Ayarlar → Uygulamalar → KOYDUM → ⋮ → **Kısıtlanmış ayarlara izin ver**, then switch it on). Strict CSP: the copy script is the only script, allowed by its sha256 hash. Rate-limited with /invites (120 per client per 10 min, an IPv6 client being its /64) |
| GET /indir?kod= | same page without an inviter; its copy field still holds `<origin>/davet/CODE` |
| GET /invites/:code | public JSON `{ code, inviter: { username, displayName, avatarEmoji } }`, 404 `invite_not_found`; rate-limited (429 `too_many_lookups`) |
| GET /koydum.apk | the build published with `npm run apk:yayinla` (`<APP_DIR>/koydum.apk` + `latest.json`), `application/vnd.android.package-archive`, `Cache-Control: no-cache`; answers HEAD and a single `Range` (206, 416 with `Content-Range: bytes */<size>` past the end) with `Last-Modified`/`ETag` for `If-Range`, so a dropped download resumes and one that resumes after a new build gets the whole new file; 404 `apk_not_found` |
| GET /health | also `app: { latestVersion, downloadUrl, notes } \| null` — the app shows "Yeni sürüm var" when latestVersion > its native version — and `publicUrl: string \| null` (PUBLIC_URL when set and not loopback; `npm run internet` sets it to the Cloudflare quick-tunnel address). The friends tab builds invite links from `publicUrl ?? serverUrl`. And `serverId`: the first 16 hex chars of HMAC-SHA256(jwtSecret, 'koydum-server-id'), computed once per start. It stays the same across restarts and addresses and changes exactly when old tokens stop working (a new secret); it reveals nothing about the secret. The app uses it as a quick "another server" (a different id); a matching id proves nothing, since anybody can read it, so the app moves a session only after `POST /auth/prove` (services/serverMove.ts). |
| POST /uploads | one image per request (jpg/png/webp, ≤ 5 MB); at most 60 per account per hour ("Bu saatlik fotoğraf hakkın doldu. N dakika sonra tekrar dene.") and 60 per client per hour, every account on it together ("Bu ağdan bir saatte çok fazla fotoğraf yüklendi. N dakika sonra tekrar dene."; a client is its IPv4 address or IPv6 /64, `clientKey`), and the whole server stores at most 2 GiB of photos in a rolling 24 hours ("Sunucu bugün çok fazla fotoğraf aldı. N saat sonra tekrar dene.", counted a minute at a time before the write, given back when the write fails), all 429 `upload_limit`; only a stored photo counts toward the hour (both hours are counted before the body is read, so photos sent side by side cannot all pass the check, and given back when nothing is stored). In-process, so a restart forgets them. Before the body is read, while the upload folder's disk has less free than `UPLOAD_MIN_FREE_MB` (2048 by default; `statfs`, skipped when the system cannot say), and when the write runs out of room (ENOSPC/EDQUOT; the partial file is deleted), 507 `disk_full`: "Sunucunun diski dolmak üzere, şimdilik fotoğraf alınmıyor. Sunucuyu açan kankana haber ver." The rest of the disk belongs to the database, the step syncs and the backup. The owner's window gets one `warn` line an hour for a full disk and one for a spent day, and a 507 is not logged as a failed request. The declared mimetype picks the extension and turns away anything that is not an image before the body is read; the bytes themselves must then start like a JPG, PNG or WEBP by their magic (400 `invalid_file_type`, "Sadece JPG, PNG ya da WEBP fotoğraf yükleyebilirsin."); the picture is never decoded, and the static mount serves whatever follows the header with `nosniff` and a sandboxing CSP. Before the file is stored its metadata is stripped by what the bytes really are (`services/images.ts`): JPEG APP1 (Exif with the GPS, XMP), APP13 (IPTC) and COM segments before the first scan, everything from SOS on copied unchanged; PNG `eXIf`, `tEXt`, `zTXt`, `iTXt`, `tIME` chunks (a chunk running past the end: the rest as it came); WebP `EXIF` and `XMP ` chunks, their VP8X flags cleared and the RIFF size rewritten. A JPEG or WebP whose structure does not add up is refused rather than stored (400 `invalid_file_type`, "Bu fotoğraf bozuk görünüyor, başka bir tane seç."). The APKs already on phones send camera shots with GPS in their EXIF, so this is the server's job |

### 2.3 Entry validation (`services/entries.ts`)

Common: user must be `accepted` participant; challenge `active` (the route first starts every `pending` çelınc
whose start has passed and that has two players, as the scheduler's step 1 would: after a sleep the pass from
before it can still hang on a push flush, and a parked "Geldim" for a "Yarın 04:00" çelınc must not get
`challenge_not_active`); from `endsAt` on this endpoint takes
nothing, a device source included (400 `challenge_ended`; a replayed `sessionId` and a day already checked in
are answered before the state and the end are looked at, after the finish too, since they were written in time): a phone-counted çelınc's last syncs, while it waits for them (2.4), arrive through
`POST /me/steps` and `/me/screen-time` (the device fan-out below), never here; `dayKey` must be in the
player's `scoringWindow` (400 `day_out_of_range` "Bu gün çelıncın tarih aralığında değil."; for a day inside
`dayKeysBetween` that the trim below left out, "Saat farkı yüzünden bu gün sende sayılmıyor: herkes çelıncı açanın gün
sayısı kadar gün oynar.", on a check-in "Saat farkı yüzünden bu check-in sende sayılmıyor: herkes çelıncı açanın sayısı
kadar check-in yapar.": an older app, or an entry parked on one, shows that day inside the dates): `dayKeysBetween(startsAt,
endsAt, user.tz)`, except that on `daily_boolean`, `checkin_deadline` and `manual_lower_is_better` it never holds
more days than the creator's own (`creatorTimezone`: the zone pinned on their row, whatever its status). The wizard snaps the end in
the creator's zone, so a friend in another one gets one more day key: a "3 gün" made at 08:00 in New York runs in
Istanbul from 16:00 on its first day to 07:59 on a fourth. While it is longer, the end the çelınc covers fewer hours
of goes, the last on a tie (Los Angeles in an Istanbul çelınc from 09:00 keeps its 13-hour last day and loses its
2-hour first one). On `manual_lower_is_better` a last day the end cuts goes first, whatever its hours: it can be typed
only until `endsAt` and then costs 1440, while a first day the start cuts can be typed all evening and all of the
next day (New York in an Istanbul çelınc from Monday 00:00 keeps its Sunday from 16:00 and loses the Sunday that
ends at 15:59). The creator's raw count is the bar, a day their own end cut in half included. On
`checkin_deadline` the count is of deadlines (`checkinPlayableDays`: the days whose slot, from `checkinWindowStart`
(00:00 without one) to the last minute of the `effectiveDeadline`, meets `startsAt` up to `endsAt`). A day whose
deadline minute lies inside the çelınc outranks one the end cuts before its deadline, then the end whose slot the
çelınc covers less of goes (the last on a tie): an Istanbul erken_kus made "Hemen" at 23:00 by an older app has four
mornings there and five in Tokyo (05:00 on the first to 05:59 on Saturday), and Tokyo's Saturday is
`day_out_of_range`; one made at 00:30 keeps Tokyo's first morning (06:30 to its 07:00) over the last one (04:00 to
05:59, its 07:00 after the end). A day with no slot stays only where the creator's own window has that day with no
slot too, a "Geldim" on it a late 0 as before (the first day of a "Hemen" past the deadline, in Berlin as in
Istanbul); the others are left out (New York's evening before an Istanbul erken_kus from 04:00, or its last Sunday
of an Istanbul erken_yat, which ends at 15:59 before its 19:00). Fewer deadlines than the creator's never get in
(2.2 `checkin_days_short`); same-zone players are never cut. A playable day the end cuts before its deadline
(London's last evening of an Istanbul erken_yat ends at 20:59) still counts until the end: the app shows that day's
limit as the end ("Bugünün sınırı: 20:59. Çelınc saat 23:00 olmadan bitiyor, ondan önce bas.") and pokes 30 minutes
before it. Sums (steps,
focus, counts) cover the same hours in every zone and keep every day. The phones' fan-out writes the same window,
the standings score it (a cut day's entries left out, written before this rule too) and `everyPhoneReported`
waits for its last day; a finished çelınc keeps the results stored at its finish; `dayKey <= todayKey(user.tz)`; `dayKey >= todayKey − 2 days`
(manual types) / `− 7 days` (steps); value ≤ `type.maxPerEntry`, and a whole number on a `wholeNumbers` type (400
`not_whole` "Küsurat olmaz, tam sayı yaz.": a parked 12,43 adım from an app that read "12.430" as a decimal comes back as
the offline queue's refusal, to be typed again); proof required when
`challenge.proofRequired` and source is manual (400 `proof_required`) — and only for metrics where a photo can back a typed number (`manual_count`, `manual_lower_is_better`, `auto_steps`); a `daily_boolean` mark or a `checkin` has no photo step and ignores the flag. Device sources (`pedometer`, `health_connect`, `usage_stats`) never need proof; `usage_stats` gets the 7-day device backfill window.

Per type:
- `auto_steps`: source `manual` allowed (marks entry as beyan). Upsert by (challenge,user,day). Value ≤ maxPerDay. A `manual` write on a day whose row carries an upheld dispute (or one reopened on the restored row, `won_before`) is refused (409 `day_rejected`): only the phone writes that day again (fan-out below), and on a still-rejected device row not even the phone, which the 409's message says instead.
- `focus_minutes`: source must be `focus`; `sessionId` (a real v4 UUID — `z.uuid()`; the app generates it with `utils/ids.ts`, Hermes has no `crypto.randomUUID`) required; duplicate sessionId → idempotent return of existing entry (checked first, so a replay past the cap, past `endsAt` or after the finish still answers); value 1..180. The day holds at most `maxPerDay` (360) minutes over its non-rejected sessions: a session longer than what is left is stored cut to it (an older app posts the whole session, and its focus screen then says the whole session went in: the writer gets a `reminder` row, data `{ challengeId, kind: 'focus_cap' }`, "Odak tavanı doldu" / "“{başlık}”: 180 dakikalık seansın 60 dakikası yazıldı. Günde en fazla 360 dakika sayılıyor."), and with less than a minute left → 400 `daily_cap` ("Bugünlük odak tavanı doldu (360 dk). Yarın devam.", without "Yarın devam." on the çelınc's last day; for an earlier day "O günün odak tavanı zaten dolmuştu (360 dk)."). The focus picker starts no session longer than what is left and shows it ("Bugün 30 dk hakkın kaldı").
- `checkin_deadline`: source `checkin`; judged at `now`, or at the tap when the server was not running then: when `now` misses the day (dayKey ≠ local today) or the deadline, and `clientTime` falls inside a `server_pauses` row that ended at most 12 h before `now` (`PAUSE_TRUST_MS`, `tappedWhileDown`), that instant is used instead for everything below, the day window's `day_too_old` included (a pause over a weekend does not make Friday's tap too old by Monday), and the row's `created_at`/`updated_at` are that instant (so `lastEntryAt`, the phones' "done today", belongs to that night, not to the morning it arrived; the end-of-çelınc rules still go by `now`). A "Geldim" at 23:10 for 23:30, parked while the owner's PC slept from 23:00 to 08:00 and sent at 08:30, counts for its night and on time; at 22:00 (the server was up to hear it) it is refused, at 23:40 it is late. Inside a recorded pause a phone with its clock turned back can claim any minute of it; outside one `clientTime` buys nothing. dayKey must equal user's local today at that instant (400 `checkin_today_only`); server computes `localTimeHHmm(at, tz)`; before `type.checkinWindowStart` → 400 `checkin_too_early` "Bu check-in saat 19:00 olmadan sayılmıyor. Biraz erken geldin." (a "yattım" at 02:00 is not an early night; no suffix after the time, each window start wants a different one); if ≤ `effectiveDeadline` (1.2) → value 1 else value 0 and `late: true`. `Challenge.deadlineTime` reports that same effective deadline for check-in types, so the detail screen and the phone's reminder show the one enforced. One per day (409 `already_checked_in`, checked first, before the çelınc's state, `endsAt` and `checkin_today_only`: a replay of one already written, which the offline queue sends after a lost answer, often the next morning, gets "O gün zaten check-in yapmıştın." rather than a refusal of a night that counted; "Bugün zaten check-in yaptın." for today).
- `daily_boolean`: value 0 or 1; upsert per day.
- `manual_count`: append; daily sum must stay ≤ maxPerDay (400 `daily_cap`: "Günlük sınır 300 tekrar. Bugün zaten 270 tekrar girdin."; for an earlier day, which only the offline queue sends past the form's own check, the day is named, not today: "… 5 Ocak Pazartesi için zaten 270 tekrar girmiştin."). Optional `sessionId` (UUID) is stored and makes the write idempotent — the app sends a fresh one per tap so a timed-out request replayed from the offline queue cannot count twice. Upsert metrics ignore the field.
- `manual_lower_is_better`: upsert per day; value ≤ maxPerEntry. Sources `manual` and `usage_stats`; once the day's row has a device source, a `manual` write is refused (409 `device_locked`) — a device source may raise the phone's reading, never lower it (as the fan-out). Scored as the DAILY AVERAGE over the participant's own window (sum + missing days × penalty) / window days. Before `endsAt` the window stops at the last day that is over: today, with its entries, joins the average only tomorrow. Day 2 of 7 shows day 1, not five days of penalty, and an Android phone's half day sent at noon does not rank an iPhone player, who types their screen time at night, behind all afternoon (nor nudge them). With no earlier day (day one) today stays with what it has, so silence shows the penalty, never a free 0. From `endsAt` on the full window applies, also when the end cuts the last day in half; a last day another zone's end cut short is the one left out when the window is longer than the creator's (`scoringWindow` above), so nobody is charged 1440 minutes for a day they could not type after the end. A reader whose last day the end does cut (their own çelınc made for 24 hours from noon) is told on it "çelınc bugün bitiyor: bugünü saat 15:59 olmadan gir, sonra giremezsin." instead of "bugün ise gün bitince ortalamana katılır." A player is scored from `LIMITS.MANUAL_PICKER_DAYS` (1) day before the day they could first write, in their pinned zone, when that moment is after `startsAt`: the later of their `invited_at` (the wizard's and a rematch's invitees get the creation time; invited after `startsAt` with `/invite`, the time of that invite, a declined friend asked again a fresh one) and the moment the çelınc became playable (created for a later start, it took no entry while `pending`: the later of `startsAt` and the second-earliest `joined_at`, a row accepted with no `joined_at` counting as joined at creation). The window starts there, and their entries before it (an Android phone syncs a week back) are left out of the sum too, since the average divides every counted entry by the window's size. Accepting late does not move it: an invitee who sat on the invite pays for the days they sat out, and everybody else keeps the whole window. The app's entry picker reaches back `MANUAL_BACKFILL_DAYS` on this metric, so that first day can be typed all of the next day too.
- An accept runs the same fan-out once for that çelınc over what `steps_daily` / `screen_time_daily` already hold (`backfillFromPhone`, 2.2): the window, the 7-day device backfill limit, no future day, `dayOverByEnd`, steps only raised, a rejected device row untouched, exactly as a sync.
- Device fan-out (`POST /me/steps`) never lowers a typed `manual` value on a higher-is-better metric: the Android foreground counter is partial by design and the user was told to declare the real number; a device value ≥ the typed one replaces it (source becomes the device's). On screen time (lower-is-better) a device reading replaces a typed value either way, but never lowers a device row. A reading that changes the row's number forgets the itirazlar answered with a photo or taken back on it (`forgetDismissedDisputes`, as a typed change does): the photo backed the old number (it stays on the row), and in a 1v1 the rival is the only one who could challenge the new one. A typed row that is `disputed` is left alone by every sync until the itiraz is settled: written over, it would become a device row, which an upheld itiraz throws out for good. No app posts a device source to `POST /challenges/:id/entries` (the phones sync through the routes above), so one sent there is typed by hand and gets these rules and no more: it never lowers a step day or a device screen-time day, never writes over a `disputed` typed row nor any `rejected` row (only a sync restores one), and answers 200 with the row unchanged when it would.
- A `rejected` typed row (an upheld itiraz) is restored by the fan-out (steps and screen time) whatever the reading's size: the device's value and source, status `ok`, `proof_url` and `answer_by` cleared, dismissed disputes forgotten (`forgetDismissedDisputes`), upheld ones kept (they are `disputesWon`). The scheduler does it in the same pass that upholds the itiraz when `steps_daily` / `screen_time_daily` already holds that day, however old the day is (`restoreFromPhone`, before finalize, so an itiraz upheld after `endsAt` still gets the phone's number into the result); otherwise the next sync does while the day is inside the sync's 7-day limit (an older day the phone never sent stays out: no sync carries it). The 7-day device backfill limit is for what a phone sends, not for a reading the server already holds, so `restoreFromPhone` skips it (the window and `dayOverByEnd` still apply): an itiraz on day one of a 14-day race upheld on day ten, or one that ran out while the owner's PC slept from Sunday night to Tuesday, must not turn the day into a 0 that no later sync could undo. A 0 on a higher-is-better metric restores nothing. A `rejected` device row is never touched by a sync. The upheld dispute keeps its disputer's slot on the entry (`UNIQUE(entry_id, by_user_id)`), so from then on the day takes no typed number (`day_rejected` above; screen time already has `device_locked`); the phone's number is a new one, so that disputer may file an itiraz on it again: the same row reopens with `won_before = 1`, which keeps the first win in `disputesWon` and the day closed to typing.
- Disputes: only while the challenge is `active` (400 `challenge_not_active`) and, past `endsAt`, only inside the settle hour (`endsAt + LIMITS.DEVICE_SETTLE_MS`, or later while that hour, restarted by a server that started or woke past the end, still holds the çelınc: `disputesOpenUntil` with the scheduler's `bootAt`, 2.4; 400 `challenge_ended` otherwise — a new dispute during a wait would hold the result another 12 h, and a chain of them for days). A phone-counted çelınc always has that hour (the last evening lands in it); any other one only when an entry not written by a phone (`source` not `pedometer`/`health_connect`/`usage_stats`) was created or changed in its last hour (`created_at` ≥ `endsAt − DEVICE_SETTLE_MS`, or `updated_at` in that hour before `endsAt`, `lateTypedEntry`; an itiraz's turn on a typed row counts too, but not one after the end: a photo answering an afternoon itiraz, or the scheduler upholding one, reopens nothing): six focus sessions or 300 pages posted at 23:59:30 left the rival thirty seconds to file one, and an itiraz is the only check on a typed number. A typed çelınc with nothing late closes them at `endsAt`. Across a block a dispute goes only between two players both still `accepted` in it (a block placed mid-race takes neither out, and the itiraz is the only check on a typed number; otherwise 403 `blocked`); the owner's `dispute` notification across a block names nobody ("Bir rakibin, …"). Phone-counted entries may be disputed too. A dispute never rejects anything by itself: a majority starts the owner's 12-hour answer window (2.2), and only an unanswered one is upheld (2.4). Accepting an invite from someone who blocked you or whom you blocked → 403 `blocked`.
- Taunt context `revenge` only when the çelınc is a rematch AND both played the original (accepted) AND the loser finished
  ahead of the taunting winner there (`final_rank`; a row without one: the loser won it outright), so not against a friend
  brought into the rematch, a group rival the winner beat last time or one who shared their place; otherwise `streak` when the winner has won this çelınc and the two before it that both played (accepted, finished, newest first counting back from this one; a tie, a loss or a third player's win breaks the run), otherwise the margin. Templates carry an optional `metrics` list and are filtered by the challenge's metric (a "kalk yürü" line stays on step çelınclar; a line about a pile that grows, "hâlâ 4.201 ile duruyorsun", stays on steps, focus and counts; screen time and the day-count types have lines of their own).

After every write: recompute standings (in memory via shared `rankParticipants`) and return.

### 2.4 Lifecycle (scheduler, every 30 s; also callable directly for tests: `runSchedulerOnce(db, now, { bootAt? })`)

1. `pending` with `starts_at <= now`: if accepted count ≥ 2 → `active` + `challenge_started` notification to accepted
   (a çelınc created `active` never comes through here: the accept that first makes it two says it, 2.2; on a check-in
   çelınc not to a player for whom it is still before 07:00 in their pinned zone: a morning one starts at 04:00 or 05:00,
   `nextDayStartTime` (1.2), and nobody is woken for that; the phone's reminder 30 min before the deadline speaks first.
   Only where the phone could set that reminder (`startsQuietly`): at least two of the accepted had `joined_at <=
   starts_at` (a phone leaves out a `pending` çelınc with one yes, 3.5, and the scheduler starts one whose
   second yes came after the start within 30 s of it), and the first deadline at or after `starts_at` in the player's
   zone is at least 30 min after it. Otherwise "başladı" goes out whatever the hour: it is the first morning's only word);
   else if `ends_at <= now` → `cancelled` (`challenge_cancelled`). (Single-participant challenges wait; others can still accept.)
   Not a scheduler step but the same rule sooner: after a decline, a leave or an account deletion, a `pending`/`active`
   çelınc before its `ends_at` with fewer than two participants `accepted` or still `invited` is cancelled on the spot
   (`cancelIfAbandoned`: `finalized_at = now`, `challenge_cancelled` with data `{ challengeId, reason: 'everyone_left' }`
   to whoever is left, "herkes kaçtı" rather than "kimse kabul etmedi"). Past `ends_at` it is left to the scheduler,
   which says the same (`reason: 'everyone_left'`) when it cancels a çelınc with fewer than two accepted in which
   somebody else had accepted (`joined_at` set) and left — a silent invitee can keep one open to its end;
   only when nobody else ever accepted is it "kimse kabul etmedi" (`reason: 'not_enough_players'` from finalize).
1b. Disputes (`resolveDisputes`, before finalize): in every `active` çelınc the clocks are brought up to date first
   (`announceDisputeClocks`): a `disputed` entry of an accepted player whose open disputes (from accepted players)
   reach the threshold and has no `answer_by` gets `now + LIMITS.DISPUTE_ANSWER_MS` and its owner a `dispute`
   notification; one that no longer reaches it loses its clock (measured against the players accepted by
   `answer_from`, so a late joiner cannot stop it). While `now < bootAt + LIMITS.DEVICE_SETTLE_MS` (2), an
   `answer_by` before `bootAt` is moved to `bootAt + DEVICE_SETTLE_MS` (`answer_from` kept): the server was off or
   asleep when it ran out, so a photo sent in its last hours never got through, and the owner gets that hour after
   it is back. Stored, so the feed's `answerBy` and the app's "Kanıt ekle" show it. Then an entry whose `answer_by` has passed is
   upheld (`upholdDisputes`, one transaction): open disputes → `upheld`, entry → `rejected`, and a typed day the
   phone already reported takes the phone's number right away (`restoreFromPhone`, 2.3). Then `entry_rejected` to
   the owner (not when deleted): when the phone's number took the day it names both ("… için yazdığın 15.000 adım
   … Telefonun 8.200 adım demiş"), otherwise the day "skorundan düştü". Each disputer (not deleted, not blocked
   with the owner) gets a `dispute` notification with data `{ challengeId, entryId, kind: 'upheld' }` ("İtirazın
   tuttu", plus the phone's number when it took the day). Badges are recomputed for the disputers
   (`disputesWon`). Every itiraz notification writes the day as `formatDayKeyTr(dayKey, { withWeekday: true })`
   ("21 Ekim Salı günkü girişine"), never the raw key. The window runs from the moment the majority was reached and is
   stored then, so a second dispute ten hours after the first still gives the owner the full 12 hours, and a
   player leaving (which shrinks the majority) starts a full window at the leave instead of putting an old
   dispute's clock in the past; the leave and account-deletion paths arm it on the spot. A database from before
   `answer_by` (migration 009) is armed by the first pass, always with a full window. Below the threshold nothing
   is ever upheld.
2. `active` with `ends_at <= now` → finalize. A type with a `deviceMetric` (steps, screen time) first **settles**: the
   phone's last evening usually arrives with the next background sync (15+ minutes, longer under Doze), so it
   stays `active` until `now >= max(ends_at, bootAt) + LIMITS.DEVICE_SETTLE_MS` (1 h; `bootAt` counts only when a
   `server_pauses` row, or a pause the scheduler holds because it could not write it, overlaps the hour after `ends_at`:
   a wake or restart long after an hour the server was up for does not run it again, or every sleep reopened
   itirazlar on a result an itiraz holds, each new one holding it 12 h more), or earlier once every
   accepted participant's `steps_daily` / `screen_time_daily` row for their own last window day
   (`challengeWindow(c, participantTimezone(p, u)).at(-1)`) has `updated_at > ends_at`; a participant whose last
   day was not over by `ends_at` (another zone, an end in the middle of a day) is not waited for, because that day
   no longer moves (2.3). That early finish needs no entry of the çelınc to have `updated_at > ends_at` either
   (`movedAfterEnd`; the fan-out stamps only a row whose number it changes, so a sync that brings nothing new is
   not one): the numbers that moved after the end are what the hour lets friends question (2.3), and a player who
   kept his phone offline until the rival's post-midnight sync, then raised three days, was crowned by the next
   pass with the rival's itiraz refused. With one, the full hour runs. `bootAt` is when
   `startScheduler` started, so a server that was off at the end gives the phones the full hour after boot. A PC
   that sleeps keeps its process, so the scheduler also moves `bootAt` to `now` when a beat of its interval comes
   more than `RESUME_GAP_MS` (5 min) after the one before (`nextBootAt`), and logs it (`warn`, the minutes slept);
   asleep at the end is the same as off at the end. The daily reminder, the nudges and the weekly recap wait
   `WAKE_GRACE_MS` after `bootAt` too (3; a Monday make-up whose noon falls within it goes at once). Either way the gap goes to `server_pauses` (a start reads the
   last beat a stopped process, or its stop(), left in `server_state`, and writes any gap; a running one writes a gap
   only when the machine's uptime moved as much, so a clock put forward is no pause), where a check-in tapped
   meanwhile is judged (2.3). A gap that cannot be written (a PC that wakes on a full disk) is held in memory
   (`holdPause`) and written by a later beat (`writeHeldPauses`); meanwhile it vouches for a tap like a written one,
   so the night's parked "Geldim", sent the moment the PC wakes, is judged at its tap and only the disk (507) keeps
   it out. The phones' queues send what they parked the moment the server answers again, often
   before the interval's next beat, so a request that comes more than `RESUME_GAP_MS` after the last beat runs that
   beat first (`catchUp`, from an `onRequest` hook): the pause is written, `bootAt` moved and the pass run (a due
   `pending` çelınc started) before it is handled. Whichever of the request and the interval comes second finds no
   gap, and a pass still running is never joined by another. While
   settling, device syncs still fan out into the last day and `POST /challenges/:id/entries` gets `challenge_ended` (2.3); the
   app shows "Sonuç birazdan" instead of the countdown, hides the entry buttons and sends its own count once.
   Every other type finalizes right at `ends_at` — unless an entry not written by a phone was created or changed in
   its last hour (`lateTypedEntry`, 2.3): then it settles too, until `max(ends_at, bootAt) + LIMITS.DEVICE_SETTLE_MS`
   and no earlier, so the rival can see that number and file an itiraz on it (with one, a phone-counted type runs its
   full hour as well, every phone reported or not: a "Beyan et" day typed at the whistle). That is the longest the
   hour runs; an itiraz filed in it holds the result only by the next rule. Whatever the type, it also waits while
   one of its entries is inside a dispute answer window (1b): the owner was promised those hours even when the dispute came a minute before the
   end, so it stays `active` (the same wait) until a photo (2.2) or the window running out; the app says it is
   waiting for proof. Finalize: accepted participants with `rankParticipants`; write final_score/rank,
   winner_id/is_tie, `finished`, `finalized_at`; notifications: winner → `challenge_finished` with data
   `{ role: 'winner' }`, losers → `{ role: 'loser', winnerId }` ("… bitti. Kazanan Ali (10 bardak), senin skorun 4
   bardak."; never naming a winner the loser has a block with, either way: "… bitti, senin skorun 4 bardak.", nor
   opening with the `challenge_finished_lost` sentence then: its "Rövanş isteyebilirsin." / "Kazanan ağzını açarsa
   telefonun öter." promise a rematch and a laf the block refuses), a
   tie → `{ role: 'tie' }` to the players sharing first place ("… berabere bitti. Senin skorun … İsteyen rövanş açsın."). Whoever finished behind a tie lost:
   `{ role: 'loser', winnerId: null }`, the loser title, and a body naming the co-leaders (in the final table's order, `participantRows`, never by user id), the shared top score and
   their own place, and the penalty only when the çelınc has one ("Sosyal Medya Orucu bitti. Ali ve Veli berabere kaldı
   (7 gün), sen 3. oldun (4 gün). Ceza sende: Kaybeden bulaşık yıkar. Rövanş aç.", without one "… Yine de yedin, rövanş
   aç."; L1 "… birinciliği paylaştı … İstersen rövanş aç.", L3 "… Ceza sende 🍆 {ceza}. Rövanşı aç da görelim." /
   "… Yedin 🍆 Rövanşı aç da görelim."; a reader with a block with any co-leader, either way, gets no names at all:
   "… Birinciler berabere kaldı (7 gün) …", L1 "… Birincilik paylaşıldı (7 gün) …"),
   never the `challenge_finished_lost` sentence, which promises a laf no co-leader may send them. The TITLE is a short
   lock-screen phrase per level ("Kazandın 🏆" / "KOYDUN! 👑" / "KOYDUN! 👑🍆", and "Bu tur bitti" / "Yedin lan" /
   "YEDİN 🍆"); the `challenge_finished_won` / `_lost` sentence opens the BODY, because a phone truncates a long
   title to nothing useful (the loser's, but for that block). Award badges (stats recompute) for all participants.
3. Reminders: for each user with `reminder_hour` not null and an active challenge whose `ends_at` is still ahead (a settling one has nothing left to type), when `localHour(now, tz) >= reminder_hour`
   (not equality: a DST spring-forward hour or a scheduler outage would swallow it; the `reminders_sent` claim keeps it
   to one per local day), no typed (non-device) non-rejected entry today in any active challenge and no `reminders_sent`
   row for today → `reminder` notification with copy `notification_daily_reminder`. A row the phone wrote by itself
   (`DEVICE_SOURCES`: a background step sync, Android's screen time) does not count as logging: it silenced the
   reminder for every typed çelınc of a step racer whose sync works. With one today the body names the first çelınc
   still empty (soonest `ends_at`; "“Şekersiz Günler” bugün boş kaldı. Gir şuraya.", 2.2) with data
   `{ dayKey, challengeId }`. Not within `WAKE_GRACE_MS` (20 min, longer than the phones' 15-minute background task)
   of `bootAt` (a start or a wake), so the phones' parked entries land first; a phone whose background task runs
   later than 20 min can still be reminded. Nudges wait the same: `runSchedulerOnce` skips both steps meanwhile, so
   nothing is claimed and the first pass after it sends them with the parked entries counted. The claim and its
   `reminder` row are written in one transaction (the winner's "KOYDUM MU?" follow-up too), as nudges and recaps
   are: a disk that takes the small claim and not the notification must not spend the day's one reminder. Only when
   at least one of those live çelınclar is still empty today and can still take an entry: a phone-counted one
   (`deviceMetric`) only until its sync (a non-rejected entry today from any source), a check-in çelınc only until its
   `effectiveDeadline` in the zone pinned at join time (an erken_kus sleeper is not told at 20:00 to tap a "Geldim" that
   scores 0; erken_yat's 23:00 still is), and only on a deadline of the reader's `scoringWindow`, a yes/no or
   screen-time çelınc only on a day of it
   (2.3: Los Angeles is not told on the first afternoon of an Istanbul çelınc to mark a day the server refuses),
   checked before the claim, so a çelınc joined later that evening still gets that day's reminder.
3b. Taunt follow-up (`sendTauntFollowups`): a `finished` çelınc with a winner (not a tie), finalized between 48 h and
   2 h ago, where some accepted, non-deleted loser who is not blocked with the winner (either way) has no `taunts` row
   from the winner (a loser's answer goes the other way and never counts) → one `reminder` to the winner, data `{ challengeId, kind: 'taunt_followup' }`, at the winner's
   level, naming only the losers still waiting ("Veli hâlâ bekliyor" / "Koymayacak mısın? Veli ağzını açmanı
   bekliyor." / "KOYMADIN DAHA 🍆"; several → "Veli ve Ayşe …"). Only while the winner's local hour (profile
   timezone) is within the nudge window, 12:00–22:00, and checked before the `taunt_followups (challenge_id, 1)`
   claim, so a midnight finish is reminded at noon instead of losing its slot. Once per çelınc; nothing is ever sent
   in the winner's name.
4. Push queue: every unread notification row with `pushed_at IS NULL AND push_error IS NULL`, at most 1 h old
   (`PUSH_MAX_AGE_MS`, against the pass's `now`), for users with a token → Expo push (batched, oldest first, 200 a
   pass); each chunk is claimed (`pushed_at`, one transaction) before Expo hears of it, and a failed send or ticket gives
   the row back with its `push_error` (`pushed_at` cleared again). A claim that cannot be written (a full disk) ends the
   pass with nothing sent: marked after the send, a failed mark left the row pending and every pass rang the same laf
   again, about 120 times in its hour. Uses `Expo.isExpoPushToken`. Each pass first marks the waiting rows older
   than the hour `push_error = 'expired'`, whoever they belong to. So a row older than an hour, a read row and a row
   from before the token (`before_token`, see POST /me/push-token) are never pushed; they stay in the inbox. Turning
   Firebase on later rings nothing old, and one account's backlog never holds back another's fresh row.

### 2.5 Tests (`apps/server/test/*.test.ts`, vitest, in-memory DB, `app.inject`)

Cover: register/login/duplicate; friends request/accept/auto-accept/block; create challenge (immediate + future start),
accept, entries per metric type incl. validation errors and caps, checkin late logic (inject `now` via `app.decorate('now')`
or an injectable clock in `buildApp({ clock })`), steps sync fan-out, scheduler activation/finalization/tie/underfilled
cancel, taunt: winner / one per loser / the loser's one answer / a tie's co-leaders / level clamp / banned content, banned names, titles and stakes, poke cooldown, dispute threshold, rematch,
inbox read/unread, account deletion, uploads (multipart), badges awarded.

### 2.6 Ops

Daily backup (`services/backup.ts`, run from the scheduler tick): `db.backup()` into `<DATA_DIR>/backups/koydum-YYYY-MM-DD.db` (Istanbul date) once per day, written aside and renamed, last 7 kept; skipped for `:memory:` and while `users` has no row at all (a server started on an empty data folder, typically on a new PC before `geri-yukle`: its copy would be the newest day `geri-yukle` picks, and a week of them would trim the real backups out of `BACKUP_DIR`; the day is backed up on the first pass after the first sign-up). `BACKUP_DIR` (env / `.env`, trimmed; ignored for an in-memory config) names a second folder, typically OneDrive: once today's local copy exists, every local backup the folder lacks is copied there (aside and renamed, created if missing) and it is trimmed to 7 the same way. The copy runs detached from the pass, so a hanging cloud or network folder never holds up the lifecycle; a failure logs a `warn` and is retried after an hour (`BACKUP_COPY_RETRY_MS`), never touching the local backup. `stop()` waits for a copy in flight like it waits for a pass. A local backup that fails removes its partial `.tmp`; when it failed for want of room (`isDiskFull`) it is not tried again for `BACKUP_COPY_RETRY_MS` and logs one `warn` with the database file's size in MB, rounded up (`neededMb`), instead of an error with a stack on every pass. Every other scheduler write that fails on a full disk (the last beat and a pause, a step, the pass, clearing deleted accounts, the push flush) goes to the full disk's hourly line instead of its own.

Old proof photos (`src/main.ts`, every start, before `listen`, since a served photo is cached for a year): `scrubUploadDir(UPLOAD_DIR)` runs the strip of `POST /uploads` over every `*.jpg`/`*.jpeg`/`*.png`/`*.webp` in the folder, for the photos stored before uploads were stripped. A file is rewritten only when stripping changes it, written to `<name>.<pid>.tmp` (flushed) and renamed over it. A file that does not sniff as an image or does not strip is left byte for byte; a failed read, write or rename leaves the photo as it was and removes only the temp file; nothing is ever deleted. A JPEG is first read up to 64 KB: when that head holds the first scan and nothing to drop, the rest is not read, so a start costs little once the folder is clean. A missing folder is nothing to do. Any count above zero is one line (`warn` when some failed, retried at the next start); a failure of the whole pass is one `warn` and never stops the start.

Unused proof photos (`services/photos.ts`, from the scheduler tick after the backup, on the first pass of each Istanbul day: at every start and when the day turns): the app uploads a photo when it is picked, before the entry exists, so a photo picked and then swapped, an entry's photo replaced by a new post of the day (2.3), a typed day friends threw out that a phone reading took back (`proof_url` cleared; one the phone simply replaces keeps it) and a deleted entry all leave a file no entry shows. `sweepOrphanPhotos(db, UPLOAD_DIR, now, { dbPath })` deletes each file whose name is one `POST /uploads` gives (`<uuid>.jpg|png|webp`, lowercase; a `.tmp`, any other name and anything but a plain file are never touched), whose mtime is more than `UNUSED_PHOTO_GRACE_MS` (7 days) before `now`, and that no `entries.proof_url` points at, in the open database or in a `koydum-onceki-*.db` a restore set aside beside it (opened read-only; one that cannot be read throws and nothing is deleted that day: a wrong restore is undone by putting that file back, and `data/uploads` is in no backup), read with the same `…/uploads/<name>` rule as `DELETE /me` (relative or with a server address in front). The week is for a phone that uploaded a photo and parked its entry (the offline queue keeps the uploaded path) and for an itiraz answer, uploaded before it is posted. A file that cannot be deleted (locked on Windows) or is already gone is skipped and tried again the next day; a missing folder is nothing to do. Skipped for a `:memory:` database, which knows nothing of an earlier run's uploads. Also deletes nothing while no entry (in the open database or a set-aside one) shows any photo: that is a rescued `data/uploads` next to a database not restored yet, not a folder of unused files. Deleting any is one `info` line with the count and MB; a failed sweep is one `warn` and waits for the next day.

Owner CLI (`npm run yonet`, root script → workspace script, so the cwd is `apps/server` and the default `./data` is the server's database; the root script calls it with `npm run --silent`, so a failure shows only the CLI's own `✗` lines and its exit code, not npm's English `npm error Lifecycle script … failed` block): `kullanicilar` (username, name, created, last seen in Istanbul time, accepted active çelınclar, deleted last), `sikayetler` (reporter, reported, reason, newest first; the newest 200 (`REPORTS_LISTED`), then "Toplam N şikayet var, en yeni 200 tanesini gösterdim." when there are more; a reason is printed through `stripEscapeSequences`, `stripInvisible` and `singleLine`, so one stored before the API cleaned them cannot clear or recolour the console), `sifre <kullanici>` (name folded like a login, so `sifre Şeyma` finds seyma; new random password from `abcdefghjkmnpqrstuvwxyz23456789`, stored as scrypt, printed once; unknown or deleted → Turkish error, exit 1), `sil <kullanici> [--evet]` (`kapat` too; name folded the same way; the soft delete of `DELETE /me`, photos removed from the server's `UPLOAD_DIR`, so the account's tokens get 401 at once; asks "<ad> (@kullanici) silinsin mi? Geri alınamaz. (evet/hayır)" on a terminal, where only `evet`/`e` goes ahead; without a terminal it refuses unless `--evet` is given; unknown or already deleted → exit 1; a no at the prompt → "Peki, hesaba dokunmadım.", nothing touched, exit 0), `yedekler` (both backup folders: name, mtime in Istanbul time, size; a BACKUP_DIR hint when unset), `geri-yukle [yedek]` (`geri-yükle` too; no argument → the newest day across both folders, the local copy on a tie; else a path, a backup name or a bare `YYYY-MM-DD`). No argument → Turkish help (exit 0); unknown command → help on stderr, exit 1. Refuses when the DB file does not exist rather than creating one (except `yedekler`/`geri-yukle`, which keep no connection to it: `geri-yukle` opens it only for the moment of the check below), and never writes a JWT secret. Safe beside a running server (WAL + busy_timeout), except `geri-yukle`: it refuses (exit 1, nothing touched) when `GET http://127.0.0.1:<PORT>/health` answers `ok: true` within 2 s, and `restoreBackup` refuses on its own when the live file's `-wal` survives an open/read/close of ours (another connection holds it). Before anything else `restoreBackup` asks the database's disk for room (`statfsSync` of its folder, or of the nearest one that exists; skipped when the system cannot say): with less free than the backup plus 10 MB (`RESTORE_HEADROOM_BYTES`, for the check's -wal/-shm and the server's first writes) it refuses, nothing touched, with "Diskte yer yok: yedeği yüklemek için ~N MB boş yer lazım, önce yer aç." (on a full disk the open check below cannot fold the WAL back in and would call the server open). The backup is copied next to the database (`koydum.db.gelen`; a copy that runs out of room anyway is removed and refused the same way) and must pass `PRAGMA integrity_check` and have `_migrations` rows ("bozuk" / "KOYDUM yedeği değil" otherwise); its open accounts (`deleted_at IS NULL`; an unreadable `users` counts 0) are counted there too, never in the backup folder, and printed as "Yüklenen yedek: <file> (<mtime>, <n> hesap)"; with 0 (an empty server's copy an earlier version wrote) it still loads and exits 0, but prints "! Bu yedekte hiç hesap yok. Sunucuyu açmadan önce başka bir günün yedeğini yükle." and the `yedekler` hint instead of "Şimdi sunucuyu aç." When the other backup folder holds a file of the same name (BACKUP_DIR's copy of that day, which a day or a name never reaches past the local one), the line reads "…başka bir yedek yükle." and is followed by "Aynı günün bir kopyası daha var, önce onu dene" ("(tarihini yazarsan yine bunu yükler)" when the loaded one is the local copy) and `npm run yonet -- geri-yukle "<its full path>"`; the live file (with a WAL it could not fold in) is renamed to `koydum-onceki-YYYY-MM-DD-HHmm[-n].db` beside it, stale `-wal`/`-shm` removed, the new file renamed in. Nothing is deleted. There is no email and no reset endpoint: a forgotten password is reset by the owner, which signs out every phone on the account (token version + 1, push token cleared, as `POST /me/password`). A signed-in user changes their own (including the temporary one) in Ayarlar → Hesap → "Şifreni değiştir" (`POST /me/password`).

Keep-awake (`src/keepAwake.ts`, started right after the scheduler): on Windows, unless `KEEP_AWAKE` is `0`, the
server spawns `powershell.exe -NoProfile -NonInteractive -EncodedCommand …` (`stdio: 'ignore'`, `windowsHide`; no
`-WindowStyle Hidden`, which would hide the console it was started from). It calls
`SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` through `Add-Type`, then polls every 30 s until the
server's pid is gone, so it also ends after a hard kill. No display flag: the screen still goes dark. A closed lid
still sleeps (README). Shutdown kills it; a spawn error or an exit nobody asked for logs one `warn` and is never
fatal. Other platforms: nothing.

Shutdown (`src/main.ts`): SIGINT, SIGTERM, SIGHUP (a closed console window, Windows too), SIGBREAK on Windows, an
IPC message `{ type: 'shutdown' }` and a lost IPC channel all run the same path: stop the keep-awake helper, await
the scheduler stop, `app.close()`, `db.close()`, exit 0 (forced after 12 s). An unhandled rejection or uncaught exception is logged as fatal and takes the
same path with exit code 1. The scheduler starts only after `listen` succeeds.

A failed start (`src/index.ts`, which imports `main.ts` with `import()` so that a failure while loading it is caught
too) prints one Turkish line without a stack where `startupErrorMessage` (`src/listenError.ts`) knows the cause: a busy
port (EADDRINUSE) exits 1; a missing package (ERR_MODULE_NOT_FOUND / MODULE_NOT_FOUND naming a bare package or a file
under node_modules: "npm install") and a native module built for another Node.js (ERR_DLOPEN_FAILED or
NODE_MODULE_VERSION: "npm rebuild better-sqlite3") exit 3, "fixed only by the owner". Anything else, a missing file of
the server's own included, prints `KOYDUM sunucusu başlatılamadı:` and the error with its stack and exits 1.

Logging: no per-request lines (`LogController({ disableRequestLogging: true })`); an `onResponse` hook writes one `warn`
for a status ≥ 500 (except a 507 `disk_full`, a full disk's or POST /uploads', which have their own hourly lines) or a response slower
than 2 s: method, path without the query string, status, ms.
In a console (stdout is a TTY, `LOG_FORMAT` is not `json`) `src/main.ts` passes `logStream: ownerLogStream()` and every
pino line becomes `HH:mm:ss <glyph> <Turkish text>`: Istanbul time, `•` up to info, `!` warn, `✗` error and fatal; a
`── YYYY-MM-DD ──` line before the first entry of each Istanbul day. The server's own messages have Turkish renderings
(startup with port and the explicit PUBLIC_URL, Fastify's "Server listening at", scheduler pass counts, push sent/failed,
backup written/copied/failed, old proof photos cleaned at the start (and how many could not be), unused proof photos deleted (count and MB) or not, photos refused for a nearly full disk (free MB, or the write's ENOSPC) or a spent day (MB in 24 h), a full disk ("disk doldu (N MB boş): kankaların girişleri ve adımları, yeni hesaplar kaydedilmiyor; diskte yer aç, sunucuyu yeniden başlatman gerekmez"), a day's backup that did not fit (the database's size in MB, "bir saat sonra yine denerim"), shutdown reason, the failed/slow request line, YENİ ŞİKAYET with reporter, reported and
reason, the PC waking after N minutes ("bilgisayar 9 saat 3 dakika uyumuş; …"), the keep-awake helper failing); an `err` adds `: <message>` and, from error up, the first 3 "at" frames of its stack (all of them for fatal).
An all-zero pass or flush writes nothing. Unknown messages: the message, then the remaining keys as `k=v` (pid,
hostname, level, time, v and reqId dropped; `err=` its message). Control characters in any value become a space. A line that is not JSON
is written unchanged. Anything else (pipe, file, Docker, tests) keeps pino's JSON.

`npm run internet` (`scripts/internet.mjs`) supervises: the server runs as `node --import tsx src/index.ts` (one process,
IPC channel). Stop = IPC shutdown, SIGKILL after 15 s. A server exit that was not asked for is restarted with the same
PUBLIC_URL after 1 / 5 / 15 s; the 5th crash within 10 min pauses the server for `KOYDUM_CRASH_PAUSE_MS` (5 min), with
the tunnel and its address kept, then starts it again with a fresh crash count. Exit code 3 is not a crash: it pauses
at once, without the 1 / 5 / 15 s retries. The script reads stdin as lines (readline, `terminal: false`, so stdin never
goes raw and Ctrl+C stays SIGINT; a closed stdin means no commands), trimmed and Turkish-lowercased: `y` or `yeniden`
restarts a running server (same PUBLIC_URL, so new code behind the same address) or starts a paused, held or waiting
one at once, and clears the crash count; `dur` stops the server and holds it, no restart of any kind, until `y` (on
Windows npm install cannot replace better-sqlite3's .node while a server has it open); anything else prints the two
commands. A cloudflared that exits after printing its address leaves the server running (LAN and scheduler still work)
and is restarted with a 5 s → 60 s backoff, forever; a new address restarts the server with it and prints the banner
again. `.env` is read first (`scripts/env.mjs`), so PORT from the file reaches the tunnel too; the values it set are
passed to every server start, so a changed value needs the script restarted (a new address), not `y`.

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
expo-background-task, expo-localization, expo-build-properties (android minSdkVersion 26, compile/target 36,
`buildArchs` armeabi-v7a + arm64-v8a only and `useLegacyPackaging` for compressed native libs: the APK friends download
through the owner's tunnel drops from ~113 MB to ~42 MB; `__tests__/appConfig.test.ts` guards both),
react-native-health-connect. iOS `infoPlist.NSMotionUsageDescription` Turkish; Android permissions include
`ACTIVITY_RECOGNITION`, `android.permission.health.READ_STEPS`, `android.permission.health.READ_HEALTH_DATA_IN_BACKGROUND`
(from 1.1.1: the headless task's Health Connect reads), `SCHEDULE_EXACT_ALARM` and
`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` (Ayarlar → Arka plan; never `USE_EXACT_ALARM`, which is for alarm-clock apps). `extra.eas.projectId` placeholder documented in README
(user runs `eas init`). `eas.json` with `development` (dev client, internal), `preview` (apk, internal), `production`.

### 3.2 State & services (`src/`)

```
lib/api.ts             ApiClient: baseUrl + token; request<T>(method, path, body?); typed helpers for every endpoint; ApiError { code, message, status }; a 401 in our error envelope calls onUnauthorized. A reply without the envelope (`error.code` a string) is not our server, which renders every failure in it: 502/503/504/520-530 → `server_down` with its status ("Sunucu şu an kapalı, uyuyor ya da adresi değişmiş…": a quick tunnel's old address answers with the same 530 as a sleeping PC, so the text asks for the new link if the server is up; a 5xx, so an entry is parked), 413 → `too_large` (nginx's own body limit; the photo's problem), any other status → `not_koydum` with its status, and a 2xx body that is not JSON (a Wi-Fi login page) → `not_koydum` with status 0, so `isNetwork` parks it like no signal; none of them ever calls onUnauthorized, in the app or in the headless task. An empty 2xx body still comes back as null. A failed fetch says "Aynı ağda mısın, adres doğru mu?" only for a LAN or loopback address (utils/url isLocalNetworkUrl); for any other it asks whether the internet is on and points at the PC or a new link. Every call is aborted after the client's `timeoutMs` (15 s; 8 s for the probes, 20 s in the headless task) with `timeout`, status 0, except a proof photo's `POST /uploads` (`uploadPhoto`, and the web path of useProofPhoto), which gets `UPLOAD_TIMEOUT_MS` (120 s): 1.5-3 MB from the camera at quality 0.6 needs 15-25 s at about 1 Mbit up, and a timeout there was parked as no signal on a working connection
lib/storage.ts         key-value: SecureStore on native, localStorage on web (token, serverUrl, level cache, tokenRenewedAt, serverId)
lib/query.ts           QueryClient + query keys
store/auth.ts          zustand: { token, me, serverUrl, serverId, hydrated, sessionEnded, sessionEndReason, onboarding, setSession, setMe, logout, setServerUrl, rememberServerId, setOnboarding }; hydrate on boot, then (once /me answered) renewTokenIfDue. A 401 from the store's client sets `sessionEnded` and `sessionEndReason` (the server's message when the body is our `unauthorized` envelope, else null) before logging out, only when there was a token and only when the client was built with the token the store still holds (a request out while a password change swapped it must not log out the new session); setSession stamps tokenRenewedAt, logout removes it. serverId is /health's id of the server the session lives on: learned right after setSession (fire-and-forget /health) and from every useServerInfo fetch, kept only while signed in and only for the address still in use (rememberServerId(id, forUrl)); logout removes it. `onboarding` (never stored) is true from the register screen's submit (set before setSession) until the welcome slides go away; NotificationBridge keeps its push-registration and step effects off while it is true
services/serverMove.ts moveSession(url) → 'moved' | 'different' | 'unreachable': the same server at a new address keeps the session. /health on a bare client (8 s; no answer, or a page that is not JSON such as a Wi-Fi login, → 'unreachable'); a stored serverId the server does not repeat → 'different' without the token ever being sent; else a bare /me with the token (no onUnauthorized): 401/other 4xx or another user id → 'different', network/5xx → 'unreachable'; else setServerUrl + rememberServerId + setMe, invalidate every query, flush the offline queue → 'moved'. Only ever run on a tap (the invite screen, Ayarlar → Sunucu)
services/invite.ts     pending invite (savePendingInvite / readPendingInvite / applyPendingInvite, a week at most), serverFromInviteLink(text) (the `server=` of an app link or the origin of a `/davet` or `/indir` page link, inside any message), parsePastedInvite(text) → { server, code }: server = serverFromInviteLink ?? normalizeServerUrl(text) ?? the first http(s) URL in the text; code from `/davet/CODE` or `kod=CODE`
lib/config.ts          normalizeServerUrl: typed without a scheme, a LAN IP, localhost, `.local` or dotless name → http (+ :4000 when no port), any other domain → https unless a port was typed (a tunnel only answers on https)
components/ChooseServerCard.tsx "Önce sunucuyu seç" on login and register while needsServerChoice(serverUrl): native (not web), editable build, and serverUrl still loopback (the APK without a baked-in address, opened from the installer). Takes a pasted invite message or address (parsePastedInvite; a loopback one is refused), probes /health on a bare client (8 s), parks a code with savePendingInvite, then setServerUrl, then `onChosen(code)` (login: a paste that carried a code → `router.replace('/(auth)/register')`, since a pasted invite on a phone that never chose a server is somebody new; a bare address stays on login). While it shows, the screen's submit button is disabled with "Önce sunucuyu seç" under it. PendingInviteBanner re-reads the pending invite whenever serverUrl changes; on register it says "Kayıt olunca kanka olursunuz.", on login "Hesabın yoksa önce kayıt ol, kanka olursunuz. Varsa giriş yap, istek kendiliğinden gider." with a "Hesabım yok, kayıt ol" button → register
components/OfflineBanner.tsx `OfflineFrame` around the root Stack: a strip shown after two failed /health probes (hooks/useConnection.ts); tap → Ayarlar (signed in) or the server screen. Signed in, on an editable build, and unreachable for 2 minutes in a row (`longOffline`): "Adres değişmiş olabilir. Kankandan yeni bağlantıyı iste →". The strip reaches under the status bar and pads itself clear of it (`insets.top + 6`, Android being edge-to-edge); while it shows, everything below reads `useSafeAreaInsets().top` as 0 (an inner SafeAreaInsetsContext provider, mounted either way so the Stack never remounts), so no screen leaves the status bar's room a second time. Its measured height is `useOfflineStripHeight()` (0 while hidden): a KeyboardAvoidingView measures its frame against its parent, not the window, so `Screen keyboard` adds it to its offset or an offline form stops that far short of the keyboard. ToastProvider sits outside it and keeps the real inset
services/savedDetails.ts the last detail of each check-in çelınc the account plays, pending or active and before `endsAt` (`me` accepted), under one key with the stored profile's id (`StorageKeys.savedDetails`, at most 5, the most recently seen first): saved on every successful GET /challenges/:id (one that no longer qualifies, or a 404, is dropped) and from the detail a yes answers with (useChallengeAction), and kept up to date from the list every reminder refresh reads (`syncSavedWithList`: a row replaces the copy's `challenge`, `participants`, `me` and `unreadTaunts`, and its `myTimezone` and `myDays` when it has them (an older server's list leaves them out), a row that no longer qualifies drops it, and a qualifying row with no copy has its detail read once by `refreshReminders`), read by useChallenge's fetch while react-query holds nothing for it and put in first with `updatedAt: 0`, so a failed fetch leaves it on screen as a failed refetch would. Another account's copy is never read back (nor a detail whose `me` is not the stored account), and `forgetStoredSession` removes it, queued behind a save still running
services/session.ts    renewTokenIfDue(client, onToken?): when tokenRenewedAt is missing, in the future or ≥ 7 days old → POST /auth/refresh, store the token (only if the stored one is still the token that asked, so a logout mid-request is not undone), stamp tokenRenewedAt, onToken(token). Never throws. Called from hydrate and from the headless task
store/ui.ts            vulgarity level used for UI copy (mirrors me.vulgarityMax)
hooks/*.ts             useMe, useChallenges(status), useChallenge(id), useFriends, useInbox, useUnreadCount (30 s poll while foreground), mutations
hooks/useInviteLink.ts { link, isLoopback, isLocal }: `<publicUrl from /health ?? serverUrl>/davet/<my invite code>`, the one link Kankalar → Paylaş and the results' "Gruba at" send
hooks/useNewKankaToast.ts useNewKankaToast() → (friend, invitable, otherwise) for "Kanka oldunuz" after a "Kabul" (3.3 friends.tsx); invitableForNewKanka(invitable, cached list, friendId, clock) picks the çelınc it names
services/offlineQueue.ts entry writes that fail with no connection, a 5xx (not a 507 `disk_full`, the photo's or the entry's own, whose message the form shows) or `not_koydum` are parked (useAddEntry, with the çelınc's `challengeTitle` from the cached detail or lists) and replayed oldest first on every successful write, mount, foreground and background run; a write that reaches the server drops the copy parked under its own key before that drain (`dropParked`), so a second "Geldim" that got through is not replayed into `already_checked_in` and told as refused, nor a corrected day put back to its older number. A flush reads the queue once, so right before each POST (after its photo, which may take 120 s) it reads it again and skips an item that is gone or was parked again meanwhile (same id, another `queuedAt`); it removes, updates and finally merges only the item it read (id and `queuedAt`), so a correction parked during the flush waits for the next one instead of being overwritten by the older copy. While the friend's own write of a day is on its way, a flush leaves that day's parked copy alone (useAddEntry holds its key with `holdParked` until that write has dropped the copy or parked its own value in its place; the flush checks it after that re-read, with nothing awaited before the POST): sent then, the older value landed after the newer one and the server, which keeps a day's last write, kept it ("Yapmadım" put back to "Yaptım"). Every change to the stored list (parking, `dropParked`, a flush's photo path, removal and final merge, `clearFailed`) runs one at a time behind the one before it (`mutateQueue`), never across a request: AsyncStorage answers from its native thread, so a tap being parked and a flush storing what it sent each read the list before the other wrote, and the later write dropped the other's change (a glass told "Sıraya alındı" was gone). A parked check-in answered 409 `already_checked_in` counts as sent: its first send landed and only the answer was lost. `server_down` and `not_koydum` stop a flush like no connection, photo uploads included: never sent, never refused, and, as with no connection, no try toward the 8 that give up (only a 5xx answer other than 507, or a slow photo, counts one). A 507 `disk_full` answer to the entry itself stops the flush the same way: the server's disk is full, every entry behind it would get the same, and eight flushes come in minutes. Any other 4xx in our envelope is final (a check-in's `checkin_today_only` is told as "Check-in sunucuya ulaşamadan gün bitti, o gün sayılmadı."): NotificationBridge tells it once, and only while the app is on screen (`AppState.currentState === 'active'`; the background handler leaves refused items in the queue and the next foreground tells them). The toast ("Bir giriş gönderilemedi" / "N giriş gönderilemedi", 8 s) names the first one: "“<çelınc>” · <Bugün|Dün|8 Eylül>: <reason>", plus "N giriş daha gitmedi." when there are more; an item parked before `challengeTitle` existed is named from the cache or not at all. Only the items in that toast are cleared (`clearFailed(ids)`), after it is raised. An entry may be parked with `proofLocalUri`, a proof photo the entry modal could not upload: the image picker's own cache file, never sent to the server. The flush uploads it first and stores the returned path in `body.proofUrl` before the POST (a failed POST does not upload it again); no connection keeps it, a 5xx counts an attempt. A 429 `upload_limit` or 507 `disk_full` holds it without one: the item gets `photoHeldSince` (the first such answer) and the flush goes on to the entries behind it; an hour after that (`PHOTO_HOLD_MS`) the photo is dropped and the entry goes without it, a refusal's reason then starting with the server's message ("Sunucunun diski dolmak üzere, … Bu çelıncta kanıt fotoğrafı zorunlu."). Time, not flushes: every foreground and saved entry flushes, and eight tries spent in minutes threw away entries the server would have taken without the photo. A photo that can never go up (400/413, or a status-0 failure twice while /health answers: the OS cleared the cache) is dropped and the entry goes without it; when the çelınc then refuses it (`proof_required`) the reason starts "Kanıt fotoğrafı telefonda bulunamadı." An upload that runs out of its 120 s is not tried again in that flush: if /health fails too it stops the flush like no connection; if /health answers, the connection is only too slow for the photo, so the item gets `photoSlowTries` + 1 (and an attempt) and the flush goes on to the entries behind it. On the third such flush the photo is dropped the same way, the reason then starting "Kanıt fotoğrafı gitmedi, bağlantı çok yavaştı." Each item carries `ownerId` (the stored profile's id when it was parked): a flush under another account on the same phone skips it and keeps it for its owner, so one account's entry and photo never go up with another's token (items parked before the field existed go with whoever is logged in). The refusal toast and the parked check-in whose tap time a new "Geldim" keeps (`pendingForChallenge`) read only that account's items the same way: another account's refusal stays queued, failed, until its owner signs in again and is told (shown to whoever had the phone next, it named somebody else's çelınc and was cleared before its owner heard).
services/steps.ts      getDailySteps(days: number): Promise<{ dayKey, steps, source }[]> + syncSteps(); platform files: steps.native.ts (ios Pedometer.getStepCountAsync per day; android: per day the largest of Health Connect (aggregate per day; a 0 day is dropped, since an empty Health Connect answers 0 everywhere), the Recording API and Pedometer.watchStepCount accumulated per day in AsyncStorage (expo-sensors drops the sensor while the app is off screen, so the first event back carries everything walked meanwhile: within the day it counts, across midnight it is dropped rather than put on the morning, which counted the evening twice beside the Recording API; a phone with only this counter loses that jump and stays "yaklaşık", with Beyan et); a row keeps source 'health_connect' only for a day Health Connect won. getStepAvailability names Health Connect as the source only when it holds steps from the last 7 days, otherwise it reports the phone's own count with `hcEmpty: true` (Health Connect ships with Android 14+ and is often empty). requestStepPermission asks Health Connect, then ACTIVITY_RECOGNITION, then starts recording, and is true when ACTIVITY_RECOGNITION was granted, or Health Connect was and holds steps from the last 7 days: an empty Health Connect's yes alone counts nothing, so it answers false and the callers show the way to the phone's settings. After a Health Connect yes, when it holds steps from the last 7 days and the APK reports 1.1.1+ (`Application.nativeApplicationVersion`; 1.1.0 shares the update runtime but its manifest lacks READ_HEALTH_DATA_IN_BACKGROUND), it also asks for `BackgroundAccessPermission` in a separate, separately caught request whose answer never changes the result: Health Connect refuses reads from a closed app without it, so the 15-minute task got only the phone's own count. healthConnectBackgroundMissing() → true when that APK has Health Connect granted for Steps but not for background reads (false on 1.1.0, without Health Connect, or on a throw); requestHealthConnectBackground() asks for it alone → granted); on web steps.ts itself answers (returns [], false for both)
services/recordingSteps.ts Android steps recorded by Google Play services' Recording API (local module `KoydumSteps`, modules/koydum-steps, play-services-fitness 21.3.0): status() / subscribe() / dailySteps(days ≤ 10). Read by steps.native.ts beside Health Connect and the foreground counter; per day the largest of the three wins (all undercount; never summed). Since Android 9 a background app gets no step-sensor events, so this is the only way to count while the app is closed.
services/screenTime.ts   getScreenTimeAvailability() / requestScreenTimePermission() / getDailyScreenMinutes(days): looks up the local Expo module `KoydumScreenTime` by name (requireOptionalNativeModule); Android + usage access → real numbers, everywhere else `available: false` with a reason (ios | web | needs-native-module | permission | error). usageAccessMayBeRestricted(): Android at API 35+ (Android 15), where usage access for an app installed from a file is a "restricted setting" whose switch stays grey; with USAGE_ACCESS_RESTRICTED_HINT, the way out (tap it once, then App info → ⋮ → "Kısıtlanmış ayarlara izin ver", worded to hold across versions and brands). An API-level guess, not a check: knowing for sure needs a new native call
services/screenTimeSync.ts syncScreenTimeNow(): POST /me/screen-time with the last 7 days when the phone can read them; twin of stepSync.ts, called from the same places
modules/koydum-screen-time/  local Expo module (Kotlin): UsageStatsManager.queryEvents → foreground minutes per local day, an app's interval closed by its pause/stop, by SCREEN_NON_INTERACTIVE (16, the screen going dark; not 17, KEYGUARD_SHOWN, which a delayed lock postpones) or by shutdown; com.android.systemui and the home screen are left out like Digital Wellbeing does (the default HOME activity, or every HOME package when none is picked; never "android", the chooser, or com.android.settings, FallbackHome); app.plugin.js adds PACKAGE_USAGE_STATS (tools:ignore=ProtectedPermissions) and a `<queries>` MAIN/HOME intent to the manifest, without which Android 11+ package visibility shows only FallbackHome and the launcher counted (1.1.0)
services/deviceHealth.ts getBackgroundHealth() → { batteryUnrestricted, exactAlarms, xiaomi } | null, requestBatteryExemption(), openExactAlarmSettings(): the local Expo module `KoydumDevice` looked up by name like screenTime.ts; null / false on iOS, web, Expo Go and an APK without the module, and when the module throws. `xiaomi` comes from expo-device manufacturer/brand (Xiaomi, Redmi, POCO). openAppSettings(): `Linking.openSettings()` (KOYDUM's page, where a refused notification or activity permission is switched back on; Android stops showing the dialog after the second no), every native platform, false on web or a throw
modules/koydum-device/   local Expo module (Kotlin): PowerManager.isIgnoringBatteryOptimizations; ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS for the app (fallback: the optimisation list); AlarmManager.canScheduleExactAlarms (true below API 31); ACTION_REQUEST_SCHEDULE_EXACT_ALARM for the app (fallback: app details). expo-notifications sets its alarms exact only when that last one is allowed
components/OtaReadyCard.tsx home card under UpdateBanner for an over-the-air update (expo-updates) that is downloaded but not running: expo-updates looks only on a cold start and, with `fallbackToCacheTimeout: 0`, keeps running the old bundle that start. On every AppState active (not on mount: the cold start looked) it runs `checkForUpdateAsync` and, when `isAvailable`, `fetchUpdateAsync`, at most once per 30 min (a module-level timestamp, kept across remounts, never read in render; a failed check or download does not count, every error swallowed). Shown while `useUpdates().isUpdatePending`: title by level (1 "Güncelleme hazır", 2 "Güncelleme hazır, bir yenile", 3 "Eski sürümle gezme, yenile 🍆"), body that "Yenile" restarts the app into the new code and that otherwise a full close and reopen does; "Yenile" → `reloadAsync` (a refusal is swallowed), "Sonra" hides it until the screen mounts again. Never reloads by itself (a resume from a notification would lose its screen, a focus session or photo pick its state). Nothing on web (the web stub reports `isEnabled`), in `__DEV__` (every call rejects) or when `Updates.isEnabled` is false
components/PermissionBanner.tsx home card above BatteryBanner: shown while pushPermissionStatus() (expo-notifications getPermissionsAsync, never asks; 'unknown' on web) is 'denied'. Body by level: without the permission "KOYDUM MU?" and the check-in reminders never ring. "Ayarları aç" → openAppSettings (services/deviceHealth: `Linking.openSettings()`, false on web; a failure toasts the path), "Kalsın" → `StorageKeys.dismissedNotifCard` for good; re-checked on AppState active, so switching it on hides the card
components/BatteryBanner.tsx home card, once: shown when the stored push reason (`StorageKeys.pushReason`, written by NotificationBridge after every registerForPush) is 'no-fcm' and getBackgroundHealth says battery-restricted; "Kısıtlamayı kaldır" → requestBatteryExemption, "Kalsın" → `StorageKeys.dismissedBatteryCard` for good; re-checked on AppState active
services/notifications.ts  registerForPush({ askAgain? }) → token or null (never throws; web returns null; asks for the permission when not granted, except that NotificationBridge passes `askAgain: false` and so asks only when nothing has this app run: a no on the welcome slide is not followed by the same dialog on home. startForegroundStepTracking treats the physical activity dialog the same way; taps always ask); pushPermissionStatus() → 'granted' | 'denied' | 'undetermined' | 'unknown' (never asks); setNotificationHandler; Android channel; response listener → NotificationBridge opens the route with `router.navigate`, a tab through `goToTab` (the route keeps `notificationId` so the tap marks the row read, 3.5); getInitialRoute() → the launch tap's route, once per process: the OS keeps the last response (warm taps included) until the app exits and the bridge asks on every sign-in, so a response whose id was already handed out, by getInitialRoute or the listener, answers null (a logout and login, or a move to another server, opened the old çelınc again)
services/notifications.ts fireLocal(title, body, data) — used when a new inbox item arrives that was not pushed (device without push). On Android it posts on the `koydum` channel (trigger `{ channelId }`); a `null` trigger would land in the library's English "Miscellaneous" fallback channel
services/background.ts   BackgroundTask (15 min): sync steps + fetch unread inbox → fire local notifications for new items (skip on web / Expo Go gracefully). With the app swiped away the task runs headless (services/backgroundWork.ts) and does the same from the stored session (and re-plans the phone's own reminders, 3.5), renewing the token first when it is due (a phone only ever woken by the task must not lose its session at day 90). A 401 there (in our envelope; a proxy's page never, lib/api.ts) ends the session as the app's logout does on the phone (`forgetStoredSession`: token, its stamp, me, serverId, push token, inbox cursor, saved check-in details; and `clearReminders`) and stops the run; the offline queue stays for the next sign-in. The app entry `index.ts` (package.json `main`) imports `expo-router/entry` and then this file, so the task is defined even in a headless run, where expo-router never renders `_layout`; an undefined task is unregistered by expo-task-manager.
services/inboxNotifier.ts deliverNewInbox(client, surface | () => surface) → { surface, items }: the one place that turns unread, un-pushed inbox items into phone notifications (or, when on screen, items for ONE in-app toast of the newest with "N bildirim daha"). The surface is resolved after the fetch. Shared by the foreground poll, the background handler and the headless task. Only rows newer than the stored lastInboxId count (one full page of 100 is fetched); delivered ids are remembered (last 100) so racing checks never show an item twice; the first check on an install replays nothing (an empty first inbox stores a sentinel so the first row that ever arrives is shown); more than 3 new items → 2 shown + one "N bildirim daha". A phone holding a registered push token only updates the badge: push delivers there, and a local copy shown before the server's next flush would ring twice. This is what makes "KOYDUM MU?" reach a closed phone on a build without Firebase (registerForPush reports reason 'no-fcm', settings says "Gecikmeli").
services/focus.ts        focus session engine: start/stop, AppState listener → abandon when app leaves foreground > 10 s (grace), persists in-progress session to survive reload; `finishEarly` ends a live session on its whole minutes when the çelınc is about to end
theme/                   colors, spacing, typography (dark neon), components: Screen, Button, Card, Avatar, Chip, Stat, ProgressBar, Countdown, EmptyState, Toast, TauntBubble, Confetti (reanimated, optional), Sheet
components/Button.tsx    the label stays inside its pill: the row is capped at the pill's width and the one-line label shrinks into "…" while the icon keeps its size (never a smaller font). Uncapped, a label longer than the pill ran out of it and under its neighbour (Kankalar's "BAĞLANTIYI KOPYALA" under "PAYLAŞ" at 390 px)
components/Screen.tsx    pads the top by insets.top. `safeBottom` adds insets.bottom at the end: Android draws every route edge-to-edge, and a 3-button bar (48 dp, common on Samsung) covered the bottom of the last button. A scroll screen gets it at the end of its content (32 dp + insets.bottom, so the content still scrolls under the bar), one that does not scroll in its body's paddingBottom (on top of `bottomInset`). Passed by the stack screens that end in a button: entry, settings, user/[id], davet/[code], login, register, server and every focus state; history pads its FlatList's end the same way, onboarding its footer (max(insets.bottom, 24 dp)). Never on a tab screen: it reads the same inset and the tab bar already stands on it. The wizard's footer and every Sheet pad themselves (max(insets.bottom, 16 dp))
components/Toast.tsx     ToastProvider + useToast; ToastView draws the toast. A Sheet is an RN Modal (its own window on Android and iOS, a body portal on web), so a toast drawn in the root tree sat under its scrim: every visible Sheet registers with useToastLayer, the one opened last draws the toast inside its Modal (after the KeyboardAvoidingView, so the keyboard does not move it), and the provider draws it only while no Sheet is open. A Sheet whose screen loses focus (a toast's onPress or a notification pushed the next screen with it open; Android dismisses its dialog with the screen) closes itself (`onClose`) and gives the layer up at once, via the screen's `NavigationContext` (none in component tests: always in front) Animated stops a running fade when the last view on its value unmounts, so the view that draws the toast next finishes the fade (a "Şikayet alındı" raised in the tap that closed the sheet stayed invisible otherwise)
hooks/usePullRefresh.ts  usePullRefresh(run) → { refreshing, onRefresh } for every pull-to-refresh: the spinner runs from the pull until `run` settles and at no other time. react-query's `isRefetching` is also true for the 45 s / 60 s polls, push invalidations and step syncs, which dropped the spinner in by itself
utils/keyboard.ts        keyboardBehavior(): 'padding' on iOS and Android, none on web. `Screen keyboard` and every Sheet (a KeyboardAvoidingView around backdrop and sheet, so only the sheet rises; its 88% maxHeight is of what the keyboard leaves) lift their content with it: Android builds and RN Modals are edge-to-edge on every version, so `adjustResize` no longer shrinks the window. Screen's offset is 0 on Android (the frame is measured below the root's paddingTop) and stays insets.top on iOS, whose modal routes are page sheets, plus the offline strip's height while it shows. Forms with several fields chain "İleri" (`returnKeyType="next"`, `submitBehavior="submit"`, focus the next field's ref): login, register, "Şifreni değiştir"; password fields are `autoCapitalize="none"`, `autoCorrect={false}`. A pressable Chip reaches 4 dp past each side (`hitSlop`, half of a chip row's 8 dp gap both ways, so two neighbours' slops never overlap, beside or in the wrapped row below) and reports `accessibilityState.selected`; the header back/close circles take `hitSlop={8}`
utils/format.ts          formatNumber (tr-TR; the shared formatNumberTr, so a typed 2,25 km reads "2,25" in the toast as in the standings and the feed), formatDuration, relativeTime (tr; given the zone of the date beside it, i.e. the feed row's day, the inbox's day header, the results' range and the closed çelınc's "Kapandı", a gap of a day or more counts calendar days there, so "Dün" never sits next to "2 gün önce" nor "31 Aralık" next to "dün"), clockGapTr ("3 saat 5 dakika"), dayKey helpers (formatDayKey is shared formatDayKeyTr), dateRange(startsAt, endsAt, tz) → "1 Eylül – 8 Eylül" / "8 Eylül" (results and the rules card)
utils/serverClock.ts     the server's clock as this phone sees it: noteServerTime(iso, sentAt, receivedAt) from every /health the connection probe (hooks/useConnection.ts) and useServerInfo read keeps `offset = time − midpoint of the round trip`, ignoring a round trip of 5 s or more; clockSkewMs() (null before the first), serverNow() (the phone's clock until then), subscribeClockSkew / useClockSkew (useSyncExternalStore), forgetServerTime() (store/auth on logout and on setServerUrl to another address: the old server's clock says nothing about the next). The wizard's "Hemen" and "yarın" count from serverNow()
components/ClockSkewCard.tsx home card under BatteryBanner and Ayarlar card after Sunucu, while |skew| > `CLOCK_SKEW_WARN_MS` (3 min): title by level (1 "Telefonunla sunucunun saati farklı", 2 "Saatler tutmuyor", 3 "Saatler şaşmış, çelınc yanar 🍆"), body "Sunucunun saati seninkinden 3 saat geri." (clockGapTr: "20 dakika", "3 saat 5 dakika", "4 gün"; "ileri" when the server is ahead) and what to do: the phone's automatic time first, else the server PC's Windows Ayarlar → Zaman ve dil → Tarih ve saat → "Saati otomatik olarak ayarla" + "Şimdi eşitle". Nothing to close; it goes when the clocks agree
utils/challengeWindow.ts computeWindow(startMode, days, tz, now, type?, deadlineTime?) → { startsAt, endsAt, startsTomorrow }: the wizard's window in the account's zone, the end snapped to the last millisecond of the last day (a window too short to be legal: 24 h steps); "Yarın" at `nextDayStartTime`, and a check-in "Hemen" past today's deadline moved there (`startsTomorrow`)
utils/joinWindow.ts      joinClosesAt(challenge) (the server's `acceptClosesAt`, else the shared function) and stillJoinable(challenge, clock): pending/active and `clock` before it. `clock` is the last fetch's time, never `Date.now()` in render
utils/turkish.ts         upperTr (İ/I by hand before toUpperCase), dativeTr(name) → "Can'a" / "Gül'e" / "Ali'ye" / "Mustafa'ya" by the last vowel (a short list of soft-"l" names takes "e": "Kemal'e", "Hilal'e"), null when the name ends in no letter or has no Turkish vowel
```

### 3.3 Routes (`src/app`)

```
_layout.tsx                 providers (QueryClientProvider, GestureHandlerRootView, SafeAreaProvider), hydrate auth,
                            notifications setup, Stack with <Stack.Protected guard={!token}> (auth) and guard={!!token} (app)
(auth)/login.tsx            username/password, link to register, forgot-password hint (ask the server's owner), "Sunucu adresi" link; after a 401 logout shows the server's reason once (store `sessionEndReason`, e.g. "Şifren değişti, bu telefondaki oturum kapandı. Yeni şifreyle gir."), or "Oturumun düşmüş, bir daha gir." when it gave none (store `sessionEnded`, both cleared on mount); ChooseServerCard on top while no server is chosen (3.2)
(auth)/register.tsx         + display name (the username field folds as typed: "Şeyma" shows as seyma), vulgarity level picker (with live preview of a taunt at that level); ChooseServerCard like login. A 409 `username_taken` for the very name and password of an earlier try that got no answer (status 0 or `server_down`) signs in with them through POST /auth/login and goes on as after a sign-up (onboarding): that try made the account, and the friend used to sign up as zeynep2 beside an empty zeynep. A wrong password there keeps "kapılmış"; no answer again says so
(auth)/server.tsx           edit server URL or paste an invite link (parsePastedInvite; a code in it is parked as the pending invite on "Kaydet"), "Bağlantıyı test et" → GET /health; "Tahminimi kullan" hidden on a phone when the guess is loopback
onboarding.tsx              4 slides (copy onboarding_1..4 under a title per level; the copy never says its title again,
                            quoting it is fine), shown once after register. The 4th explains the two permissions
                            and asks for them: "Bildirim izni" → registerForPush, "Adım izni" → requestStepPermission, each
                            turning into a "✅ … verildi" chip once granted (a no keeps the button and says Ayarlar can do it
                            later). "Geç" before the last slide jumps to it; "Geç" / "BAŞLAYALIM" there → setOnboarding(false)
                            + home, whatever was answered. Leaving any other way (Android back) also clears the flag (unmount).
                            Each slide scrolls on its own (a short phone or a large font still reaches the two buttons)
(app)/(tabs)/_layout.tsx    Tabs: index "Çelınclar", friends "Kankalar", inbox "Gelen Kutusu" (badge = unread), profile "Ben"
(app)/(tabs)/index.tsx      header: today's steps + sync button + level chip; sections: Davetler (accept/decline inline;
                            "Reddet" asks first, and says so when the no would cancel the çelınc; each card says who invited
                            (`me.invitedBy`, from an older server the creator),
                            "📅 7 gün · 1 Eylül – 7 Eylül" in the account's zone (cut to `myDays`, 1.7), "· 📸 Kanıt lazım" when a typed number needs a
                            photo, and "🎁 … · 💀 …" on up to two lines; only invites still open: `stillJoinable`, pending/active
                            and before `acceptClosesAt`, read against the list's last fetch; the line over "Kabul" is
                            `challenge_pending_you` ("… Kabul edersen başlar.") only while pending, and on an active one says it
                            already started: 1 "Bu çelınc başladı bile. Kabul edersen hemen sıralamaya girersin.", 2 "Çelınc başladı
                            bile, atla da sıralamaya gir.", 3 "… katıl da gör kim kime koyuyor 🍆"),
                            Aktif (cards: emoji, title, countdown, mini standings, my rank; losing → red "yiyorsun" chip;
                            fewer than two accepted → "RAKİP YOK" chip and no verdict line; past `endsAt` but still
                            `active` (the settle hour, an itiraz's 12 hours) → "⏳ Sonuç bekleniyor", the chip as it stands
                            but no verdict line and no red glow, as the çelınc screen; a pending card past its start
                            → "🚦 kabul bekleniyor" with fewer than two accepted, "🚦 başlıyor" with two (the server's
                            next pass starts it; a list read before that says pending), not the countdown's "Bitti"),
                            Bekleyen, Biten (newest 5; the header counts all of them, and past 5 a "Hepsini gör (N)"
                            button opens history; a finished çelınc I never answered → "KAÇIRDIN" chip, not "DAVET"; won / lost
                            → "KOYDUN" / "YEDİN", at my level 1 "KAZANDIN" / "KAYBETTİN");
                            FAB "Çelınc Aç". Under the header: UpdateBanner, OtaReadyCard, PermissionBanner, BatteryBanner, then ClockSkewCard.
                            A refused "İZİN VER" toasts "Dokun, ayarları açayım" (8 s); the tap → openAppSettings
(app)/(tabs)/friends.tsx    list friends (tap → user/[id]), incoming/outgoing requests (an outgoing one has "Geri çek":
                            confirm → DELETE /friends/:userId?only=request), search by username, my invite code ("Kopyala"
                            copies the link, the bare code without one: "Bağlantıyı kopyala" did not fit half the card; screen
                            readers hear "Davet bağlantısını kopyala" / "Davet kodunu kopyala"; Paylaş sends inviteShareText
                            (utils/shareText.ts) at my level: 1 "KOYDUM'da yarışalım mı? 🤝",
                            2 "KOYDUM'da kanka olalım 🍆", 3 "… bakalım kim kime saplıyor 🍆", then the link and "Açılmazsa davet kodum: …");
                            "Kod ile ekle" toasts by the answer: `accepted` (a young account, 2.2) "Kanka oldunuz", else "İstek gönderildi.";
                            "Kabul" on a request (and the profile's "Kanka isteğini kabul et") toasts "Kanka oldunuz" through
                            hooks/useNewKankaToast.ts: with a running çelınc of mine that could take them (the answer's
                            `invitable[0]`; from an older server that sends none, the cached list's soonest-ending çelınc I am
                            `accepted` in, `stillJoinable`, with them not on it unless they declined) the body names it at my level
                            (1 "Cem artık listende. “Ofis Ligi” çelıncına davet edebilirsin.", 2 "… çağır, grubu bölme.",
                            3 "Cem geldi 🍆 “Ofis Ligi” çelıncına çek, o da yesin."), stays 8 s, and the tap opens
                            `/challenge/[id]?invite=<their id>`; else the screen's own "Aç bir çelınc" line
(app)/(tabs)/inbox.tsx      inbox list grouped by day; taunt items rendered as TauntBubble (big, red, shame) under the sender's name and
                            avatar (`data.fromUserId`, else the winner); tap → challenge or friends (a `friend_accepted` with a
                            `challengeId` → that çelınc with `?invite=` the new kanka); "Hepsini okundu yap";
                            pages of 30 (useInfiniteQuery on qk.inbox): reaching the end, or "Daha eskileri göster", loads the next
                            older page with `before` = the last row's createdAt + 1 ms (rows sharing that millisecond come again and
                            are shown once); a failed older page keeps the list, says "Eskiler gelmedi" and only the button retries
(app)/(tabs)/profile.tsx    me: avatar emoji picker, stats grid (Koydum 🍆 / Yedim 😵 / Berabere / Kanka / Çelınc / Rövanş; at my level 1 Galibiyet 🏆 / Yenilgi), badges (named by `badgeTitle` at my level; at my level 1 the Koyuş / Yiyiş ladders are headed Galibiyet / Yenilgi; a locked rung asks in the unit its progress counts, focus in minutes "Toplam 3.000 dakika odaklan" over "1.280/3.000", and the step rung says "(telefonun saydığı)", since that ladder reads `steps_daily` alone and a "Beyan et" day never moves it), leaderboard preview ("en çok koyanlar", "N koyuş"; at my level 1 "en çok kazananlar", "N galibiyet"; a failed refetch keeps the last board with a faint "Güncellenemedi, son gelen sıralama bu." over it; the error and "Tekrar dene" only with no board to keep), settings link, logout
(app)/challenge/new.tsx     4-step wizard: 1) tip seç (grouped by category, each shows emoji + name + desc at my level)
                            2) ayarlar (title, start now / tomorrow (both counted from the server's clock, serverNow(): a phone running slow is
                            not refused for a start in the past; "Yarın 09:00", for a check-in type `nextDayStartTime` (1.2): "Yarın 04:00"
                            for erken_kus, "Yarın 05:00" for yatak_toplama; a check-in "Hemen" past today's deadline (the typed hour,
                            `effectiveDeadline` while it is half typed) starts there too, with "Bugünün check-in saati geçti, ilk check-in
                            yarın." under the choice; so "N gün" is N deadlines that can be played; utils/challengeWindow.ts),
                            duration days 1/3/7/14/30 or custom, deadline time for checkin, proof toggle, reward, penalty;
                            a deadline at or before the type's window start is refused on the spot with the schema's message, and an
                            evening window's hint adds "Gece yarısını geçen saat olmaz, en geç 23:59.")
                            3) kankalar seç (multi-select friends) 4) özet + "KOY BAKALIM" create;
                            Android back steps back like "Geri"; on step 1 with a type chosen it asks before closing
                            (nothing chosen → the modal closes)
(app)/challenge/[id].tsx    detail: hero (emoji, title, status/countdown), standings (ranked bars with scores + "koyuyor/yiyor" labels;
                            every row but mine opens that player's profile; once finished an unanswered invite is not listed;
                            while `active` and before `endsAt`, an accepted rival whose `lastSyncAt` is 3 hours or more older
                            than the last fetch gets a faint line under the bar, at my level: "Telefonundan 5 saattir veri
                            gelmedi" / "Telefonu 5 saattir ses vermiyor, sayı eski olabilir" / "Telefonu 5 saattir ölü, bu sayı
                            bayat", "2 gündür" from 48 hours on; none on my row or with a null `lastSyncAt`; a
                            player whose `timezone` is not mine gets "(Tokyo saati)" by the name, `zoneCityTr`: the
                            IANA city, in Turkish where it differs, "İstanbul", "Londra"),
                            a "Kurallar" card (components/ChallengeRules.tsx): the type's description at my level, "📅 N gün ·
                            1 Eylül – 7 Eylül" (the days I am scored on: cut to `myDays`, 1.7), "⏰ Her gün saat 07:00 olmadan “Geldim” demen lazım" with a deadline, "📸 Elle
                            girdiğin her sayıya kanıt fotoğrafı lazım" (only where a photo can back a number, the server's rule),
                            "⚠️ Girmediğin gün 1.440 dk yazılır" for a type with `missingDayPenalty`, 🎁 reward and 💀 penalty,
                            and "Nasıl sayılıyor?" folding `howMeasuredTr`; somebody invited, or who said no, while the çelınc
                            still takes players gets it right above "Varım" / "Katıl" with "Nasıl sayılıyor?" open, everybody
                            else below the action area, folded,
                            my action area per metric type (see 3.4), feed of recent entries ("Bugün · 👟 sayaç · 10 dakika
                            önce": a phone's row (`pedometer`, `health_connect`, `usage_stats`) is timed by `updatedAt ??
                            createdAt`, a typed one by `createdAt`, both read against the screen's clock, the last fetch,
                            as the standings' quiet-phone line is; a check-in of a player whose `timezone` is not mine
                            adds "Tokyo saatiyle 06:30 (sende 00:30)", its `createdAt` on both clocks; under it the
                            owner's `note`, “in quotes”, two lines at most, on the author's own row too) with dispute
                            button (only while
                            the server takes one: `active` and before `disputesCloseAt`, i.e. the end, plus the settle hour
                            of a phone-counted type or of one with a number typed in its last hour (2.3; from an older
                            server that sends none, `endsAt` plus the hour on a phone-counted type);
                            only to a reader who is `accepted`, and only on rows of players still `accepted`: an invitee
                            looking before "Varım" or a player who left would get 403 `not_participant`, and a leaver's row
                            counts for nothing; "🗑️ Sil" on my own typed rows likewise only while I am `accepted`);
                            with `feedCursor` set a ghost "Daha eski girişler" under it loads the older ones, the same rows
                            and chips, newest first with the detail's (`useChallengeFeed`: pages from the newest, the first
                            one 80 rows, so a refetch never leaves a hole where an entry pushed a row out of the detail's 40;
                            repeats dropped, and down to `feedCursor` only the detail's rows, so one deleted since a page
                            came does not stay), and stays while a page is left ("Eski girişler gelmedi. Bir daha dene." when one fails)
                            (every open dispute's `{ad}: “{reason}”` under a disputed row, an upheld one's under a rejected
                            row; a disputed row says "İtiraz var. {kalan} içinde kanıt gelmezse yanar." from `answerBy`,
                            "İtiraz 1/5. 4 kişi daha itiraz ederse 12 saatlik kanıt süresi başlar." from `disputeVotes`,
                            or "henüz çoğunluk değil" without either; the "İtiraz gitti" toast says "{kalan} içinde
                            kanıt gelmezse giriş yanar." when the response has `answerBy`; when it is null "{n} kankaya
                            haber gitti. Çoğunluk itiraz ederse sahibinin 12 saati başlar." with `othersCalled` > 0, and
                            only the second sentence otherwise (0, or a server from before the call, which sends no count
                            and called nobody but the owner); my own open dispute's chip is "Geri çek" (confirm →
                            DELETE); the owner's disputed row gets "Kanıt ekle", a sheet with the entry modal's camera /
                            gallery pick → /uploads → POST .../proof),
                            past `endsAt` but still `active` (settling, 2.4) → "Süre bitti / Sonuç birazdan" instead of the
                            countdown, under it what it waits for (an itiraz's photo; the phones' last numbers, "… En geç
                            bir saat içinde kazanan belli olur."; on a typed çelınc whose `disputesCloseAt` is past `endsAt`
                            "Son saatte yapılan girişler var, kankalar bakıp itiraz edebilsin diye sonuç bekliyor. …" (a yes/no tick or a check-in is no number), else
                            "Son hesap yapılıyor, bir dakikaya kalmaz."), no action area, "böyle devam" verdict, "laf sok" or "Ayrıl", one device sync on open
                            (the list card says "Sonuç bekleniyor" and drops its verdict line too),
                            "laf sok" per rival you lead, before `endsAt` — its note says "Öndesin" only to the sole leader (the
                            verdict's rule); one in the middle, or level at the top, is told whom they are ahead of ("Bunun
                            önündesin" over one name, "Bunların önündesin" over more) — opens a sheet of rendered `poke`
                            lines to choose from,
                            titled with dativeTr ("Mehmet'e ne diyelim?", "🔥 için ne diyelim?" when it gives null),
                            running (before `endsAt`) with fewer than two accepted → "Rakip bekleniyor / 1/2 kişi" hero
                            (the clock runs; nobody in by the end → cancelled) with a small end countdown, no
                            "öndesin" verdict and no "laf sok",
                            `pending` past `startsAt` with fewer than two accepted → "Kabul bekleniyor / 1/2 kişi" hero: it
                            starts with the second yes and the end does not move; a steps çelınc says the phones' days
                            already go in (all of them count), any other "Başlayana kadar giriş yapılamaz." (typing is
                            refused, and a screen-time average only counts from the day before the second yes); nobody
                            in by the end → cancelled; the creator is pointed at "İptal et" below,
                            `pending` past `startsAt` with two accepted (a detail from before the server's next pass: the
                            PC asleep, no signal) → "Bitmesine" with the end countdown and "Başlamış olmalı, sunucuya
                            ulaşınca burada da görünür." (L1 "Başlama saati geçti, çelınc başlamış olmalı. Sunucuya
                            ulaşınca burada da başlamış görünür.", L3 "Başladı bile lan, sunucu ya uyuyor ya sende
                            çekmiyor. Bağlanınca burada da görünür."), and before `endsAt` the action area as in a
                            running one: the entry's POST starts it on the server first (`activateDueChallenges`), and
                            with no answer the entry is parked. The entry modal and the focus timer it opens take it the
                            same way (`runningUnseen` in utils/joinWindow.ts, against the time they were opened), instead
                            of "aktif değil". The "Başlamasına" countdown running out moves the
                            screen's clock, so a start passing with no answer from the server gets here too,
                            invited → "Varım" / "Yokum" ("Yokum" asks first, like the home card; a "Varım" before the start
                            toasts "Çelınc başlayınca skorun sayılmaya başlar."); declined → "Reddetmiştin..." card with "Katıl"
                            (accept); both only while `stillJoinable` (pending/active and before `acceptClosesAt`, against the
                            last fetch): past it, the settle hour included, "Bu çelınca katılım kapandı." under the hero and no
                            "Kabul et" line under the standings; a successful "Varım", "Katıl" or the
                            home card's "Kabul" on a phone-counted type runs one device sync (`services/deviceSyncNow.ts`)
                            for the days the phone never sent,
                            any player still `accepted` in it (not only the creator), while `pending` or running and before
                            `acceptClosesAt` → an `invite_friends_cta` button under the standings ("Kanka ekle"): a sheet that
                            loads GET /friends only when opened and lists my friends not on the line-up (a declined one is offered
                            again; anybody accepted, invited or left is not), multi-pick within the 15 cap (everybody accepted or
                            invited but the creator) → POST .../invite; `?invite=<userId>` (the "Kanka oldunuz" toast and
                            notification) opens the sheet at once with that friend ticked,
                            toast "Davet gitti: Cem, Can."; no friends left → "Kankalara git",
                            "Ayrıl" (only to a player `accepted` in it: an invitee has "Yokum") / "İptal et"; finished → button to results;
                            a failed refetch keeps the last detail with a faint "Sunucuya ulaşamıyorum, gördüğün son bilinen hali."
                            line ("Girişin sıraya alınır…" while I can enter); "Çelınc gelmedi" is only for a çelınc never loaded,
                            and a 404 still shows "Bu çelınc sende yok". A check-in çelınc is also kept on the phone
                            (services/savedDetails): an app opened cold with no answer (the morning reminder's tap after
                            the phone killed it overnight) draws that copy with the same line and parks the "Geldim"
(app)/challenge/[id]/results.tsx   winner view: podium + "KOYDUM MU?" CTA per loser in `canTaunt` (or "Hepsine koy"; a loser behind a block keeps the row, without a button; with every loser behind one, "Aranızda engel var, laf gitmez." (L1 "Aranızda engel olduğu için mesaj gönderilemiyor.", L3 "…, bu sefer laf yok 🍆") in place of "Kime koyacağını seç…" and "Bu çelınc senin, keyfini çıkar." (L1 "Tebrikler, bu çelınc senin.") under the title in place of `challenge_finished_won`) → taunt picker; loser view: shame screen
                            (big TauntBubble if received, else "bekliyor..." — and 24 h after `finalizedAt`, counted from the
                            last fetch, "unuttu galiba, rövanş aç, bu sefer sen koy" instead; the header only says the laf is
                            "aşağıda" once there is one; under a received laf "Cevap ver" (L1 "Cevap yaz", L3 "Lafı geri sok 🍆") →
                            taunt picker `to` the winner, or, once answered, my answer as a smaller TauntBubble; the winner's
                            loser rows show each loser's answer under the name, "💬 …"), rewards/penalty text, "Rövanş" button with a note naming `rematchLeftOut`
                            ("Veli kankan değil, rövanşa çağrılmaz. Tablodan adına dokun, ekle."; final-table rows open profiles, and an
                            invite nobody answered is not on the table: Standings drops `invited` rows once `finished`, and on a `cancelled` çelınc's screen and card (`closed`)),
                            and a success toast naming whoever the new çelınc really invited (read back from its detail); once
                            `rematch` names one, the button leads there instead ("Rövanş daveti sende" / "Rövanşa git" → its çelınc,
                            once it is over "Rövanşın sonucu" → its results) with a line under it ("Ali rövanş açtı, davet sende.",
                            "…, sen de içindesin.", "Rövanşı sen açtın, davetler gitti.", "Rövanş da oynandı, sonucu orada.") and
                            no left-out note; `rematchInvitable` 0 greys the button out ("Rövanşa çağrılacak kimse kalmadı." when
                            the note names nobody); a 409 `rematch_exists` / `already_rematched` refetches the results and opens
                            the rematch they name, with the server's line as an info toast; while `rematch` names one, every
                            "rövanş aç" line above (the tie's, the one behind a tie, "unuttu galiba") points to it instead:
                            "Rövanşı aşağıda" (L2/L3 "…, oraya bak."); tie view
                            (a rank-1 player sees the lafs the other co-leaders sent them and "Laf at" (L1 "Mesaj bırak") → picker,
                            `to` the one other co-leader or, with more, no `to`; only co-leaders in `canTaunt` when the
                            server says `canTauntCoversTie`, so none behind a block; then "Lafını attın, sıra onda.", or "Lafını attın, ödeştiniz." once every co-leader has written to me too);
                            a player behind a tie gets the loser view without a laf: the shame header with "Laf hakkı berabere
                            kalanlarda, sen arkada kaldın. Rövanş aç." (L1 "Mesaj hakkı…", L3 "…öndekilerde…"), no "bekliyor" card
                            and no answer button, "Öndekilerle aranda … fark var." against the shared top score, the Ceza card
                            ("Öndekilerin ödülü: …", no `challenge_finished_lost` line) and the loser's rematch label;
                            anybody else gets "ÇELINC BİTTİ" 🏁, or in a tie the tie's title ("BERABERE" / "BERABERE LAN" /
                            "KİMSE KOYAMADI") with 🤝 but never its rematch line, under it "Sen bu çelınca girmedin, sadece izledin." for
                            somebody who never said yes (invited, declined, not in it), "Sen ayrılmıştın zaten, sonuç bu." for whoever is `left`
                            (a player who walked out, whose entries the detail still shows, or an invitee's "Ayrıl" an older server stored as a walk-out; one stored now is `declined`);
                            every player (not a watcher) also gets "Gruba at" (level 1 "Sonucu paylaş"): resultShareText
                            (utils/shareText.ts) writes "🚶 Haftalık Adım bitti (7 Eylül – 10 Eylül)", one line per player
                            who raced (🥇🥈🥉 by rank, so a tie has two 🥇, then "4." on; display name · score), a verdict at
                            the reader's level (tie / "Koydum, geçmiş olsun." / "Bu sefer Ali koydu, yedik." / behind a tie
                            "Ali ve Veli berabere kaldı, ben 3. oldum, yedik.") and my invite
                            link (useInviteLink) unless it is loopback or a home-network address. Phone → Share.share
                            ("Paylaşılamadı" toast on a throw), web → clipboard ("Kopyalandı"). "Çelınca dön" (here and on the
                            not-finished / cancelled states) uses `router.dismissTo`: back down to the çelınc the results were
                            opened from, or in their place when a push opened them alone; `navigate` reuses only the screen in
                            front and stacked a second copy of the çelınc over the results
(app)/challenge/[id]/taunt.tsx     picker: target chip(s), a context chip per loser from `tauntContexts` (RÖVANŞ / SERİ / EZİCİ FARK / NORMAL FARK / KIL PAYI;
                            without the field, the margin); a loser answering gets the winner as the only target and the CEVAP
                            (`reply`) pool ("Önce o konuşsun" before the winner's laf, "Cevabını verdin" after the answer), a
                            co-leader of a tie the other rank-1 players and the BERABERE pool (the winner's targets, and with
                            `canTauntCoversTie` a co-leader's, only those in `canTaunt`); list of templates of that context rendered with real names/scores (levels ≤ target max; higher ones shown locked with
                            "X bunu kaldıramaz" note), custom text field (banned-word check client side), preview, "GÖNDER" → success animation
(app)/challenge/[id]/entry.tsx     modal: log manual value (numeric pad, quick +1/+5 chips per unit), note, proof photo (camera/gallery → /uploads), day selector
                            (today/yesterday, `LIMITS.MANUAL_PICKER_DAYS`, which also starts a late joiner's screen-time window, 2.3;
                            only the days I am scored on (`myDays`, 1.7): when today is the sliver of a day another zone's end cut short,
                            it opens on the newest of them, or, before my first day, says "Herkes aynı sayıda gün oynasın diye bugün
                            sende sayılmıyor, ilk günün yarın." with Kaydet off; a manual_lower_is_better çelınc offers back to MANUAL_BACKFILL_DAYS so that first day can still be typed the day after; an auto_steps çelınc offers every window day back to STEPS_BACKFILL_DAYS as chips
                            labelled by formatDayKeyFriendly), the `day` param preselects a day it offers; a step day with an
                            upheld itiraz is locked like a device_locked one (server 409 `day_rejected`);
                            a manual_count çelınc says what is left of the day's cap cut down to the cent ("Bugün için kalan: 94,62 km."
                            after 5,375 km), never rounded up to a number the cap check would refuse; the day's sum and what is left
                            drop JavaScript's float noise first (`dropFloatNoise`, six decimals), as do the "+" chips' sums in the
                            field: 14,4 + 59,7 + 15,9 km is 90.00000000000001 in JS but 90 in the server's SUM, and "9,99 km kaldı"
                            refused the 10 the server takes;
                            the value is read by `parseTypedNumber` (utils/format.ts): on a `wholeNumbers` type "12.430" and "12,430" are
                            thousands (12430, as the app prints them) and a real fraction ("12,5") is refused on the spot ("Küsurat olmaz,
                            tam sayı yaz.", nothing sent); elsewhere one "," or "." is the decimal point ("5,2" = "5.2" = 5.2) and "1.234,5" is 1234.5;
                            on a phone, a photo that cannot go up for lack of a connection (or `server_down`/`not_koydum`) stays on the phone ("Fotoğraf telefonda",
                            previewed with "henüz gitmedi"), counts as the required proof for Kaydet, and goes up with the entry:
                            right then if the connection is back, else from the offline queue (`proofLocalUri`). The feed's
                            "Kanıt ekle" stays online-only. Both turn away a photo whose `fileSize` is over `LIMITS.UPLOAD_MAX_BYTES`
                            before uploading it ("Fotoğraf çok büyük"), except on Android, where expo-image-picker reports the
                            original's size from before its own quality 0.6 pass (there the server's 413 says it). A failed refetch keeps the form and what was typed, with a
                            "son bilinen hali" line; "Giriş yapılamıyor" is only for a çelınc never loaded or a 404
(app)/focus/[id].tsx        full-screen timer (pick 15/25/45/60 min), big countdown, "elini telefondan çek" copy, leaving app → abandoned state with copy focus_abandoned; completion posts entry;
                            while the timer runs, Android back (and any other pop: usePreventRemove) opens the same "Seansı bitirelim mi?" sheet as "Vazgeç" instead of leaving;
                            a failed refetch keeps the last detail and the timer (the "Seans açılmadı" screen is only for a çelınc never loaded);
                            the server refuses a focus entry from `endsAt` on, so a session fits the time left: start() caps the target at
                            the whole minutes until `endsAt − 30 s` ("Çelıncın bitmesine az kaldı, seans en fazla 20dk sayılır." on the
                            picker when that is under 60), under a minute blocks Başlat, and a session stretched by pauses past that
                            point ends there (`finishEarly`, whole minutes) and posts like a completed one;
                            the day takes 360 minutes (`focusMinutesLeft` over today's non-rejected myEntries): the picker says
                            "Bugün 30 dk hakkın kaldı" (", seans 30 dk sürer." when the preset is longer and the çelınc's end does not cut
                            it shorter still), start() caps the target there too, and at the cap "Bugünlük 360 dk doldu. Yarın devam."
                            (no "Yarın devam." on the last day) blocks Başlat; the done card shows what the server stored (`entry.value`),
                            not what the timer counted; the running timer scrolls (centred while it fits), so "Vazgeç" under the
                            paused card stays reachable on a short phone or with a large font
(app)/history.tsx           every finished and cancelled çelınc, newest closed first (the same `GET /challenges` list home
                            uses); chips Hepsi / Koyduklarım / Yediklerim / Berabere / İptal with counts (at my level 1
                            Kazandıklarım / Kaybettiklerim), read like the Karne
                            (a loss is someone else's win in a çelınc I played, or a place behind a tie; the home card
                            says YEDİN there too, KAYBETTİN at level 1); `with=<userId>` keeps the ones we both played
                            (both `accepted`) until "Herkesle"; `show=<chip>` opens on that chip (the rövanş badge → Yediklerim);
                            tap → results (finished) or the çelınc (cancelled); pull-to-refresh
(app)/user/[id].tsx         public profile (stats Koydu 🍆 / Yedi 🍽️ / Çelınc, at MY level 1 Galibiyet 🏆 / Yenilgi 😵; badges named by `badgeTitle` at MY level, not theirs) + head-to-head record vs me (finished çelınclar we both played, both `accepted`:
                            one who declined or left sits at rank 0 and is no round; tap → history `with` them) + a 🔥 line (for a çelınc
                            still active or pending with me `accepted` in it (utils/history `liveRivalry`): one they are `accepted` in too, an
                            active one first, ranks us ("şu an öndesin / geridesin / başa başsınız"; pending: "başlamak üzere, ikiniz de
                            varsınız."); else one they are only `invited` to says "… daha kabul etmedi." and is never ranked (an invitee
                            sits at rank 0), and the line above it drops "Bir çelınc aç"; one they declined or left gets no line) + "Çelınc aç" shortcut; not friends yet →
                            "Kanka isteği gönder", "Kanka isteğini kabul et" for an incoming one, "İsteği geri çek"
                            (confirm) for my own; "Diğer seçenekler": copy username, remove friend, report, block
                            (the toast says it can be undone under Ayarlar → Engellediklerin)
(app)/settings.tsx          vulgarity level (with preview), "Bildirim tercihleri" (reminder hour chips; "Geride kalınca dürt beni" and "Pazar akşamı haftalık özet" switches → PATCH /me `nudgesEnabled` / `recapEnabled` with a short optimistic override; "Saatli çelınc uyarıları", phone only and hidden on web → `setDeviceRemindersEnabled` + `refreshReminders`; a note at the reader's level that "KOYDUM MU?", pokes, invites and results cannot be switched off), timezone (auto; "Cihazdan güncelle" → PATCH /me, and a line that new çelınclar count their days in it while the ones already joined keep the zone they were joined in), server URL (editable builds only: a "Sunucu adresi" sheet taking a bare address or a pasted invite link — `koydum://…?server=` or `https://host/davet/CODE`, see serverFromInviteLink in services/invite.ts — and running moveSession: moved → level toast, different → confirm, logout, set the new address, login screen; unreachable → inline error), ClockSkewCard after it (also on builds with a baked-in address), push status + "yeniden dene" (reason 'denied' adds "Ayarları aç" → openAppSettings, push re-read on the next AppState active; the mount and that re-read only look, `registerForPush({ askAgain: false })`, so a no on the welcome slide is not met by the dialog again when Ayarlar opens; only "Tekrar dene" asks), "Adım sayacı" "İzin ver" (refused → the same tap-to-open-settings toast as home, except on web; `hcEmpty` → "Health Connect’e adım yazan bir uygulama yok; adımlarını telefonun kendisi sayıyor."; source 'health_connect' with healthConnectBackgroundMissing → a line that it is read only while KOYDUM is open and a secondary "Arka planda da okusun" → requestHealthConnectBackground, then both re-read; granted → "İzin alındı", refused → an 8 s toast whose tap opens Health Connect, since it also stops asking after the second no, and which names the way there: Health Connect opens on its home screen, and the switch (“Verilere arka planda erişim”) is not in KOYDUM's permission list but one level down, under “Ek erişim”, which a phone without the feature does not show; Health Connect opened from there or from "Health Connect’i aç" is re-read on the next AppState active), "Arka plan" (only when getBackgroundHealth answers, i.e. an Android build with modules/koydum-device: "Pil kısıtlaması" Yok/Var + "Kısıtlamayı kaldır", "Tam saatinde hatırlatma" Açık/Kapalı + "Alarm izni ver", each a system page re-read on the next AppState active; exact alarms newly allowed → `refreshReminders`, since alarms set before stay inexact; a Xiaomi line about "Otomatik başlatma"), "Ekran süresi" (reason 'permission' → "Kullanım erişimi ver" → the usage-access page, re-read on the next AppState active; on Android 15+ (usageAccessMayBeRestricted) also USAGE_ACCESS_RESTRICTED_HINT and "Uygulama bilgilerini aç" → openAppSettings, KOYDUM's App info where the ⋮ is, re-read on return; not opened → "Ayarlar açılamadı" with the path), "Engellediklerin" (my blocks from GET /users/blocked, "Engeli kaldır" → confirm → unblock; empty → "Kimseyi engellemedin."), "Şifreni değiştir" sheet (current / new / repeat; min length and mismatch checked inline, wrong_password and same_password shown under their field, success → setSession + level toast; a note under the button that the other phones are signed out), delete account (double confirm; the copy says what goes, the proof photos and notes, and what stays, the scores in finished çelınclar under "Silinen kanka"), about (+ "Yeni sürümü indir" when the server offers a newer APK)
davet/[code].tsx            invite deep link (koydum://davet/CODE?server=...), reachable signed in or not. Signed in: shows the inviter and sends the friend request only on a tap (a waiting request from that person would be ACCEPTED by it). A fresh install still on the localhost fallback adopts the link's server (after /health) without a conflict warning. Signed out: parks the code (services/invite.ts) and goes to register/login; the bridge sends it right after sign-in. Sent from an account in its first week, the code makes the two kankas at once (2.2), so neither card promises a wait for "Kabul"; the 'sent' outcome ("… kabul edince kanka olursunuz") is for an older account. The 'accepted' one, here and in the bridge's "Kanka oldunuz" toast, ends "İlk çelıncı aç, kim kime koyacak görelim.", at the reader's level 1 "İlk çelıncı aç, bakalım kim kazanacak." A `server` differing from the current one is shown and only switched to on an explicit tap (after a /health check); builds with a baked-in URL ignore it. Signed in, the screen also asks that server's /health for its serverId: unless it is known to differ from the stored one (or a tap already found another server), the card reads "Bu davet yeni bir adresten" and its primary button "Yeni adrese geç (çıkış yok)" runs moveSession; the logout buttons stay below as secondary. On 'moved' serverUrl is the link's, so the ordinary send-request card follows. Signed in, "Kankalara git", "Vazgeç" and "Ana ekrana dön" leave through `leaveForTab` (utils/navigation.ts): over a running app (`canDismiss`) `dismissAll` off the link, then `goToTab` on the next tick; a `replace` there put a second app with its own tab bar over the first (back: home, the çelınc that was open, home again). On a cold start from the link (nothing under it) a `replace`.
```

### 3.4 Per-metric action area (challenge detail)

Everything about one çelınc's days (today and yesterday, the window, the entry modal's days, the day a focus session
is written to, the check-in poke, the rules card's dates, the results' date range, the "Bugün"/"Dün" of a refused parked
entry's toast) is counted in its `myTimezone` (`useChallengeTimezone`; `me.timezone` from an older server). The rest
of the app (home's greeting, the inbox, the wizard, the recap) keeps `me.timezone`.

- auto_steps: "Bugün: 6.421 adım" + "Senkronla" (calls syncSteps → POST /me/steps → invalidate). Android while the count is approximate
  (foreground counter only, or the day recording started; a granted but empty Health Connect is not a source):
  shows "Yaklaşık (uygulama açıkken sayılıyor)" + manual "Beyan et" entry. A past window day within STEPS_BACKFILL_DAYS
  with no positive entry (a rejected one is the phone's to restore, so it does not count) → secondary "Eksik günü yaz",
  opening the entry modal on the oldest; when one of them is before `recordingSince()` a faint line says the phone
  started counting that day and a later, higher phone count still wins.
- focus_minutes: "Odak seansı başlat" → focus/[id]; today's total.
- checkin_deadline: big "GELDİM" button visible only today, and only when today is a day I am scored on (`myDays`;
  else "Herkes aynı sayıda check-in yapsın diye bugün sende sayılmıyor, ilk check-in günün yarın." / "…, son check-in
  günün dündü."); shows deadline; after tap → success or late copy. A parked
  one (no connection, server asleep) says "Check-in gitmedi, sırada" (toast, `danger`) and, under the still-enabled
  button until the server's entry arrives, "Sunucuya ulaşamadım. Sunucu uyuyorsa bastığın saat sayılır, telefonun
  çekmiyorsa gittiği saat. Bağlanınca uygulamayı aç." Another tap while one waits replaces it in the queue with the
  first tap's `clientTime`; one that gets through takes it out of the queue (`dropParked`). The action is keyed by
  today's day key: a screen left open overnight drops last night's "sırada" when the day turns.
- daily_boolean: the type's `askTr` ("Günün dumansız geçti mi?") above two buttons `yesTr ✅` / `noTr ❌` ("İçmedim ✅ / İçtim ❌";
  "Yaptım / Yapmadım" only for a type without its own), for today (when today is a day I am scored on, `myDays`; else
  "Herkes aynı sayıda gün oynasın diye bugün sende sayılmıyor, ilk günün yarın." / "…, son günün dündü.") and, while inside the window, yesterday: labelled
  "Dün (boş kalmış)" while empty, "Dün" with its answer chip once answered, and still tappable so a wrong tap is put right
  (the server upserts the day). Toast after a 0, at the reader's level, says the other button changes it.
- manual_count: "+ Giriş" → entry modal; quick-add chips. A chip over what is left of today's cap is greyed out, the
  remainder taken without float noise (`dropFloatNoise`, as in the entry form, so 14,4 + 59,7 + 15,9 km keeps "+10");
  under a cent left reads "Günlük tavan doldu (100 km).", as the entry form says "tavan doldu" and the nudge skips it.
- manual_lower_is_better: for `deviceMetric: 'screen_time'` on Android with usage access → today's minutes from the phone + "Senkronla" (POST /me/screen-time), no manual button; permission missing → "Kullanım erişimi ver" (opens system usage-access page, re-checked on AppState active), on Android 15+ USAGE_ACCESS_RESTRICTED_HINT + "Uygulama bilgilerini aç" (openAppSettings) under it, every time access is missing, + a ghost manual fallback; iPhone / Expo Go / other → "Bugünkü değeri gir" → entry modal (proof photo emphasized), and a day the phone already reported shows as locked (server 409 `device_locked`).

### 3.5 Notifications & polling

- On login/boot: `registerForPush()`; if token → POST /me/push-token, once per session token (a password change hands out a new session, and when the server cleared the push token the same device token goes up again; a failed POST is retried on the next foreground). Once it went up, each foreground asks `GET /me` (`refreshMe`), and `hasPushToken: false` sends the same device token again: a logout elsewhere can still empty the account's single slot (an app from before logout said which token was its own clears whatever is there), and a stored token means push delivers, so the phone otherwise had neither push nor its own notifications until a restart. `/me` says whether a token is there, not whose: a second phone on the account that holds it is left alone, and a `/me` that could not be read changes nothing. Logout sends the token this phone registered (`StorageKeys.pushToken`, read before `forgetStoredSession` removes it; null without one) to `DELETE /me/push-token`, so only that one is cleared; Ayarlar stores the token it registers there too. The password sheet sends the token it registered (`StorageKeys.pushToken`, null without one) as `pushToken`, so the server keeps it and drops one held by a phone the change signs out. Handler shows banner+list+sound.
- `useUnreadCount` polls every 30 s in foreground, plus refetch on AppState active. When `latestId` changes and the new
  items have `pushedAt == null` (server includes `pushed` flag) and app is in background → `fireLocal`. In foreground → in-app Toast.
- Tapping a notification response routes: taunt/challenge_* → `/challenge/[id]/results` or `/challenge/[id]`, friend_* → friends tab,
  except a `friend_accepted` with a `challengeId` (2.2): that çelınc, with the new kanka (`data.userId`) as `invite`.
  A `reminder` with `data.kind === 'taunt_followup'` (2.4, 3b) opens the results, where the laf is sent; the inbox row does the same.
  The in-app toast for a push received in the foreground opens the same place (`routeForNotificationData`).
- Every one of these (push tap, its toast, the poll's toast, a Gelen row) opens its screen with `router.navigate`, not
  `push`: when the screen in front is already that route with the same path params (a "Dürtüldün" about the çelınc on
  screen, a second tap on the banner or the row) nothing new is stacked, and the same screen gets the new search params in
  place without remounting (the çelınc screen keys its "Kanka ekle" sheet on `invite`, so a "Kanka oldunuz" about the
  çelınc on screen still opens it with the kanka ticked); another çelınc still opens over it. The bridge's
  inbox and friends tabs go through `goToTab` (utils/navigation.ts): `dismissAll` down to the tab bar when something is
  stacked over it (`canDismiss`), then `navigate`. A tab route pushed or navigated to from a çelınc stacked a second
  tab bar over it. The çelınc screen's "Kankalara git" and the wizard's button under "Kanka yok" use it too.
- While the welcome slides are up (`onboarding`), a tap on a push, its toast or the poll's toast opens nothing and marks
  nothing read; the row waits in Gelen. Opened over the slides, the app stacked on them: they stayed mounted, their
  cleanup never ended onboarding, and push registration, steps and reminders stayed off until a restart.
- A tap also marks its inbox row read: the server's push and `fireLocal` both put `notificationId` in the data, the route keeps
  it, and the bridge sends `POST /me/inbox/read { ids: [id] }` (then refreshes unread + inbox) before navigating. The phone's own
  reminders carry no id.
- The phone's own reminders (services/reminders.ts), only for çelınclar whose `me.status` is `accepted` (the list also
  returns invites), and not for a `pending` one with fewer than two accepted (it takes no entry and is cancelled at its
  end if nobody joins; the refresh after the second yes sets them, below): a check-in çelınc's slot 30 minutes before its
  deadline (30 minutes before the end on a day the end cuts before its deadline: "çelınc bitiyor. Check-in için 30 dakikan
  kaldı." at level 1; none on a day it ends before the slot opens, `checkinWindowStart`) and a "son 1 saat" warning before every end. On an `auto_steps` çelınc there is nothing to type, so that
  warning says when to open the app instead ("Bitince uygulamayı bir kez aç…"), and a second one fires at
  `endsAt + 2 min` ("… bitti. Bir saat içinde dokun…", `reminder: 'last_hour'`, a tap opens the çelınc, whose settling
  effect syncs): an iPhone seldom lets the background task run, so its steps mostly go when the app is opened, and
  nothing after the settle hour moves the result.
  When the end cuts the reader's last day in half (their `myTimezone` is not the one the end was snapped in), a sync
  after the end cannot move that day (`dayOverByEnd`, POST /me/steps): the warning says "Bitmeden" and there is no second one.
  The check-in slot is one DATE trigger per remaining day of the window (cut to `myDays` when the server sends it) in the çelınc's `myTimezone` (`zonedInstant`; the
  account's zone, `refreshReminders`' `tz`, only when an older server leaves it out;
  identifier `koydum-checkin-<challengeId>-<dayKey>`; a deadline before 00:30 is poked the evening before), never a
  repeating one: only days from today on, today left out once `me.lastEntryAt` is today, at most 14 days ahead, and only
  slots after now, at or after `startsAt` and before `endsAt`. All requests are sorted by fire time and capped at 60
  (iOS keeps 64). `refreshReminders(client, level, tz)` runs one at a time; with the "Saatli çelınc uyarıları" switch
  off (`StorageKeys.deviceRemindersOff`, on by default, this phone only) it clears every scheduled one without asking
  the server, otherwise it reads `GET /challenges?status=active,pending` and replaces them (`syncReminders`, which
  creates the `koydum` channel first). The bridge calls it once signed in, on every foreground and in its background
  handler, and when a `challenge_accepted`, `challenge_started` or `challenge_cancelled` comes in (a push received in
  the foreground, or the inbox poll); `useChallengeAction` after a yes, a no, a walk-out or a cancel on this phone (a
  yes in the evening to a çelınc that starts at 04:00 is often the last thing done on the phone, and 2.4 says no
  "başladı" before 07:00); Ayarlar right after the switch, the headless task (services/backgroundWork.ts) after the
  inbox with the stored `me`'s level and zone. A "Geldim" the server took calls `skipTodayCheckinReminder(id, tz)`:
  today's slot is cancelled (behind any refresh in flight) and stays out of later refreshes while this app runs, since
  a refresh may have read the list just before it landed. A parked one keeps the slot: it has not counted, and the poke
  brings the app, and with it the queue, to the front before the deadline. A drain that sent anything refreshes the
  reminders once more, so a parked check-in that lands takes its poke with it. Logout clears every one with `clearReminders()`,
  also behind any refresh in flight: that refresh still holds the old token, its list still arrives, and it would
  otherwise schedule the old account's alarms right after the clear.
- New rows refresh what is on screen (`invalidateForNotifications` in hooks/queries): inbox + unread always, friends for
  friend_*, and for each `data.challengeId` (and a `rematch` row's `data.rematchOfId`, whose results then link to it) the challenge lists, the detail and the results.
  A `challenge_finished` or `badge` row also moves the leaderboard and reads `me` again (`refreshMe`: the Karne and the
  rozetler live in the auth store, not the query cache), and a `friend_accepted` row the leaderboard (a new row on it). A friendship this phone makes or ends (a request accepted, an invite link, "Arkadaşlıktan çıkar", a block) moves the friends list and the leaderboard together (`invalidateFriendships`). Called by the received listener
  (push), by the inbox poll whenever it returns items (either surface) and by the background handler while the app is alive.
  An answer to a kanka isteği or a çelınc daveti (`useFriendAction`, `useChallengeAction`) reads inbox + unread again too: the
  server marked the request's row read, wherever it was answered.
  The tabs stay mounted and `refetchOnWindowFocus` is off, so the list tabs also catch up on their own: Gelen refetches
  when the unread poll's `latestId` is not its first row (waiting while an older page is on its way), and its "N yeni" chip /
  "Hepsini okundu yap" use the larger of the loaded pages' unread and the server's `count`; Kankalar refetches on focus when its list is older than 20 s;
  Profil refetches the leaderboard and `me` together on focus when the leaderboard is older than 20 s (a friend's finish sends me no row).

### 3.6 Tests

`jest-expo` unit tests for: `lib/api` (fetch mocked), `services/focus` (state machine), `utils/format`, one render test for
`TauntBubble`. Keep them fast; they must pass with `npx jest` in `apps/mobile`.

### 3.7 Visual language

Dark background `#0B0B0F`, surfaces `#16161D`, accent hot pink `#FF3D71`, secondary yellow `#FFD400`, success `#2EE59D`,
danger `#FF4D4D`, text `#F5F5F7`, muted `#9A9AA5`, faint `#868692` (the quietest text; it still carries things said
nowhere else, so like muted it keeps 4.5:1 on the background and both surfaces), bronze `#CD7F32` for third place on the
podium. Big bold headings (uppercase for CTAs: "KOY BAKALIM", "GELDİM", "KOYDUM MU?"). Emoji-heavy. Haptics on key
actions. Loading skeletons/spinners; every list has an EmptyState with level copy.

---------------------------------------------------------------------------------------

## 4. Verification pipeline (what "done" means)

1. `npm run typecheck` at root passes (shared, server) and `npx tsc --noEmit` in apps/mobile passes.
2. `npm test -w packages/shared`, `npm test -w apps/server` pass; `npx jest` in apps/mobile passes.
3. `npx expo export --platform web` and `npx expo export --platform ios --platform android` succeed in apps/mobile.
4. Playwright smoke: serve the web export, run the server on :4000, register two users, add friends, create a challenge
   starting now, log entries, force finalize via test-only endpoint `POST /dev/finalize/:id` (enabled only when
   `ENABLE_DEV_ROUTES=1`), send a taunt, assert it appears in the loser's inbox. Screenshots saved to `docs/screens/`.
5. README (Turkish) explains: server run, LAN URL, Expo Go run, dev build with EAS for push + Health Connect, deploy.
