/**
 * The social half of a challenge: poking during the race, taunting after it,
 * asking for a rematch, the results screen and the friends leaderboard.
 *
 *   POST /challenges/:id/poke
 *   POST /challenges/:id/taunt
 *   POST /challenges/:id/rematch
 *   GET  /challenges/:id/results
 *   GET  /leaderboard
 */
import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_TIMEZONE,
  LIMITS,
  PokeBodySchema,
  TauntBodySchema,
  addDays,
  dayKeyInTz,
  isValidTimeZone,
  startOfDayInTz,
  type Challenge,
  type ChallengeDetail,
  type ChallengeResults,
  type LeaderboardEntry,
  type PublicUser,
  type Taunt,
  type VulgarityLevel,
} from '@koydum/shared';
import { badRequest, conflict, forbidden, notFound, parseBody } from '../errors.js';
import { newId, nowIso, type ChallengeRow, type Database, type ParticipantRow, type UserRow } from '../db/index.js';
import { toPublicUser, toTaunt } from '../serialize.js';
import { challengeWindow, computeStandings, dayOverByEnd, participantTimezone } from '../services/challenges.js';
import { notify } from '../services/notifications.js';
import { toChallenge } from '../serialize.js';
import { computeUserStats } from '../services/stats.js';
import {
  buildSummary,
  getParticipant,
  getUserRow,
  levelOf,
  rematchCopy,
  requireAcceptedMembership,
  requireChallengeRow,
  pokeTargetList,
  requireMembership,
  tauntsForUser,
} from '../services/challengeViews.js';
import { areFriends, assertNotBlocked, isBlockedBetween } from '../services/friends.js';
import {
  sendPoke,
  sendTaunt,
  tauntContextsForWinner,
  tauntPreviewsForWinner,
  type TauntMode,
} from '../services/taunts.js';

interface IdParams {
  id: string;
}

export interface PokeResponse {
  ok: true;
  poke: { id: string; challengeId: string; fromUserId: string; toUserId: string; createdAt: string };
  title: string;
  body: string;
  level: VulgarityLevel;
}

export interface TauntResponse {
  ok: true;
  taunt: Taunt;
}

/**
 * Accepted participant of this challenge, or a 404 that does not leak membership.
 *
 * A participant who has since deleted their account is still part of the history of
 * a finished challenge (`softDeleteUser` only pulls people out of pending/active
 * ones), so the anonymised row is returned rather than a 404 — otherwise the winner
 * could never taunt a line-up that includes a deleted friend.
 */
function requireTarget(db: Database, challenge: ChallengeRow, userId: string): UserRow {
  const row = db
    .prepare("SELECT * FROM challenge_participants WHERE challenge_id = ? AND user_id = ? AND status = 'accepted'")
    .get(challenge.id, userId) as { user_id: string } | undefined;
  if (!row) throw notFound('participant_not_found', 'Bu kişi çelıncta değil.');
  const user = getUserRow(db, userId);
  if (!user) throw notFound('participant_not_found', 'Bu kişi çelıncta değil.');
  return user;
}

/**
 * What gives the caller (`me`, their row in this finished çelınc) the right to
 * talk to `toUserId` after the whistle, or the 403 that says why not.
 *
 * "KOYDUM MU?" is the winner's. Two smaller rights sit next to it, so the
 * comeback does not move to WhatsApp: a loser may answer the winner, only once
 * the winner's laf has landed and only once (`sendTaunt` keeps it to one row);
 * and in a tie the players sharing first place may have a go at each other.
 * Whoever finished behind a tie has nothing to talk about, and a loser has
 * nobody to answer but the winner. Neither right touches the winner's reminder
 * (`sendTauntFollowups`), which only counts taunts sent BY the winner.
 */
function tauntModeFor(db: Database, challenge: ChallengeRow, me: ParticipantRow, toUserId: string): TauntMode {
  if (challenge.winner_id !== null && challenge.winner_id === me.user_id) return 'win';
  const notWinner = () => forbidden('not_winner', 'Laf sokma hakkı kazananın.');
  if (me.status !== 'accepted') throw notWinner();
  if (challenge.is_tie) {
    if (me.final_rank !== 1) throw notWinner();
    return 'tie';
  }
  if (!challenge.winner_id || toUserId !== challenge.winner_id) throw notWinner();
  const spoke = db
    .prepare('SELECT 1 FROM taunts WHERE challenge_id = ? AND from_user_id = ? AND to_user_id = ?')
    .get(challenge.id, challenge.winner_id, me.user_id);
  if (!spoke) throw forbidden('not_winner', 'Önce o konuşsun, sonra cevap verirsin.');
  return 'reply';
}

