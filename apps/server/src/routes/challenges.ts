/**
 * Challenge routes: the list, creation and the invite lifecycle.
 *
 *   GET  /challenges?status=active,pending,finished
 *   POST /challenges
 *   GET  /challenges/:id
 *   GET  /challenges/:id/feed?before=&beforeId=&userId=&limit=
 *   POST /challenges/:id/accept | /decline | /leave | /cancel
 *   POST /challenges/:id/invite
 *
 * Every mutation answers with the full `ChallengeDetail` of the challenge it touched,
 * so the app can repaint the screen straight from the response.
 */
import type { FastifyInstance } from 'fastify';
import {
  LIMITS,
  InviteToChallengeBodySchema,
  IsoDateTimeSchema,
  acceptClosesAt,
  createChallengeBodySchema,
  deadlineFitsWindow,
  getChallengeType,
  isValidHHmm,
  ChallengeFeedQuerySchema,
  ChallengeListQuerySchema,
  type Challenge,
  type ChallengeDetail,
  type ChallengeSummary,
  type FeedPage,
} from '@koydum/shared';
import { badRequest, conflict, forbidden, parseBody, parseQuery, type HttpError } from '../errors.js';
import { newId, nowIso, type ChallengeRow, type Database, type UserRow } from '../db/index.js';
import { markAnsweredRead, notify } from '../services/notifications.js';
import { toChallenge } from '../serialize.js';
import {
  acceptedCopy,
  buildDetail,
  buildSummary,
  cancelledByCreatorCopy,
  challengeFeedPage,
  declinedCopy,
  freshDetail,
  getParticipant,
  getUserRow,
  inviteCopy,
  leftCopy,
  levelOf,
  requireChallengeRow,
  requireMembership,
  requireUserRow,
} from '../services/challengeViews.js';
import {
  acceptedParticipants,
  activateDueChallenges,
  cancelIfAbandoned,
  checkinDaysShort,
  creatorTimezone,
  participantRows,
  participantTimezone,
  startedCopy,
  stillOpen,
  typeForChallenge,
} from '../services/challenges.js';
import { backfillFromPhone } from '../services/deviceSync.js';
import { isDiskFull, warnDiskFull } from '../services/disk.js';
import { announceDisputeClocks } from '../services/entries.js';
import { assertNotBlocked, isBlockedBetween } from '../services/friends.js';
import { BANNED_TEXT_MESSAGES, assertCleanTitle } from '../services/moderation.js';

interface IdParams {
  id: string;
}

/**
 * A start this little ahead of the server's clock is "Hemen". The app sends
 * this server's now as it last measured it (utils/serverClock), right only to
 * within half a /health round trip: a probe that waited for the phone's radio
 * to wake up puts it a moment ahead. Taken as a future start, it sat `pending`
 * until a friend said "Varım", its creator unable to write a thing.
 */
const START_AHEAD_SLACK_MS = 60_000;

/**
 * How close a second "KOY BAKALIM" comes to the first to be its retry: the app
 * gives up on an answer after 15 s, and a "Hemen" start (and an end too short
 * to snap to a local midnight, computeWindow's fallback) moves on with the
 * clock between the two taps.
 */
const RETRY_TWIN_MS = 2 * 60_000;

/**
 * Ordering (SPEC 2.2): active first by soonest deadline, then pending by start time,
 * then finished newest-first. Cancelled ones trail the list.
 */
const LIST_ORDER = `
  ORDER BY CASE c.status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 WHEN 'finished' THEN 2 ELSE 3 END ASC,
           CASE c.status WHEN 'active' THEN c.ends_at WHEN 'pending' THEN c.starts_at ELSE '' END ASC,
           COALESCE(c.finalized_at, '') DESC,
           c.created_at DESC
`;

/** Accepted friendship in either direction, with no block on top of it. */
function areFriends(db: Database, a: string, b: string): boolean {
  const friend = db
    .prepare(
      `SELECT 1 AS ok FROM friendships
        WHERE status = 'accepted'
          AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))`,
    )
    .get(a, b, b, a) as { ok: number } | undefined;
  return friend !== undefined;
}

function isBlocked(db: Database, a: string, b: string): boolean {
  const blocked = db
    .prepare(
      `SELECT 1 AS ok FROM friendships
        WHERE status = 'blocked'
          AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))`,
    )
    .get(a, b, b, a) as { ok: number } | undefined;
  return blocked !== undefined;
}

/**
 * Who is in a çelınc with one of `statuses`, but `exceptId`: the people the
 * invite and accept routes check a newcomer's blocks against (SPEC 2.2).
 */
function lineUpOf(
  db: Database,
  challengeId: string,
  exceptId: string,
  statuses: readonly ('accepted' | 'invited')[],
): string[] {
  const rows = db
    .prepare(
      `SELECT user_id, status FROM challenge_participants
        WHERE challenge_id = ? AND user_id <> ?`,
    )
    .all(challengeId, exceptId) as { user_id: string; status: string }[];
  return rows.filter((row) => (statuses as readonly string[]).includes(row.status)).map((row) => row.user_id);
}

