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
import { LIMITS, formatDayKeyTr } from '@koydum/shared';
import type {
  CanTaunt,
  ChallengeDetail,
  ChallengeSummary,
  Dispute,
  Entry,
  FeedCursor,
  FeedItem,
  FeedPage,
  ParticipantView,
  Taunt,
  VulgarityLevel,
} from '@koydum/shared';
import { countOf, type ChallengeRow, type Database, type DisputeRow, type EntryRow, type ParticipantRow, type TauntRow, type UserRow } from '../db/index.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { asVulgarityLevel, toChallenge, toDispute, toEntry, toFeedItem, toTaunt } from '../serialize.js';
import { computeStandings, disputesOpenUntil, getChallengeRow, participantTimezone } from './challenges.js';
import { disputeDeadlines, disputeThreshold, disputedEntries } from './entries.js';
import { isBlockedBetween } from './friends.js';
import { canonicalInstant } from './notifications.js';

/** How many recent entries the detail feed carries (SPEC 2.2). */
export const FEED_LIMIT: number = LIMITS.FEED_PAGE;

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

export function requireChallengeRow(db: Database, challengeId: string): ChallengeRow {
  const row = getChallengeRow(db, challengeId);
  if (!row) throw notFound('challenge_not_found', 'Böyle bir çelınc yok.');
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
  if (!row) throw notFound('challenge_not_found', 'Böyle bir çelınc yok.');
  return row;
}

/** Membership that also joined the race — the bar for writing entries, poking, rematching. */
export function requireAcceptedMembership(db: Database, challenge: ChallengeRow, userId: string): ParticipantRow {
  const row = requireMembership(db, challenge, userId);
  if (row.status !== 'accepted') throw forbidden('not_participant', 'Bu çelınca katılmadın.');
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

/**
 * The most recent entries, plus every one still under dispute however old: the
 * feed is where its owner answers with a photo and where everybody reads why,
 * so a busy week of focus sessions must not push it out of reach.
 *
 * A disputed row not on the clock yet carries its count ("İtiraz 1/5"): in a
 * big group a lone itiraz is far from a majority, and "henüz çoğunluk değil"
 * did not say how far. Counted like the clock counts it (`disputedEntries`),
 * so a row of somebody who left, or with no itiraz of a player still in,
 * gets none.
 */
export function challengeFeed(db: Database, challengeId: string, limit = FEED_LIMIT): FeedItem[] {
  const rows = db
    .prepare(
      `SELECT e.*, u.display_name AS display_name FROM entries e
         JOIN users u ON u.id = e.user_id
        WHERE e.challenge_id = ?
          AND (e.status = 'disputed'
               OR e.id IN (SELECT id FROM entries WHERE challenge_id = ? ORDER BY created_at DESC, id DESC LIMIT ?))
        ORDER BY e.created_at DESC, e.id DESC`,
    )
    .all(challengeId, challengeId, limit) as FeedRow[];
  return toFeedItems(db, challengeId, rows);
}

export interface FeedPageOptions {
  /** Only rows older than this instant… */
  before?: string;
  /** …or written in that same millisecond with a smaller id. */
  beforeId?: string;
  /** Only this player's rows. */
  userId?: string;
  limit?: number;
}

/**
 * One page of the feed, newest first (GET /challenges/:id/feed). The detail
 * carries the newest 40, and an itiraz stays open for the whole çelınc: four
 * players of a 14-day steps çelınc write 56 rows, ten people's focus sessions
 * bury Tuesday by Thursday, and the itiraz chip lives only on a feed row.
 *
 * Paged on (created_at, id), the feed's own order, not on the instant alone:
 * one device sync writes several days in the same millisecond, and a cut at
 * the instant would skip the rest of them or repeat them. An edit keeps
 * `created_at`, so a row stays on its page. One row past `limit` is read to
 * tell whether another page follows.
 */
export function challengeFeedPage(db: Database, challengeId: string, options: FeedPageOptions = {}): FeedPage {
  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? FEED_LIMIT)), LIMITS.FEED_PAGE_MAX);
  const filters: string[] = [];
  const params: unknown[] = [challengeId];
  if (options.userId !== undefined) {
    filters.push('AND e.user_id = ?');
    params.push(options.userId);
  }
  const before = canonicalInstant(options.before);
  if (before !== undefined && options.beforeId !== undefined) {
    filters.push('AND (e.created_at < ? OR (e.created_at = ? AND e.id < ?))');
    params.push(before, before, options.beforeId);
  } else if (before !== undefined) {
    filters.push('AND e.created_at < ?');
    params.push(before);
  }
  const rows = db
    .prepare(
      `SELECT e.*, u.display_name AS display_name FROM entries e
         JOIN users u ON u.id = e.user_id
        WHERE e.challenge_id = ? ${filters.join(' ')}
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT ?`,
    )
    .all(...params, limit + 1) as FeedRow[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: toFeedItems(db, challengeId, page),
    next: rows.length > limit && last ? cursorOf(last) : null,
  };
}