/**
 * Who a rematch of `challenge` opened by `meId` invites, and who of the old
 * line-up it leaves out for not being friends.
 *
 * The old line-up is not a licence to invite: a rematch goes through the same
 * gate as POST /challenges, so somebody who blocked me (or is no longer a friend)
 * cannot be dragged into a brand-new challenge — and pushed at — from here.
 * `notFriends` feeds the results screen's "rövanşa çağrılmaz" note; a deleted
 * account or a block (either way) is left out of it, since neither can be fixed
 * by adding the person, and a block placed on me must not show.
 */
function rematchLineUp(
  db: Database,
  challenge: ChallengeRow,
  meId: string,
): { invitees: UserRow[]; notFriends: string[] } {
  const previous = db
    .prepare("SELECT user_id FROM challenge_participants WHERE challenge_id = ? AND status = 'accepted' ORDER BY user_id ASC")
    .all(challenge.id) as { user_id: string }[];

  const invitees: UserRow[] = [];
  const notFriends: string[] = [];
  for (const row of previous) {
    if (row.user_id === meId) continue;
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(row.user_id) as
      | UserRow
      | undefined;
    if (!user || isBlockedBetween(db, meId, user.id)) continue;
    if (!areFriends(db, meId, user.id)) {
      notFriends.push(user.id);
      continue;
    }
    invitees.push(user);
  }
  return { invitees, notFriends };
}

/**
 * When a rematch starting at `startsAt` ends: as many local days as the
 * original had, ending on the last millisecond of a day in the creator's zone,
 * the way the wizard snaps an end. `startsAt + duration` used to end it at
 * whatever time of day the button was tapped, and a phone reading of that half
 * day after the whistle would carry steps walked after the end.
 *
 * The original's days are counted in the zone its own creator's wizard snapped
 * it in (their pinned zone); a day its end cut in half (an old 24-hour-step
 * çelınc) is not counted, so "7 gün" stays 7. A rematch opened minutes before
 * midnight would be too short to be legal, so it runs to the end of the next
 * day instead.
 */
function rematchEndsAt(challenge: ChallengeRow, originalTz: string, zone: string, startsAt: Date): string {
  const tz = isValidTimeZone(zone) ? zone : DEFAULT_TIMEZONE;
  const days = challengeWindow(challenge, originalTz);
  const last = days.at(-1);
  const complete = last !== undefined && dayOverByEnd(challenge, originalTz, last);
  const dayCount = Math.max(1, days.length - (complete ? 0 : 1));
  const lastKey = addDays(dayKeyInTz(startsAt, tz), dayCount - 1);
  const endOf = (key: string) => startOfDayInTz(addDays(key, 1), tz).getTime() - 1;
  let end = endOf(lastKey);
  if (end - startsAt.getTime() <= LIMITS.MIN_DURATION_MS) end = endOf(addDays(lastKey, 1));
  return new Date(end).toISOString();
}

