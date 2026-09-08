/**
 * Read models and notification copy shared by the challenge, entry and social routes.
 *
 * Routes never assemble a `ChallengeSummary` / `ChallengeDetail` by hand: they load
 * the row, check membership here, and hand the row to `buildSummary` / `buildDetail`
 * so every endpoint returns byte-identical shapes (SPEC 1.7).
 *
 * Visibility rule (SPEC 2.2): a non-participant must not be able to tell an existing
 * challenge from a made-up id, so `requireMembership` throws 404 — never 403.
 */
import type {
  CanTaunt,
  ChallengeDetail,
  ChallengeSummary,
  Dispute,
  Entry,
  FeedItem,
  ParticipantView,
  Taunt,
  VulgarityLevel,
} from '@koydum/shared';
import { countOf, type ChallengeRow, type Database, type DisputeRow, type EntryRow, type ParticipantRow, type TauntRow, type UserRow } from '../db/index.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { asVulgarityLevel, toChallenge, toDispute, toEntry, toFeedItem, toTaunt } from '../serialize.js';
import { computeStandings, getChallengeRow } from './challenges.js';

/** How many recent entries the detail feed carries (SPEC 2.2). */
export const FEED_LIMIT = 40;

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

export function requireChallengeRow(db: Database, challengeId: string): ChallengeRow {
  const row = getChallengeRow(db, challengeId);
  if (!row) throw notFound('challenge_not_found', 'Böyle bir çelinç yok.');
  return row;
}

export function getParticipant(db: Database, challengeId: string, userId: string): ParticipantRow | undefined {
  return db
    .prepare('SELECT * FROM challenge_participants WHERE challenge_id = ? AND user_id = ?')
    .get(challengeId, userId) as ParticipantRow | undefined;
}

/** Any row in `challenge_participants` (invited, declined and left included). */
export function requireMembership(db: Database, challenge: ChallengeRow, userId: string): ParticipantRow {
  const row = getParticipant(db, challenge.id, userId);
  if (!row) throw notFound('challenge_not_found', 'Böyle bir çelinç yok.');
  return row;
}

/** Membership that also joined the race — the bar for writing entries, poking, rematching. */
export function requireAcceptedMembership(db: Database, challenge: ChallengeRow, userId: string): ParticipantRow {
  const row = requireMembership(db, challenge, userId);
  if (row.status !== 'accepted') throw forbidden('not_participant', 'Bu çelince katılmadın.');
  return row;
}

export function acceptedCount(db: Database, challengeId: string): number {
  return countOf(
    db,
    "SELECT COUNT(*) AS n FROM challenge_participants WHERE challenge_id = ? AND status = 'accepted'",
    challengeId,
  );
}

export function getUserRow(db: Database, userId: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
}

export function requireUserRow(db: Database, userId: string): UserRow {
  const row = getUserRow(db, userId);
  if (!row || row.deleted_at !== null) throw notFound('user_not_found', 'Böyle bir kullanıcı yok.');
  return row;
}

