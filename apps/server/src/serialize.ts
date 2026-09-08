/**
 * Row → API shape mappers.
 *
 * Routes never build response objects by hand: they select rows and pass them
 * through here, so the wire format stays identical everywhere (SPEC 1.7).
 */
import {
  DIRECTIONS,
  DISPUTE_STATUSES,
  ENTRY_SOURCES,
  ENTRY_STATUSES,
  METRIC_TYPES,
  NOTIFICATION_TYPES,
  PARTICIPANT_STATUSES,
  CHALLENGE_STATUSES,
  isVulgarityLevel,
  type Challenge,
  type ChallengeStatus,
  type Direction,
  type Dispute,
  type DisputeStatus,
  type Entry,
  type EntrySource,
  type EntryStatus,
  type FeedItem,
  type Me,
  type MetricType,
  type Notification,
  type NotificationType,
  type ParticipantStatus,
  type PublicProfile,
  type PublicUser,
  type Taunt,
  type VulgarityLevel,
} from '@koydum/shared';
import type {
  ChallengeRow,
  Database,
  DisputeRow,
  EntryRow,
  NotificationRow,
  TauntRow,
  UserRow,
} from './db/index.js';
import { computeUserStats, getBadges } from './services/stats.js';

// ---------------------------------------------------------------------------
// Column → union casts (a value written by an older build never crashes a read)
// ---------------------------------------------------------------------------

function oneOf<T extends string>(values: readonly T[], value: string, fallback: T): T {
  return (values as readonly string[]).includes(value) ? (value as T) : fallback;
}

export const asMetricType = (v: string): MetricType => oneOf(METRIC_TYPES, v, 'manual_count');
export const asDirection = (v: string): Direction => oneOf(DIRECTIONS, v, 'higher');
export const asChallengeStatus = (v: string): ChallengeStatus => oneOf(CHALLENGE_STATUSES, v, 'pending');
export const asParticipantStatus = (v: string): ParticipantStatus => oneOf(PARTICIPANT_STATUSES, v, 'invited');
export const asEntrySource = (v: string): EntrySource => oneOf(ENTRY_SOURCES, v, 'manual');
export const asEntryStatus = (v: string): EntryStatus => oneOf(ENTRY_STATUSES, v, 'ok');
export const asDisputeStatus = (v: string): DisputeStatus => oneOf(DISPUTE_STATUSES, v, 'open');
export const asNotificationType = (v: string): NotificationType => oneOf(NOTIFICATION_TYPES, v, 'reminder');
export const asVulgarityLevel = (v: number): VulgarityLevel => (isVulgarityLevel(v) ? v : 2);

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarEmoji: row.avatar_emoji,
    createdAt: row.created_at,
  };
}

/** The full `Me` payload: public fields + settings + stats + badges. */
export function toMe(db: Database, row: UserRow, now: Date = new Date()): Me {
  return {
    ...toPublicUser(row),
    vulgarityMax: asVulgarityLevel(row.vulgarity_max),
    timezone: row.timezone,
    reminderHour: row.reminder_hour === null ? null : Number(row.reminder_hour),
    inviteCode: row.invite_code,
    hasPushToken: Boolean(row.push_token),
    stats: computeUserStats(db, row.id, now),
    badges: getBadges(db, row.id),
  };
}

/** `GET /users/:id` — only the public half of the stats. */
export function toPublicProfile(db: Database, row: UserRow, now: Date = new Date()): PublicProfile {
  const stats = computeUserStats(db, row.id, now);
  return {
    ...toPublicUser(row),
    stats: {
      wins: stats.wins,
      losses: stats.losses,
      tauntsSent: stats.tauntsSent,
      tauntsReceived: stats.tauntsReceived,
    },
    badges: getBadges(db, row.id),
  };
}

// ---------------------------------------------------------------------------
// Challenges & entries
// ---------------------------------------------------------------------------

export function toChallenge(row: ChallengeRow): Challenge {
  return {
    id: row.id,
    creatorId: row.creator_id,
    typeKey: row.type_key,
    metricType: asMetricType(row.metric_type),
    direction: asDirection(row.direction),
    unit: row.unit,
    title: row.title,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: asChallengeStatus(row.status),
    rewardText: row.reward_text,
    penaltyText: row.penalty_text,
    deadlineTime: row.deadline_time,
    dailyTarget: row.daily_target === null ? null : Number(row.daily_target),
    proofRequired: row.proof_required === 1,
    createdAt: row.created_at,
    finalizedAt: row.finalized_at,
    winnerId: row.winner_id,
    isTie: row.is_tie === 1,
    rematchOfId: row.rematch_of_id,
  };
}

export function toEntry(row: EntryRow): Entry {
  return {
    id: row.id,
    challengeId: row.challenge_id,
    userId: row.user_id,
    dayKey: row.day_key,
    value: Number(row.value),
    source: asEntrySource(row.source),
    note: row.note,
    proofUrl: row.proof_url,
    status: asEntryStatus(row.status),
    createdAt: row.created_at,
    late: row.late === 1 ? true : undefined,
  };
}

/** Feed rows carry the author's display name so the app does not have to join. */
export function toFeedItem(row: EntryRow, displayName: string): FeedItem {
  return {
    id: row.id,
    userId: row.user_id,
    displayName,
    dayKey: row.day_key,
    value: Number(row.value),
    source: asEntrySource(row.source),
    status: asEntryStatus(row.status),
    createdAt: row.created_at,
    proofUrl: row.proof_url,
  };
}

export function toDispute(row: DisputeRow): Dispute {
  return {
    id: row.id,
    entryId: row.entry_id,
    byUserId: row.by_user_id,
    reason: row.reason,
    status: asDisputeStatus(row.status),
    createdAt: row.created_at,
  };
}

export function toTaunt(row: TauntRow): Taunt {
  return {
    id: row.id,
    challengeId: row.challenge_id,
    fromUserId: row.from_user_id,
    toUserId: row.to_user_id,
    level: asVulgarityLevel(row.level),
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

function parseData(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function toNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    type: asNotificationType(row.type),
    title: row.title,
    body: row.body,
    data: parseData(row.data),
    readAt: row.read_at,
    createdAt: row.created_at,
    pushed: row.pushed_at !== null,
  };
}
