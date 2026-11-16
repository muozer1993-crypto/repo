/**
 * Other people (SPEC 2.2): GET /users/search, GET /users/blocked, GET /users/:id,
 * POST /users/:id/block | /unblock | /report.
 *
 * Blocking is modelled as a `friendships` row with status `blocked` and the blocker
 * as `requester_id` (SPEC 2.2). A blocked pair is invisible to each other: no search
 * hit, no profile, no friend request, no challenge invite. A block also retires the
 * blocker's invite code: the old davet links stop working.
 */
import type { FastifyInstance } from 'fastify';
import { foldUsername, ReportBodySchema, UserSearchQuerySchema, type PublicUser } from '@koydum/shared';
import { newId, nowIso, type Database, type UserRow } from '../db/index.js';
import { badRequest, notFound, parseBody, parseQuery } from '../errors.js';
import { requireUser } from '../plugins/auth.js';
import { toPublicProfile, toPublicUser } from '../serialize.js';
import { renewInviteCode } from '../services/accounts.js';
import { blockedByMe, isBlockedBetween, recordRefusal, removeBlock, upsertBlock } from '../services/friends.js';

/** Max hits returned to the app (SPEC 2.2). */
const SEARCH_LIMIT = 20;

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
 * first character SQL cannot be trusted with; an empty prefix simply means "every row
 * goes to `matchesPrefix`". A space counts too: the folded username match drops it, so
 * "ali veli" has to reach `aliveli`. `%`, `_` and `\` are escaped (the query uses ESCAPE '\').
 */
function sqlPrefix(query: string): string {
  let prefix = '';
  for (const ch of trLower(query)) {
    if (ch.charCodeAt(0) > 127 || ch === 'i' || /\s/.test(ch)) break;
    prefix += ch;
  }
  return prefix.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * The hits: not me, not soft-deleted, not in a blocked relationship with me, and a
 * prefix match (`koydum_search_match`, registered in `userRoutes`).
 *
 * The match runs inside the query, before the LIMIT. It used to run in JavaScript
 * on the first 2,000 rows by username, and for a query SQL cannot narrow ("Şey",
 * "şeyma": the LIKE is then `%`) those were simply the first 2,000 accounts, so
 * 2,000 throwaway "aa…" accounts hid @seyma from everybody.
 */
function searchHits(db: Database, meId: string, query: string): UserRow[] {
  const like = `${sqlPrefix(query)}%`;
  return db
    .prepare(
      `SELECT * FROM users
        WHERE deleted_at IS NULL
          AND id <> ?
          AND (lower(username) LIKE ? ESCAPE '\\' OR lower(display_name) LIKE ? ESCAPE '\\')
          AND koydum_search_match(username, display_name, ?) = 1
          AND NOT EXISTS (
            SELECT 1 FROM friendships f
             WHERE f.status = 'blocked'
               AND ((f.requester_id = ? AND f.addressee_id = users.id)
                 OR (f.addressee_id = ? AND f.requester_id = users.id)))
        ORDER BY username ASC
        LIMIT ?`,
    )
    .all(meId, like, like, query, meId, meId, SEARCH_LIMIT) as UserRow[];
}

/**
 * Prefix match on either field, in Turkish casing and in plain casing. The username is
 * also tried in the spelling it is stored in (`foldUsername`), so "şey" finds @seyma
 * even when her display name is spelled some other way.
 */
function matchesPrefix(row: Pick<UserRow, 'username' | 'display_name'>, query: string): boolean {
  const tr = trLower(query);
  const plain = query.toLowerCase();
  const folded = foldUsername(query);
  // a query of nothing but invisible characters folds to '', a prefix of everybody
  if (folded !== '' && row.username.startsWith(folded)) return true;
  const fields = [row.username, row.display_name];
  return fields.some((field) => trLower(field).startsWith(tr) || field.toLowerCase().startsWith(plain));
}

export default async function userRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;
  const auth = { preHandler: app.authenticate };

  // `matchesPrefix` as an SQL function (see `searchHits`). A function belongs to
  // the connection it is made on, so every app makes it once, on its own `db`.
  db.function('koydum_search_match', { deterministic: true }, (username: string, displayName: string, query: string) =>
    matchesPrefix({ username, display_name: displayName }, query) ? 1 : 0,
  );

  app.get('/users/search', auth, async (request) => {
    const me = requireUser(request);
    const { q } = parseQuery(UserSearchQuerySchema, request.query);

    const users: PublicUser[] = searchHits(db, me.id, q).map(toPublicUser);

    // SPEC 2.2 and the mobile client both expect a bare array.
    return users;
  });

  // Ayarlar → Engellediklerin. Without it a block was for ever: a blocked profile
  // 404s and search hides the pair, so the app had nowhere to unblock from.
  // Registered before /users/:id so nobody reads "blocked" as an id.
  app.get('/users/blocked', auth, async (request) => {
    const me = requireUser(request);
    const users: PublicUser[] = blockedByMe(db, me.id).map(toPublicUser);
    return users;
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

    const now = app.now();
    db.transaction(() => {
      upsertBlock(db, me.id, target.id, now);
      // after an unblock their invite code still only asks (routes/friends.ts)
      recordRefusal(db, me.id, target.id, now);
      // The davet links I sent carry my code, and a new account's code is a
      // friendship at once: the blocked one would be back with a fresh account.
      // The app reads the new code from /me.
      renewInviteCode(db, me.id);
    })();
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
    // Nobody in the app reads reports; this line lands in the owner's server window.
    request.log.warn(
      { reporter: me.row.username, reported: target.username, reason: body.reason },
      'YENİ ŞİKAYET (npm run yonet -- sikayetler)',
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