/**
 * Somebody the reader may put in a çelınc: an existing account and an accepted
 * friendship with no block on top of it. Creation and a later invite pass the
 * same gate.
 */
function requireFriend(db: Database, meId: string, userId: string): UserRow {
  const user = requireUserRow(db, userId);
  if (isBlocked(db, meId, user.id) || !areFriends(db, meId, user.id)) {
    throw badRequest('not_friends', `${user.display_name} kankan değil. Önce arkadaş olun.`);
  }
  return user;
}

/** The columns of a new çelınc that a retry of its creation sends again. */
interface CreatedFields {
  type_key: string;
  title: string;
  starts_at: string;
  ends_at: string;
  reward_text: string | null;
  penalty_text: string | null;
  deadline_time: string | null;
  daily_target: number | null;
  proof_required: number;
}

/**
 * The çelınc this creation already made, when it is a retry. A tunnel or a
 * mobile link can deliver POST /challenges and lose its answer; the app says
 * "Sunucu cevap vermedi" and the creator taps "KOY BAKALIM" again. Each tap
 * made a çelınc and sent every friend an invite, and the twin of a "Hemen" one
 * is live, which nobody can call off. A twin is the same creator's, made within
 * RETRY_TWIN_MS, still theirs to play (pending or active, not walked out of),
 * with the same type, name, stakes and rules, the same friends asked (whatever
 * they answered since) and its start and end within RETRY_TWIN_MS of these:
 * computeWindow snaps the end to the last local day, so the retry of every
 * installed wizard sends the same one. Both have begun or neither has: a
 * "Hemen" is no twin of a start two minutes ahead. A rematch is never one: it
 * has its own route and its own check.
 */
function retryTwin(
  db: Database,
  meId: string,
  fields: CreatedFields,
  participantIds: readonly string[],
  now: Date,
): ChallengeRow | undefined {
  const candidates = db
    .prepare(
      `SELECT c.* FROM challenges c
         JOIN challenge_participants p ON p.challenge_id = c.id AND p.user_id = c.creator_id
        WHERE c.creator_id = ? AND c.created_at >= ? AND c.status IN ('pending', 'active')
          AND c.rematch_of_id IS NULL AND p.status = 'accepted'
          AND c.type_key = ? AND c.title = ? AND c.reward_text IS ? AND c.penalty_text IS ?
          AND c.deadline_time IS ? AND c.daily_target IS ? AND c.proof_required = ?
        ORDER BY c.created_at DESC`,
    )
    .all(
      meId,
      nowIso(new Date(now.getTime() - RETRY_TWIN_MS)),
      fields.type_key,
      fields.title,
      fields.reward_text,
      fields.penalty_text,
      fields.deadline_time,
      fields.daily_target,
      fields.proof_required,
    ) as ChallengeRow[];
  const near = (a: string, b: string): boolean => Math.abs(Date.parse(a) - Date.parse(b)) <= RETRY_TWIN_MS;
  const begun = (at: string): boolean => Date.parse(at) <= now.getTime();
  const asked = [...participantIds].sort().join(',');
  return candidates.find((row) => {
    if (!near(row.starts_at, fields.starts_at) || !near(row.ends_at, fields.ends_at)) return false;
    if (begun(row.starts_at) !== begun(fields.starts_at)) return false;
    const others = db
      .prepare('SELECT user_id FROM challenge_participants WHERE challenge_id = ? AND user_id <> ?')
      .all(row.id, meId) as { user_id: string }[];
    return others.map((other) => other.user_id).sort().join(',') === asked;
  });
}

/** "6 güne denk geliyor", or no day at all: the check-in days a zone gets (`checkinDaysShort`). */
function checkinDaysTr(days: number): string {
  return days === 0 ? 'hiçbir güne denk gelmiyor' : `${days} güne denk geliyor`;
}

/** "çelıncı açan Ali için": whose count of check-in days is the bar. */
function forCreator(db: Database, challenge: ChallengeRow): string {
  const name = getUserRow(db, challenge.creator_id)?.display_name;
  return name ? `çelıncı açan ${name} için` : 'çelıncı açan için';
}

/**
 * 400 `checkin_days_short` for a friend put into a check-in çelınc whose
 * deadlines their zone gives fewer of than the creator's: "Hemen" at 12:50 in
 * Istanbul, an erken_yat of one day ends at 15:59 in New York, and Mert lost
 * it 1-0 without one evening to tap "Geldim" in. `whose` says whose count
 * the bar is: "sende" to the creator, else `forCreator`. No suffix after the
 * name: it follows the name's last vowel, and a display name can be "MSN" or
 * "🔥".
 */
function invitedShortError(name: string, short: { days: number; creatorDays: number }, whose: string): HttpError {
  return badRequest(
    'checkin_days_short',
    `Saat farkı yüzünden bu çelıncın check-in saati ${name} için ${checkinDaysTr(short.days)}, ${whose} ${short.creatorDays} gün. Eksik günle eklenemez.`,
  );
}