export function levelOf(user: UserRow): VulgarityLevel {
  return asVulgarityLevel(user.vulgarity_max);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Unread `taunt` notifications pointing at this challenge (badge on the card). */
export function unreadTauntCount(db: Database, userId: string, challengeId: string): number {
  try {
    return countOf(
      db,
      `SELECT COUNT(*) AS n FROM notifications
        WHERE user_id = ? AND type = 'taunt' AND read_at IS NULL
          AND json_extract(data, '$.challengeId') = ?`,
      userId,
      challengeId,
    );
  } catch {
    // SQLite build without JSON1: the badge is cosmetic, never fail the request.
    return 0;
  }
}

export function myEntries(db: Database, challengeId: string, userId: string): Entry[] {
  const rows = db
    .prepare('SELECT * FROM entries WHERE challenge_id = ? AND user_id = ? ORDER BY day_key ASC, created_at ASC')
    .all(challengeId, userId) as EntryRow[];
  return rows.map(toEntry);
}

export function challengeFeed(db: Database, challengeId: string, limit = FEED_LIMIT): FeedItem[] {
  const rows = db
    .prepare(
      `SELECT e.*, u.display_name AS display_name FROM entries e
         JOIN users u ON u.id = e.user_id
        WHERE e.challenge_id = ?
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT ?`,
    )
    .all(challengeId, limit) as (EntryRow & { display_name: string })[];
  return rows.map((row) => toFeedItem(row, row.display_name));
}

export function challengeDisputes(db: Database, challengeId: string): Dispute[] {
  const rows = db
    .prepare(
      `SELECT d.* FROM disputes d
         JOIN entries e ON e.id = d.entry_id
        WHERE e.challenge_id = ?
        ORDER BY d.created_at DESC, d.id DESC`,
    )
    .all(challengeId) as DisputeRow[];
  return rows.map(toDispute);
}

/** Only the taunts the caller is part of — the rest is between other people. */
export function tauntsForUser(db: Database, challengeId: string, userId: string): Taunt[] {
  const rows = db
    .prepare(
      `SELECT * FROM taunts
        WHERE challenge_id = ? AND (from_user_id = ? OR to_user_id = ?)
        ORDER BY created_at ASC, id ASC`,
    )
    .all(challengeId, userId, userId) as TauntRow[];
  return rows.map(toTaunt);
}

/** One row per loser when the caller is the winner of a finished challenge. */
export function canTauntList(db: Database, challenge: ChallengeRow, userId: string): CanTaunt[] {
  if (challenge.status !== 'finished' || challenge.winner_id !== userId) return [];
  const losers = db
    .prepare(
      `SELECT user_id FROM challenge_participants
        WHERE challenge_id = ? AND status = 'accepted' AND user_id <> ?
        ORDER BY user_id ASC`,
    )
    .all(challenge.id, userId) as { user_id: string }[];
  const done = new Set(
    (
      db
        .prepare('SELECT to_user_id FROM taunts WHERE challenge_id = ? AND from_user_id = ?')
        .all(challenge.id, userId) as { to_user_id: string }[]
    ).map((row) => row.to_user_id),
  );
  return losers.map((row) => ({ toUserId: row.user_id, done: done.has(row.user_id) }));
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

export function buildSummary(db: Database, challenge: ChallengeRow, userId: string): ChallengeSummary {
  const participants: ParticipantView[] = computeStandings(db, challenge);
  return {
    challenge: toChallenge(challenge),
    participants,
    me: participants.find((p) => p.user.id === userId) ?? null,
    unreadTaunts: unreadTauntCount(db, userId, challenge.id),
  };
}

export function buildDetail(db: Database, challenge: ChallengeRow, userId: string): ChallengeDetail {
  const summary = buildSummary(db, challenge, userId);
  const mine = summary.me;
  return {
    ...summary,
    myEntries: myEntries(db, challenge.id, userId),
    feed: challengeFeed(db, challenge.id),
    disputes: challengeDisputes(db, challenge.id),
    taunts: tauntsForUser(db, challenge.id, userId),
    canTaunt: canTauntList(db, challenge, userId),
    canPoke: challenge.status === 'active' && mine?.status === 'accepted' && acceptedCount(db, challenge.id) >= 2,
  };
}

/** Reload from the database so the response always mirrors what was committed. */
export function freshDetail(db: Database, challengeId: string, userId: string): ChallengeDetail {
  return buildDetail(db, requireChallengeRow(db, challengeId), userId);
}

// ---------------------------------------------------------------------------
// Notification copy — always rendered at the RECIPIENT's vulgarity level
// ---------------------------------------------------------------------------

export interface CopyText {
  title: string;
  body: string;
}

export function inviteCopy(level: VulgarityLevel, creator: string, title: string): CopyText {
  if (level === 1) {
    return { title: '📩 Çelinç daveti', body: `${creator} seni "${title}" çelincine davet etti. Kabul et, yarış başlasın.` };
  }
  if (level === 3) {
    return { title: '🍆 SANA KOYMAK İSTİYORLAR', body: `${creator} "${title}" çelincini açtı ve gözüne seni kestirdi. Kabul et de kim kime koyacak görelim.` };
  }
  return { title: '🔥 Sana çelinç açıldı', body: `${creator} "${title}" çelincinde sana meydan okudu lan. Kabul et ya da korkak diye anıl.` };
}

export function cancelledByCreatorCopy(level: VulgarityLevel, creator: string, title: string): CopyText {
  if (level === 1) return { title: 'Çelinç iptal edildi', body: `${creator}, "${title}" çelincini iptal etti.` };
  if (level === 3) return { title: 'Çelinç iptal 🍆', body: `${creator} "${title}" çelincini iptal etti. Bugün kimse yemiyor, şanslısın.` };
  return { title: 'Çelinç iptal oldu', body: `${creator} "${title}" çelincini iptal etti lan. Boşuna heveslenmişsin.` };
}

export function disputeCopy(level: VulgarityLevel, by: string, title: string, dayKey: string): CopyText {
  if (level === 1) {
    return { title: 'Girişine itiraz var', body: `${by}, "${title}" çelincinde ${dayKey} girişine itiraz etti. Kanıtını paylaşabilirsin.` };
  }
  if (level === 3) {
    return { title: 'PALAVRA DEDİLER 🍆', body: `${by}, "${title}" çelincinde ${dayKey} girişin için "palavra" dedi. Kanıtla yoksa gün gidiyor.` };
  }
  return { title: 'İtiraz yedin', body: `${by}, "${title}" çelincinde ${dayKey} girişine "yalan" dedi lan. Kanıtını göster.` };
}

export function entryRejectedCopy(level: VulgarityLevel, title: string, dayKey: string): CopyText {
  if (level === 1) {
    return { title: 'Girişin silindi', body: `"${title}" çelincinde ${dayKey} girişin itiraz sonucu iptal edildi. Skorundan düştü.` };
  }
  if (level === 3) {
    return { title: 'GİRİŞİN ÇÖPE GİTTİ 🍆', body: `"${title}" çelincinde ${dayKey} girişin çoğunlukla "hile" sayıldı. Silindi, skorun eridi.` };
  }
  return { title: 'Girişin iptal', body: `"${title}" çelincinde ${dayKey} girişine çoğunluk "yalan" dedi lan. Giriş silindi.` };
}

export function rematchCopy(level: VulgarityLevel, by: string, title: string): CopyText {
  if (level === 1) return { title: '🔁 Rövanş daveti', body: `${by}, "${title}" için rövanş istiyor. Kabul et, tekrar yarışın.` };
  if (level === 3) return { title: '🔁 RÖVANŞ 🍆', body: `${by} "${title}" için rövanş açtı. Bu sefer kim kime koyacak, görelim.` };
  return { title: '🔁 Rövanş var', body: `${by}, "${title}" için rövanş istedi lan. Kabul et de hesaplaşalım.` };
}