/**
 * Where the rows older than the detail's newest `limit` start; null when the
 * feed already reaches the first entry. The server works it out because the
 * feed also carries every disputed row however old: its last item is not
 * where the newest stop.
 */
export function feedCursor(db: Database, challengeId: string, limit = FEED_LIMIT): FeedCursor | null {
  const rows = db
    .prepare('SELECT created_at, id FROM entries WHERE challenge_id = ? ORDER BY created_at DESC, id DESC LIMIT 2 OFFSET ?')
    .all(challengeId, limit - 1) as { created_at: string; id: string }[];
  // the limit-th row, and only when a row older than it exists
  const last = rows[0];
  return rows.length === 2 && last ? cursorOf(last) : null;
}

type FeedRow = EntryRow & { display_name: string };

function cursorOf(row: { created_at: string; id: string }): FeedCursor {
  return { before: row.created_at, beforeId: row.id };
}

/** Feed rows as the app reads them, with the itiraz clock and vote count only the whole çelınc knows. */
function toFeedItems(db: Database, challengeId: string, rows: FeedRow[]): FeedItem[] {
  const deadlines = disputeDeadlines(db, challengeId);
  const needed = disputeThreshold(acceptedCount(db, challengeId));
  const open = new Map(disputedEntries(db, challengeId).map((row) => [row.id, row.open_count]));
  return rows.map((row) => {
    const answerBy = deadlines.get(row.id);
    const votes = open.get(row.id) ?? 0;
    return toFeedItem(
      row,
      row.display_name,
      answerBy === undefined ? null : new Date(answerBy).toISOString(),
      answerBy === undefined && votes > 0 && votes < needed ? { open: votes, needed } : null,
    );
  });
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

/**
 * One row per loser when the caller is the winner of a finished challenge.
 * A loser with a block between the two (either way) is left out: the taunt
 * route refuses them with 403 `blocked`, and the follow-up reminder does not
 * count them (`sendTauntFollowups`).
 */
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
  return losers
    .filter((row) => !isBlockedBetween(db, userId, row.user_id))
    .map((row) => ({ toUserId: row.user_id, done: done.has(row.user_id) }));
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

/**
 * Who the reader may talk to while the çelınc is still running.
 *
 * Talking mid-çelınc is a privilege, not a button everybody has: only whoever
 * is AHEAD earns it, and only over the people they are actually ahead of. A tie
 * earns nothing — "sana fark koydum" has to be true.
 *
 * `done` marks a rival still inside the poke cooldown, so the client can grey
 * them out instead of letting the send fail.
 *
 * Only before `ends_at`: past it an `active` çelınc is only waiting for its
 * result (the phones' hour, an itiraz's photo), entries are closed, and "hâlâ
 * açık, sıra sende" would be a lie.
 *
 * On screen time a rival with no day reported yet is nobody's target: their
 * score is the missing-day penalty, so "Ali 180 dk, sen 1.440" would quote a
 * number they never wrote. The scheduler's nudge skips them for the same
 * reason (`sendNudges`); once they write a day they are fair game.
 *
 * Nor is a rival with a block between the two, either way: a block mid-race
 * leaves both in, but the poke route refuses them with 403 `blocked`, so
 * offering "Dürt" would only earn that.
 */
export function pokeTargetList(
  db: Database,
  challenge: ChallengeRow,
  userId: string,
  now: Date,
): CanTaunt[] {
  if (challenge.status !== 'active') return [];
  if (now.getTime() >= Date.parse(challenge.ends_at)) return [];
  const standings = computeStandings(db, challenge, now);
  const mine = standings.find((view) => view.user.id === userId);
  if (!mine || mine.status !== 'accepted') return [];

  const ahead = challenge.direction === 'lower'
    ? (theirs: number) => mine.score < theirs
    : (theirs: number) => mine.score > theirs;

  const lastPoke = db.prepare(
    `SELECT created_at FROM pokes
      WHERE challenge_id = ? AND from_user_id = ? AND to_user_id = ?
      ORDER BY created_at DESC LIMIT 1`,
  );

  const targets: CanTaunt[] = [];
  for (const view of standings) {
    if (view.user.id === userId || view.status !== 'accepted') continue;
    if (challenge.metric_type === 'manual_lower_is_better' && view.days === 0) continue;
    if (!ahead(view.score)) continue;
    if (isBlockedBetween(db, userId, view.user.id)) continue;
    const last = lastPoke.get(challenge.id, userId, view.user.id) as { created_at: string } | undefined;
    const elapsed = last ? now.getTime() - Date.parse(last.created_at) : Number.POSITIVE_INFINITY;
    const cooling = Number.isFinite(elapsed) && elapsed >= 0 && elapsed < LIMITS.POKE_COOLDOWN_MS;
    targets.push({ toUserId: view.user.id, done: cooling });
  }
  return targets;
}

export function buildSummary(db: Database, challenge: ChallengeRow, userId: string, now: Date = new Date()): ChallengeSummary {
  const participants: ParticipantView[] = computeStandings(db, challenge, now);
  const membership = getParticipant(db, challenge.id, userId);
  return {
    challenge: toChallenge(challenge),
    participants,
    me: participants.find((p) => p.user.id === userId) ?? null,
    unreadTaunts: unreadTauntCount(db, userId, challenge.id),
    // The zone entry validation reads this reader's days in. Their profile's
    // follows the phone (login after travel, "Cihazdan güncelle"), and an app
    // counting "today" there sends a day this çelınc refuses.
    myTimezone: membership ? participantTimezone(membership, getUserRow(db, userId)) : null,
  };
}

/**
 * `bootAt` is the scheduler's (`app.schedulerBootAt.at`): the phones' hour it
 * starts on waking moves the itiraz window too, and the app hides its itiraz
 * chip by the instant sent here.
 */
export function buildDetail(
  db: Database,
  challenge: ChallengeRow,
  userId: string,
  now: Date = new Date(),
  bootAt?: Date,
): ChallengeDetail {
  const summary = buildSummary(db, challenge, userId, now);
  const pokeTargets = pokeTargetList(db, challenge, userId, now);
  const disputesClose = disputesOpenUntil(db, challenge, now, bootAt);
  return {
    ...summary,
    disputesCloseAt: Number.isFinite(disputesClose) ? new Date(disputesClose).toISOString() : null,
    myEntries: myEntries(db, challenge.id, userId),
    feed: challengeFeed(db, challenge.id),
    feedCursor: feedCursor(db, challenge.id),
    disputes: challengeDisputes(db, challenge.id),
    taunts: tauntsForUser(db, challenge.id, userId),
    canTaunt: canTauntList(db, challenge, userId),
    pokeTargets,
    // the button only lights up when there is somebody to talk to right now
    canPoke: pokeTargets.some((target) => !target.done),
  };
}

/** Reload from the database so the response always mirrors what was committed. */
export function freshDetail(
  db: Database,
  challengeId: string,
  userId: string,
  now: Date = new Date(),
  bootAt?: Date,
): ChallengeDetail {
  return buildDetail(db, requireChallengeRow(db, challengeId), userId, now, bootAt);
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
    return {
      title: 'Çelınc daveti',
      body: `${creator} seni "${title}" çelıncına çağırdı. Var mısın?`,
    };
  }
  if (level === 3) {
    return {
      title: 'ADAMLIĞIN YETER Mİ? 🍆',
      body: `Adamlığın yeter mi bilmiyorum ama ${creator} sana "${title}" çelıncı gönderdi.`,
    };
  }
  return {
    title: 'Sana çelınc geldi',
    body: `Adamlığın yeter mi bilmiyorum ama ${creator} sana "${title}" çelıncı gönderdi.`,
  };
}

