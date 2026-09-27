/**
 * Entry routes (SPEC 2.3).
 *
 *   POST   /challenges/:id/entries
 *   DELETE /challenges/:id/entries/:entryId
 *   POST   /challenges/:id/entries/:entryId/dispute
 *   DELETE /challenges/:id/entries/:entryId/dispute   (the disputer takes it back)
 *   POST   /challenges/:id/entries/:entryId/proof     (the owner answers with a photo)
 *
 * The heavy lifting — per-metric rules, caps, backfill windows, the check-in verdict
 * and the dispute threshold with its answer window — lives in `services/entries.ts`;
 * these handlers only do access control, notifications and the response shape.
 */
import type { FastifyInstance } from 'fastify';
import {
  DisputeBodySchema,
  EntryBodySchema,
  EntryProofBodySchema,
  type Dispute,
  type Entry,
  type ParticipantView,
} from '@koydum/shared';
import { badRequest, forbidden, notFound, parseBody } from '../errors.js';
import { nowIso, type ChallengeRow, type EntryRow, type UserRow } from '../db/index.js';
import { computeStandings, disputesCloseAt } from '../services/challenges.js';
import { notify } from '../services/notifications.js';
import { awardBadges } from '../services/stats.js';
import {
  disputeCopy,
  disputeProofCopy,
  getUserRow,
  levelOf,
  requireAcceptedMembership,
  requireChallengeRow,
  requireMembership,
} from '../services/challengeViews.js';
import {
  answerDisputeWithProof,
  forgetDismissedDisputes,
  getEntryRow,
  recordDispute,
  validateAndUpsertEntry,
  withdrawDispute,
} from '../services/entries.js';
import { assertNotBlocked, isBlockedBetween } from '../services/friends.js';
import { toDispute, toEntry } from '../serialize.js';

interface IdParams {
  id: string;
}
interface EntryParams extends IdParams {
  entryId: string;
}

export interface EntryResponse {
  entry: Entry;
  standings: ParticipantView[];
}

export interface DisputeResponse {
  dispute: Dispute;
  entry: Entry;
  /**
   * Set once the open disputes are a majority: the entry is thrown out at this
   * instant unless its owner adds a photo first (`resolveDisputes`).
   */
  answerBy: string | null;
  standings: ParticipantView[];
}

