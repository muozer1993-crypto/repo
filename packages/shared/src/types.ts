/**
 * Domain types for KOYDUM — shared between the Fastify server and the Expo app.
 *
 * Enumerations are declared as `as const` tuples so that zod schemas (schemas.ts)
 * and UI pickers can iterate them; the union types are derived from the tuples so
 * there is a single source of truth.
 */

// ---------------------------------------------------------------------------
// 1.1 Enums
// ---------------------------------------------------------------------------

export const METRIC_TYPES = [
  'auto_steps',
  'focus_minutes',
  'checkin_deadline',
  'manual_count',
  'manual_lower_is_better',
  'daily_boolean',
] as const;
export type MetricType = (typeof METRIC_TYPES)[number];

export const DIRECTIONS = ['higher', 'lower'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const VULGARITY_LEVELS = [1, 2, 3] as const;
export type VulgarityLevel = (typeof VULGARITY_LEVELS)[number];

export const CHALLENGE_STATUSES = ['pending', 'active', 'finished', 'cancelled'] as const;
export type ChallengeStatus = (typeof CHALLENGE_STATUSES)[number];

export const PARTICIPANT_STATUSES = ['invited', 'accepted', 'declined', 'left'] as const;
export type ParticipantStatus = (typeof PARTICIPANT_STATUSES)[number];

/**
 * Where an entry's number came from. The three device sources (`pedometer`,
 * `health_connect`, `usage_stats`) are written by the phone's own sensors and
 * counters, never typed; the server treats them as trustworthy and lets them
 * overwrite a typed value for the same day, never the other way round.
 */
export const ENTRY_SOURCES = ['pedometer', 'health_connect', 'manual', 'focus', 'checkin', 'usage_stats'] as const;
export type EntrySource = (typeof ENTRY_SOURCES)[number];

export const ENTRY_STATUSES = ['ok', 'disputed', 'rejected'] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

export const FRIENDSHIP_STATUSES = ['pending', 'accepted', 'blocked'] as const;
export type FriendshipStatus = (typeof FRIENDSHIP_STATUSES)[number];

export const NOTIFICATION_TYPES = [
  'friend_request',
  'friend_accepted',
  'challenge_invite',
  'challenge_started',
  'challenge_cancelled',
  'challenge_finished',
  'taunt',
  'poke',
  'dispute',
  'entry_rejected',
  'reminder',
  'badge',
  'rematch',
  /** the mid-day "o ne lan, sana fark koymuş" poke the server sends by itself */
  'nudge',
  /** Sunday evening: the week's score, "haftanın kralı" and the step count */
  'recap',
  /** to the creator: an invitee said no ("Ali tırstı, reddetti") */
  'challenge_declined',
  /** to the players still in: somebody walked out mid-çelınc ("Ali havlu attı") */
  'challenge_left',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * `data` of a `recap` notification: the numbers the inbox card draws. The text
 * lines are already written at the reader's level, so the phone never has to
 * know how to phrase "haftanın kralı".
 */
export interface RecapData {
  /** Monday and Sunday of the week, as local day keys of the reader. */
  weekStart: string;
  weekEnd: string;
  wins: number;
  losses: number;
  ties: number;
  steps: number;
  /** çelınclar still running when the recap was written */
  active: number;
  /** "👑 Haftanın kralı ..." and friends, ready to show */
  highlights: string[];
}

export const TAUNT_CONTEXTS = ['win', 'win_big', 'win_close', 'tie', 'poke', 'streak', 'revenge'] as const;
export type TauntContext = (typeof TAUNT_CONTEXTS)[number];

export const DISPUTE_STATUSES = ['open', 'upheld', 'dismissed'] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

export const PUSH_PLATFORMS = ['ios', 'android', 'web'] as const;
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

export const CHALLENGE_CATEGORIES = [
  'hareket',
  'ekran',
  'uyku',
  'beslenme',
  'zihin',
  'kotu_aliskanlik',
  'diger',
] as const;
export type ChallengeCategory = (typeof CHALLENGE_CATEGORIES)[number];

// ---------------------------------------------------------------------------
// 1.2 ChallengeType (catalog)
// ---------------------------------------------------------------------------

export interface ChallengeType {
  key: string;
  nameTr: string;
  emoji: string;
  metricType: MetricType;
  unitTr: string;
  direction: Direction;
  descriptionTr: string;
  descriptionPoliteTr: string;
  howMeasuredTr: string;
  defaultDurationDays: number;
  /** "HH:mm" local time — only meaningful for `checkin_deadline`. */
  defaultDeadlineTime?: string;
  /**
   * "HH:mm" local time — `checkin_deadline` only: a check-in before this hour is
   * refused. Without it a "yattım" at 02:00 counts as an on-time bedtime and
   * blocks the real one that evening.
   */
  checkinWindowStart?: string;
  suggestedRewardTr: string;
  antiCheatTr: string;
  proofRequired: boolean;
  category: ChallengeCategory;
  /** Anti-abuse cap for a single manual value. */
  maxPerEntry: number;
  /** Cap for the daily sum. */
  maxPerDay: number;
  /** lower-is-better only: value assumed for unreported days. */
  missingDayPenalty?: number;
  /**
   * Which phone reading fills this type in without typing, when the platform
   * can give it: `steps` (pedometer / Health Connect, `POST /me/steps`) or
   * `screen_time` (Android usage access, `POST /me/screen-time`). Absent means
   * the number is always entered by hand.
   */
  deviceMetric?: DeviceMetric;
}

/** The phone readings the server knows how to fan out into challenges. */
export const DEVICE_METRICS = ['steps', 'screen_time'] as const;
export type DeviceMetric = (typeof DEVICE_METRICS)[number];

// ---------------------------------------------------------------------------
// 1.4 Taunts (types only — data + helpers live in taunts.ts)
// ---------------------------------------------------------------------------

export interface TauntTemplate {
  id: string;
  level: VulgarityLevel;
  context: TauntContext;
  title: string;
  body: string;
  /**
   * Only for çelınclar of these metrics. A line about walking ("kalk da iki
   * dolaş", "10 bin adım at") lands wrong on a screen-time or bedtime çelınc, so
   * such templates name the metrics they make sense for. Absent = any çelınc.
   */
  metrics?: readonly MetricType[];
}

/** Placeholder values for `renderTaunt`. Numbers are pre-formatted strings (tr-TR). */
export interface TauntVars {
  winner: string;
  loser: string;
  metric: string;
  winnerScore: string;
  loserScore: string;
  diff: string;
  unit: string;
  challenge: string;
}

// ---------------------------------------------------------------------------
// 1.5 Copy (types only — data lives in copy.ts)
// ---------------------------------------------------------------------------

export const MICROCOPY_KEYS = [
  'home_empty',
  'create_challenge_cta',
  'invite_friends_cta',
  'challenge_pending_you',
  'challenge_active_leading',
  'challenge_active_tie',
  'challenge_active_losing',
  'challenge_finished_won',
  'challenge_finished_lost',
  'shame_screen_title',
  'shame_screen_subtitle',
  'taunt_picker_title',
  'taunt_sent_confirmation',
  'poke_button',
  'rematch_button',
  'add_friend_empty',
  'focus_start',
  'focus_abandoned',
  'focus_done',
  'checkin_late',
  'checkin_ok',
  'proof_needed',
  'dispute_button',
  'profile_record',
  'onboarding_1',
  'onboarding_2',
  'onboarding_3',
  'onboarding_4',
  'notification_daily_reminder',
  'login_title',
  'register_title',
  'settings_vulgarity_label',
  'logout_confirm',
] as const;
export type MicrocopyKey = (typeof MICROCOPY_KEYS)[number];

/** One microcopy entry: the same message at the three vulgarity levels. */
export interface MicrocopyEntry {
  level1: string;
  level2: string;
  level3: string;
}

/**
 * Badges come in ladders, not as one flat wall. A family is a single thing you
 * can get better at, and its rungs unlock one after another: you only ever see
 * what you have earned plus the one rung above it, so the profile shows a
 * climb instead of a grid of grey squares on day one.
 */
export const BADGE_FAMILIES = [
  'koyus',
  'yiyis',
  'adim',
  'odak',
  'erken',
  'itiraz',
  'rovans',
] as const;
export type BadgeFamily = (typeof BADGE_FAMILIES)[number];

/** What each ladder is called on the profile. */
export const BADGE_FAMILY_LABELS_TR: Record<BadgeFamily, string> = {
  koyus: 'Koyuş',
  yiyis: 'Yiyiş',
  adim: 'Adım',
  odak: 'Odak',
  erken: 'Erken kalkma',
  itiraz: 'İtiraz',
  rovans: 'Rövanş',
};

export interface BadgeDef {
  key: string;
  nameTr: string;
  emoji: string;
  descriptionTr: string;
  /** Machine rule, e.g. `wins>=3` (see SPEC 1.5). */
  rule: string;
  /** The ladder this rung belongs to. */
  family: BadgeFamily;
  /** 1-based position on that ladder. */
  tier: number;
}

/** Stat keys that badge rules may reference (SPEC 1.5). */
export interface BadgeStats {
  wins: number;
  losses: number;
  ties: number;
  tauntsSent: number;
  tauntsReceived: number;
  stepsSingleDayMax: number;
  focusTotalMinutes: number;
  checkinsStreakMax: number;
  disputesWon: number;
  challengesPlayed: number;
  pokesSent: number;
  /** Finished challenges won that were a rematch of an earlier one (SPEC 1.5, `revenge_master`). */
  revengeWins: number;
}
export type BadgeStatKey = keyof BadgeStats;

/** Full user stats as returned by the API (SPEC 1.7). */
export interface UserStats extends BadgeStats {
  stepsToday: number;
}

// ---------------------------------------------------------------------------
// 1.7 API response types
// ---------------------------------------------------------------------------

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  avatarEmoji: string;
  createdAt: string;
}

export interface Me extends PublicUser {
  vulgarityMax: VulgarityLevel;
  timezone: string;
  reminderHour: number | null;
  /** The mid-day "sana fark koymuş" nudge; taunts, pokes, invites and results cannot be switched off. */
  nudgesEnabled: boolean;
  /** The Sunday evening weekly recap. */
  recapEnabled: boolean;
  inviteCode: string;
  hasPushToken: boolean;
  stats: UserStats;
  badges: string[];
}

/** `GET /users/:id` — public profile with public stats. */
export interface PublicProfile extends PublicUser {
  stats: Pick<UserStats, 'wins' | 'losses' | 'challengesPlayed'>;
  badges: string[];
}

export interface Challenge {
  id: string;
  creatorId: string;
  typeKey: string;
  metricType: MetricType;
  direction: Direction;
  unit: string;
  title: string;
  startsAt: string;
  endsAt: string;
  status: ChallengeStatus;
  rewardText: string | null;
  penaltyText: string | null;
  /** "HH:mm" local — only for `checkin_deadline`. */
  deadlineTime: string | null;
  dailyTarget: number | null;
  proofRequired: boolean;
  createdAt: string;
  finalizedAt: string | null;
  winnerId: string | null;
  isTie: boolean;
  rematchOfId: string | null;
}

export interface ParticipantView {
  user: PublicUser;
  status: ParticipantStatus;
  score: number;
  days: number;
  rank: number;
  lastEntryAt: string | null;
  isWinner: boolean;
}

export interface ChallengeSummary {
  challenge: Challenge;
  participants: ParticipantView[];
  me: ParticipantView | null;
  unreadTaunts: number;
}

export interface Entry {
  id: string;
  challengeId: string;
  userId: string;
  dayKey: string;
  value: number;
  source: EntrySource;
  note: string | null;
  proofUrl: string | null;
  status: EntryStatus;
  createdAt: string;
  /** Set on check-in entries recorded after the deadline. */
  late?: boolean;
}

export interface FeedItem {
  id: string;
  userId: string;
  displayName: string;
  dayKey: string;
  value: number;
  source: EntrySource;
  status: EntryStatus;
  createdAt: string;
  proofUrl: string | null;
  /**
   * Set while a majority disputes this entry: the moment it is thrown out
   * unless its owner adds a photo first. Older servers leave it out.
   */
  answerBy?: string | null;
}

export interface Dispute {
  id: string;
  entryId: string;
  byUserId: string;
  reason: string;
  status: DisputeStatus;
  createdAt: string;
}

export interface Taunt {
  id: string;
  challengeId: string;
  fromUserId: string;
  toUserId: string;
  level: VulgarityLevel;
  title: string;
  body: string;
  createdAt: string;
}

export interface CanTaunt {
  toUserId: string;
  done: boolean;
}

export interface ChallengeDetail extends ChallengeSummary {
  myEntries: Entry[];
  feed: FeedItem[];
  disputes: Dispute[];
  taunts: Taunt[];
  canTaunt: CanTaunt[];
  canPoke: boolean;
  /**
   * While a çelınc is still running, talking is a privilege: only whoever is
   * ahead gets entries here, and only for the people they are actually ahead
   * of. `done` means that one is still inside the poke cooldown.
   */
  pokeTargets: CanTaunt[];
}

/** `GET /challenges/:id/results` */
export interface ChallengeResults {
  challenge: Challenge;
  standings: ParticipantView[];
  taunts: Taunt[];
  /** Only for the winner: rendered previews (one list per loser is done client side). */
  tauntTemplatesForWinner?: TauntTemplate[];
  /**
   * Only for the winner: per loser id, what their taunt is about — `revenge`,
   * `streak`, or the margin (`win_big` / `win` / `win_close`). The picker offers
   * that pool; an older server leaves it out and the app falls back to the margin.
   */
  tauntContexts?: Record<string, TauntContext>;
  /**
   * Only for an accepted player: the others a rematch opened by the reader would
   * not invite because they are not friends. Deleted accounts and blocks are
   * left out of it too, but not listed.
   */
  rematchLeftOut?: string[];
}

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
  /** Whether the server delivered it via push (see SPEC 3.5). */
  pushed?: boolean;
}

export interface FriendRequestView {
  id: string;
  user: PublicUser;
}

export interface FriendsView {
  friends: PublicUser[];
  incoming: FriendRequestView[];
  outgoing: FriendRequestView[];
}

export interface LeaderboardEntry {
  user: PublicUser;
  wins: number;
  losses: number;
  rank: number;
}

export interface AuthResponse {
  token: string;
  me: Me;
}

export interface UnreadCount {
  count: number;
  latestId: string | null;
}

/** Error envelope: `{ error: { code, message } }` (message in Turkish). */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    issues?: unknown;
  };
}