/**
 * To the players and invitees of a çelınc its creator called off before the
 * start. `creator` is null across a block: the çelınc is gone either way, the
 * name the reader blocked (or was blocked by) does not need to come with it.
 */
export function cancelledByCreatorCopy(level: VulgarityLevel, creator: string | null, title: string): CopyText {
  if (level === 1) {
    return {
      title: 'Çelınc iptal edildi',
      body: creator ? `${creator}, "${title}" çelıncını iptal etti.` : `"${title}" çelıncı iptal edildi.`,
    };
  }
  if (level === 3) {
    return {
      title: 'Çelınc iptal 🍆',
      body: creator ? `${creator} "${title}" çelıncını iptal etti. Ödü koptu herhalde.` : `"${title}" çelıncı yattı, iptal 🍆`,
    };
  }
  return {
    title: 'Çelınc iptal oldu',
    body: creator ? `${creator} "${title}" çelıncını iptal etti.` : `"${title}" çelıncı iptal oldu.`,
  };
}

/**
 * To whoever called them in (the creator, unless a player did): an invitee
 * said no. The one moment a "tırstı" is fair game.
 */
export function declinedCopy(level: VulgarityLevel, who: string, title: string): CopyText {
  if (level === 1) return { title: `${who} daveti reddetti`, body: `${who}, "${title}" çelıncına katılmayacak.` };
  if (level === 3) return { title: `${who} korktu kaçtı 🐔`, body: `"${title}" davetini görünce yok dedi. Adamlığı yetmedi 🍆` };
  return { title: `${who} tırstı, reddetti`, body: `"${title}" davetine yok dedi.` };
}