/**
 * "Ali tırstı": a no goes to whoever called Ali in (the creator, unless
 * another player brought him with "Kanka ekle"), a walk-out to the players
 * still in, each at their own level. A yes goes to the creator, and to the
 * one who called if that is somebody else, while the çelınc has not started
 * (they are the ones waiting for answers), and to every other player once it
 * runs. Only people still in the race hear it, and never across a block:
 * somebody who blocked Ali does not want that name in the inbox.
 */
function tellWhoIsIn(
  db: Database,
  challenge: ChallengeRow,
  who: UserRow,
  type: 'challenge_declined' | 'challenge_left' | 'challenge_accepted',
  at: string,
): void {
  const players = acceptedParticipants(db, challenge.id);
  const inviter = getParticipant(db, challenge.id, who.id)?.invited_by ?? challenge.creator_id;
  const only =
    type === 'challenge_declined'
      ? [inviter]
      : type === 'challenge_accepted' && challenge.status === 'pending'
        ? [challenge.creator_id, inviter]
        : null;
  for (const participant of players) {
    if (participant.user_id === who.id) continue;
    if (only && !only.includes(participant.user_id)) continue;
    if (isBlockedBetween(db, who.id, participant.user_id)) continue;
    const user = getUserRow(db, participant.user_id);
    if (!user || user.deleted_at !== null) continue;
    const copy =
      type === 'challenge_accepted'
        ? acceptedCopy(levelOf(user), who.display_name, challenge.title, players.length)
        : (type === 'challenge_declined' ? declinedCopy : leftCopy)(levelOf(user), who.display_name, challenge.title);
    notify(db, {
      userId: user.id,
      type,
      title: copy.title,
      body: copy.body,
      data: { challengeId: challenge.id, fromUserId: who.id },
      createdAt: at,
    });
  }
}

/**
 * Who hears about a yes, once it is written.
 *
 * A "Hemen" çelınc is `active` from its creation with only the creator in it,
 * and the scheduler only ever starts `pending` ones, so the yes that first
 * makes it two is its start: "başladı" to both players, as the scheduler says
 * it, whatever the hour on a check-in çelınc too: nothing made the creator's
 * phone set a check-in reminder since the creation, so this is the only word
 * the creator gets. A yes that makes a `pending` çelınc past its start time two
 * is left to the scheduler, which starts it within 30 s and says the same, also
 * before 07:00 (`startsQuietly`: nobody's phone had it either); a second
 * notification on top would only be noise. Every other yes is a
 * `challenge_accepted` (`tellWhoIsIn`), also the one that brings a çelınc back
 * to two after somebody walked out: it had its start already.
 */
function announceAccept(db: Database, challenge: ChallengeRow, who: UserRow, now: Date): void {
  const at = nowIso(now);
  const players = acceptedParticipants(db, challenge.id);
  if (challenge.status === 'pending' && Date.parse(challenge.starts_at) <= now.getTime() && players.length >= 2) {
    return;
  }
  // rows from before `joined_at` was always set count as having joined
  const everJoined = participantRows(db, challenge.id).filter((p) => p.status === 'accepted' || p.joined_at !== null);
  if (challenge.status === 'active' && players.length === 2 && everJoined.length === 2) {
    for (const participant of players) {
      const user = getUserRow(db, participant.user_id);
      if (!user || user.deleted_at !== null) continue;
      const copy = startedCopy(levelOf(user), challenge.title);
      notify(db, {
        userId: user.id,
        type: 'challenge_started',
        title: copy.title,
        body: copy.body,
        data: { challengeId: challenge.id },
        createdAt: at,
      });
    }
    return;
  }
  tellWhoIsIn(db, challenge, who, 'challenge_accepted', at);
}

/**
 * An invite answered (yes, no, or an invitee's "Ayrıl") is read in Gelen too:
 * the one sent at creation, a "Kanka ekle" one and a rematch's, which names the
 * rematch as its `challengeId`. They are mostly answered on the home card or
 * the çelınc screen, and the badge kept counting them.
 */
function markInviteAnswered(db: Database, userId: string, challengeId: string, at: string): void {
  markAnsweredRead(db, userId, ['challenge_invite', 'rematch'], 'challengeId', challengeId, at);
}