export default async function socialRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;

  // -------------------------------------------------------------------------
  // POST /challenges/:id/poke
  // -------------------------------------------------------------------------
  app.post('/challenges/:id/poke', { preHandler: app.authenticate }, async (request, reply): Promise<PokeResponse> => {
    const me = request.user;
    const { id } = request.params as IdParams;
    const body = parseBody(PokeBodySchema, request.body);

    const challenge = requireChallengeRow(db, id);
    requireAcceptedMembership(db, challenge, me.id);
    if (challenge.status !== 'active') throw badRequest('challenge_not_active', 'Sadece devam eden çelıncta dürtebilirsin.');
    // past the end an `active` çelınc only waits for its result
    if (app.now().getTime() >= Date.parse(challenge.ends_at)) {
      throw badRequest('challenge_ended', 'Süre bitti, artık dürtemezsin. Sonuç birazdan.');
    }
    if (body.toUserId === me.id) throw badRequest('self_poke', 'Kendini dürtemezsin.');

    const target = requireTarget(db, challenge, body.toUserId);
    assertNotBlocked(db, me.id, target.id);
    // Talking mid-çelınc is earned: you may only say it to somebody you are
    // actually ahead of. The client hides the button, but the rule lives here.
    const allowed = pokeTargetList(db, challenge, me.id, app.now());
    if (!allowed.some((entry) => entry.toUserId === target.id)) {
      throw forbidden('not_ahead', 'Önde olan konuşur. Önce geç, sonra sok.');
    }
    const result = sendPoke(db, {
      challenge,
      from: me.row,
      to: target,
      templateId: body.templateId,
      now: app.now(),
    });

    void reply.code(201);
    return {
      ok: true,
      poke: {
        id: result.poke.id,
        challengeId: result.poke.challenge_id,
        fromUserId: result.poke.from_user_id,
        toUserId: result.poke.to_user_id,
        createdAt: result.poke.created_at,
      },
      title: result.title,
      body: result.body,
      level: result.level,
    };
  });

  // -------------------------------------------------------------------------
  // POST /challenges/:id/taunt
  // -------------------------------------------------------------------------
  app.post('/challenges/:id/taunt', { preHandler: app.authenticate }, async (request, reply): Promise<TauntResponse> => {
    const me = request.user;
    const { id } = request.params as IdParams;
    const body = parseBody(TauntBodySchema, request.body);

    const challenge = requireChallengeRow(db, id);
    const membership = requireMembership(db, challenge, me.id);

    // a result still waiting (the phones' hour, an itiraz) keeps everybody quiet
    if (challenge.status !== 'finished') {
      throw badRequest('challenge_not_finished', 'Çelınc bitmeden laf sokamazsın.');
    }
    const mode = tauntModeFor(db, challenge, membership, body.toUserId);
    if (body.toUserId === me.id) throw badRequest('self_taunt', 'Kendine koyamazsın.');

    const target = requireTarget(db, challenge, body.toUserId);
    // a tie is between the ones sharing first place, not at whoever finished behind
    if (mode === 'tie' && getParticipant(db, challenge.id, target.id)?.final_rank !== 1) {
      throw forbidden('not_winner', 'Berabere bitti, laf sadece berabere kalanlar arasında.');
    }
    assertNotBlocked(db, me.id, target.id);

    const { taunt } = sendTaunt(db, {
      challenge,
      from: me.row,
      to: target,
      templateId: body.templateId,
      customBody: body.customBody,
      mode,
      now: app.now(),
    });

    void reply.code(201);
    return { ok: true, taunt: toTaunt(taunt) };
  });

  // -------------------------------------------------------------------------
  // POST /challenges/:id/rematch
  // -------------------------------------------------------------------------
  app.post('/challenges/:id/rematch', { preHandler: app.authenticate }, async (request, reply): Promise<Challenge> => {
    const me = request.user;
    const now = app.now();
    const { id } = request.params as IdParams;

    const challenge = requireChallengeRow(db, id);
    requireAcceptedMembership(db, challenge, me.id);
    if (challenge.status !== 'finished') {
      throw badRequest('challenge_not_finished', 'Rövanş sadece biten çelınc için istenir.');
    }

    // A rematch that was turned down (and so cancelled) does not count: the
    // results screen's "Rövanş" must not dead-end on one nobody can join.
    const duplicate = db
      .prepare("SELECT id FROM challenges WHERE rematch_of_id = ? AND creator_id = ? AND status <> 'cancelled'")
      .get(challenge.id, me.id) as { id: string } | undefined;
    if (duplicate) throw conflict('already_rematched', 'Bu çelınc için zaten rövanş açtın.');

    // Same settings, same number of days; only the calendar moves.
    const startsAtDate = new Date(now.getTime() + LIMITS.REMATCH_START_DELAY_MS);
    const startsAt = startsAtDate.toISOString();
    const originalTz = participantTimezone(
      getParticipant(db, challenge.id, challenge.creator_id),
      getUserRow(db, challenge.creator_id) ?? me.row,
    );
    const endsAt = rematchEndsAt(challenge, originalTz, me.row.timezone, startsAtDate);
    const createdAt = nowIso(now);
    const rematchId = newId();

    const { invitees } = rematchLineUp(db, challenge, me.id);
    if (invitees.length === 0) {
      throw badRequest('no_participants', 'Rövanş için davet edilecek kimse kalmadı.');
    }

    const run = db.transaction(() => {
      db.prepare(
        `INSERT INTO challenges (id, creator_id, type_key, metric_type, direction, unit, title, starts_at, ends_at,
                                 status, reward_text, penalty_text, deadline_time, daily_target, proof_required,
                                 created_at, finalized_at, winner_id, is_tie, rematch_of_id)
         VALUES (@id, @creator_id, @type_key, @metric_type, @direction, @unit, @title, @starts_at, @ends_at,
                 'pending', @reward_text, @penalty_text, @deadline_time, @daily_target, @proof_required,
                 @created_at, NULL, NULL, 0, @rematch_of_id)`,
      ).run({
        id: rematchId,
        creator_id: me.id,
        type_key: challenge.type_key,
        metric_type: challenge.metric_type,
        direction: challenge.direction,
        unit: challenge.unit,
        title: challenge.title,
        starts_at: startsAt,
        ends_at: endsAt,
        reward_text: challenge.reward_text,
        penalty_text: challenge.penalty_text,
        deadline_time: challenge.deadline_time,
        daily_target: challenge.daily_target,
        proof_required: challenge.proof_required,
        created_at: createdAt,
        rematch_of_id: challenge.id,
      });

      const insertParticipant = db.prepare(
        `INSERT INTO challenge_participants (challenge_id, user_id, status, invited_at, joined_at, final_score, final_rank, timezone)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
      );
      insertParticipant.run(rematchId, me.id, 'accepted', createdAt, createdAt, me.row.timezone);

      for (const user of invitees) {
        insertParticipant.run(rematchId, user.id, 'invited', createdAt, null, null);
        const copy = rematchCopy(levelOf(user), me.row.display_name, challenge.title);
        notify(db, {
          userId: user.id,
          type: 'rematch',
          title: copy.title,
          body: copy.body,
          data: { challengeId: rematchId, rematchOfId: challenge.id, fromUserId: me.id },
          createdAt,
        });
      }
    });
    run();

    void reply.code(201);
    // SPEC 2.2: the rematch answers with the new Challenge so the caller can
    // navigate straight to it.
    return toChallenge(requireChallengeRow(db, rematchId));
  });

  // -------------------------------------------------------------------------
  // GET /challenges/:id/results
  // -------------------------------------------------------------------------
  app.get('/challenges/:id/results', { preHandler: app.authenticate }, async (request): Promise<ChallengeResults> => {
    const me = request.user;
    const { id } = request.params as IdParams;
    const challenge = requireChallengeRow(db, id);
    requireMembership(db, challenge, me.id);

    const summary = buildSummary(db, challenge, me.id, app.now());
    const results: ChallengeResults = {
      challenge: summary.challenge,
      standings: summary.participants,
      taunts: tauntsForUser(db, challenge.id, me.id),
    };

    if (challenge.status === 'finished' && challenge.winner_id === me.id) {
      // Previews are rendered against the runner-up; the picker re-renders per loser.
      // A loser who deleted their account stays in the history of a finished
      // challenge, so the anonymised row is used ("Silinen kanka") instead of 404ing
      // the whole results screen.
      const runnerUp = summary.participants.find((p) => p.status === 'accepted' && p.user.id !== me.id);
      const loser = runnerUp ? getUserRow(db, runnerUp.user.id) : undefined;
      results.tauntTemplatesForWinner = tauntPreviewsForWinner(db, challenge, me.row, loser, app.now());
      // each loser's own context: the picker would otherwise only know the margin
      results.tauntContexts = tauntContextsForWinner(db, challenge, me.id, summary.participants);
    }
    if (challenge.status === 'finished' && summary.me?.status === 'accepted') {
      results.rematchLeftOut = rematchLineUp(db, challenge, me.id).notFriends;
    }

    return results;
  });

  // -------------------------------------------------------------------------
  // GET /leaderboard
  // -------------------------------------------------------------------------
  app.get('/leaderboard', { preHandler: app.authenticate }, async (request): Promise<LeaderboardEntry[]> => {
    const me = request.user;
    const now = app.now();

    const friends = db
      .prepare(
        `SELECT u.* FROM users u
           JOIN friendships f ON f.status = 'accepted'
            AND ((f.requester_id = ? AND f.addressee_id = u.id) OR (f.addressee_id = ? AND f.requester_id = u.id))
          WHERE u.deleted_at IS NULL`,
      )
      .all(me.id, me.id) as UserRow[];

    const people: UserRow[] = [me.row, ...friends.filter((u) => u.id !== me.id)];
    const scored = people.map((user) => {
      const stats = computeUserStats(db, user.id, now);
      const publicUser: PublicUser = toPublicUser(user);
      return { user: publicUser, wins: stats.wins, losses: stats.losses };
    });

    // What counts is whether you put it on someone, not how much you talked
    // about it: wins first, then whoever has eaten fewer of them.
    scored.sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (a.losses !== b.losses) return a.losses - b.losses;
      return a.user.displayName.localeCompare(b.user.displayName, 'tr');
    });

    // Competition ranking: equal (wins, losses) share a rank (1, 1, 3).
    const entries: LeaderboardEntry[] = [];
    let rank = 1;
    for (let i = 0; i < scored.length; i++) {
      const current = scored[i];
      const previous = i > 0 ? scored[i - 1] : undefined;
      if (previous && (previous.wins !== current.wins || previous.losses !== current.losses)) rank = i + 1;
      entries.push({ ...current, rank });
    }
    return entries;
  });
}