/**
 * To the creator (and whoever called them in) of a çelınc that has not
 * started, or to the players of one already running: somebody said yes.
 * `count` is how many are in now. Nothing hangs off the name: "de/da" and
 * every case suffix follow its last vowel, and a display name can be "MSN" or
 * "🔥".
 */
export function acceptedCopy(level: VulgarityLevel, who: string, title: string, count: number): CopyText {
  if (level === 1) {
    return { title: `${who} kabul etti`, body: `${who}, "${title}" çelıncına katıldı. Artık ${count} kişisiniz.` };
  }
  if (level === 3) return { title: `${who} sahaya indi 🍆`, body: `"${title}" çelıncına daldı, kurban sayısı ${count} oldu.` };
  return { title: `${who} "varım" dedi`, body: `"${title}" çelıncında artık ${count} kişisiniz.` };
}

/** To the players still in: somebody walked out mid-çelınc. */
export function leftCopy(level: VulgarityLevel, who: string, title: string): CopyText {
  if (level === 1) return { title: `${who} çelınctan ayrıldı`, body: `${who}, "${title}" çelıncında artık yok. Sıralamadan düştü.` };
  if (level === 3) return { title: `${who} havlu attı 🐔`, body: `"${title}" çelıncında dayanamadı, bıraktı gitti 🍆` };
  return { title: `${who} bıraktı kaçtı`, body: `"${title}" çelıncını yarıda bıraktı, sıralamadan düştü.` };
}

/** "12 saat": the answer window as the owner reads it. */
const ANSWER_HOURS = `${Math.round(LIMITS.DISPUTE_ANSWER_MS / 3_600_000)} saat`;

/**
 * "21 Ekim Salı", not "2026-10-21 tarihli". Always followed by "günkü",
 * "için" or a "·" in the copy below, never by a case suffix of its own.
 */
