/**
 * Social routes: auth, /me, users, friends, catalog and uploads.
 *
 * Everything runs against an in-memory database with the injected clock from
 * `makeApp()`, so day keys and notification timestamps are deterministic.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CHALLENGE_TYPES, SHARED_VERSION, type FriendsView, type Me, type Notification } from '@koydum/shared';
import { newId, nowIso, type ChallengeRow, type EntryRow, type UserRow } from '../src/db/index.js';
import { authed, makeApp, registerUser, type TestApp } from './helpers.js';

let harness: TestApp | null = null;

afterEach(async () => {
  if (harness) {
    await harness.close();
    harness = null;
  }
});

async function boot(now?: string): Promise<TestApp> {
  harness = await makeApp(now ? { now } : {});
  return harness;
}

// ---------------------------------------------------------------------------
// Fixtures that belong to the challenges group — written directly so these tests
// stay independent of POST /challenges.
// ---------------------------------------------------------------------------

interface ChallengeFixture {
  creatorId: string;
  accepted?: string[];
  invited?: string[];
  startsAt: string;
  endsAt: string;
  status?: 'pending' | 'active' | 'finished' | 'cancelled';
  typeKey?: string;
  metricType?: string;
  title?: string;
}

function insertChallenge(h: TestApp, fixture: ChallengeFixture): string {
  const id = newId();
  const at = nowIso(h.now());
  h.db
    .prepare(
      `INSERT INTO challenges (id, creator_id, type_key, metric_type, direction, unit, title, starts_at, ends_at,
                               status, reward_text, penalty_text, deadline_time, daily_target, proof_required,
                               created_at, finalized_at, winner_id, is_tie, rematch_of_id)
       VALUES (?, ?, ?, ?, 'higher', 'adım', ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, ?, NULL, NULL, 0, NULL)`,
    )
    .run(
      id,
      fixture.creatorId,
      fixture.typeKey ?? 'adim_yarisi',
      fixture.metricType ?? 'auto_steps',
      fixture.title ?? 'Adım yarışı',
      fixture.startsAt,
      fixture.endsAt,
      fixture.status ?? 'active',
      at,
    );

  const insertParticipant = h.db.prepare(
    'INSERT INTO challenge_participants (challenge_id, user_id, status, invited_at, joined_at) VALUES (?, ?, ?, ?, ?)',
  );
  for (const userId of fixture.accepted ?? []) insertParticipant.run(id, userId, 'accepted', at, at);
  for (const userId of fixture.invited ?? []) insertParticipant.run(id, userId, 'invited', at, null);
  return id;
}

function entriesOf(h: TestApp, challengeId: string, userId: string): EntryRow[] {
  return h.db
    .prepare('SELECT * FROM entries WHERE challenge_id = ? AND user_id = ? ORDER BY day_key ASC')
    .all(challengeId, userId) as EntryRow[];
}

function userRow(h: TestApp, id: string): UserRow {
  return h.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow;
}

/** Minimal multipart/form-data body for `app.inject`. */
function multipart(file: { filename: string; contentType: string; content: Buffer; field?: string }): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = `----koydum${Math.random().toString(16).slice(2)}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${file.field ?? 'file'}"; filename="${file.filename}"\r\n` +
      `Content-Type: ${file.contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, file.content, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('POST /auth/register', () => {
  it('creates a user with a lowercase username and a unique invite code', async () => {
    const h = await boot();
    const response = await h.app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { username: '  MuStAfA  ', password: 'sifre123', displayName: 'Mustafa', timezone: 'Europe/Istanbul' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<{ token: string; me: Me }>();
    expect(body.me.username).toBe('mustafa');
    expect(body.me.displayName).toBe('Mustafa');
    expect(body.me.vulgarityMax).toBe(2);
    expect(body.me.hasPushToken).toBe(false);
    expect(body.me.inviteCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    expect(body.token.split('.')).toHaveLength(3);

    // The token works immediately.
    const me = await authed(h.app, body.token)({ method: 'GET', url: '/me' });
    expect(me.statusCode).toBe(200);
    expect(me.json<Me>().id).toBe(body.me.id);
  });

  it('gives every user a different invite code', async () => {
    const h = await boot();
    const a = await registerUser(h.app, 'ali');
    const b = await registerUser(h.app, 'veli');
    expect(a.me.inviteCode).not.toBe(b.me.inviteCode);
  });

  it('rejects a duplicate username with 409 username_taken', async () => {
    const h = await boot();
    await registerUser(h.app, 'mustafa');
    const response = await h.app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { username: 'MUSTAFA', password: 'baskasifre', displayName: 'Başkası' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string; message: string } }>().error.code).toBe('username_taken');
    expect(response.json<{ error: { message: string } }>().error.message).toMatch(/kullanıcı adı/i);
  });

  it('rejects an invalid body with 400 validation', async () => {
    const h = await boot();
    const response = await h.app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { username: 'ab', password: '123', displayName: '' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('validation');
  });
});

describe('POST /auth/login', () => {
  it('returns a token for the right password', async () => {
    const h = await boot();
    await registerUser(h.app, 'mustafa', { password: 'cokgizli' });
    const response = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'MuStAfA', password: 'cokgizli' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ me: Me }>().me.username).toBe('mustafa');
  });

  it('rejects a wrong password and an unknown user with 401 bad_credentials', async () => {
    const h = await boot();
    await registerUser(h.app, 'mustafa', { password: 'cokgizli' });

    const wrong = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'mustafa', password: 'yanlissifre' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json<{ error: { code: string } }>().error.code).toBe('bad_credentials');

    const unknown = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'kimseyok', password: 'cokgizli' },
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json<{ error: { code: string } }>().error.code).toBe('bad_credentials');
  });
});

// ---------------------------------------------------------------------------
// /me
// ---------------------------------------------------------------------------

describe('/me', () => {
  it('patches the profile and keeps everything else', async () => {
    const h = await boot();
    const user = await registerUser(h.app, 'mustafa');
    const call = authed(h.app, user.token);

    const response = await call({
      method: 'PATCH',
      url: '/me',
      payload: { displayName: 'Musti', avatarEmoji: '🔥', vulgarityMax: 3, reminderHour: null, timezone: 'Europe/Berlin' },
    });
    expect(response.statusCode).toBe(200);
    const me = response.json<Me>();
    expect(me).toMatchObject({
      displayName: 'Musti',
      avatarEmoji: '🔥',
      vulgarityMax: 3,
      reminderHour: null,
      timezone: 'Europe/Berlin',
      username: 'mustafa',
    });
  });

  it('rejects an invalid patch', async () => {
    const h = await boot();
    const user = await registerUser(h.app, 'mustafa');
    const response = await authed(h.app, user.token)({ method: 'PATCH', url: '/me', payload: { vulgarityMax: 9 } });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('validation');
  });

  it('stores and clears the push token', async () => {
    const h = await boot();
    const user = await registerUser(h.app, 'mustafa');
    const call = authed(h.app, user.token);

    const stored = await call({
      method: 'POST',
      url: '/me/push-token',
      payload: { token: 'ExponentPushToken[abcdef]', platform: 'ios' },
    });
    expect(stored.statusCode).toBe(200);
    expect((await call({ method: 'GET', url: '/me' })).json<Me>().hasPushToken).toBe(true);
    expect(userRow(h, user.me.id).push_platform).toBe('ios');

    const cleared = await call({ method: 'DELETE', url: '/me/push-token' });
    expect(cleared.statusCode).toBe(200);
    expect((await call({ method: 'GET', url: '/me' })).json<Me>().hasPushToken).toBe(false);
  });

  it('requires a token', async () => {
    const h = await boot();
    const response = await h.app.inject({ method: 'GET', url: '/me' });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('unauthorized');
  });
});

describe('DELETE /me', () => {
  it('anonymises the account, leaves live challenges and keeps finished ones', async () => {
    const h = await boot();
    const user = await registerUser(h.app, 'mustafa', { pushToken: 'ExponentPushToken[x]' });
    const rival = await registerUser(h.app, 'kemal');
    const call = authed(h.app, user.token);

    const active = insertChallenge(h, {
      creatorId: rival.me.id,
      accepted: [rival.me.id, user.me.id],
      startsAt: '2026-01-04T00:00:00.000Z',
      endsAt: '2026-01-10T00:00:00.000Z',
      status: 'active',
    });
    const finished = insertChallenge(h, {
      creatorId: rival.me.id,
      accepted: [rival.me.id, user.me.id],
      startsAt: '2025-12-01T00:00:00.000Z',
      endsAt: '2025-12-08T00:00:00.000Z',
      status: 'finished',
    });

    const response = await call({ method: 'DELETE', url: '/me' });
    expect(response.statusCode).toBe(200);

    const row = userRow(h, user.me.id);
    expect(row.username).toBe(`deleted_${user.me.id.replace(/-/g, '').slice(0, 8)}`);
    expect(row.deleted_at).not.toBeNull();
    expect(row.push_token).toBeNull();
    expect(row.push_platform).toBeNull();
    expect(row.reminder_hour).toBeNull();

    const statusIn = (challengeId: string): string =>
      (
        h.db
          .prepare('SELECT status FROM challenge_participants WHERE challenge_id = ? AND user_id = ?')
          .get(challengeId, user.me.id) as { status: string }
      ).status;
    expect(statusIn(active)).toBe('left');
    expect(statusIn(finished)).toBe('accepted');

    // The old username is free again and the old token is dead.
    expect((await call({ method: 'GET', url: '/me' })).statusCode).toBe(401);
    const reuse = await h.app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { username: 'mustafa', password: 'sifre123', displayName: 'Yeni Mustafa' },
    });
    expect(reuse.statusCode).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// POST /me/steps
// ---------------------------------------------------------------------------

describe('POST /me/steps', () => {
  it('upserts steps_daily and fans out into the challenges being played', async () => {
    const h = await boot();
    const user = await registerUser(h.app, 'mustafa');
    const rival = await registerUser(h.app, 'kemal');
    const call = authed(h.app, user.token);

    const activeChallenge = insertChallenge(h, {
      creatorId: rival.me.id,
      accepted: [rival.me.id, user.me.id],
      startsAt: '2026-01-04T00:00:00.000Z',
      endsAt: '2026-01-10T00:00:00.000Z',
      status: 'active',
    });
    // pending but already started → counts too (SPEC 2.2)
    const startedPending = insertChallenge(h, {
      creatorId: rival.me.id,
      accepted: [rival.me.id, user.me.id],
      startsAt: '2026-01-05T06:00:00.000Z',
      endsAt: '2026-01-09T00:00:00.000Z',
      status: 'pending',
    });
    // not started yet → ignored
    const futurePending = insertChallenge(h, {
      creatorId: rival.me.id,
      accepted: [rival.me.id, user.me.id],
      startsAt: '2026-02-01T00:00:00.000Z',
      endsAt: '2026-02-05T00:00:00.000Z',
      status: 'pending',
    });
    // only invited → ignored
    const invitedOnly = insertChallenge(h, {
      creatorId: rival.me.id,
      accepted: [rival.me.id],
      invited: [user.me.id],
      startsAt: '2026-01-04T00:00:00.000Z',
      endsAt: '2026-01-10T00:00:00.000Z',
      status: 'active',
    });
    // wrong metric → ignored
    const otherMetric = insertChallenge(h, {
      creatorId: rival.me.id,
      accepted: [rival.me.id, user.me.id],
      startsAt: '2026-01-04T00:00:00.000Z',
      endsAt: '2026-01-10T00:00:00.000Z',
      status: 'active',
      typeKey: 'su_bardak',
      metricType: 'manual_count',
    });

    const response = await call({
      method: 'POST',
      url: '/me/steps',
      payload: {
        days: [
          { dayKey: '2026-01-05', steps: 8421, source: 'pedometer' },
          { dayKey: '2026-01-04', steps: 3000, source: 'health_connect' },
          { dayKey: '2025-12-30', steps: 999, source: 'pedometer' }, // outside every window
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    // active: 2 days in range, startedPending: only 2026-01-05..09 → 1 day in range
    expect(response.json<{ updated: number }>().updated).toBe(3);

    const daily = h.db
      .prepare('SELECT * FROM steps_daily WHERE user_id = ? ORDER BY day_key ASC')
      .all(user.me.id) as { day_key: string; steps: number; source: string }[];
    expect(daily.map((d) => d.day_key)).toEqual(['2025-12-30', '2026-01-04', '2026-01-05']);
    expect(daily[2]?.steps).toBe(8421);

    const activeEntries = entriesOf(h, activeChallenge, user.me.id);
    expect(activeEntries.map((e) => [e.day_key, e.value, e.source])).toEqual([
      ['2026-01-04', 3000, 'health_connect'],
      ['2026-01-05', 8421, 'pedometer'],
    ]);
    expect(entriesOf(h, startedPending, user.me.id).map((e) => e.day_key)).toEqual(['2026-01-05']);
    expect(entriesOf(h, futurePending, user.me.id)).toHaveLength(0);
    expect(entriesOf(h, invitedOnly, user.me.id)).toHaveLength(0);
    expect(entriesOf(h, otherMetric, user.me.id)).toHaveLength(0);

    // Re-syncing the same day updates the existing entry instead of adding one.
    const again = await call({
      method: 'POST',
      url: '/me/steps',
      payload: { days: [{ dayKey: '2026-01-05', steps: 12430, source: 'pedometer' }] },
    });
    expect(again.json<{ updated: number }>().updated).toBe(2);
    expect(entriesOf(h, activeChallenge, user.me.id)).toHaveLength(2);
    expect(entriesOf(h, activeChallenge, user.me.id)[1]?.value).toBe(12430);

    // stepsToday follows the user's own timezone (09:00Z is 12:00 in Istanbul).
    const me = (await call({ method: 'GET', url: '/me' })).json<Me>();
    expect(me.stats.stepsToday).toBe(12430);
    expect(me.stats.stepsSingleDayMax).toBe(12430);
  });

  it('accepts an empty sync and rejects an invalid one', async () => {
    const h = await boot();
    const user = await registerUser(h.app, 'mustafa');
    const call = authed(h.app, user.token);

    const empty = await call({ method: 'POST', url: '/me/steps', payload: { days: [] } });
    expect(empty.statusCode).toBe(200);
    expect(empty.json<{ updated: number }>().updated).toBe(0);

    const invalid = await call({
      method: 'POST',
      url: '/me/steps',
      payload: { days: [{ dayKey: '2026-13-01', steps: 10, source: 'pedometer' }] },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ error: { code: string } }>().error.code).toBe('validation');
  });
});

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

describe('/me/inbox', () => {
  it('lists newest first, counts unread and marks read by id and in bulk', async () => {
    const h = await boot();
    const target = await registerUser(h.app, 'mustafa');
    const first = await registerUser(h.app, 'ali');
    const second = await registerUser(h.app, 'veli');
    const call = authed(h.app, target.token);

    await authed(h.app, first.token)({ method: 'POST', url: '/friends/request', payload: { username: 'mustafa' } });
    h.advance(60_000);
    await authed(h.app, second.token)({ method: 'POST', url: '/friends/request', payload: { username: 'mustafa' } });

    const inbox = await call({ method: 'GET', url: '/me/inbox' });
    expect(inbox.statusCode).toBe(200);
    const items = inbox.json<Notification[]>();
    expect(items).toHaveLength(2);
    expect(items[0]?.type).toBe('friend_request');
    expect(items[0]?.body).toContain('veli'); // newest first
    expect(items[0]?.data).toMatchObject({ userId: second.me.id });
    expect(items[0]?.readAt).toBeNull();

    const unread = await call({ method: 'GET', url: '/me/inbox/unread' });
    expect(unread.json<{ count: number; latestId: string | null }>()).toEqual({ count: 2, latestId: items[0]?.id });

    const readOne = await call({ method: 'POST', url: '/me/inbox/read', payload: { ids: [items[0]!.id] } });
    expect(readOne.json<{ updated: number; count: number }>()).toMatchObject({ updated: 1, count: 1 });

    const readAll = await call({ method: 'POST', url: '/me/inbox/read', payload: { all: true } });
    expect(readAll.json<{ updated: number; count: number }>()).toMatchObject({ updated: 1, count: 0 });
    expect((await call({ method: 'GET', url: '/me/inbox/unread' })).json<{ count: number }>().count).toBe(0);

    const listed = (await call({ method: 'GET', url: '/me/inbox' })).json<Notification[]>();
    expect(listed.every((item) => item.readAt !== null)).toBe(true);
  });

  it('pages with ?before= and validates the body of /read', async () => {
    const h = await boot();
    const target = await registerUser(h.app, 'mustafa');
    const first = await registerUser(h.app, 'ali');
    const second = await registerUser(h.app, 'veli');
    const call = authed(h.app, target.token);

    await authed(h.app, first.token)({ method: 'POST', url: '/friends/request', payload: { username: 'mustafa' } });
    h.advance(60_000);
    await authed(h.app, second.token)({ method: 'POST', url: '/friends/request', payload: { username: 'mustafa' } });

    // the client pages by asking for everything older than the last item it has
    const page = (await call({ method: 'GET', url: '/me/inbox?limit=1' })).json<Notification[]>();
    expect(page).toHaveLength(1);

    const older = (
      await call({ method: 'GET', url: `/me/inbox?before=${encodeURIComponent(page[0]!.createdAt)}` })
    ).json<Notification[]>();
    expect(older).toHaveLength(1);
    expect(older[0]?.id).not.toBe(page[0]?.id);

    const bad = await call({ method: 'POST', url: '/me/inbox/read', payload: {} });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ error: { code: string } }>().error.code).toBe('validation');
  });
});

// ---------------------------------------------------------------------------
// Friends
// ---------------------------------------------------------------------------

describe('friends', () => {
  it('sends, lists and accepts a request by username', async () => {
    const h = await boot();
    const asker = await registerUser(h.app, 'mustafa');
    const target = await registerUser(h.app, 'kemal');

    const requested = await authed(h.app, asker.token)({
      method: 'POST',
      url: '/friends/request',
      payload: { username: 'KEMAL' },
    });
    expect(requested.statusCode).toBe(201);
    const friendshipId = requested.json<{ status: string; friendshipId: string }>().friendshipId;
    expect(requested.json<{ status: string }>().status).toBe('pending');

    const askerView = (await authed(h.app, asker.token)({ method: 'GET', url: '/friends' })).json<FriendsView>();
    expect(askerView.outgoing.map((r) => r.user.username)).toEqual(['kemal']);
    expect(askerView.friends).toHaveLength(0);

    const targetView = (await authed(h.app, target.token)({ method: 'GET', url: '/friends' })).json<FriendsView>();
    expect(targetView.incoming.map((r) => r.user.username)).toEqual(['mustafa']);
    expect(targetView.incoming[0]?.id).toBe(friendshipId);

    const accepted = await authed(h.app, target.token)({ method: 'POST', url: `/friends/${friendshipId}/accept` });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json<{ status: string }>().status).toBe('accepted');

    for (const who of [asker, target]) {
      const view = (await authed(h.app, who.token)({ method: 'GET', url: '/friends' })).json<FriendsView>();
      expect(view.friends).toHaveLength(1);
      expect(view.incoming).toHaveLength(0);
      expect(view.outgoing).toHaveLength(0);
    }

    // The requester hears about it.
    const inbox = (
      await authed(h.app, asker.token)({ method: 'GET', url: '/me/inbox' })
    ).json<Notification[]>();
    expect(inbox[0]?.type).toBe('friend_accepted');
  });

  it('finds the target by invite code', async () => {
    const h = await boot();
    const asker = await registerUser(h.app, 'mustafa');
    const target = await registerUser(h.app, 'kemal');

    const response = await authed(h.app, asker.token)({
      method: 'POST',
      url: '/friends/request',
      payload: { inviteCode: target.me.inviteCode.toLowerCase() },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json<{ user: { id: string } }>().user.id).toBe(target.me.id);
  });

  it('auto-accepts when the target already asked', async () => {
    const h = await boot();
    const first = await registerUser(h.app, 'mustafa');
    const second = await registerUser(h.app, 'kemal');

    await authed(h.app, first.token)({ method: 'POST', url: '/friends/request', payload: { username: 'kemal' } });
    const crossed = await authed(h.app, second.token)({
      method: 'POST',
      url: '/friends/request',
      payload: { username: 'mustafa' },
    });

    expect(crossed.statusCode).toBe(200);
    expect(crossed.json<{ status: string }>().status).toBe('accepted');

    const rows = h.db.prepare('SELECT * FROM friendships').all() as { status: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('accepted');

    const view = (await authed(h.app, first.token)({ method: 'GET', url: '/friends' })).json<FriendsView>();
    expect(view.friends.map((u) => u.username)).toEqual(['kemal']);

    const inbox = (
      await authed(h.app, first.token)({ method: 'GET', url: '/me/inbox' })
    ).json<Notification[]>();
    expect(inbox[0]?.type).toBe('friend_accepted');
  });

  it('declines a request and lets the requester ask again', async () => {
    const h = await boot();
    const asker = await registerUser(h.app, 'mustafa');
    const target = await registerUser(h.app, 'kemal');

    const first = await authed(h.app, asker.token)({
      method: 'POST',
      url: '/friends/request',
      payload: { username: 'kemal' },
    });
    const friendshipId = first.json<{ friendshipId: string }>().friendshipId;

    const declined = await authed(h.app, target.token)({ method: 'POST', url: `/friends/${friendshipId}/decline` });
    expect(declined.statusCode).toBe(200);
    expect(declined.json<{ status: string }>().status).toBe('declined');
    expect(h.db.prepare('SELECT * FROM friendships').all()).toHaveLength(0);

    const again = await authed(h.app, asker.token)({
      method: 'POST',
      url: '/friends/request',
      payload: { username: 'kemal' },
    });
    expect(again.statusCode).toBe(201);
  });

  it('removes an accepted friendship', async () => {
    const h = await boot();
    const asker = await registerUser(h.app, 'mustafa');
    const target = await registerUser(h.app, 'kemal');
    const call = authed(h.app, asker.token);

    const created = await call({ method: 'POST', url: '/friends/request', payload: { username: 'kemal' } });
    await authed(h.app, target.token)({
      method: 'POST',
      url: `/friends/${created.json<{ friendshipId: string }>().friendshipId}/accept`,
    });

    const removed = await call({ method: 'DELETE', url: `/friends/${target.me.id}` });
    expect(removed.statusCode).toBe(200);
    expect(removed.json<{ status: string }>().status).toBe('removed');
    expect((await call({ method: 'GET', url: '/friends' })).json<FriendsView>().friends).toHaveLength(0);

    const missing = await call({ method: 'DELETE', url: `/friends/${target.me.id}` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<{ error: { code: string } }>().error.code).toBe('friendship_not_found');
  });

  it('covers every friend-request error code', async () => {
    const h = await boot();
    const asker = await registerUser(h.app, 'mustafa');
    const target = await registerUser(h.app, 'kemal');
    const stranger = await registerUser(h.app, 'zeynep');
    const call = authed(h.app, asker.token);

    const unknown = await call({ method: 'POST', url: '/friends/request', payload: { username: 'kimseyok' } });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json<{ error: { code: string } }>().error.code).toBe('user_not_found');

    const badCode = await call({ method: 'POST', url: '/friends/request', payload: { inviteCode: 'ZZZZZZ' } });
    expect(badCode.statusCode).toBe(404);
    expect(badCode.json<{ error: { code: string } }>().error.code).toBe('user_not_found');

    const self = await call({ method: 'POST', url: '/friends/request', payload: { username: 'mustafa' } });
    expect(self.statusCode).toBe(400);
    expect(self.json<{ error: { code: string } }>().error.code).toBe('cannot_friend_self');

    const both = await call({ method: 'POST', url: '/friends/request', payload: { username: 'kemal', inviteCode: 'ABC123' } });
    expect(both.statusCode).toBe(400);
    expect(both.json<{ error: { code: string } }>().error.code).toBe('validation');

    const created = await call({ method: 'POST', url: '/friends/request', payload: { username: 'kemal' } });
    const friendshipId = created.json<{ friendshipId: string }>().friendshipId;

    const twice = await call({ method: 'POST', url: '/friends/request', payload: { username: 'kemal' } });
    expect(twice.statusCode).toBe(409);
    expect(twice.json<{ error: { code: string } }>().error.code).toBe('already_requested');

    // Only the addressee may answer.
    const notMine = await authed(h.app, stranger.token)({ method: 'POST', url: `/friends/${friendshipId}/accept` });
    expect(notMine.statusCode).toBe(403);
    expect(notMine.json<{ error: { code: string } }>().error.code).toBe('forbidden');

    const ghost = await call({ method: 'POST', url: `/friends/${newId()}/accept` });
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json<{ error: { code: string } }>().error.code).toBe('friendship_not_found');

    await authed(h.app, target.token)({ method: 'POST', url: `/friends/${friendshipId}/accept` });

    const answered = await authed(h.app, target.token)({ method: 'POST', url: `/friends/${friendshipId}/accept` });
    expect(answered.statusCode).toBe(409);
    expect(answered.json<{ error: { code: string } }>().error.code).toBe('not_pending');

    const already = await call({ method: 'POST', url: '/friends/request', payload: { username: 'kemal' } });
    expect(already.statusCode).toBe(409);
    expect(already.json<{ error: { code: string } }>().error.code).toBe('already_friends');
  });
});

// ---------------------------------------------------------------------------
// Users: search, profile, block, report
// ---------------------------------------------------------------------------

describe('GET /users/search', () => {
  it('prefix matches username and display name with Turkish casing', async () => {
    const h = await boot();
    const me = await registerUser(h.app, 'mustafa', { displayName: 'Mustafa' });
    await registerUser(h.app, 'ismail', { displayName: 'İsmail Şahin' });
    await registerUser(h.app, 'musa', { displayName: 'Musa Bey' });
    await registerUser(h.app, 'kemal', { displayName: 'Kemal' });
    const call = authed(h.app, me.token);

    const byUsername = await call({ method: 'GET', url: '/users/search?q=mus' });
    expect(byUsername.statusCode).toBe(200);
    // "mustafa" is me and must not show up in my own search.
    expect(byUsername.json<{ username: string }[]>().map((u) => u.username)).toEqual(['musa']);

    // "İsmail" lowercases to "ismail" only under Turkish rules.
    const turkish = await call({ method: 'GET', url: '/users/search?q=%C4%B0sm' });
    expect(turkish.json<{ username: string }[]>().map((u) => u.username)).toEqual(['ismail']);

    const byDisplayName = await call({ method: 'GET', url: '/users/search?q=Kem' });
    expect(byDisplayName.json<{ username: string }[]>().map((u) => u.username)).toEqual(['kemal']);

    const nothing = await call({ method: 'GET', url: '/users/search?q=zzz' });
    expect(nothing.json<unknown[]>()).toHaveLength(0);

    const invalid = await call({ method: 'GET', url: '/users/search?q=' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ error: { code: string } }>().error.code).toBe('validation');
  });

  it('hides soft-deleted users', async () => {
    const h = await boot();
    const me = await registerUser(h.app, 'mustafa');
    const leaving = await registerUser(h.app, 'kemal');

    expect(
      (await authed(h.app, me.token)({ method: 'GET', url: '/users/search?q=kem' })).json<unknown[]>(),
    ).toHaveLength(1);

    await authed(h.app, leaving.token)({ method: 'DELETE', url: '/me' });

    expect(
      (await authed(h.app, me.token)({ method: 'GET', url: '/users/search?q=kem' })).json<unknown[]>(),
    ).toHaveLength(0);
  });
});

describe('GET /users/:id', () => {
  it('returns the public profile', async () => {
    const h = await boot();
    const me = await registerUser(h.app, 'mustafa');
    const other = await registerUser(h.app, 'kemal', { displayName: 'Kemal' });

    const response = await authed(h.app, me.token)({ method: 'GET', url: `/users/${other.me.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ username: string; stats: { wins: number }; badges: string[] }>()).toMatchObject({
      username: 'kemal',
      displayName: 'Kemal',
      stats: { wins: 0, losses: 0, challengesPlayed: 0 },
      badges: [],
    });
    // Private fields stay private.
    expect(response.json<Record<string, unknown>>().inviteCode).toBeUndefined();
  });

  it('404s for unknown ids', async () => {
    const h = await boot();
    const me = await registerUser(h.app, 'mustafa');
    const response = await authed(h.app, me.token)({ method: 'GET', url: `/users/${newId()}` });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('user_not_found');
  });
});

