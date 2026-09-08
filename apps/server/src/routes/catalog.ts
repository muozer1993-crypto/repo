/**
 * GET /catalog — one public dump of everything the app needs to render itself
 * (SPEC 2.2): challenge types, taunt templates, microcopy and badge definitions.
 *
 * It is public on purpose: the register screen previews taunts at each vulgarity
 * level before a token exists. `version` is the shared package version, so the app
 * can cache the payload and only refetch when it changes.
 */
import type { FastifyInstance } from 'fastify';
import { BADGES, CHALLENGE_TYPES, MICROCOPY, SHARED_VERSION, TAUNTS } from '@koydum/shared';

export default async function catalogRoutes(app: FastifyInstance): Promise<void> {
  const payload = {
    version: SHARED_VERSION,
    types: CHALLENGE_TYPES,
    taunts: TAUNTS,
    microcopy: MICROCOPY,
    badges: BADGES,
  };

  app.get('/catalog', async () => payload);
}
