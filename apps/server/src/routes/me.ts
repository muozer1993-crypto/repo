/**
 * TODO: owned by the route agent for these endpoints — GET/PATCH/DELETE /me, POST+DELETE /me/push-token, POST /me/steps, GET /me/inbox, POST /me/inbox/read, GET /me/inbox/unread.
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

export default async function meRoutes(_app: FastifyInstance): Promise<void> {
  // no routes yet
}