describe('block / unblock / report', () => {
  it('hides a blocked pair from search, profiles and friend requests', async () => {
    const h = await boot();
    const blocker = await registerUser(h.app, 'mustafa');
    const blocked = await registerUser(h.app, 'kemal');
    const blockerCall = authed(h.app, blocker.token);
    const blockedCall = authed(h.app, blocked.token);

    // They are friends first — blocking must tear that down.
    const created = await blockerCall({ method: 'POST', url: '/friends/request', payload: { username: 'kemal' } });
    await blockedCall({ method: 'POST', url: `/friends/${created.json<{ friendshipId: string }>().friendshipId}/accept` });

    const blockResponse = await blockerCall({ method: 'POST', url: `/users/${blocked.me.id}/block` });
    expect(blockResponse.statusCode).toBe(200);
    expect(blockResponse.json<{ status: string }>().status).toBe('blocked');

    const row = h.db.prepare('SELECT * FROM friendships').all() as {
      requester_id: string;
      addressee_id: string;
      status: string;
    }[];
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ requester_id: blocker.me.id, addressee_id: blocked.me.id, status: 'blocked' });

    for (const call of [blockerCall, blockedCall]) {
      const search = await call({ method: 'GET', url: '/users/search?q=k' });
      expect(search.json<{ id: string }[]>().some((u) => u.id === blocked.me.id)).toBe(false);
      expect(search.json<{ id: string }[]>().some((u) => u.id === blocker.me.id)).toBe(false);
    }

    expect((await blockedCall({ method: 'GET', url: `/users/${blocker.me.id}` })).statusCode).toBe(404);
    expect((await blockerCall({ method: 'GET', url: `/users/${blocked.me.id}` })).statusCode).toBe(404);

    // Neither side is a friend any more and neither can ask again.
    expect((await blockerCall({ method: 'GET', url: '/friends' })).json<FriendsView>().friends).toHaveLength(0);
    const blockedAsks = await blockedCall({ method: 'POST', url: '/friends/request', payload: { username: 'mustafa' } });
    expect(blockedAsks.statusCode).toBe(403);
    expect(blockedAsks.json<{ error: { code: string } }>().error.code).toBe('blocked');

    // Unblocking restores visibility (but not the friendship).
    const unblocked = await blockerCall({ method: 'POST', url: `/users/${blocked.me.id}/unblock` });
    expect(unblocked.statusCode).toBe(200);
    expect(unblocked.json<{ status: string; removed: boolean }>()).toMatchObject({ status: 'none', removed: true });
    expect(h.db.prepare('SELECT * FROM friendships').all()).toHaveLength(0);
    expect((await blockedCall({ method: 'GET', url: `/users/${blocker.me.id}` })).statusCode).toBe(200);
    expect((await blockedCall({ method: 'POST', url: '/friends/request', payload: { username: 'mustafa' } })).statusCode).toBe(
      201,
    );

    // Unblocking twice is a no-op, not an error.
    const noop = await blockerCall({ method: 'POST', url: `/users/${blocked.me.id}/unblock` });
    expect(noop.json<{ removed: boolean }>().removed).toBe(false);
  });

  it('blocks over a pending request in the other direction', async () => {
    const h = await boot();
    const blocker = await registerUser(h.app, 'mustafa');
    const pest = await registerUser(h.app, 'kemal');

    await authed(h.app, pest.token)({ method: 'POST', url: '/friends/request', payload: { username: 'mustafa' } });
    await authed(h.app, blocker.token)({ method: 'POST', url: `/users/${pest.me.id}/block` });

    const rows = h.db.prepare('SELECT * FROM friendships').all() as { requester_id: string; status: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requester_id: blocker.me.id, status: 'blocked' });
    expect((await authed(h.app, blocker.token)({ method: 'GET', url: '/friends' })).json<FriendsView>().incoming).toHaveLength(0);
  });

  it('rejects blocking or reporting yourself and unknown users', async () => {
    const h = await boot();
    const me = await registerUser(h.app, 'mustafa');
    const call = authed(h.app, me.token);

    const self = await call({ method: 'POST', url: `/users/${me.me.id}/block` });
    expect(self.statusCode).toBe(400);
    expect(self.json<{ error: { code: string } }>().error.code).toBe('cannot_block_self');

    const selfUnblock = await call({ method: 'POST', url: `/users/${me.me.id}/unblock` });
    expect(selfUnblock.statusCode).toBe(400);
    expect(selfUnblock.json<{ error: { code: string } }>().error.code).toBe('cannot_block_self');

    const selfReport = await call({ method: 'POST', url: `/users/${me.me.id}/report`, payload: { reason: 'test' } });
    expect(selfReport.statusCode).toBe(400);
    expect(selfReport.json<{ error: { code: string } }>().error.code).toBe('cannot_report_self');

    const ghost = await call({ method: 'POST', url: `/users/${newId()}/block` });
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json<{ error: { code: string } }>().error.code).toBe('user_not_found');
  });

  it('stores a report', async () => {
    const h = await boot();
    const me = await registerUser(h.app, 'mustafa');
    const other = await registerUser(h.app, 'kemal');
    const call = authed(h.app, me.token);

    const response = await call({
      method: 'POST',
      url: `/users/${other.me.id}/report`,
      payload: { reason: 'Küfür ediyor.' },
    });
    expect(response.statusCode).toBe(201);

    const rows = h.db.prepare('SELECT * FROM reports').all() as { reporter_id: string; reported_id: string; reason: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reporter_id: me.me.id, reported_id: other.me.id, reason: 'Küfür ediyor.' });

    const empty = await call({ method: 'POST', url: `/users/${other.me.id}/report`, payload: { reason: '' } });
    expect(empty.statusCode).toBe(400);
    expect(empty.json<{ error: { code: string } }>().error.code).toBe('validation');
  });
});

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

