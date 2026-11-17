/**
 * Other people (SPEC 2.2): GET /users/search, GET /users/blocked, GET /users/:id,
 * POST /users/:id/block | /unblock | /report.
 *
 * Blocking is modelled as a `friendships` row with status `blocked` and the blocker
 * as `requester_id` (SPEC 2.2). A blocked pair is invisible to each other: no search
 * hit, no profile, no friend request, no challenge invite. A block also retires the
 * blocker's invite code: the old davet links stop working.
 *
 * Every stored report is a `YENİ ŞİKAYET` line in the owner's server window: an
 * account files at most `REPORTS_PER_USER` an hour, and a repeat of the same
 * person for the same reason within a day is not stored again.
 */
import type { FastifyInstance } from 'fastify';
import { foldForSearch, foldUsername, ReportBodySchema, UserSearchQuerySchema, type PublicUser } from '@koydum/shared';
import { newId, nowIso, type Database, type UserRow } from '../db/index.js';
import { badRequest, notFound, parseBody, parseQuery, tooMany } from '../errors.js';
import { requireUser } from '../plugins/auth.js';
import { toPublicProfile, toPublicUser } from '../serialize.js';
import { renewInviteCode } from '../services/accounts.js';
import { blockedByMe, isBlockedBetween, recordRefusal, removeBlock, upsertBlock } from '../services/friends.js';
import { AttemptLimiter, retryAfterText } from '../services/throttle.js';

/** Max hits returned to the app (SPEC 2.2). */
const SEARCH_LIMIT = 20;

/**
 * Reports one account may file in an hour. Each is a line in the window the
 * README tells the owner to watch, and one account wrote 3,000 in two and a half
 * seconds: the tunnel address and every real error scrolled out of it. Somebody
 * who has had enough of a few people still fits in it.
 */
export const REPORTS_PER_USER = { max: 10, windowMs: 60 * 60 * 1000 };

/**
 * A second report of the same person for the same reason from the same account
 * this soon is not stored: a double tap or a retry, the owner has the first one
 * to read, and the phone hears "alındı" either way. A new reason ("şimdi de
 * tehdit etti") is news for the owner and is stored like any report.
 */
export const REPORT_REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The hits: not me, not soft-deleted, not in a blocked relationship with me, and a
 * match (`koydum_search_match`, registered in `userRoutes`).
 *
 * The match runs inside the query, before the LIMIT. It used to run in JavaScript
 * on the first 2,000 rows by username, and for a query SQL cannot narrow ("Şey",
 * "şeyma") those were simply the first 2,000 accounts, so 2,000 throwaway "aa…"
 * accounts hid @seyma from everybody. No query is narrowed in SQL any more:
 * SQLite's `lower()` and LIKE are ASCII-only, and a match at any word of the
 * display name ("cag" for "Özge Çağlar") has no prefix to narrow by, so every
 * row is asked. The LIMIT still caps what comes back.
 *
 * The hits are ranked before the LIMIT too: the username itself first, then
 * usernames that start with the query, then names that only match by display
 * name. Sorted by username alone, 20 accounts named "Seyma" (@a01…@a20) hid
 * @seyma from a search for "seyma".
 */
function searchHits(db: Database, meId: string, query: string): UserRow[] {
  const folded = foldUsername(query);
  const usernamePrefix = `${folded.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  return db
    .prepare(
      `SELECT * FROM users
        WHERE deleted_at IS NULL
          AND id <> ?
          AND koydum_search_match(username, display_name, ?) = 1
          AND NOT EXISTS (
            SELECT 1 FROM friendships f
             WHERE f.status = 'blocked'
               AND ((f.requester_id = ? AND f.addressee_id = users.id)
                 OR (f.addressee_id = ? AND f.requester_id = users.id)))
        ORDER BY (username = ?) DESC, (username LIKE ? ESCAPE '\\') DESC, username ASC
        LIMIT ?`,
    )
    .all(meId, query, meId, meId, folded, usernamePrefix, SEARCH_LIMIT) as UserRow[];
}

/**
 * What a word is made of: a letter or a digit. Not a mark: the accents are gone
 * by now, and what is left is mostly the U+FE0F many emoji end with (sun, heart).
 */
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Whether `query` starts a word of `name` (both `foldForSearch`ed): at its start,
 * after a space, or as a letter or digit right after an emoji or punctuation. A
 * display name can be "🔥Mert", "Ayşe-Nur" or "@kral", and split on spaces alone
 * "mert", "nur" and "kral" found none of them. A query that itself starts with an
 * emoji or punctuation ("😎") still needs the start or a space in front.
 */
function startsAWord(name: string, query: string): boolean {
  const opensWord = WORD_CHAR.test(query[0] ?? '');
  for (let at = name.indexOf(query); at !== -1; at = name.indexOf(query, at + 1)) {
    const before = name[at - 1];
    if (before === undefined || before === ' ' || (opensWord && !WORD_CHAR.test(before))) return true;
  }
  return false;
}

/**
 * The query folded like a username against the start of the username ("Çağ" finds
 * @cagri, "ca gri" too), and folded for search (`foldForSearch`) against the start
 * of any word of the display name (`startsAWord`): "ozge", "Ozge" and "cag" find
 * "Özge Çağlar", "Ismail" and "ISMAIL" find "İsmail Şahin". The app sends the query
 * as typed (the 1.1.0 APKs in friends' hands too), so all of the folding happens here.
 */
function matchesPrefix(row: Pick<UserRow, 'username' | 'display_name'>, query: string): boolean {
  // a query of nothing but invisible characters or accents folds to '', a prefix of everybody
  const folded = foldUsername(query);
  if (folded !== '' && row.username.startsWith(folded)) return true;
  const words = foldForSearch(query);
  return words !== '' && startsAWord(foldForSearch(row.display_name), words);
}

export default async function userRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;
  const auth = { preHandler: app.authenticate };
  const reportsPerUser = new AttemptLimiter(REPORTS_PER_USER.max, REPORTS_PER_USER.windowMs);

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

    const now = app.now();
    const waitMs = reportsPerUser.retryAfterMs(me.id, now);
    if (waitMs > 0) throw tooMany('too_many_requests', `Çok fazla şikayet gönderdin. ${retryAfterText(waitMs)}`);
    const repeat = db
      .prepare('SELECT 1 FROM reports WHERE reporter_id = ? AND reported_id = ? AND reason = ? AND created_at >= ?')
      .get(me.id, target.id, body.reason, nowIso(new Date(now.getTime() - REPORT_REPEAT_WINDOW_MS)));
    if (repeat) return reply.code(201).send({ ok: true });

    db.prepare('INSERT INTO reports (id, reporter_id, reported_id, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(
      newId(),
      me.id,
      target.id,
      body.reason,
      nowIso(now),
    );
    // only a stored report counts: a repeat costs the owner nothing to read
    reportsPerUser.record(me.id, now);
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