export default async function challengeRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;

  // The start a read makes on the way. On a full disk it cannot be written, and
  // its 507 took the list and the çelınc screen from every friend while any
  // çelınc anywhere was due to start; the read goes on with it still pending
  // (the app shows a due start as running) and the scheduler starts it once
  // there is room. A write route that activates first still answers 507.
  const activateOnRead = (): void => {
    try {
      activateDueChallenges(db, app.now());
    } catch (err) {
      if (!isDiskFull(err)) throw err;
      warnDiskFull(app, app.now().getTime());
    }
  };

  // -------------------------------------------------------------------------
  // GET /challenges
  // -------------------------------------------------------------------------
  app.get('/challenges', { preHandler: app.authenticate }, async (request): Promise<ChallengeSummary[]> => {
    const me = request.user;
    const query = parseQuery(ChallengeListQuerySchema, request.query ?? {});
    // started by rule is started on every read too (see GET /challenges/:id)
    activateOnRead();

    const filters: string[] = [];
    const params: unknown[] = [me.id];
    if (query.status.length > 0) {
      filters.push(`AND c.status IN (${query.status.map(() => '?').join(', ')})`);
      params.push(...query.status);
    }

    const rows = db
      .prepare(
        `SELECT c.* FROM challenges c
           JOIN challenge_participants p ON p.challenge_id = c.id
          WHERE p.user_id = ? AND p.status IN ('accepted', 'invited')
          ${filters.join(' ')}
          ${LIST_ORDER}`,
      )
      .all(...(params as never[])) as ChallengeRow[];

    return rows.map((row) => buildSummary(db, row, me.id, app.now()));
  });

  // -------------------------------------------------------------------------
  // POST /challenges
  // -------------------------------------------------------------------------
  app.post('/challenges', { preHandler: app.authenticate }, async (request, reply): Promise<Challenge> => {
    const me = request.user;
    const now = app.now();
    // The check-in window is a schema rule, and a schema 400 says only
    // "Gönderdiğin bilgiler geçersiz.": the 1.0 and 1.1 wizards take any hour
    // and show nothing but the message, so its reason must be the message.
    const raw = typeof request.body === 'object' && request.body !== null ? (request.body as Record<string, unknown>) : {};
    const rawType = typeof raw.typeKey === 'string' ? getChallengeType(raw.typeKey) : undefined;
    if (
      rawType?.metricType === 'checkin_deadline' &&
      isValidHHmm(raw.deadlineTime) &&
      !deadlineFitsWindow(rawType, raw.deadlineTime)
    ) {
      throw badRequest(
        'deadline_outside_window',
        `Check-in saati ${rawType.checkinWindowStart} sonrası, en geç 23:59 olmalı. Saati değiştirip tekrar dene.`,
      );
    }
    // So is a start in the past. Older wizards take "Hemen" from the phone's
    // own clock: one running slow, or a server PC whose clock is off (Windows
    // next to a Linux install, until it resyncs), had every "Hemen" refused
    // with nothing to say which clock was wrong. They show the message, too.
    if (
      IsoDateTimeSchema.safeParse(raw.startsAt).success &&
      Date.parse(raw.startsAt as string) < now.getTime() - LIMITS.START_GRACE_MS
    ) {
      throw badRequest(
        'start_in_past',
        'Başlangıç sunucunun saatine göre geçmişte kalıyor. Telefonunun ya da sunucu bilgisayarının saati yanlış olabilir; ikisinde de otomatik saat açık olsun.',
      );
    }
    // The clock is injected so `startsAt >= now - 5min` follows the test clock too.
    const schema = createChallengeBodySchema({ now: () => now.getTime() });
    const body = parseBody(schema, request.body);
    // invitees read these before they say yes, the title in the invite's push
    assertCleanTitle(body.title, BANNED_TEXT_MESSAGES.title);
    assertCleanTitle(body.rewardText, BANNED_TEXT_MESSAGES.rewardText);
    assertCleanTitle(body.penaltyText, BANNED_TEXT_MESSAGES.penaltyText);

    const type = getChallengeType(body.typeKey);
    if (!type) throw badRequest('unknown_type', 'Böyle bir çelınc tipi yok.');

    if (body.participantIds.includes(me.id)) {
      throw badRequest('self_participant', 'Kendini davet edemezsin, zaten içindesin.');
    }

    for (const participantId of body.participantIds) requireFriend(db, me.id, participantId);

    const startMs = Date.parse(body.startsAt);
    const startsAt = (
      startMs > now.getTime() && startMs - now.getTime() <= START_AHEAD_SLACK_MS ? now : new Date(startMs)
    ).toISOString();
    const endsAt = new Date(body.endsAt).toISOString();
    const createdAt = nowIso(now);
    // Live immediately when the start time has already passed (SPEC 2.2); a future
    // start waits for the scheduler.
    const status = Date.parse(startsAt) <= now.getTime() ? 'active' : 'pending';
    // Nobody is asked into a check-in çelınc their zone gives fewer deadlines
    // of: they could only lose it (the accept route refuses them too).
    const deadlineTime =
      body.deadlineTime ?? (type.metricType === 'checkin_deadline' ? (type.defaultDeadlineTime ?? null) : null);
    for (const participantId of body.participantIds) {
      const invitee = requireUserRow(db, participantId);
      const short = checkinDaysShort(
        { starts_at: startsAt, ends_at: endsAt, deadline_time: deadlineTime },
        type,
        participantTimezone(undefined, me.row),
        participantTimezone(undefined, invitee),
      );
      if (short) throw invitedShortError(invitee.display_name, short, 'sende');
    }

    const challengeId = newId();
    const insertChallenge = db.prepare(
      `INSERT INTO challenges (id, creator_id, type_key, metric_type, direction, unit, title, starts_at, ends_at,
                               status, reward_text, penalty_text, deadline_time, daily_target, proof_required,
                               created_at, finalized_at, winner_id, is_tie, rematch_of_id)
       VALUES (@id, @creator_id, @type_key, @metric_type, @direction, @unit, @title, @starts_at, @ends_at,
               @status, @reward_text, @penalty_text, @deadline_time, @daily_target, @proof_required,
               @created_at, NULL, NULL, 0, NULL)`,
    );
    // `timezone` is the zone the participant's day keys are measured in, frozen at
    // join time (invitees get theirs when they accept) so a later PATCH /me cannot
    // move the check-in deadline or the day window under a running challenge.
    const insertParticipant = db.prepare(
      `INSERT INTO challenge_participants (challenge_id, user_id, status, invited_at, joined_at, final_score, final_rank, timezone)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
    );

    const fields: CreatedFields = {
      type_key: type.key,
      title: body.title ?? type.nameTr,
      starts_at: startsAt,
      ends_at: endsAt,
      reward_text: body.rewardText ?? null,
      penalty_text: body.penaltyText ?? null,
      deadline_time: deadlineTime,
      daily_target: body.dailyTarget ?? null,
      proof_required: (body.proofRequired ?? type.proofRequired) ? 1 : 0,
    };

    // In the transaction with the insert, so two copies arriving together
    // cannot both miss each other.
    const run = db.transaction((): ChallengeRow | undefined => {
      const twin = retryTwin(db, me.id, fields, body.participantIds, now);
      if (twin) return twin;

      insertChallenge.run({
        ...fields,
        id: challengeId,
        creator_id: me.id,
        // The metric shape is COPIED from the catalog so a later catalog edit can
        // never rewrite the rules of a challenge that is already being played.
        metric_type: type.metricType,
        direction: type.direction,
        unit: type.unitTr,
        status,
        created_at: createdAt,
      });

      insertParticipant.run(challengeId, me.id, 'accepted', createdAt, createdAt, me.row.timezone);

      for (const participantId of body.participantIds) {
        insertParticipant.run(challengeId, participantId, 'invited', createdAt, null, null);
        const invitee = requireUserRow(db, participantId);
        const copy = inviteCopy(levelOf(invitee), me.row.display_name, body.title ?? type.nameTr);
        notify(db, {
          userId: invitee.id,
          type: 'challenge_invite',
          title: copy.title,
          body: copy.body,
          data: { challengeId, fromUserId: me.id },
          createdAt,
        });
      }
      return undefined;
    });
    const twin = run();

    // A retry gets the first one, as the lost answer would have had it: 200, no
    // second invite. Every wizard treats any 2xx alike and opens /challenge/<id>.
    void reply.code(twin ? 200 : 201);
    // SPEC 2.2: creation answers with the Challenge itself — the wizard navigates
    // straight to /challenge/<id> and then loads the detail.
    return toChallenge(twin ?? requireChallengeRow(db, challengeId));
  });

  // -------------------------------------------------------------------------
  // GET /challenges/:id
  // -------------------------------------------------------------------------
  app.get('/challenges/:id', { preHandler: app.authenticate }, async (request): Promise<ChallengeDetail> => {
    const me = request.user;
    const { id } = request.params as IdParams;
    // A çelınc past its start with two yeses has started by rule; the scheduler
    // gets to it on its next beat, up to 30 s on. The screen refetches the moment
    // its countdown runs out, and a "pending" read then had the app say the
    // server could not be reached, to a phone that had just reached it. As in the
    // entry and cancel routes: an indexed lookup that almost always finds nothing.
    activateOnRead();
    const challenge = requireChallengeRow(db, id);
    requireMembership(db, challenge, me.id);
    return buildDetail(db, challenge, me.id, app.now(), app.schedulerBootAt.at);
  });

  // -------------------------------------------------------------------------
  // GET /challenges/:id/feed — the entries older than the detail's feed
  // -------------------------------------------------------------------------
  app.get('/challenges/:id/feed', { preHandler: app.authenticate }, async (request): Promise<FeedPage> => {
    const me = request.user;
    const { id } = request.params as IdParams;
    const challenge = requireChallengeRow(db, id);
    requireMembership(db, challenge, me.id);
    const query = parseQuery(ChallengeFeedQuerySchema, request.query ?? {});
    return challengeFeedPage(db, challenge.id, query);
  });

  // -------------------------------------------------------------------------
  // POST /challenges/:id/accept
  // -------------------------------------------------------------------------
  app.post('/challenges/:id/accept', { preHandler: app.authenticate }, async (request): Promise<ChallengeDetail> => {
    const me = request.user;
    const now = app.now();
    const { id } = request.params as IdParams;
    const challenge = requireChallengeRow(db, id);
    const membership = requireMembership(db, challenge, me.id);

    if (membership.status === 'accepted') throw conflict('already_accepted', 'Bu çelıncı zaten kabul ettin.');
    // An invite, or a no taken back, opens the door. Somebody who played and
    // walked out was announced as gone and moved the itiraz majority; walking
    // back in would undo both. (An invite's "Ayrıl" never joined: a no, stored
    // as `declined` now and as `left` by older servers.)
    if (membership.status === 'left' && membership.joined_at !== null) {
      throw conflict('already_left', 'Bu çelınctan ayrıldın, geri dönemezsin.');
    }
    if (challenge.status !== 'pending' && challenge.status !== 'active') {
      throw badRequest('challenge_closed', 'Bu çelınc kapandı, artık katılamazsın.');
    }
    // the invite predates the block; the block wins, the creator's and that of
    // whoever called them in with "Kanka ekle"
    assertNotBlocked(db, me.id, challenge.creator_id);
    if (membership.invited_by) assertNotBlocked(db, me.id, membership.invited_by);
    // And anybody already playing: a block placed after the invite (a player
    // who was never asked about the newcomer has only that to say), or a no
    // taken back after somebody they blocked came in. Two blocked people are
    // never both in, whoever says yes second; the refusal names nobody.
    if (lineUpOf(db, challenge.id, me.id, ['accepted']).some((otherId) => isBlockedBetween(db, me.id, otherId))) {
      throw badRequest('blocked_in_challenge', 'Bu çelınca katılamazsın.');
    }
    if (now.getTime() >= acceptClosesAt(challenge.starts_at, challenge.ends_at)) {
      throw badRequest('accept_closed', 'Çelıncın bitmesine az kaldı, artık katılamazsın.');
    }
    // Measured in the zone this yes pins (the profile's). A rematch's invite
    // comes through here too: its creator may play from another zone now.
    const short = checkinDaysShort(
      challenge,
      typeForChallenge(challenge),
      creatorTimezone(db, challenge),
      participantTimezone(undefined, me.row),
    );
    if (short) {
      throw badRequest(
        'checkin_days_short',
        `Saat farkı yüzünden bu çelıncın check-in saati sende ${checkinDaysTr(short.days)}, ${forCreator(db, challenge)} ${short.creatorDays} gün. Eksik günle bu çelınca katılamazsın.`,
      );
    }

    const iso = nowIso(now);
    const run = db.transaction(() => {
      db.prepare(
        "UPDATE challenge_participants SET status = 'accepted', joined_at = ?, timezone = ? WHERE challenge_id = ? AND user_id = ?",
      ).run(iso, me.row.timezone, challenge.id, me.id);
      markInviteAnswered(db, me.id, challenge.id, iso);
      // the days this phone already reported count from the first look, not
      // from the next sync (and are not typed again from memory meanwhile)
      backfillFromPhone(db, me.row, challenge, now);
      announceAccept(db, challenge, me.row, now);
    });
    run();

    return freshDetail(db, challenge.id, me.id, app.now(), app.schedulerBootAt.at);
  });

  // -------------------------------------------------------------------------
  // POST /challenges/:id/decline
  // -------------------------------------------------------------------------
  app.post('/challenges/:id/decline', { preHandler: app.authenticate }, async (request): Promise<ChallengeDetail> => {
    const me = request.user;
    const now = app.now();
    const { id } = request.params as IdParams;
    const challenge = requireChallengeRow(db, id);
    const membership = requireMembership(db, challenge, me.id);

    if (membership.status === 'accepted') {
      throw conflict('already_accepted', 'Kabul ettikten sonra reddedemezsin, çelınctan ayrıl.');
    }
    if (membership.status !== 'invited') throw conflict('already_declined', 'Bu daveti zaten cevapladın.');

    const run = db.transaction(() => {
      db.prepare("UPDATE challenge_participants SET status = 'declined' WHERE challenge_id = ? AND user_id = ?").run(
        challenge.id,
        me.id,
      );
      markInviteAnswered(db, me.id, challenge.id, nowIso(now));
      // a no to a çelınc that is already over is news to nobody
      if (!stillOpen(challenge, now)) return;
      tellWhoIsIn(db, challenge, me.row, 'challenge_declined', nowIso(now));
      cancelIfAbandoned(db, challenge.id, now);
    });
    run();
    return freshDetail(db, challenge.id, me.id, app.now(), app.schedulerBootAt.at);
  });

  // -------------------------------------------------------------------------
  // POST /challenges/:id/leave
  // -------------------------------------------------------------------------
  app.post('/challenges/:id/leave', { preHandler: app.authenticate }, async (request): Promise<ChallengeDetail> => {
    const me = request.user;
    const now = app.now();
    const { id } = request.params as IdParams;
    const challenge = requireChallengeRow(db, id);
    const membership = requireMembership(db, challenge, me.id);

    if (challenge.status !== 'pending' && challenge.status !== 'active') {
      throw badRequest('challenge_closed', 'Biten çelınctan ayrılamazsın.');
    }
    if (membership.status !== 'accepted' && membership.status !== 'invited') {
      throw conflict('already_left', 'Bu çelıncta zaten değilsin.');
    }
    // Past its end an `active` çelınc is only waiting (the phones' hour, an
    // itiraz's photo). A player leaving then is not quitting a race but voiding a
    // result they have seen: head to head the çelınc is cancelled and the winner
    // loses the win.
    if (
      challenge.status === 'active' &&
      membership.status === 'accepted' &&
      now.getTime() >= Date.parse(challenge.ends_at)
    ) {
      throw badRequest('challenge_ended', 'Süre bitti, sonuç birazdan. Artık ayrılamazsın.');
    }

    // "Ayrıl" on an invite never joined the race: it is a no, stored as one. As
    // `left` it read like a walk-out, so the app offered no "Katıl" and "Kanka
    // ekle" never asked them again, though both routes would take them back.
    // Older apps still show an invitee "Ayrıl".
    const invitee = membership.status === 'invited';
    const run = db.transaction(() => {
      db.prepare('UPDATE challenge_participants SET status = ? WHERE challenge_id = ? AND user_id = ?').run(
        invitee ? 'declined' : 'left',
        challenge.id,
        me.id,
      );
      if (invitee) markInviteAnswered(db, me.id, challenge.id, nowIso(now));
      if (!stillOpen(challenge, now)) return;
      tellWhoIsIn(db, challenge, me.row, invitee ? 'challenge_declined' : 'challenge_left', nowIso(now));
      if (cancelIfAbandoned(db, challenge.id, now)) return;
      // one player fewer is a smaller itiraz majority: an entry it now reaches
      // gets its full 12 hours from here, and its owner hears it
      announceDisputeClocks(db, challenge.id, now);
    });
    run();
    return freshDetail(db, challenge.id, me.id, app.now(), app.schedulerBootAt.at);
  });

  // -------------------------------------------------------------------------
  // POST /challenges/:id/invite
  // -------------------------------------------------------------------------
  /**
   * A player brings friends into a çelınc that already exists: phones get
   * KOYDUM over days, and the friend who installs on day two should not need a
   * second çelınc that splits the group. Any player may, not only the creator:
   * the newcomer is usually somebody else's kanka (the one who handed out the
   * link), and only their own friends can call them. They come in `invited`,
   * exactly like the ones picked in the wizard, accept through the same door,
   * and the row remembers who called (`invited_by`): a no goes back to them.
   */
  app.post('/challenges/:id/invite', { preHandler: app.authenticate }, async (request): Promise<ChallengeDetail> => {
    const me = request.user;
    const now = app.now();
    const { id } = request.params as IdParams;
    const challenge = requireChallengeRow(db, id);
    const membership = requireMembership(db, challenge, me.id);

    if (membership.status !== 'accepted') {
      throw forbidden(
        'not_participant',
        membership.status === 'left' && membership.joined_at !== null
          ? 'Bu çelınctan ayrıldın, kimseyi çağıramazsın.'
          : 'Önce çelınca katıl, sonra kanka çağırırsın.',
      );
    }
    const body = parseBody(InviteToChallengeBodySchema, request.body);
    // past the end only the result is left (the settle hour, an itiraz's photo)
    if (!stillOpen(challenge, now)) throw badRequest('challenge_closed', 'Bu çelınc bitti, kimse eklenemez.');
    // an invite nobody may accept any more would only be a push for nothing
    if (now.getTime() >= acceptClosesAt(challenge.starts_at, challenge.ends_at)) {
      throw badRequest('accept_closed', 'Çelıncın bitmesine az kaldı, artık kimse katılamaz.');
    }
    if (body.userIds.includes(me.id)) {
      throw badRequest('self_participant', 'Kendini davet edemezsin, zaten içindesin.');
    }

    const invitees = body.userIds.map((userId) => {
      const user = requireFriend(db, me.id, userId);
      const row = getParticipant(db, challenge.id, user.id);
      if (row?.status === 'accepted' || row?.status === 'invited') {
        throw conflict('already_in', `${user.display_name} zaten bu çelıncta.`);
      }
      // The accept route's rule: somebody who played and walked out was announced
      // as gone and moved the itiraz majority. A "Reddet", or an invitee's "Ayrıl",
      // is only a no, and a no may be asked again.
      if (row?.status === 'left' && row.joined_at !== null) {
        throw conflict('already_left', `${user.display_name} bu çelınctan ayrıldı, geri dönemez.`);
      }
      return { user, row };
    });
    // Blocked people do not see each other (SPEC 2.2), and the feed would show
    // a player who blocked the newcomer every number and photo of theirs. In
    // the wizard everybody saw the line-up before saying yes; a late invite
    // nobody else agreed to must not get round a block. The refusal does not
    // say who blocked whom.
    // The creator counts even after leaving: the accept route refuses anybody
    // with a block between them and the creator.
    const lineUp = [...lineUpOf(db, challenge.id, me.id, ['accepted', 'invited']), challenge.creator_id];
    for (const { user } of invitees) {
      const others = [...lineUp, ...invitees.map((i) => i.user.id)].filter((id) => id !== user.id && id !== me.id);
      if (others.some((otherId) => isBlockedBetween(db, user.id, otherId))) {
        throw badRequest('blocked_in_challenge', `${user.display_name} bu çelınca eklenemez.`);
      }
    }
    // the accept route's check-in days, so nobody gets an invite only to be refused
    const type = typeForChallenge(challenge);
    const creatorTz = creatorTimezone(db, challenge);
    for (const { user } of invitees) {
      const short = checkinDaysShort(challenge, type, creatorTz, participantTimezone(undefined, user));
      if (short) {
        throw invitedShortError(user.display_name, short, challenge.creator_id === me.id ? 'sende' : forCreator(db, challenge));
      }
    }

    // The wizard's cap counts everybody but the creator who is in or may still
    // say yes; a no does not hold a seat.
    const seated = db
      .prepare(
        `SELECT COUNT(*) AS n FROM challenge_participants
          WHERE challenge_id = ? AND user_id <> ? AND status IN ('accepted', 'invited')`,
      )
      .get(challenge.id, challenge.creator_id) as { n: number };
    if (seated.n + invitees.length > LIMITS.PARTICIPANTS_MAX) {
      throw badRequest(
        'too_many_participants',
        `Çelınc dolu: senden başka en fazla ${LIMITS.PARTICIPANTS_MAX} kişi olabilir.`,
      );
    }

    const iso = nowIso(now);
    const run = db.transaction(() => {
      for (const { user, row } of invitees) {
        if (row) {
          // a fresh invite: it goes to the end of the line-up like a new one, and it is the new caller's
          db.prepare(
            `UPDATE challenge_participants SET status = 'invited', invited_at = ?, invited_by = ?
              WHERE challenge_id = ? AND user_id = ?`,
          ).run(iso, me.id, challenge.id, user.id);
        } else {
          // `timezone` stays empty until they accept, like any invitee (see POST /challenges)
          db.prepare(
            `INSERT INTO challenge_participants (challenge_id, user_id, status, invited_at, joined_at, final_score, final_rank, timezone, invited_by)
             VALUES (?, ?, 'invited', ?, NULL, NULL, NULL, NULL, ?)`,
          ).run(challenge.id, user.id, iso, me.id);
        }
        const copy = inviteCopy(levelOf(user), me.row.display_name, challenge.title);
        notify(db, {
          userId: user.id,
          type: 'challenge_invite',
          title: copy.title,
          body: copy.body,
          data: { challengeId: challenge.id, fromUserId: me.id },
          createdAt: iso,
        });
      }
    });
    run();

    return freshDetail(db, challenge.id, me.id, app.now(), app.schedulerBootAt.at);
  });

  // -------------------------------------------------------------------------
  // POST /challenges/:id/cancel
  // -------------------------------------------------------------------------
  app.post('/challenges/:id/cancel', { preHandler: app.authenticate }, async (request): Promise<ChallengeDetail> => {
    const me = request.user;
    const now = app.now();
    const { id } = request.params as IdParams;
    // A çelınc past its start with two yeses has started by rule, even before the
    // scheduler's next pass (or while the owner's PC slept through it): activate
    // it first, as the entry route does, so "pending" here is never stale.
    activateDueChallenges(db, now);
    const challenge = requireChallengeRow(db, id);
    requireMembership(db, challenge, me.id);

    if (challenge.creator_id !== me.id) throw forbidden('not_creator', 'Sadece çelıncı açan iptal edebilir.');
    if (challenge.status !== 'pending') {
      throw badRequest('challenge_started', 'Başlamış çelınc iptal edilemez.');
    }

    const iso = nowIso(now);
    const others = db
      .prepare(
        `SELECT user_id FROM challenge_participants
          WHERE challenge_id = ? AND user_id <> ? AND status IN ('accepted', 'invited')`,
      )
      .all(challenge.id, me.id) as { user_id: string }[];

    const run = db.transaction(() => {
      db.prepare("UPDATE challenges SET status = 'cancelled', finalized_at = ? WHERE id = ? AND status = 'pending'").run(
        iso,
        challenge.id,
      );
      for (const row of others) {
        const user = requireUserRow(db, row.user_id);
        // still told, since the invite or the race is gone, but not by name
        const creator = isBlockedBetween(db, user.id, me.id) ? null : me.row.display_name;
        const copy = cancelledByCreatorCopy(levelOf(user), creator, challenge.title);
        notify(db, {
          userId: user.id,
          type: 'challenge_cancelled',
          title: copy.title,
          body: copy.body,
          data: { challengeId: challenge.id },
          createdAt: iso,
        });
      }
    });
    run();

    return freshDetail(db, challenge.id, me.id, app.now(), app.schedulerBootAt.at);
  });
}