export default async function entryRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;

  /** "Kanıt geldi, bir bak" to everybody whose itiraz a photo just answered. */
  function tellDisputers(disputerIds: string[], owner: UserRow, challenge: ChallengeRow, entry: EntryRow, now: Date): void {
    const iso = nowIso(now);
    for (const disputerId of disputerIds) {
      const disputer = getUserRow(db, disputerId);
      if (!disputer || disputer.deleted_at !== null) continue;
      // a block since the itiraz closes this door too
      if (isBlockedBetween(db, owner.id, disputerId)) continue;
      const copy = disputeProofCopy(levelOf(disputer), owner.display_name, challenge.title, entry.day_key);
      notify(db, {
        userId: disputer.id,
        type: 'dispute',
        title: copy.title,
        body: copy.body,
        data: { challengeId: challenge.id, entryId: entry.id, kind: 'proof' },
        createdAt: iso,
      });
    }
  }

  // -------------------------------------------------------------------------
  // POST /challenges/:id/entries
  // -------------------------------------------------------------------------
  app.post('/challenges/:id/entries', { preHandler: app.authenticate }, async (request, reply): Promise<EntryResponse> => {
    const me = request.user;
    const { id } = request.params as IdParams;
    const body = parseBody(EntryBodySchema, request.body);
    const challenge = requireChallengeRow(db, id);
    // A stranger must not be able to tell an existing challenge from a made-up id,
    // so membership answers 404 here; `validateAndUpsertEntry` keeps the 403
    // `not_participant` for the invited / declined / left cases.
    requireMembership(db, challenge, me.id);
    const now = app.now();
    // the day's row as it was, for an owner answering an itiraz by re-posting
    const before = db
      .prepare('SELECT * FROM entries WHERE challenge_id = ? AND user_id = ? AND day_key = ? ORDER BY created_at ASC, id ASC LIMIT 1')
      .get(challenge.id, me.id, body.dayKey) as EntryRow | undefined;

    const { created, entry: written } = validateAndUpsertEntry(db, {
      challenge,
      user: me.row,
      body,
      now,
    });
    let entry = written;

    // The 1.0 app has no "Kanıt ekle": its owner answers an itiraz by sending
    // the day again with a photo. That is a photo answer like /proof. When the
    // number changed with it, the disputers may say "yalan" to the new one.
    if (!created && body.proofUrl && before?.status === 'disputed' && before.id === entry.id) {
      const outcome = answerDisputeWithProof(db, { entry, byUserId: me.id, proofUrl: body.proofUrl, now });
      if (Number(before.value) !== Number(outcome.entry.value)) forgetDismissedDisputes(db, entry.id);
      tellDisputers(outcome.disputerIds, me.row, challenge, entry, now);
      entry = outcome.entry;
    }

    // Badges that depend on entries (adım / odak / check-in serisi) refresh on write.
    awardBadges(db, me.id, now);

    void reply.code(created ? 201 : 200);
    return { entry: toEntry(entry), standings: computeStandings(db, challenge, now) };
  });

  // -------------------------------------------------------------------------
  // DELETE /challenges/:id/entries/:entryId
  // -------------------------------------------------------------------------
  app.delete(
    '/challenges/:id/entries/:entryId',
    { preHandler: app.authenticate },
    async (request): Promise<{ ok: true; standings: ParticipantView[] }> => {
      const me = request.user;
      const { id, entryId } = request.params as EntryParams;
      const challenge = requireChallengeRow(db, id);
      requireAcceptedMembership(db, challenge, me.id);

      const entry = getEntryRow(db, entryId);
      if (!entry || entry.challenge_id !== challenge.id) throw notFound('entry_not_found', 'Böyle bir giriş yok.');
      if (entry.user_id !== me.id) throw forbidden('not_your_entry', 'Sadece kendi girişini silebilirsin.');
      if (challenge.status !== 'active') throw badRequest('challenge_not_active', 'Bu çelınc şu an aktif değil.');
      // Automatic rows (pedometer, focus, check-in) are evidence, not drafts.
      if (entry.source !== 'manual') throw badRequest('not_deletable', 'Sadece elle girdiğin kayıtları silebilirsin.');
      // A day friends have challenged is no longer the owner's to retract: deleting
      // it would drop the disputes with it (ON DELETE CASCADE) and let the same day
      // be re-posted as a clean `ok` entry — laundering exactly what `upsertDayEntry`
      // refuses to launder.
      if (entry.status !== 'ok') {
        throw badRequest('entry_disputed', 'İtiraz edilen bir girişi silemezsin.');
      }

      db.prepare('DELETE FROM entries WHERE id = ?').run(entry.id);
      return { ok: true, standings: computeStandings(db, challenge, app.now()) };
    },
  );

  // -------------------------------------------------------------------------
  // POST /challenges/:id/entries/:entryId/dispute
  // -------------------------------------------------------------------------
  app.post(
    '/challenges/:id/entries/:entryId/dispute',
    { preHandler: app.authenticate },
    async (request, reply): Promise<DisputeResponse> => {
      const me = request.user;
      const now = app.now();
      const { id, entryId } = request.params as EntryParams;
      const body = parseBody(DisputeBodySchema, request.body);

      const challenge = requireChallengeRow(db, id);
      requireAcceptedMembership(db, challenge, me.id);
      // A dispute after the whistle would reject a row the final score already
      // counted — the result would not move, only the owner's inbox would.
      if (challenge.status !== 'active') {
        throw badRequest('challenge_not_active', 'Bu çelınc bitti, artık itiraz edilemez.');
      }
      // still `active` past its end only while it waits (disputesCloseAt)
      if (now.getTime() >= disputesCloseAt(challenge)) {
        throw badRequest('challenge_ended', 'Süre bitti, artık itiraz edilemez.');
      }

      const entry = getEntryRow(db, entryId);
      if (!entry || entry.challenge_id !== challenge.id) throw notFound('entry_not_found', 'Böyle bir giriş yok.');
      // a blocked pair must not reach each other through an old participant list
      assertNotBlocked(db, me.id, entry.user_id);

      // The owner is looked up BEFORE the write: `recordDispute` commits its own
      // transaction, so a throw afterwards (an owner who deleted their account) would
      // report a failure for a dispute that actually landed. A soft-deleted owner is
      // simply not notified — the dispute itself still counts.
      const owner = getUserRow(db, entry.user_id);
      if (!owner) throw notFound('entry_not_found', 'Böyle bir giriş yok.');
      const notifyOwner = owner.deleted_at === null;

      const outcome = recordDispute(db, { challenge, entry, byUserId: me.id, reason: body.reason, now });

      if (notifyOwner) {
        const copy = disputeCopy(levelOf(owner), me.row.display_name, challenge.title, entry.day_key, outcome.reachedThreshold);
        notify(db, {
          userId: owner.id,
          type: 'dispute',
          title: copy.title,
          body: copy.body,
          data: { challengeId: challenge.id, entryId: entry.id, disputeId: outcome.dispute.id, answerBy: outcome.answerBy },
          createdAt: nowIso(now),
        });
      }

      void reply.code(201);
      return {
        dispute: toDispute(outcome.dispute),
        entry: toEntry(outcome.entry),
        answerBy: outcome.answerBy,
        standings: computeStandings(db, challenge, now),
      };
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /challenges/:id/entries/:entryId/dispute
  // -------------------------------------------------------------------------
  app.delete(
    '/challenges/:id/entries/:entryId/dispute',
    { preHandler: app.authenticate },
    async (request): Promise<{ dispute: Dispute; entry: Entry; standings: ParticipantView[] }> => {
      const me = request.user;
      const now = app.now();
      const { id, entryId } = request.params as EntryParams;

      const challenge = requireChallengeRow(db, id);
      // somebody who has since left may still take back what they said
      requireMembership(db, challenge, me.id);
      if (challenge.status !== 'active') {
        throw badRequest('challenge_not_active', 'Bu çelınc bitti, itiraz artık geri çekilemez.');
      }

      const entry = getEntryRow(db, entryId);
      if (!entry || entry.challenge_id !== challenge.id) throw notFound('entry_not_found', 'Böyle bir giriş yok.');

      const outcome = withdrawDispute(db, { entry, byUserId: me.id, now });
      return {
        dispute: toDispute(outcome.dispute),
        entry: toEntry(outcome.entry),
        standings: computeStandings(db, challenge, now),
      };
    },
  );

  // -------------------------------------------------------------------------
  // POST /challenges/:id/entries/:entryId/proof
  // -------------------------------------------------------------------------
  app.post(
    '/challenges/:id/entries/:entryId/proof',
    { preHandler: app.authenticate },
    async (request): Promise<EntryResponse> => {
      const me = request.user;
      const now = app.now();
      const { id, entryId } = request.params as EntryParams;
      const body = parseBody(EntryProofBodySchema, request.body);

      const challenge = requireChallengeRow(db, id);
      requireMembership(db, challenge, me.id);
      // `active` covers the wait past the end too: a çelınc with an entry on the
      // clock does not finish before its owner has had the promised hours
      if (challenge.status !== 'active') {
        throw badRequest('challenge_not_active', 'Bu çelınc bitti, artık kanıt eklenemez.');
      }

      const entry = getEntryRow(db, entryId);
      if (!entry || entry.challenge_id !== challenge.id) throw notFound('entry_not_found', 'Böyle bir giriş yok.');

      const outcome = answerDisputeWithProof(db, { entry, byUserId: me.id, proofUrl: body.proofUrl, now });
      tellDisputers(outcome.disputerIds, me.row, challenge, entry, now);

      return { entry: toEntry(outcome.entry), standings: computeStandings(db, challenge, now) };
    },
  );
}