const dayWord = (dayKey: string): string => formatDayKeyTr(dayKey, { withWeekday: true });

/**
 * Where the photo goes. The "Kanıt ekle" chip only exists from 1.1.0 on, and a
 * friend still on the 1.0 APK was otherwise told to do something their app
 * cannot; the server does not know which one the reader has.
 */
function proofWhere(level: VulgarityLevel): string {
  if (level === 1) return 'Girişin yanında "Kanıt ekle" düğmesi yoksa önce uygulamayı güncelle.';
  return '"Kanıt ekle" düğmesi yoksa önce uygulamayı güncelle.';
}

/**
 * To the owner of a disputed entry. `onTheClock` is the itiraz that made it a
 * majority: from now on the entry goes unless a photo comes in, so the copy
 * says so. Before that (or after, from yet another friend) it only asks.
 * `by` is null across a block: the owner hears that an itiraz came, which
 * the race needs, but the lock screen does not spell out the name they
 * blocked (or were blocked by). The çelınc's own screen still shows who said
 * what under the row, as its standings show both of them.
 */
export function disputeCopy(level: VulgarityLevel, by: string | null, title: string, dayKey: string, onTheClock = false): CopyText {
  const who = by ?? 'Bir rakibin';
  if (level === 1) {
    return {
      title: 'Girişine itiraz var',
      body: onTheClock
        ? `${who}, "${title}" çelıncında ${dayWord(dayKey)} günkü girişine itiraz etti. ${ANSWER_HOURS} içinde fotoğraf eklersen giriş kalır, eklemezsen iptal olur. ${proofWhere(level)}`
        : `${who}, "${title}" çelıncında ${dayWord(dayKey)} günkü girişine itiraz etti. Kanıtını paylaşabilirsin.`,
    };
  }
  if (level === 3) {
    return {
      title: 'PALAVRA DEDİ 🍆',
      body: onTheClock
        ? `${who}, "${title}" çelıncında ${dayWord(dayKey)} günkü girişine palavra dedi. ${ANSWER_HOURS} içinde fotoğrafı koy, yoksa o gün yanar. ${proofWhere(level)}`
        : `${who}, "${title}" çelıncında ${dayWord(dayKey)} günkü girişine palavra dedi. Kanıtlayamazsan o gün gider.`,
    };
  }
  return {
    title: 'İtiraz yedin',
    body: onTheClock
      ? `${who}, "${title}" çelıncında ${dayWord(dayKey)} günkü girişine yalan dedi. ${ANSWER_HOURS} içinde fotoğraf ekle, yoksa bu giriş yanar. ${proofWhere(level)}`
      : `${who}, "${title}" çelıncında ${dayWord(dayKey)} günkü girişine yalan dedi. Kanıtını göster.`,
  };
}

/**
 * To the other players, on the first itiraz an entry gets when one vote is
 * not a majority (four players and up): a majority nobody hears about never
 * forms, and the disputed number keeps counting. `value` comes from
 * `scoreLabel` ("600 sayfa"), `needed` is the majority with the disputer in
 * it. Neither name takes a suffix (see `acceptedCopy`), so the entry is
 * written the way the feed shows it: "Ali · 21 Ekim Salı · 600 sayfa".
 */
export function disputeCallCopy(
  level: VulgarityLevel,
  by: string,
  owner: string,
  title: string,
  dayKey: string,
  value: string,
  needed: number,
): CopyText {
  const entry = `${owner} · ${dayWord(dayKey)} · ${value}`;
  if (level === 1) {
    return {
      title: 'Bir girişe itiraz var',
      body: `${by}, "${title}" çelıncında bir girişe itiraz etti: ${entry}. İtiraz edenler ${needed} kişiyi bulursa sahibinin ${ANSWER_HOURS} içinde kanıt eklemesi gerekir, eklemezse giriş sayılmaz. Sen de bir göz atabilirsin.`,
    };
  }
  if (level === 3) {
    return {
      title: 'Biri sallıyor olabilir 🍆',
      body: `${by}, "${title}" çelıncında bir girişe palavra dedi: ${entry}. Palavra diyenler ${needed} kişiyi bulursa ${ANSWER_HOURS} içinde kanıtı koyacak, koyamazsa çöpe gider. Sen de bak 🍆`,
    };
  }
  return {
    title: 'İtiraz var, sen de bak',
    body: `${by}, "${title}" çelıncında bir girişe yalan dedi: ${entry}. Yalan diyenler ${needed} kişiyi bulursa ${ANSWER_HOURS} içinde kanıt lazım, yoksa giriş yanar. Sen ne diyorsun?`,
  };
}

