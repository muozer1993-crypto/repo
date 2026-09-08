/**
 * Challenge routes: the list, creation and the invite lifecycle.
 *
 *   GET  /challenges?status=active,pending,finished
 *   POST /challenges
 *   GET  /challenges/:id
 *   POST /challenges/:id/accept | /decline | /leave | /cancel
 *
 * Every mutation answers with the full `ChallengeDetail` of the challenge it touched,
 * so the app can repaint the screen straight from the response.
 */
import type { FastifyInstance } from 'fastify';
import {
  LIMITS,
  createChallengeBodySchema,
  getChallengeType,
  ChallengeListQuerySchema,
  type ChallengeDetail,
  type ChallengeSummary,
} from '@koydum/shared';
import { badRequest, conflict, forbidden, parseBody, parseQuery } from '../errors.js';
import { newId, nowIso, type ChallengeRow, type Database } from '../db/index.js';
import { notify } from '../services/notifications.js';
import {
  buildDetail,
  buildSummary,
  cancelledByCreatorCopy,
  freshDetail,
  inviteCopy,
  levelOf,
  requireChallengeRow,
  requireMembership,
  requireUserRow,
} from '../services/challengeViews.js';

interface IdParams {
  id: string;
}

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

export default async function challengeRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;

  // -------------------------------------------------------------------------
  // GET /challenges
  // -------------------------------------------------------------------------
  app.get('/challenges', { preHandler: app.authenticate }, async (request): Promise<ChallengeSummary[]> => {
    const me = request.user;
    const query = parseQuery(ChallengeListQuerySchema, request.query ?? {});

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

    return rows.map((row) => buildSummary(db, row, me.id));
  });

  // -------------------------------------------------------------------------
  // POST /challenges
  // -------------------------------------------------------------------------
  app.post('/challenges', { preHandler: app.authenticate }, async (request, reply): Promise<ChallengeDetail> => {
    const me = request.user;
    const now = app.now();
    // The clock is injected so `startsAt >= now - 5min` follows the test clock too.
    const schema = createChallengeBodySchema({ now: () => now.getTime() });
    const body = parseBody(schema, request.body);

    const type = getChallengeType(body.typeKey);
    if (!type) throw badRequest('unknown_type', 'Böyle bir çelinç tipi yok.');

    if (body.participantIds.includes(me.id)) {
      throw badRequest('self_participant', 'Kendini davet edemezsin, zaten içindesin.');
    }

    for (const participantId of body.participantIds) {
      const user = requireUserRow(db, participantId);
      if (isBlocked(db, me.id, user.id) || !areFriends(db, me.id, user.id)) {
        throw badRequest('not_friends', `${user.display_name} kankan değil. Önce arkadaş olun.`);
      }
    }

    const startsAt = new Date(body.startsAt).toISOString();
    const endsAt = new Date(body.endsAt).toISOString();
    const createdAt = nowIso(now);
    // Live immediately when the start time has already passed (SPEC 2.2); a future
    // start waits for the scheduler.
    const status = Date.parse(startsAt) <= now.getTime() ? 'active' : 'pending';

    const challengeId = newId();
    const insertChallenge = db.prepare(
      `INSERT INTO challenges (id, creator_id, type_key, metric_type, direction, unit, title, starts_at, ends_at,
                               status, reward_text, penalty_text, deadline_time, daily_target, proof_required,
                               created_at, finalized_at, winner_id, is_tie, rematch_of_id)
       VALUES (@id, @creator_id, @type_key, @metric_type, @direction, @unit, @title, @starts_at, @ends_at,
               @status, @reward_text, @penalty_text, @deadline_time, @daily_target, @proof_required,
               @created_at, NULL, NULL, 0, NULL)`,
    );
    const insertParticipant = db.prepare(
      `INSERT INTO challenge_participants (challenge_id, user_id, status, invited_at, joined_at, final_score, final_rank)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
    );

    const run = db.transaction(() => {
      insertChallenge.run({
        id: challengeId,
        creator_id: me.id,
        type_key: type.key,
        // The metric shape is COPIED from the catalog so a later catalog edit can
        // never rewrite the rules of a challenge that is already being played.
        metric_type: type.metricType,
        direction: type.direction,
        unit: type.unitTr,
        title: body.title ?? type.nameTr,
        starts_at: startsAt,
        ends_at: endsAt,
        status,
        reward_text: body.rewardText ?? null,
        penalty_text: body.penaltyText ?? null,
        deadline_time: body.deadlineTime ?? (type.metricType === 'checkin_deadline' ? (type.defaultDeadlineTime ?? null) : null),
        daily_target: body.dailyTarget ?? null,
        proof_required: (body.proofRequired ?? type.proofRequired) ? 1 : 0,
        created_at: createdAt,
      });

      insertParticipant.run(challengeId, me.id, 'accepted', createdAt, createdAt);

      for (const participantId of body.participantIds) {
        insertParticipant.run(challengeId, participantId, 'invited', createdAt, null);
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
    });
    run();

    void reply.code(201);
    return freshDetail(db, challengeId, me.id);
  });

  // -------------------------------------------------------------------------
  // GET /challenges/:id
  // -------------------------------------------------------------------------
  app.get('/challenges/:id', { preHandler: app.authenticate }, async (request): Promise<ChallengeDetail> => {
    const me = request.user;
    const { id } = request.params as IdParams;
    const challenge = requireChallengeRow(db, id);
    requireMembership(db, challenge, me.id);
    return buildDetail(db, challenge, me.id);
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

    if (membership.status === 'accepted') throw conflict('already_accepted', 'Bu çelinci zaten kabul ettin.');
    if (challenge.status !== 'pending' && challenge.status !== 'active') {
      throw badRequest('challenge_closed', 'Bu çelinç kapandı, artık katılamazsın.');
    }
    // Joining in the last hour would be a free ride, so the door closes early.
    if (now.getTime() >= Date.parse(challenge.ends_at) - LIMITS.ACCEPT_CUTOFF_MS) {
      throw badRequest('accept_closed', 'Çelincin bitmesine az kaldı, artık katılamazsın.');
    }

    const iso = nowIso(now);
    db.prepare("UPDATE challenge_participants SET status = 'accepted', joined_at = ? WHERE challenge_id = ? AND user_id = ?").run(
      iso,
      challenge.id,
      me.id,
    );

    return freshDetail(db, challenge.id, me.id);
  });

  // -------------------------------------------------------------------------
  // POST /challenges/:id/decline
  // -------------------------------------------------------------------------
  app.post('/challenges/:id/decline', { preHandler: app.authenticate }, async (request): Promise<ChallengeDetail> => {
    const me = request.user;
    const { id } = request.params as IdParams;
    const challenge = requireChallengeRow(db, id);
    const membership = requireMembership(db, challenge, me.id);

    if (membership.status === 'accepted') {
      throw conflict('already_accepted', 'Kabul ettikten sonra reddedemezsin, çelinçten ayrıl.');
    }
    if (membership.status !== 'invited') throw conflict('already_declined', 'Bu daveti zaten cevapladın.');

    db.prepare("UPDATE challenge_participants SET status = 'declined' WHERE challenge_id = ? AND user_id = ?").run(
      challenge.id,
      me.id,
    );
    return freshDetail(db, challenge.id, me.id);
  });

  // -------------------------------------------------------------------------
  // POST /challenges/:id/leave
  // -------------------------------------------------------------------------
  app.post('/challenges/:id/leave', { preHandler: app.authenticate }, async (request): Promise<ChallengeDetail> => {
    const me = request.user;
    const { id } = request.params as IdParams;
    const challenge = requireChallengeRow(db, id);
    const membership = requireMembership(db, challenge, me.id);

    if (challenge.status !== 'pending' && challenge.status !== 'active') {
      throw badRequest('challenge_closed', 'Biten çelinçten ayrılamazsın.');
    }
    if (membership.status !== 'accepted' && membership.status !== 'invited') {
      throw conflict('already_left', 'Bu çelinçte zaten değilsin.');
    }

    db.prepare("UPDATE challenge_participants SET status = 'left' WHERE challenge_id = ? AND user_id = ?").run(
      challenge.id,
      me.id,
    );
    return freshDetail(db, challenge.id, me.id);
  });

  // -------------------------------------------------------------------------
  // POST /challenges/:id/cancel
  // -------------------------------------------------------------------------
  app.post('/challenges/:id/cancel', { preHandler: app.authenticate }, async (request): Promise<ChallengeDetail> => {
    const me = request.user;
    const now = app.now();
    const { id } = request.params as IdParams;
    const challenge = requireChallengeRow(db, id);
    requireMembership(db, challenge, me.id);

    if (challenge.creator_id !== me.id) throw forbidden('not_creator', 'Sadece çelinci açan iptal edebilir.');
    if (challenge.status !== 'pending') {
      throw badRequest('challenge_started', 'Başlamış çelinç iptal edilemez.');
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
        const copy = cancelledByCreatorCopy(levelOf(user), me.row.display_name, challenge.title);
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

    return freshDetail(db, challenge.id, me.id);
  });
}
