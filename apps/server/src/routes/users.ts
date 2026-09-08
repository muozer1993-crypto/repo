/**
 * Other people (SPEC 2.2): GET /users/search, GET /users/:id,
 * POST /users/:id/block | /unblock | /report.
 *
 * Blocking is modelled as a `friendships` row with status `blocked` and the blocker
 * as `requester_id` (SPEC 2.2). A blocked pair is invisible to each other: no search
 * hit, no profile, no friend request, no challenge invite.
 */
import type { FastifyInstance } from 'fastify';
import { ReportBodySchema, UserSearchQuerySchema, type PublicUser } from '@koydum/shared';
import { newId, nowIso, type Database, type UserRow } from '../db/index.js';
import { badRequest, notFound, parseBody, parseQuery } from '../errors.js';
import { requireUser } from '../plugins/auth.js';
import { toPublicProfile, toPublicUser } from '../serialize.js';
import { isBlockedBetween, removeBlock, upsertBlock } from '../services/friends.js';

/** Max hits returned to the app (SPEC 2.2). */
const SEARCH_LIMIT = 20;
/** How many rows the SQL pre-filter may hand to the Turkish-aware refinement. */
const SEARCH_SCAN_LIMIT = 2000;

/** Turkish casing: `I → ı`, `İ → i`. `toLowerCase()` gets both of those wrong. */
function trLower(value: string): string {
  return value.toLocaleLowerCase('tr');
}

/**
 * The prefix we can safely hand to SQLite.
 *
 * SQLite's `lower()` and its case-insensitive LIKE are ASCII-only, so anything with a
 * Turkish letter in it — and the dotted/dotless i pair in particular, where "ist" must
 * match "İstanbul" — cannot be resolved in SQL. We therefore cut the prefix at the
 * first character SQL cannot be trusted with; an empty prefix simply means "scan and
 * let JavaScript decide". `%`, `_` and `\` are escaped (the query uses ESCAPE '\').
 */
function sqlPrefix(query: string): string {
  let prefix = '';
  for (const ch of trLower(query)) {
    if (ch.charCodeAt(0) > 127 || ch === 'i') break;
    prefix += ch;
  }
  return prefix.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** Candidate rows: not me, not soft-deleted, not in a blocked relationship with me. */
function searchCandidates(db: Database, meId: string, query: string): UserRow[] {
  const like = `${sqlPrefix(query)}%`;
  return db
    .prepare(
      `SELECT * FROM users
        WHERE deleted_at IS NULL
          AND id <> ?
          AND (lower(username) LIKE ? ESCAPE '\\' OR lower(display_name) LIKE ? ESCAPE '\\')
          AND NOT EXISTS (
            SELECT 1 FROM friendships f
             WHERE f.status = 'blocked'
               AND ((f.requester_id = ? AND f.addressee_id = users.id)
                 OR (f.addressee_id = ? AND f.requester_id = users.id)))
        ORDER BY username ASC
        LIMIT ?`,
    )
    .all(meId, like, like, meId, meId, SEARCH_SCAN_LIMIT) as UserRow[];
}

/** Prefix match on either field, in Turkish casing and in plain casing. */
function matchesPrefix(row: UserRow, query: string): boolean {
  const tr = trLower(query);
  const plain = query.toLowerCase();
  const fields = [row.username, row.display_name];
  return fields.some((field) => trLower(field).startsWith(tr) || field.toLowerCase().startsWith(plain));
}

export default async function userRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;
  const auth = { preHandler: app.authenticate };

  app.get('/users/search', auth, async (request) => {
    const me = requireUser(request);
    const { q } = parseQuery(UserSearchQuerySchema, request.query);

    const users: PublicUser[] = searchCandidates(db, me.id, q)
      .filter((row) => matchesPrefix(row, q))
      .slice(0, SEARCH_LIMIT)
      .map(toPublicUser);

    return { users };
  });

  app.get<{ Params: { id: string } }>('/users/:id', auth, async (request) => {
    const me = requireUser(request);
    const row = loadVisibleUser(db, me.id, request.params.id);
    return toPublicProfile(db, row, app.now());
  });

  app.post<{ Params: { id: string } }>('/users/:id/block', auth, async (request) => {
    const me = requireUser(request);
    const target = loadTarget(db, request.params.id);
    if (target.id === me.id) throw badRequest('cannot_block_self', 'Kendini engelleyemezsin.');

    upsertBlock(db, me.id, target.id, app.now());
    return { status: 'blocked' as const, userId: target.id };
  });

  app.post<{ Params: { id: string } }>('/users/:id/unblock', auth, async (request) => {
    const me = requireUser(request);
    const target = loadTarget(db, request.params.id);
    if (target.id === me.id) throw badRequest('cannot_block_self', 'Kendini engelleyemezsin.');

    // Idempotent: removing a block that is not there is a success, not an error.
    const removed = removeBlock(db, me.id, target.id);
    return { status: 'none' as const, userId: target.id, removed };
  });

  app.post<{ Params: { id: string } }>('/users/:id/report', auth, async (request, reply) => {
    const me = requireUser(request);
    const body = parseBody(ReportBodySchema, request.body);
    const target = loadTarget(db, request.params.id);
    if (target.id === me.id) throw badRequest('cannot_report_self', 'Kendini şikayet edemezsin.');

    db.prepare('INSERT INTO reports (id, reporter_id, reported_id, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(
      newId(),
      me.id,
      target.id,
      body.reason,
      nowIso(app.now()),
    );
    return reply.code(201).send({ ok: true });
  });
}

/** A live user by id, or 404. Blocking is NOT considered (block/report still work). */
function loadTarget(db: Database, id: string): UserRow {
  const row = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(id) as UserRow | undefined;
  if (!row) throw notFound('user_not_found', 'Böyle bir kullanıcı yok.');
  return row;
}

/** Same, but a blocked pair cannot see each other at all — so it reads as "gone". */
function loadVisibleUser(db: Database, meId: string, id: string): UserRow {
  const row = loadTarget(db, id);
  if (row.id !== meId && isBlockedBetween(db, meId, row.id)) {
    throw notFound('user_not_found', 'Böyle bir kullanıcı yok.');
  }
  return row;
}