/**
 * To the owner of an entry whose itirazlar became a majority without a new
 * one: somebody left, so fewer votes make it. The clock starts now, and the
 * owner hears it now instead of reading "kanıt gelmedi" twelve hours later.
 */
export function disputeMajorityCopy(level: VulgarityLevel, title: string, dayKey: string): CopyText {
  if (level === 1) {
    return {
      title: 'Girişine itiraz var',
      body: `"${title}" çelıncında ${dayWord(dayKey)} günkü girişine yapılan itiraz artık çoğunlukta. ${ANSWER_HOURS} içinde fotoğraf eklersen giriş kalır, eklemezsen iptal olur. ${proofWhere(level)}`,
    };
  }
  if (level === 3) {
    return {
      title: 'PALAVRA DİYENLER ÇOĞALDI 🍆',
      body: `"${title}" çelıncında ${dayWord(dayKey)} günkü girişine palavra diyenler artık çoğunlukta. ${ANSWER_HOURS} içinde fotoğrafı koy, yoksa o gün yanar. ${proofWhere(level)}`,
    };
  }
  return {
    title: 'İtiraz yedin',
    body: `"${title}" çelıncında ${dayWord(dayKey)} günkü girişine yalan diyenler artık çoğunlukta. ${ANSWER_HOURS} içinde fotoğraf ekle, yoksa bu giriş yanar. ${proofWhere(level)}`,
  };
}

/** To everybody whose itiraz a photo just answered. */
export function disputeProofCopy(level: VulgarityLevel, owner: string, title: string, dayKey: string): CopyText {
  if (level === 1) {
    return { title: 'Kanıt geldi', body: `${owner}, "${title}" çelıncında ${dayWord(dayKey)} günkü girişine fotoğraf ekledi. İtirazın kapandı, bir göz atabilirsin.` };
  }
  if (level === 3) {
    return { title: 'KANITI KOYDU 🍆', body: `${owner} kanıtı koydu, bir bak. "${title}" çelıncında ${dayWord(dayKey)} günkü girişi yine sayılıyor.` };
  }
  return { title: 'Kanıt geldi', body: `${owner} kanıt ekledi, bir bak. "${title}" çelıncında ${dayWord(dayKey)} günkü girişi yine sayılıyor.` };
}

export function entryRejectedCopy(level: VulgarityLevel, title: string, dayKey: string): CopyText {
  if (level === 1) {
    return { title: 'Girişin iptal oldu', body: `"${title}" çelıncında ${dayWord(dayKey)} günkü girişine itiraz vardı, ${ANSWER_HOURS} içinde kanıt gelmedi. Giriş skorundan düştü.` };
  }
  if (level === 3) {
    return { title: 'GİRİŞİN ÇÖPE GİTTİ 🍆', body: `"${title}" çelıncında ${dayWord(dayKey)} günkü girişine hile dendi, sen de kanıtı koyamadın. Yandı, skorundan düştü.` };
  }
  return { title: 'Girişin yandı', body: `"${title}" çelıncında ${dayWord(dayKey)} günkü girişine yalan dendi, kanıt da gelmedi. Giriş skorundan düştü.` };
}

/**
 * To the owner of a typed day thrown out when the phone had already reported
 * it (`restoreFromPhone`): the day did not drop off the score, the phone's
 * number took the typed one's place, and the copy says both. `typed` and
 * `phone` come from `scoreLabel` ("15.000 adım").
 */
