/**
 * Friendships (SPEC 2.2): GET /friends, POST /friends/request,
 * POST /friends/:friendshipId/accept | /decline, DELETE /friends/:userId.
 *
 * A request can be addressed either by `username` or by the 6-character `inviteCode`
 * printed on the profile screen. When the target has already asked us, the request
 * auto-accepts instead of creating a mirrored row — two people tapping "ekle" at the
 * same time end up friends rather than staring at two pending requests.
 */
import type { FastifyInstance } from 'fastify';
import {
  FriendRequestBodySchema,
  type FriendsView,
  type PublicUser,
  type VulgarityLevel,
} from '@koydum/shared';
import { newId, nowIso, type Database, type FriendshipRow, type UserRow } from '../db/index.js';
import { badRequest, conflict, forbidden, notFound, parseBody } from '../errors.js';
import { requireUser } from '../plugins/auth.js';
import { asVulgarityLevel, toPublicUser } from '../serialize.js';
import { friendRows, friendshipBetween, incomingRequests, outgoingRequests } from '../services/friends.js';
import { notify } from '../services/notifications.js';

// ---------------------------------------------------------------------------
// Notification copy — always rendered at the RECIPIENT's vulgarity level
// ---------------------------------------------------------------------------

function requestCopy(level: VulgarityLevel, name: string): { title: string; body: string } {
  if (level === 1) return { title: 'Yeni kanka isteği', body: `${name} seninle kanka olmak istiyor.` };
  if (level === 3) {
    return { title: '🍆 Kanka isteği', body: `${name} sana kanka olmak istiyor. Kabul et de kim kime koyuyor görelim.` };
  }
  return { title: '👊 Kanka isteği', body: `${name} seni kanka listesine ekledi. Kabul et de çelınc açalım.` };
}

function acceptedCopy(level: VulgarityLevel, name: string): { title: string; body: string } {
  if (level === 1) return { title: 'Kanka isteğin kabul edildi', body: `${name} kanka isteğini kabul etti.` };
  if (level === 3) return { title: '🍆 Kanka oldunuz', body: `${name} kabul etti. Sıra kime koyacağını seçmekte.` };
  return { title: '🔥 Kanka oldunuz', body: `${name} kanka isteğini kabul etti. Aç bir çelınc, koy bakalım.` };
}

