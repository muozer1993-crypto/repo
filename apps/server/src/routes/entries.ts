/**
 * Entry routes (SPEC 2.3).
 *
 *   POST   /challenges/:id/entries
 *   DELETE /challenges/:id/entries/:entryId
 *   POST   /challenges/:id/entries/:entryId/dispute
 *
 * The heavy lifting — per-metric rules, caps, backfill windows, the check-in verdict
 * and the dispute threshold — lives in `services/entries.ts`; these handlers only do
 * access control, notifications and the response shape.
 */
import type { FastifyInstance } from 'fastify';
import {
  DisputeBodySchema,
  EntryBodySchema,
  type Dispute,
  type Entry,
  type ParticipantView,
} from '@koydum/shared';
import { badRequest, forbidden, notFound, parseBody } from '../errors.js';
import { nowIso } from '../db/index.js';
import { computeStandings } from '../services/challenges.js';
import { notify } from '../services/notifications.js';
import { awardBadges } from '../services/stats.js';
import {
  disputeCopy,
  entryRejectedCopy,
  levelOf,
  requireAcceptedMembership,
  requireChallengeRow,
  requireUserRow,
} from '../services/challengeViews.js';
import { getEntryRow, recordDispute, validateAndUpsertEntry } from '../services/entries.js';
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
  /** True when this dispute reached the threshold and killed the entry. */
  upheld: boolean;
  standings: ParticipantView[];
}

export default async function entryRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;

  // -------------------------------------------------------------------------
  // POST /challenges/:id/entries
  // -------------------------------------------------------------------------
  app.post('/challenges/:id/entries', { preHandler: app.authenticate }, async (request, reply): Promise<EntryResponse> => {
    const me = request.user;
    const { id } = request.params as IdParams;
    const body = parseBody(EntryBodySchema, request.body);
    const challenge = requireChallengeRow(db, id);

    const { entry, created } = validateAndUpsertEntry(db, {
      challenge,
      user: me.row,
      body,
      now: app.now(),
    });

    // Badges that depend on entries (adım / odak / check-in serisi) refresh on write.
    awardBadges(db, me.id, app.now());

    void reply.code(created ? 201 : 200);
    return { entry: toEntry(entry), standings: computeStandings(db, challenge) };
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
      if (challenge.status !== 'active') throw badRequest('challenge_not_active', 'Bu çelinç şu an aktif değil.');
      // Automatic rows (pedometer, focus, check-in) are evidence, not drafts.
      if (entry.source !== 'manual') throw badRequest('not_deletable', 'Sadece elle girdiğin kayıtları silebilirsin.');

      db.prepare('DELETE FROM entries WHERE id = ?').run(entry.id);
      return { ok: true, standings: computeStandings(db, challenge) };
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

      const entry = getEntryRow(db, entryId);
      if (!entry || entry.challenge_id !== challenge.id) throw notFound('entry_not_found', 'Böyle bir giriş yok.');

      const outcome = recordDispute(db, { challenge, entry, byUserId: me.id, reason: body.reason, now });
      const owner = requireUserRow(db, entry.user_id);
      const iso = nowIso(now);

      if (outcome.upheld) {
        const copy = entryRejectedCopy(levelOf(owner), challenge.title, entry.day_key);
        notify(db, {
          userId: owner.id,
          type: 'entry_rejected',
          title: copy.title,
          body: copy.body,
          data: { challengeId: challenge.id, entryId: entry.id, dayKey: entry.day_key },
          createdAt: iso,
        });
        // `disputesWon` is derived from upheld disputes, so this recount is the bump
        // (and hands out the lie_detector badge).
        for (const disputerId of outcome.disputerIds) awardBadges(db, disputerId, now);
      } else {
        const copy = disputeCopy(levelOf(owner), me.row.display_name, challenge.title, entry.day_key);
        notify(db, {
          userId: owner.id,
          type: 'dispute',
          title: copy.title,
          body: copy.body,
          data: { challengeId: challenge.id, entryId: entry.id, disputeId: outcome.dispute.id },
          createdAt: iso,
        });
      }

      void reply.code(201);
      return {
        dispute: toDispute(outcome.dispute),
        entry: toEntry(outcome.entry),
        upheld: outcome.upheld,
        standings: computeStandings(db, challenge),
      };
    },
  );
}