export function entryReplacedCopy(level: VulgarityLevel, title: string, dayKey: string, typed: string, phone: string): CopyText {
  const day = dayWord(dayKey);
  if (level === 1) {
    return {
      title: 'Girişin değişti',
      body: `"${title}" çelıncında ${day} için yazdığın ${typed} artık sayılmıyor: itiraza ${ANSWER_HOURS} içinde kanıt gelmedi. Telefonun o gün ${phone} kaydetmiş, yerine o sayılıyor.`,
    };
  }
  if (level === 3) {
    return {
      title: 'PALAVRAN YANDI 🍆',
      body: `"${title}" çelıncında ${day} için yazdığın ${typed} çöpe gitti, kanıtı koyamadın. Telefonun ${phone} demiş, artık o sayılıyor. Telefon yalan söylemez 🍆`,
    };
  }
  return {
    title: 'Girişin yandı',
    body: `"${title}" çelıncında ${day} için yazdığın ${typed} yandı, kanıt gelmedi. Telefonun ${phone} demiş, yerine o sayılıyor.`,
  };
}

/**
 * To everybody whose itiraz was upheld: they started it, so they hear how it
 * ended, like they do when a photo answers it. `phone` is the phone's number
 * that took the day's place, when there was one.
 */
export function disputeUpheldCopy(level: VulgarityLevel, owner: string, title: string, dayKey: string, phone: string | null): CopyText {
  const day = dayWord(dayKey);
  if (level === 1) {
    return {
      title: 'İtirazın kabul edildi',
      body: `${owner}, "${title}" çelıncında ${day} günkü girişine ${ANSWER_HOURS} içinde kanıt eklemedi. Giriş sayılmıyor.${phone ? ` Yerine telefonunun kaydettiği ${phone} sayılıyor.` : ''}`,
    };
  }
  if (level === 3) {
    return {
      title: 'YAKALADIN 🍆',
      body: `${owner}, "${title}" çelıncında ${day} günkü girişine kanıt koyamadı, palavrası çöpe gitti.${phone ? ` Telefonu ${phone} demiş, artık o sayılıyor.` : ''}`,
    };
  }
  return {
    title: 'İtirazın tuttu',
    body: `${owner}, "${title}" çelıncında ${day} günkü girişine kanıt getiremedi, o giriş yandı.${phone ? ` Yerine telefonunun saydığı ${phone} geçti.` : ''}`,
  };
}

/**
 * How the invitee came out of the original: `won` it outright, shared first
 * place in a `tie`, or `lost` (behind a shared first place too, as in the
 * Karne). The rematch goes to the whole old line-up, winner included.
 */
export type RematchRole = 'won' | 'lost' | 'tie';

/**
 * To each invitee of a rematch. "Yine mi yiyeceksin" is only true for somebody
 * who lost the original: when the loser opens it, the winner hears that the
 * opener is back for more instead.
 */
export function rematchCopy(level: VulgarityLevel, by: string, title: string, role: RematchRole): CopyText {
  if (level === 1) return { title: '🔁 Rövanş daveti', body: `${by}, "${title}" için rövanş istiyor. Kabul edersen baştan başlıyorsunuz.` };
  if (level === 3) {
    if (role === 'won') return { title: '🔁 RÖVANŞ 🍆', body: `${by} "${title}" için rövanş açtı. Geçen sefer yedi, doymamış 🍆 Bir daha koy.` };
    if (role === 'tie') return { title: '🔁 RÖVANŞ 🍆', body: `${by} "${title}" için rövanş açtı. Bu sefer biri yiyecek 🍆` };
    return { title: '🔁 RÖVANŞ 🍆', body: `${by} "${title}" için rövanş açtı. Yine mi yiyeceksin bakalım.` };
  }
  if (role === 'won') return { title: '🔁 Rövanş var', body: `${by}, "${title}" için rövanş istiyor. Kabul et de bir daha koy.` };
  return { title: '🔁 Rövanş var', body: `${by}, "${title}" için rövanş istiyor. Kabul et de görelim.` };
}