function levelOf(user: UserRow): VulgarityLevel {
  return asVulgarityLevel(user.vulgarity_max);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export default async function friendRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;
  const auth = { preHandler: app.authenticate };

  app.get('/friends', auth, async (request) => {
    const me = requireUser(request);
    const view: FriendsView = {
      friends: friendRows(db, me.id).map(toPublicUser),
      incoming: incomingRequests(db, me.id).map((r) => ({ id: r.friendship.id, user: toPublicUser(r.user) })),
      outgoing: outgoingRequests(db, me.id).map((r) => ({ id: r.friendship.id, user: toPublicUser(r.user) })),
    };
    return view;
  });

  app.post('/friends/request', auth, async (request, reply) => {
    const me = requireUser(request);
    const body = parseBody(FriendRequestBodySchema, request.body);
    const now = app.now();
    const at = nowIso(now);

    const target = resolveTarget(db, body);
    if (!target) throw notFound('user_not_found', 'Böyle bir kanka bulamadım.');
    if (target.id === me.id) throw badRequest('cannot_friend_self', 'Kendine kanka isteği gönderemezsin.');

    const existing = friendshipBetween(db, me.id, target.id);

    if (existing?.status === 'blocked') {
      throw forbidden('blocked', 'Bu kişiyle aranızda engel var.');
    }
    if (existing?.status === 'accepted') {
      throw conflict('already_friends', 'Zaten kankasınız.');
    }
    if (existing?.status === 'pending' && existing.requester_id === me.id) {
      throw conflict('already_requested', 'İsteğini zaten gönderdin, cevabı bekle.');
    }

    // They asked first → accept instead of piling up a second pending row.
    if (existing?.status === 'pending') {
      db.prepare("UPDATE friendships SET status = 'accepted', updated_at = ? WHERE id = ?").run(at, existing.id);
      const copy = acceptedCopy(levelOf(target), me.row.display_name);
      notify(db, {
        userId: target.id,
        type: 'friend_accepted',
        title: copy.title,
        body: copy.body,
        data: { userId: me.id, friendshipId: existing.id },
        createdAt: at,
      });
      return { status: 'accepted' as const, friendshipId: existing.id, user: toPublicUser(target) };
    }

    const friendshipId = newId();
    db.prepare(
      `INSERT INTO friendships (id, requester_id, addressee_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`,
    ).run(friendshipId, me.id, target.id, at, at);

    const copy = requestCopy(levelOf(target), me.row.display_name);
    notify(db, {
      userId: target.id,
      type: 'friend_request',
      title: copy.title,
      body: copy.body,
      data: { userId: me.id, friendshipId },
      createdAt: at,
    });

    return reply.code(201).send({ status: 'pending' as const, friendshipId, user: toPublicUser(target) });
  });

  app.post<{ Params: { id: string } }>('/friends/:id/accept', auth, async (request) => {
    const me = requireUser(request);
    const friendship = loadPendingForAddressee(db, request.params.id, me.id);
    const at = nowIso(app.now());

    db.prepare("UPDATE friendships SET status = 'accepted', updated_at = ? WHERE id = ?").run(at, friendship.id);

    const requester = db.prepare('SELECT * FROM users WHERE id = ?').get(friendship.requester_id) as UserRow | undefined;
    if (requester && requester.deleted_at === null) {
      const copy = acceptedCopy(levelOf(requester), me.row.display_name);
      notify(db, {
        userId: requester.id,
        type: 'friend_accepted',
        title: copy.title,
        body: copy.body,
        data: { userId: me.id, friendshipId: friendship.id },
        createdAt: at,
      });
    }

    const friend: PublicUser | null = requester ? toPublicUser(requester) : null;
    return { status: 'accepted' as const, friendshipId: friendship.id, user: friend };
  });

  app.post<{ Params: { id: string } }>('/friends/:id/decline', auth, async (request) => {
    const me = requireUser(request);
    const friendship = loadPendingForAddressee(db, request.params.id, me.id);
    // Deleted rather than kept as 'declined': the schema has no such status and the
    // requester should be able to try again later.
    db.prepare('DELETE FROM friendships WHERE id = ?').run(friendship.id);
    return { status: 'declined' as const, friendshipId: friendship.id };
  });

  app.delete<{ Params: { userId: string } }>('/friends/:userId', auth, async (request) => {
    const me = requireUser(request);
    const existing = friendshipBetween(db, me.id, request.params.userId);
    if (!existing || existing.status !== 'accepted') {
      throw notFound('friendship_not_found', 'Böyle bir kanka bağın yok.');
    }
    db.prepare('DELETE FROM friendships WHERE id = ?').run(existing.id);
    return { status: 'removed' as const, userId: request.params.userId };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolves the target of a friend request by username or invite code. */
function resolveTarget(db: Database, body: { username?: string; inviteCode?: string }): UserRow | undefined {
  if (body.username !== undefined) {
    return db.prepare('SELECT * FROM users WHERE username = ? AND deleted_at IS NULL').get(body.username) as
      | UserRow
      | undefined;
  }
  if (body.inviteCode !== undefined) {
    return db
      .prepare('SELECT * FROM users WHERE upper(invite_code) = ? AND deleted_at IS NULL')
      .get(body.inviteCode.trim().toUpperCase()) as UserRow | undefined;
  }
  return undefined;
}

/** The pending request `friendshipId`, which only its addressee may answer. */
function loadPendingForAddressee(db: Database, friendshipId: string, meId: string): FriendshipRow {
  const row = db.prepare('SELECT * FROM friendships WHERE id = ?').get(friendshipId) as FriendshipRow | undefined;
  if (!row) throw notFound('friendship_not_found', 'Böyle bir kanka isteği yok.');
  if (row.addressee_id !== meId) throw forbidden('forbidden', 'Bu isteği sen cevaplayamazsın.');
  if (row.status !== 'pending') throw conflict('not_pending', 'Bu istek zaten cevaplanmış.');
  return row;
}
