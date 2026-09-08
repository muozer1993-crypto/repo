/**
 * TODO: owned by the route agent for these endpoints — POST /challenges/:id/poke, POST /challenges/:id/taunt, POST /challenges/:id/rematch, GET /challenges/:id/results, GET /leaderboard.
 * The foundation only creates the seam; this file must keep its default export.
 *
 * Contract: default export is an async Fastify plugin registered by src/app.ts.
 * Available on `app`: `app.db`, `app.config`, `app.now()` (the single clock source,
 * injectable in tests) and `app.authenticate` (preHandler → `request.user = { id, row }`).
 * Validate with `parseBody`/`parseQuery` (../errors.js), fail with
 * `badRequest`/`unauthorized`/`forbidden`/`notFound`/`conflict`/`tooMany`,
 * and build every response with the mappers in ../serialize.js.
 */
import type { FastifyInstance } from 'fastify';

export default async function socialRoutes(_app: FastifyInstance): Promise<void> {
  // no routes yet
}
