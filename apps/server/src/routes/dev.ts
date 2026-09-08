/**
 * Test-only endpoints. `src/app.ts` mounts this module ONLY when
 * `config.enableDevRoutes` is true (`ENABLE_DEV_ROUTES=1`), so it never exists in a
 * normal deployment — which is why these routes are deliberately unauthenticated:
 * the Playwright smoke test drives them without holding anybody's token.
 *
 *   POST /dev/finalize/:id   force a challenge to finish right now
 *   POST /dev/advance        run one scheduler pass, optionally at a given `now`
 *   POST /dev/reset          wipe every table
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ParticipantView } from '@koydum/shared';
import { badRequest, notFound, parseBody } from '../errors.js';
import {
  computeStandings,
  finalizeChallenge,
  getChallengeRow,
  runSchedulerOnce,
  type SchedulerSummary,
} from '../services/challenges.js';

interface IdParams {
  id: string;
}

const AdvanceBodySchema = z
  .object({
    /** Pretend it is this instant for one scheduler pass. */
    now: z.string().min(1).optional(),
  })
  .optional();

/** Everything except the migration ledger; children go before parents. */
const TABLES = [
  'reminders_sent',
  'reports',
  'badges',
  'notifications',
  'pokes',
  'taunts',
  'disputes',
  'steps_daily',
  'entries',
  'challenge_participants',
  'challenges',
  'friendships',
  'users',
] as const;

export default async function devRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;

  app.post('/dev/finalize/:id', async (request): Promise<{ ok: true; standings: ParticipantView[] }> => {
    const { id } = request.params as IdParams;
    const challenge = getChallengeRow(db, id);
    if (!challenge) throw notFound('challenge_not_found', 'Böyle bir çelinç yok.');

    if (challenge.status === 'finished') {
      return { ok: true, standings: computeStandings(db, challenge) };
    }
    if (challenge.status === 'cancelled') {
      throw badRequest('challenge_cancelled', 'İptal edilmiş çelinç bitirilemez.');
    }

    const standings = finalizeChallenge(db, challenge, app.now());
    return { ok: true, standings };
  });

  app.post('/dev/advance', async (request): Promise<SchedulerSummary> => {
    const body = parseBody(AdvanceBodySchema, request.body ?? {});
    const at = body?.now ? new Date(body.now) : app.now();
    if (Number.isNaN(at.getTime())) throw badRequest('invalid_now', 'Geçersiz tarih/saat.');
    return runSchedulerOnce(db, at);
  });

  app.post('/dev/reset', async (): Promise<{ ok: true; tables: number }> => {
    const run = db.transaction(() => {
      db.pragma('foreign_keys = OFF');
      for (const table of TABLES) db.prepare(`DELETE FROM ${table}`).run();
      db.pragma('foreign_keys = ON');
    });
    run();
    return { ok: true, tables: TABLES.length };
  });
}