describe('GET /catalog', () => {
  it('dumps the shared catalog without a token', async () => {
    const h = await boot();
    const response = await h.app.inject({ method: 'GET', url: '/catalog' });
    expect(response.statusCode).toBe(200);

    const body = response.json<{
      version: string;
      types: { key: string }[];
      taunts: { id: string; level: number }[];
      microcopy: Record<string, { level1: string }>;
      badges: { key: string }[];
    }>();

    expect(body.version).toBe(SHARED_VERSION);
    expect(body.types).toHaveLength(CHALLENGE_TYPES.length);
    expect(body.types.map((t) => t.key)).toContain('adim_yarisi');
    expect(body.taunts.length).toBeGreaterThan(0);
    expect(new Set(body.taunts.map((t) => t.level))).toEqual(new Set([1, 2, 3]));
    expect(body.microcopy.home_empty?.level1).toBeTruthy();
    expect(body.badges.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

describe('POST /uploads', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

  it('stores an image and serves it back from /uploads', async () => {
    const h = await boot();
    const me = await registerUser(h.app, 'mustafa');
    const form = multipart({ filename: 'kanit.png', contentType: 'image/png', content: PNG });

    const response = await authed(h.app, me.token)({ method: 'POST', url: '/uploads', ...form });
    expect(response.statusCode).toBe(201);

    const url = response.json<{ url: string }>().url;
    expect(url).toMatch(/^http:\/\/test\.local\/uploads\/[0-9a-f-]{36}\.png$/);

    const filename = url.split('/').pop()!;
    expect(fs.readFileSync(path.join(h.config.uploadDir, filename))).toEqual(PNG);

    const served = await h.app.inject({ method: 'GET', url: `/uploads/${filename}` });
    expect(served.statusCode).toBe(200);
    expect(served.rawPayload).toEqual(PNG);
  });

  it('takes the extension from the mimetype, not from the filename', async () => {
    const h = await boot();
    const me = await registerUser(h.app, 'mustafa');
    const form = multipart({ filename: 'kotu.php', contentType: 'image/jpeg', content: PNG });

    const response = await authed(h.app, me.token)({ method: 'POST', url: '/uploads', ...form });
    expect(response.statusCode).toBe(201);
    expect(response.json<{ url: string }>().url).toMatch(/\.jpg$/);
  });

  it('rejects non-images, missing files and anonymous callers', async () => {
    const h = await boot();
    const me = await registerUser(h.app, 'mustafa');
    const call = authed(h.app, me.token);

    const pdf = multipart({ filename: 'rapor.pdf', contentType: 'application/pdf', content: PNG });
    const rejected = await call({ method: 'POST', url: '/uploads', ...pdf });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json<{ error: { code: string } }>().error.code).toBe('invalid_file_type');

    const notMultipart = await call({ method: 'POST', url: '/uploads', payload: { file: 'nope' } });
    expect(notMultipart.statusCode).toBe(400);
    expect(notMultipart.json<{ error: { code: string } }>().error.code).toBe('invalid_multipart');

    const anonymous = await h.app.inject({ method: 'POST', url: '/uploads', ...multipart({ filename: 'a.png', contentType: 'image/png', content: PNG }) });
    expect(anonymous.statusCode).toBe(401);

    expect(fs.readdirSync(h.config.uploadDir)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Regression: the row types this module writes stay readable
// ---------------------------------------------------------------------------

describe('challenge fixture sanity', () => {
  it('inserts challenges the step sync can find', async () => {
    const h = await boot();
    const me = await registerUser(h.app, 'mustafa');
    const id = insertChallenge(h, {
      creatorId: me.me.id,
      accepted: [me.me.id],
      startsAt: '2026-01-04T00:00:00.000Z',
      endsAt: '2026-01-10T00:00:00.000Z',
    });
    const row = h.db.prepare('SELECT * FROM challenges WHERE id = ?').get(id) as ChallengeRow;
    expect(row.metric_type).toBe('auto_steps');
    expect(row.status).toBe('active');
  });
});
