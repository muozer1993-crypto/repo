/**
 * Social routes: auth, /me, users, friends, catalog and uploads.
 *
 * Everything runs against an in-memory database with the injected clock from
 * `makeApp()`, so day keys and notification timestamps are deterministic.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Expo } from 'expo-server-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHALLENGE_TYPES,
  SHARED_VERSION,
  type ChallengeDetail,
  type ChallengeResults,
  type FriendsView,
  type Me,
  type Notification,
} from '@koydum/shared';
import { loadConfig } from '../src/config.js';
import { newId, nowIso, type ChallengeRow, type EntryRow, type UserRow } from '../src/db/index.js';
import { REPORTS_PER_USER } from '../src/routes/users.js';
import { clearDeletedTraces } from '../src/services/accounts.js';
import { createPushSender } from '../src/services/push.js';
import {
  DEFAULT_PASSWORD,
  GPS_MARKER,
  JPEG_1X1,
  JPEG_WITH_GPS,
  authed,
  makeApp,
  multipart,
  registerUser,
  type TestApp,
} from './helpers.js';

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

  it('folds Turkish letters into the stored username instead of refusing them', async () => {
    const h = await boot();
    const response = await h.app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { username: 'Şeyma', password: 'sifre123', displayName: 'Şeyma' },
    });
    expect(response.statusCode).toBe(201);
    const me = response.json<{ me: Me }>().me;
    expect(me.username).toBe('seyma');
    // the name people see keeps its letters
    expect(me.displayName).toBe('Şeyma');

    const again = await h.app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { username: 'seyma', password: 'baskasifre', displayName: 'Başkası' },
    });
    expect(again.statusCode).toBe(409);
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

  it('opens only so many accounts an hour from one client, an IPv6 /64 being one', async () => {
    expect(loadConfig({ dataDir: ':memory:' }).registrationsPerHourPerClient).toBe(20);
    harness = await makeApp({ config: { registrationsPerHourPerClient: 3 } });
    const h = harness;
    const register = (username: string, remoteAddress: string, password = 'sifre123') =>
      h.app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { username, password, displayName: 'BOB HIRSIZ', timezone: 'Europe/Istanbul' },
        remoteAddress,
      });

    // a taken name and a typo cost no scrypt and open no account: friends on one
    // Wi-Fi retrying those must not spend the budget they share
    expect((await register('alinmis', '198.51.100.20')).statusCode).toBe(201);
    expect((await register('alinmis', '2001:db8:1:2::99')).statusCode).toBe(409);
    expect((await register('kisa', '2001:db8:1:2::99', '123')).statusCode).toBe(400);

    // a fresh address of the same /64 for every account used to be a fresh budget
    for (let i = 1; i <= 3; i += 1) expect((await register(`cop${i}`, `2001:db8:1:2::${i}`)).statusCode).toBe(201);
    const fourth = await register('cop4', '2001:db8:1:2:ffff::4');
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json<{ error: { code: string; message: string } }>().error).toEqual({
      code: 'too_many_attempts',
      message: 'Çok fazla hesap açtın. 60 dakika sonra tekrar dene.',
    });

    // somebody on another network is not held up by it, and an hour later it opens again
    expect((await register('kemal', '2001:db8:1:3::1')).statusCode).toBe(201);
    h.advance(61 * 60 * 1000);
    expect((await register('cop4', '2001:db8:1:2::4')).statusCode).toBe(201);
  });
});

describe('POST /auth/register at the same moment', () => {
  it('opens the name once and tells the others it is taken, without spending their sign-ups', async () => {
    harness = await makeApp({ config: { registrationsPerHourPerClient: 2 } });
    const h = harness;
    const register = (username: string, remoteAddress: string) =>
      h.app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { username, password: 'sifre123', displayName: 'Yarış', timezone: 'Europe/Istanbul' },
        remoteAddress,
      });

    const addresses = Array.from({ length: 6 }, (_, i) => `198.51.100.${40 + i}`);
    const answers = await Promise.all(addresses.map((address) => register('yaris', address)));
    const codes = answers.map((answer) => answer.statusCode).sort();
    expect(codes).toEqual([201, 409, 409, 409, 409, 409]);
    for (const answer of answers.filter((a) => a.statusCode === 409)) {
      expect(answer.json<{ error: { code: string; message: string } }>().error).toEqual({
        code: 'username_taken',
        message: 'Bu kullanıcı adı kapılmış. Başka bir tane dene.',
      });
    }
    // a "kapılmış" costs nothing: every address still has both of its sign-ups
    const loser = addresses[answers.findIndex((answer) => answer.statusCode === 409)]!;
    expect((await register('yaris2', loser)).statusCode).toBe(201);
    expect((await register('yaris3', loser)).statusCode).toBe(201);
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

  it('finds a Turkish-spelled username however the keyboard capitalised it', async () => {
    const h = await boot();
    await registerUser(h.app, 'Şeyma', { password: 'cokgizli' });
    await registerUser(h.app, 'İsmail', { password: 'cokgizli' });
    const login = (username: string) =>
      h.app.inject({ method: 'POST', url: '/auth/login', payload: { username, password: 'cokgizli' } });

    for (const username of ['ŞEYMA', 'şeyma', 'seyma']) {
      const response = await login(username);
      expect(response.statusCode).toBe(200);
      expect(response.json<{ me: Me }>().me.username).toBe('seyma');
    }
    // 'İsmail'.toLowerCase() is i + U+0307 + 'smail': what the 1.0 app sends
    for (const username of ['İsmail', 'İsmail'.toLowerCase(), 'ISMAIL']) {
      const response = await login(username);
      expect(response.statusCode).toBe(200);
      expect(response.json<{ me: Me }>().me.username).toBe('ismail');
    }
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

  it("keeps the new phone's push token when the old phone logs out", async () => {
    const h = await boot();
    const user = await registerUser(h.app, 'mustafa');
    const login = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'mustafa', password: DEFAULT_PASSWORD },
    });
    const oldPhone = authed(h.app, user.token);
    const newPhone = authed(h.app, login.json<{ token: string }>().token);

    const register = (call: typeof oldPhone, token: string) =>
      call({ method: 'POST', url: '/me/push-token', payload: { token, platform: 'android' } });
    expect((await register(oldPhone, 'ExponentPushToken[old]')).statusCode).toBe(200);
    expect((await register(newPhone, 'ExponentPushToken[new]')).statusCode).toBe(200);

    // "Çıkış yap" on the old phone before it is given away
    const logout = await oldPhone({ method: 'DELETE', url: '/me/push-token', payload: { token: 'ExponentPushToken[old]' } });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ ok: true, hasPushToken: true });
    expect((await newPhone({ method: 'GET', url: '/me' })).json<Me>().hasPushToken).toBe(true);

    // and the next laf still rings on the new one
    const laf = newId();
    h.db
      .prepare(
        "INSERT INTO notifications (id, user_id, type, title, body, data, read_at, created_at, pushed_at, push_error) VALUES (?, ?, 'taunt', 'Laf', 'Koydum', '{}', NULL, ?, NULL, NULL)",
      )
      .run(laf, user.me.id, nowIso(h.app.now()));
    const send = vi
      .spyOn(Expo.prototype, 'sendPushNotificationsAsync')
      .mockImplementation(async (messages) => messages.map(() => ({ status: 'ok' as const, id: 'ticket' })));
    try {
      await expect(createPushSender(h.config).flush(h.db, h.app.now())).resolves.toEqual({ sent: 1, failed: 0 });
      expect(send.mock.calls.flatMap(([messages]) => messages.map((message) => message.to))).toEqual([
        'ExponentPushToken[new]',
      ]);
    } finally {
      send.mockRestore();
    }

    // the new phone's own logout clears it
    const own = await newPhone({ method: 'DELETE', url: '/me/push-token', payload: { token: 'ExponentPushToken[new]' } });
    expect(own.json()).toEqual({ ok: true, hasPushToken: false });
    expect(userRow(h, user.me.id).push_platform).toBeNull();
  });

  it('leaves the push token to a phone that never registered one, and to an older app clears it', async () => {
    const h = await boot();
    const user = await registerUser(h.app, 'mustafa', { pushToken: 'ExponentPushToken[telefon]' });
    const call = authed(h.app, user.token);

    // the web app, or a phone whose notification permission was refused
    const web = await call({ method: 'DELETE', url: '/me/push-token', payload: { token: null } });
    expect(web.json()).toEqual({ ok: true, hasPushToken: true });
    expect(userRow(h, user.me.id).push_token).toBe('ExponentPushToken[telefon]');

    const broken = await call({ method: 'DELETE', url: '/me/push-token', payload: { token: 42 } });
    expect(broken.statusCode).toBe(400);
    expect(userRow(h, user.me.id).push_token).toBe('ExponentPushToken[telefon]');

    // an app from before the field sends no body at all
    const older = await call({ method: 'DELETE', url: '/me/push-token' });
    expect(older.json()).toEqual({ ok: true, hasPushToken: false });
    expect(userRow(h, user.me.id).push_token).toBeNull();

    // and one that sets the JSON header with nothing after it reads the same
    await call({ method: 'POST', url: '/me/push-token', payload: { token: 'ExponentPushToken[telefon]', platform: 'android' } });
    const empty = await call({
      method: 'DELETE',
      url: '/me/push-token',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    expect(empty.json()).toEqual({ ok: true, hasPushToken: false });
  });

  it("gives a phone's push token to the last account that signed in on it", async () => {
    const h = await boot();
    const ali = await registerUser(h.app, 'ali');
    const veli = await registerUser(h.app, 'veli');
    const payload = { token: 'ExponentPushToken[abc]', platform: 'android' };

    // ali's logout never reached the server, then veli signed in on the same phone
    expect((await authed(h.app, ali.token)({ method: 'POST', url: '/me/push-token', payload })).statusCode).toBe(200);
    expect((await authed(h.app, veli.token)({ method: 'POST', url: '/me/push-token', payload })).statusCode).toBe(200);

    expect(userRow(h, veli.me.id).push_token).toBe('ExponentPushToken[abc]');
    expect(userRow(h, ali.me.id).push_token).toBeNull();
    expect(userRow(h, ali.me.id).push_platform).toBeNull();
    expect((await authed(h.app, ali.token)({ method: 'GET', url: '/me' })).json<Me>().hasPushToken).toBe(false);

    // ali's invite no longer rings on veli's phone (nothing is picked, so no network)
    const forAli = newId();
    h.db
      .prepare(
        "INSERT INTO notifications (id, user_id, type, title, body, data, read_at, created_at, pushed_at, push_error) VALUES (?, ?, 'poke', 'Dürt', 'Kalk', '{}', NULL, ?, NULL, NULL)",
      )
      .run(forAli, ali.me.id, nowIso(h.app.now()));
    await expect(createPushSender(h.config).flush(h.db, h.app.now())).resolves.toEqual({ sent: 0, failed: 0 });
    const row = h.db.prepare('SELECT pushed_at, push_error FROM notifications WHERE id = ?').get(forAli);
    expect(row).toEqual({ pushed_at: null, push_error: null });
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

  /** A proof photo stored the way the app stores one, and the URL the upload answered. */
  async function uploadPhoto(h: TestApp, token: string): Promise<{ url: string; file: string }> {
    const form = multipart({ filename: 'kanit.jpg', contentType: 'image/jpeg', content: JPEG_1X1 });
    const response = await authed(h.app, token)({ method: 'POST', url: '/uploads', ...form });
    expect(response.statusCode).toBe(201);
    const url = response.json<{ url: string }>().url;
    return { url, file: path.join(h.config.uploadDir, url.split('/').pop()!) };
  }

  function insertEntry(
    h: TestApp,
    challengeId: string,
    userId: string,
    fields: { dayKey: string; value: number; note?: string; proofUrl?: string },
  ): string {
    const id = newId();
    const at = nowIso(h.now());
    h.db
      .prepare(
        `INSERT INTO entries (id, challenge_id, user_id, day_key, value, source, note, proof_url, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, 'ok', ?, ?)`,
      )
      .run(id, challengeId, userId, fields.dayKey, fields.value, fields.note ?? null, fields.proofUrl ?? null, at, at);
    return id;
  }

  function entryRow(h: TestApp, id: string): EntryRow {
    return h.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as EntryRow;
  }

  it('deletes the proof photos and notes of a finished çelınc and keeps the scores', async () => {
    const h = await boot();
    const user = await registerUser(h.app, 'mustafa');
    const rival = await registerUser(h.app, 'kemal');
    const finished = insertChallenge(h, {
      creatorId: rival.me.id,
      accepted: [rival.me.id, user.me.id],
      startsAt: '2025-12-01T00:00:00.000Z',
      endsAt: '2025-12-08T00:00:00.000Z',
      status: 'finished',
    });
    const photo = await uploadPhoto(h, user.token);
    // the oldest apps stored the address with the server in front
    const legacy = await uploadPhoto(h, user.token);
    const rivalPhoto = await uploadPhoto(h, rival.token);
    const withPhoto = insertEntry(h, finished, user.me.id, { dayKey: '2025-12-02', value: 12_000, note: 'Sahilden eve yürüdüm', proofUrl: photo.url });
    const withLegacy = insertEntry(h, finished, user.me.id, {
      dayKey: '2025-12-03',
      value: 9_000,
      proofUrl: `http://localhost:4000${legacy.url}`,
    });
    // a photo that is already gone from the disk does not stop the deletion
    const gone = insertEntry(h, finished, user.me.id, { dayKey: '2025-12-04', value: 7_000, proofUrl: `/uploads/${newId()}.jpg` });
    const rivalEntry = insertEntry(h, finished, rival.me.id, { dayKey: '2025-12-02', value: 8_000, note: 'Kemal yürüdü', proofUrl: rivalPhoto.url });

    const rivalCall = authed(h.app, rival.token);
    const standings = async () =>
      (await rivalCall({ method: 'GET', url: `/challenges/${finished}/results` }))
        .json<ChallengeResults>()
        .standings.map((p) => [p.user.id, p.score, p.rank]);
    const before = await standings();
    expect(before).toEqual([
      [user.me.id, 28_000, 1],
      [rival.me.id, 8_000, 2],
    ]);

    expect((await authed(h.app, user.token)({ method: 'DELETE', url: '/me' })).statusCode).toBe(200);

    for (const id of [withPhoto, withLegacy, gone]) {
      expect(entryRow(h, id)).toMatchObject({ note: null, proof_url: null, status: 'ok' });
    }
    expect(entryRow(h, withPhoto).value).toBe(12_000);
    expect(fs.existsSync(photo.file)).toBe(false);
    expect(fs.existsSync(legacy.file)).toBe(false);
    expect((await h.app.inject({ method: 'GET', url: photo.url })).statusCode).toBe(404);

    // Kemal's own photo and note are his, and the result reads the same
    expect(fs.existsSync(rivalPhoto.file)).toBe(true);
    expect(entryRow(h, rivalEntry)).toMatchObject({ note: 'Kemal yürüdü', proof_url: rivalPhoto.url });
    expect(await standings()).toEqual(before);
    const feed = (await rivalCall({ method: 'GET', url: `/challenges/${finished}` })).json<ChallengeDetail>().feed;
    expect(feed.find((item) => item.id === withPhoto)).toMatchObject({ displayName: 'Silinen kanka', value: 12_000, proofUrl: null });
  });

  it('keeps a photo file that somebody else’s entry still shows', async () => {
    const h = await boot();
    const user = await registerUser(h.app, 'mustafa');
    const rival = await registerUser(h.app, 'kemal');
    const finished = insertChallenge(h, {
      creatorId: rival.me.id,
      accepted: [rival.me.id, user.me.id],
      startsAt: '2025-12-01T00:00:00.000Z',
      endsAt: '2025-12-08T00:00:00.000Z',
      status: 'finished',
    });
    const photo = await uploadPhoto(h, user.token);
    const mine = insertEntry(h, finished, user.me.id, { dayKey: '2025-12-02', value: 12_000, proofUrl: photo.url });
    // the API takes any address as a proof, so the same URL can sit in Kemal's entry
    const his = insertEntry(h, finished, rival.me.id, { dayKey: '2025-12-02', value: 8_000, proofUrl: photo.url });

    expect((await authed(h.app, user.token)({ method: 'DELETE', url: '/me' })).statusCode).toBe(200);

    expect(entryRow(h, mine).proof_url).toBeNull();
    expect(entryRow(h, his).proof_url).toBe(photo.url);
    expect(fs.existsSync(photo.file)).toBe(true);
    expect((await h.app.inject({ method: 'GET', url: photo.url })).statusCode).toBe(200);
  });

  it('keeps the proof in a çelınc that is over but still being decided', async () => {
    const h = await boot();
    const user = await registerUser(h.app, 'mustafa');
    const rival = await registerUser(h.app, 'kemal');
    // ended half an hour ago: the phones' hour and any itiraz still run, with him in it
    const settling = insertChallenge(h, {
      creatorId: rival.me.id,
      accepted: [rival.me.id, user.me.id],
      startsAt: '2026-01-01T00:00:00.000Z',
      endsAt: '2026-01-05T08:30:00.000Z',
      status: 'active',
    });
    const finished = insertChallenge(h, {
      creatorId: rival.me.id,
      accepted: [rival.me.id, user.me.id],
      startsAt: '2025-12-01T00:00:00.000Z',
      endsAt: '2025-12-08T00:00:00.000Z',
      status: 'finished',
    });
    const photo = await uploadPhoto(h, user.token);
    const kept = insertEntry(h, settling, user.me.id, { dayKey: '2026-01-04', value: 12_000, note: 'Kanıt burada', proofUrl: photo.url });
    // the same photo in a finished one goes from that entry, but the file stays for the one above
    const cleared = insertEntry(h, finished, user.me.id, { dayKey: '2025-12-02', value: 12_000, proofUrl: photo.url });

    expect((await authed(h.app, user.token)({ method: 'DELETE', url: '/me' })).statusCode).toBe(200);

    const status = h.db
      .prepare('SELECT status FROM challenge_participants WHERE challenge_id = ? AND user_id = ?')
      .get(settling, user.me.id) as { status: string };
    expect(status.status).toBe('accepted');
    expect(entryRow(h, kept)).toMatchObject({ note: 'Kanıt burada', proof_url: photo.url });
    expect(entryRow(h, cleared).proof_url).toBeNull();
    expect(fs.existsSync(photo.file)).toBe(true);
  });

  it('takes that proof too once the çelınc is decided', async () => {
    const h = await boot();
    const user = await registerUser(h.app, 'mustafa');
    const rival = await registerUser(h.app, 'kemal');
    const settling = insertChallenge(h, {
      creatorId: rival.me.id,
      accepted: [rival.me.id, user.me.id],
      startsAt: '2026-01-01T00:00:00.000Z',
      endsAt: '2026-01-05T08:30:00.000Z',
      status: 'active',
    });
    const photo = await uploadPhoto(h, user.token);
    const kept = insertEntry(h, settling, user.me.id, { dayKey: '2026-01-04', value: 12_000, note: 'Kanıt burada', proofUrl: photo.url });
    const rivalPhoto = await uploadPhoto(h, rival.token);
    const his = insertEntry(h, settling, rival.me.id, { dayKey: '2026-01-04', value: 9_000, note: 'Kemal yürüdü', proofUrl: rivalPhoto.url });
    expect((await authed(h.app, user.token)({ method: 'DELETE', url: '/me' })).statusCode).toBe(200);

    // still being decided: the scheduler's pass leaves it
    expect(clearDeletedTraces(h.db, h.config.uploadDir)).toBe(0);
    expect(entryRow(h, kept).proof_url).toBe(photo.url);

    h.db.prepare("UPDATE challenges SET status = 'finished' WHERE id = ?").run(settling);
    expect(clearDeletedTraces(h.db, h.config.uploadDir)).toBe(1);
    expect(entryRow(h, kept)).toMatchObject({ note: null, proof_url: null, value: 12_000 });
    expect(fs.existsSync(photo.file)).toBe(false);
    // Kemal's stays his
    expect(entryRow(h, his)).toMatchObject({ note: 'Kemal yürüdü', proof_url: rivalPhoto.url });
    expect(fs.existsSync(rivalPhoto.file)).toBe(true);
    // and there is nothing left to do on the next pass
    expect(clearDeletedTraces(h.db, h.config.uploadDir)).toBe(0);
  });

  it('takes the notes and photos of an account deleted before deleting took them', async () => {
    const h = await boot();
    const user = await registerUser(h.app, 'mustafa');
    const rival = await registerUser(h.app, 'kemal');
    const finished = insertChallenge(h, {
      creatorId: rival.me.id,
      accepted: [rival.me.id, user.me.id],
      startsAt: '2025-12-01T00:00:00.000Z',
      endsAt: '2025-12-08T00:00:00.000Z',
      status: 'finished',
    });
    const photo = await uploadPhoto(h, user.token);
    const old = insertEntry(h, finished, user.me.id, { dayKey: '2025-12-02', value: 12_000, note: 'Sahilden eve yürüdüm', proofUrl: photo.url });
    // deleted in October by the server of the time, which left both behind
    h.db
      .prepare("UPDATE users SET username = 'deleted_0ld', display_name = 'Silinen kanka', password_hash = '', deleted_at = ? WHERE id = ?")
      .run('2025-12-10T00:00:00.000Z', user.me.id);

    expect(clearDeletedTraces(h.db, h.config.uploadDir)).toBe(1);
    expect(entryRow(h, old)).toMatchObject({ note: null, proof_url: null, value: 12_000 });
    expect(fs.existsSync(photo.file)).toBe(false);
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

  it('makes a new account that came by invite code a friend at once', async () => {
    const h = await boot();
    const asker = await registerUser(h.app, 'mustafa');
    const target = await registerUser(h.app, 'kemal');

    const response = await authed(h.app, asker.token)({
      method: 'POST',
      url: '/friends/request',
      payload: { inviteCode: target.me.inviteCode.toLowerCase() },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ status: string; friendshipId: string; user: { id: string } }>();
    expect(body.status).toBe('accepted');
    expect(body.user.id).toBe(target.me.id);

    for (const [who, other] of [
      [asker, target],
      [target, asker],
    ] as const) {
      const view = (await authed(h.app, who.token)({ method: 'GET', url: '/friends' })).json<FriendsView>();
      expect(view.friends.map((u) => u.id)).toEqual([other.me.id]);
      expect(view.incoming).toHaveLength(0);
      expect(view.outgoing).toHaveLength(0);
    }

    // the inviter hears that somebody joined, not that somebody is waiting
    const inbox = (await authed(h.app, target.token)({ method: 'GET', url: '/me/inbox' })).json<Notification[]>();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      type: 'friend_accepted',
      title: '🔥 Yeni kanka',
      data: { userId: asker.me.id, friendshipId: body.friendshipId, via: 'invite' },
    });
    expect(inbox[0]?.body).toContain('mustafa davetinle geldi');
  });

  it('still only sends a request by invite code from an account older than a week', async () => {
    const h = await boot();
    const asker = await registerUser(h.app, 'mustafa');
    const target = await registerUser(h.app, 'kemal');
    const call = authed(h.app, asker.token);
    h.advance(8 * 24 * 60 * 60 * 1000);

    const response = await call({ method: 'POST', url: '/friends/request', payload: { inviteCode: target.me.inviteCode } });
    expect(response.statusCode).toBe(201);
    expect(response.json<{ status: string }>().status).toBe('pending');
    const view = (await authed(h.app, target.token)({ method: 'GET', url: '/friends' })).json<FriendsView>();
    expect(view.friends).toHaveLength(0);
    expect(view.incoming.map((r) => r.user.id)).toEqual([asker.me.id]);

    // and asking again by code is the ordinary "already asked"
    const again = await call({ method: 'POST', url: '/friends/request', payload: { inviteCode: target.me.inviteCode } });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ error: { code: string } }>().error.code).toBe('already_requested');
  });

  it('turns my own waiting request into the friendship when I come by the invite code', async () => {
    const h = await boot();
    const asker = await registerUser(h.app, 'mustafa');
    const target = await registerUser(h.app, 'kemal', { vulgarityMax: 1 });
    const call = authed(h.app, asker.token);
    const unreadRequests = () =>
      h.db
        .prepare("SELECT * FROM notifications WHERE user_id = ? AND type = 'friend_request' AND read_at IS NULL")
        .all(target.me.id);

    const asked = await call({ method: 'POST', url: '/friends/request', payload: { username: 'kemal' } });
    expect(asked.statusCode).toBe(201);
    expect(unreadRequests()).toHaveLength(1);

    const joined = await call({ method: 'POST', url: '/friends/request', payload: { inviteCode: target.me.inviteCode } });
    expect(joined.statusCode).toBe(200);
    expect(joined.json()).toMatchObject({
      status: 'accepted',
      friendshipId: asked.json<{ friendshipId: string }>().friendshipId,
    });
    const rows = h.db.prepare('SELECT status FROM friendships').all() as { status: string }[];
    expect(rows).toEqual([{ status: 'accepted' }]);
    // no "Kabul" left to tap on a request that is a friendship already
    expect(unreadRequests()).toHaveLength(0);
    const inbox = (await authed(h.app, target.token)({ method: 'GET', url: '/me/inbox' })).json<Notification[]>();
    expect(inbox.map((n) => n.type)).toEqual(['friend_accepted']);
    expect(inbox[0]).toMatchObject({ title: 'Davetin kabul gördü', data: { via: 'invite' } });
  });

  it('counts wrong invite codes, and once over the budget a right one waits too', async () => {
    const h = await boot();
    const asker = await registerUser(h.app, 'mustafa');
    const target = await registerUser(h.app, 'kemal');
    await registerUser(h.app, 'zeynep');
    const call = authed(h.app, asker.token);

    // a 0 or 1 is never in a real code, so none of these can hit by luck
    for (let i = 0; i < 20; i += 1) {
      const miss = await call({ method: 'POST', url: '/friends/request', payload: { inviteCode: `ZZZ0${10 + i}` } });
      expect(miss.statusCode).toBe(404);
    }
    const blocked = await call({ method: 'POST', url: '/friends/request', payload: { inviteCode: target.me.inviteCode } });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json<{ error: { code: string; message: string } }>().error).toMatchObject({ code: 'too_many_requests' });
    expect(blocked.json<{ error: { message: string } }>().error.message).toContain('Çok fazla yanlış kod denedin');
    expect(h.db.prepare('SELECT * FROM friendships').all()).toHaveLength(0);

    // a request by username is not a guess, and somebody else is not held up
    expect((await call({ method: 'POST', url: '/friends/request', payload: { username: 'zeynep' } })).statusCode).toBe(201);
    const other = await registerUser(h.app, 'ali');
    const fine = await authed(h.app, other.token)({
      method: 'POST',
      url: '/friends/request',
      payload: { inviteCode: target.me.inviteCode },
    });
    expect(fine.statusCode).toBe(200);

    h.advance(60 * 60 * 1000);
    const later = await call({ method: 'POST', url: '/friends/request', payload: { inviteCode: target.me.inviteCode } });
    expect(later.statusCode).toBe(200);
    expect(later.json<{ status: string }>().status).toBe('accepted');
  });

  it('never lets an invite code past a block, either way', async () => {
    const h = await boot();
    const asker = await registerUser(h.app, 'mustafa');
    const target = await registerUser(h.app, 'kemal');
    const call = authed(h.app, asker.token);
    const codeOf = (id: string) => userRow(h, id).invite_code;

    await authed(h.app, target.token)({ method: 'POST', url: `/users/${asker.me.id}/block` });
    // the block retired the code in the link; even the new one meets the block
    const old = await call({ method: 'POST', url: '/friends/request', payload: { inviteCode: target.me.inviteCode } });
    expect(old.statusCode).toBe(404);
    const theirs = await call({ method: 'POST', url: '/friends/request', payload: { inviteCode: codeOf(target.me.id) } });
    expect(theirs.statusCode).toBe(403);
    expect(theirs.json<{ error: { code: string } }>().error.code).toBe('blocked');

    await authed(h.app, target.token)({ method: 'POST', url: `/users/${asker.me.id}/unblock` });
    await call({ method: 'POST', url: `/users/${target.me.id}/block` });
    const mine = await call({ method: 'POST', url: '/friends/request', payload: { inviteCode: codeOf(target.me.id) } });
    expect(mine.statusCode).toBe(403);
    expect(mine.json<{ error: { code: string } }>().error.code).toBe('blocked');

    const rows = h.db.prepare('SELECT status FROM friendships').all() as { status: string }[];
    expect(rows).toEqual([{ status: 'blocked' }]);
    expect(
      h.db.prepare("SELECT * FROM notifications WHERE user_id = ? AND type = 'friend_accepted'").all(target.me.id),
    ).toHaveLength(0);
  });

  it('gives the blocker a new invite code, so a fresh account cannot walk past the block with the old link', async () => {
    const h = await boot();
    const kemal = await registerUser(h.app, 'kemal');
    const stalker = await registerUser(h.app, 'stalker');
    const link = kemal.me.inviteCode;
    await authed(h.app, stalker.token)({ method: 'POST', url: '/friends/request', payload: { inviteCode: link } });
    h.advance(30 * 24 * 60 * 60 * 1000);

    expect((await authed(h.app, kemal.token)({ method: 'POST', url: `/users/${stalker.me.id}/block` })).statusCode).toBe(200);
    const renewed = (await authed(h.app, kemal.token)({ method: 'GET', url: '/me' })).json<Me>().inviteCode;
    expect(renewed).not.toBe(link);

    // a new account with the link he kept finds nobody
    const second = await registerUser(h.app, 'stalker2', { displayName: 'Ayşe' });
    const again = await authed(h.app, second.token)({ method: 'POST', url: '/friends/request', payload: { inviteCode: link } });
    expect(again.statusCode).toBe(404);
    expect((await authed(h.app, second.token)({ method: 'GET', url: `/invites/${link}` })).statusCode).toBe(404);
    const view = (await authed(h.app, kemal.token)({ method: 'GET', url: '/friends' })).json<FriendsView>();
    expect(view.friends).toHaveLength(0);
    expect(
      h.db.prepare("SELECT * FROM notifications WHERE user_id = ? AND type = 'friend_accepted' AND created_at > ?").all(
        kemal.me.id,
        nowIso(new Date(h.now().getTime() - 60_000)),
      ),
    ).toHaveLength(0);

    // the new link works for whoever kemal shares it with
    const friend = await registerUser(h.app, 'zeynep');
    const joined = await authed(h.app, friend.token)({ method: 'POST', url: '/friends/request', payload: { inviteCode: renewed } });
    expect(joined.json<{ status: string }>().status).toBe('accepted');
  });

  it('does not let the invite code of a new account undo a removal', async () => {
    const h = await boot();
    const kemal = await registerUser(h.app, 'kemal');
    const pushy = await registerUser(h.app, 'pushy');
    const call = authed(h.app, pushy.token);
    const code = { inviteCode: kemal.me.inviteCode };
    expect((await call({ method: 'POST', url: '/friends/request', payload: code })).json<{ status: string }>().status).toBe('accepted');

    h.advance(24 * 60 * 60 * 1000);
    expect((await authed(h.app, kemal.token)({ method: 'DELETE', url: `/friends/${pushy.me.id}` })).statusCode).toBe(200);
    h.advance(24 * 60 * 60 * 1000);

    // still under a week old, still holding the link: it only asks now
    const again = await call({ method: 'POST', url: '/friends/request', payload: code });
    expect(again.statusCode).toBe(201);
    expect(again.json<{ status: string }>().status).toBe('pending');
    const view = (await authed(h.app, kemal.token)({ method: 'GET', url: '/friends' })).json<FriendsView>();
    expect(view.friends).toHaveLength(0);
    expect(view.incoming.map((r) => r.user.id)).toEqual([pushy.me.id]);

    // kemal's own yes ends his no: the code counts as his yes again later
    expect(
      (await authed(h.app, kemal.token)({ method: 'POST', url: `/friends/${view.incoming[0]!.id}/accept` })).statusCode,
    ).toBe(200);
    expect(h.db.prepare('SELECT * FROM friend_refusals').all()).toHaveLength(0);
  });

  it('does not let the invite code of a new account turn a "Reddet" into a friendship', async () => {
    const h = await boot();
    const kemal = await registerUser(h.app, 'kemal');
    const asker = await registerUser(h.app, 'burak');
    const call = authed(h.app, asker.token);
    const first = await call({ method: 'POST', url: '/friends/request', payload: { username: 'kemal' } });
    const declined = await authed(h.app, kemal.token)({
      method: 'POST',
      url: `/friends/${first.json<{ friendshipId: string }>().friendshipId}/decline`,
    });
    expect(declined.statusCode).toBe(200);

    h.advance(60_000);
    const byCode = await call({ method: 'POST', url: '/friends/request', payload: { inviteCode: kemal.me.inviteCode } });
    expect(byCode.statusCode).toBe(201);
    expect(byCode.json<{ status: string }>().status).toBe('pending');
    expect((h.db.prepare('SELECT status FROM friendships').all() as { status: string }[]).map((r) => r.status)).toEqual([
      'pending',
    ]);

    // once kemal asks burak himself, his no is over
    await call({ method: 'DELETE', url: `/friends/${kemal.me.id}?only=request` });
    await authed(h.app, kemal.token)({ method: 'POST', url: '/friends/request', payload: { username: 'burak' } });
    expect(h.db.prepare('SELECT * FROM friend_refusals').all()).toHaveLength(0);
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

  // A request is mostly answered on Kankalar or a profile, not from Gelen: its
  // row went on lighting the badge for a request that was no longer there.
  it('reads the request in Gelen once it is answered, however it was answered', async () => {
    const h = await boot();
    const kemal = await registerUser(h.app, 'kemal');
    const kemalCall = authed(h.app, kemal.token);
    const mustafa = await registerUser(h.app, 'mustafa');
    const ayse = await registerUser(h.app, 'ayse');
    const deniz = await registerUser(h.app, 'deniz');
    const ece = await registerUser(h.app, 'ecem');
    const ask = async (from: typeof kemal) =>
      (
        await authed(h.app, from.token)({ method: 'POST', url: '/friends/request', payload: { username: 'kemal' } })
      ).json<{ friendshipId: string }>().friendshipId;
    const unread = async () =>
      (await kemalCall({ method: 'GET', url: '/me/inbox/unread' })).json<{ count: number }>().count;
    const requestRow = (friendshipId: string) =>
      h.db
        .prepare(
          "SELECT read_at FROM notifications WHERE user_id = ? AND type = 'friend_request' AND json_extract(data, '$.friendshipId') = ?",
        )
        .get(kemal.me.id, friendshipId) as { read_at: string | null };

    // nobody answers Ece's: it stays unread throughout
    const fromEce = await ask(ece);

    const fromMustafa = await ask(mustafa);
    expect(await unread()).toBe(2);
    h.advance(60_000);
    expect((await kemalCall({ method: 'POST', url: `/friends/${fromMustafa}/accept` })).statusCode).toBe(200);
    expect(requestRow(fromMustafa).read_at).toBe(nowIso(h.now()));
    expect(await unread()).toBe(1);

    const fromAyse = await ask(ayse);
    expect(await unread()).toBe(2);
    expect((await kemalCall({ method: 'POST', url: `/friends/${fromAyse}/decline` })).statusCode).toBe(200);
    expect(requestRow(fromAyse).read_at).not.toBeNull();
    expect(await unread()).toBe(1);

    // both asked: Kemal's own "ekle" is his answer to Deniz's request
    const fromDeniz = await ask(deniz);
    const crossed = await kemalCall({ method: 'POST', url: '/friends/request', payload: { username: 'deniz' } });
    expect(crossed.json<{ status: string }>().status).toBe('accepted');
    expect(requestRow(fromDeniz).read_at).not.toBeNull();
    expect(await unread()).toBe(1);

    expect(requestRow(fromEce).read_at).toBeNull();
    // answered rows stay in Gelen as history
    const inbox = (await kemalCall({ method: 'GET', url: '/me/inbox' })).json<Notification[]>();
    expect(inbox.filter((n) => n.type === 'friend_request')).toHaveLength(4);
    // and the requesters' own news is theirs to read
    const mustafaUnread = await authed(h.app, mustafa.token)({ method: 'GET', url: '/me/inbox/unread' });
    expect(mustafaUnread.json<{ count: number }>().count).toBe(1);
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

  it('points a new kanka at a running çelınc that could still take them', async () => {
    const h = await boot();
    const asker = await registerUser(h.app, 'mustafa', { displayName: 'Mustafa' });
    const target = await registerUser(h.app, 'kemal', { displayName: 'Kemal' });
    const ali = await registerUser(h.app, 'ali');
    const veli = await registerUser(h.app, 'veli');
    const hour = 60 * 60 * 1000;
    const startsAt = nowIso(new Date(h.now().getTime() - 24 * hour));
    // the group çelınc Kemal plays in, and Mustafa's own one with Veli
    const kemals = insertChallenge(h, {
      creatorId: ali.me.id,
      accepted: [ali.me.id, target.me.id],
      startsAt,
      endsAt: nowIso(new Date(h.now().getTime() + 3 * 24 * hour)),
      title: 'Ofis adım ligi',
    });
    const mustafas = insertChallenge(h, {
      creatorId: veli.me.id,
      accepted: [veli.me.id, asker.me.id],
      startsAt,
      endsAt: nowIso(new Date(h.now().getTime() + 2 * 24 * hour)),
      title: 'Kahve kimden',
    });

    const asked = await authed(h.app, asker.token)({ method: 'POST', url: '/friends/request', payload: { username: 'kemal' } });
    const friendshipId = asked.json<{ friendshipId: string }>().friendshipId;
    const accepted = await authed(h.app, target.token)({ method: 'POST', url: `/friends/${friendshipId}/accept` });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json<{ invitable: unknown[] }>().invitable).toEqual([
      { id: kemals, title: 'Ofis adım ligi', endsAt: nowIso(new Date(h.now().getTime() + 3 * 24 * hour)) },
    ]);

    // the tap opens Mustafa's çelınc, and the copy calls Kemal into it instead of a new one
    const [news] = (await authed(h.app, asker.token)({ method: 'GET', url: '/me/inbox' })).json<Notification[]>();
    expect(news).toMatchObject({ type: 'friend_accepted', data: { userId: target.me.id, friendshipId, challengeId: mustafas } });
    expect(news?.body).toBe('Kemal kanka isteğini kabul etti. “Kahve kimden” çelıncına çağır, grubu bölme.');

    // the one who came through the code is offered to the code's owner the same way
    const newcomer = await registerUser(h.app, 'cem', { displayName: 'Cem' });
    h.db.prepare('UPDATE users SET vulgarity_max = 1 WHERE id = ?').run(target.me.id);
    const joined = await authed(h.app, newcomer.token)({
      method: 'POST',
      url: '/friends/request',
      payload: { inviteCode: target.me.inviteCode },
    });
    expect(joined.json<{ status: string }>().status).toBe('accepted');
    const [welcome] = (await authed(h.app, target.token)({ method: 'GET', url: '/me/inbox' })).json<Notification[]>();
    expect(welcome).toMatchObject({ type: 'friend_accepted', data: { via: 'invite', challengeId: kemals } });
    expect(welcome?.body).toBe('Cem davetinle katıldı, artık arkadaşsınız. “Ofis adım ligi” çelıncına davet edebilirsin.');
  });

  it('says "Aç bir çelınc" when no çelınc could take the new kanka', async () => {
    const h = await boot();
    const asker = await registerUser(h.app, 'mustafa');
    const target = await registerUser(h.app, 'kemal', { displayName: 'Kemal' });
    const ali = await registerUser(h.app, 'ali');
    const veli = await registerUser(h.app, 'veli');
    const hour = 60 * 60 * 1000;
    const at = (offsetHours: number) => nowIso(new Date(h.now().getTime() + offsetHours * hour));
    // Kemal's ends in 30 minutes: nobody new may accept any more
    insertChallenge(h, { creatorId: ali.me.id, accepted: [ali.me.id, target.me.id], startsAt: at(-48), endsAt: at(0.5) });
    // Mustafa's: Kemal is invited already, and in the other one Veli blocked Kemal
    insertChallenge(h, { creatorId: ali.me.id, accepted: [ali.me.id, asker.me.id], invited: [target.me.id], startsAt: at(-24), endsAt: at(48) });
    insertChallenge(h, { creatorId: veli.me.id, accepted: [veli.me.id, asker.me.id], startsAt: at(-24), endsAt: at(48) });
    await authed(h.app, veli.token)({ method: 'POST', url: `/users/${target.me.id}/block` });
    // and a finished one is not running at all
    insertChallenge(h, { creatorId: ali.me.id, accepted: [ali.me.id, asker.me.id], startsAt: at(-72), endsAt: at(24), status: 'finished' });

    const asked = await authed(h.app, asker.token)({ method: 'POST', url: '/friends/request', payload: { username: 'kemal' } });
    const friendshipId = asked.json<{ friendshipId: string }>().friendshipId;
    const accepted = await authed(h.app, target.token)({ method: 'POST', url: `/friends/${friendshipId}/accept` });
    expect(accepted.json<{ invitable: unknown[] }>().invitable).toEqual([]);

    const [news] = (await authed(h.app, asker.token)({ method: 'GET', url: '/me/inbox' })).json<Notification[]>();
    expect(news?.type).toBe('friend_accepted');
    expect(news?.data).toEqual({ userId: target.me.id, friendshipId });
    expect(news?.body).toBe('Kemal kanka isteğini kabul etti. Aç bir çelınc, koy bakalım.');
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

  it('lets the requester take back a request nobody answered', async () => {
    const h = await boot();
    const asker = await registerUser(h.app, 'mustafa');
    const target = await registerUser(h.app, 'mehmet');
    const call = authed(h.app, asker.token);
    const targetCall = authed(h.app, target.token);
    const unreadRequests = () =>
      h.db
        .prepare("SELECT * FROM notifications WHERE user_id = ? AND type = 'friend_request' AND read_at IS NULL")
        .all(target.me.id);

    await call({ method: 'POST', url: '/friends/request', payload: { username: 'mehmet' } });
    expect(unreadRequests()).toHaveLength(1);

    const withdrawn = await call({ method: 'DELETE', url: `/friends/${target.me.id}` });
    expect(withdrawn.statusCode).toBe(200);
    expect(withdrawn.json()).toEqual({ status: 'withdrawn', userId: target.me.id });
    expect(h.db.prepare('SELECT * FROM friendships').all()).toHaveLength(0);
    expect(unreadRequests()).toHaveLength(0);
    expect((await targetCall({ method: 'GET', url: '/friends' })).json<FriendsView>().incoming).toHaveLength(0);
    expect((await call({ method: 'GET', url: '/friends' })).json<FriendsView>().outgoing).toHaveLength(0);

    // Asking again works, and a request the addressee already read stays in their inbox.
    const again = await call({ method: 'POST', url: '/friends/request', payload: { username: 'mehmet' } });
    expect(again.statusCode).toBe(201);
    await targetCall({ method: 'POST', url: '/me/inbox/read', payload: { all: true } });
    await call({ method: 'DELETE', url: `/friends/${target.me.id}` });
    expect(h.db.prepare('SELECT * FROM friendships').all()).toHaveLength(0);
    const inbox = (await targetCall({ method: 'GET', url: '/me/inbox' })).json<Notification[]>();
    expect(inbox.map((n) => n.type)).toEqual(['friend_request']);
  });

  it('does not let request → withdraw → request buzz somebody all day', async () => {
    const h = await boot();
    const asker = await registerUser(h.app, 'mustafa');
    const target = await registerUser(h.app, 'kurban');
    await registerUser(h.app, 'kemal');
    const call = authed(h.app, asker.token);
    const requests = () =>
      h.db.prepare("SELECT * FROM notifications WHERE user_id = ? AND type = 'friend_request'").all(target.me.id);

    for (let round = 0; round < 3; round += 1) {
      expect((await call({ method: 'POST', url: '/friends/request', payload: { username: 'kurban' } })).statusCode).toBe(201);
      await authed(h.app, target.token)({ method: 'POST', url: '/me/inbox/read', payload: { all: true } });
      expect((await call({ method: 'DELETE', url: `/friends/${target.me.id}` })).statusCode).toBe(200);
    }
    const fourth = await call({ method: 'POST', url: '/friends/request', payload: { username: 'kurban' } });
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json<{ error: { code: string; message: string } }>().error).toMatchObject({ code: 'too_many_requests' });
    expect(fourth.json<{ error: { message: string } }>().error.message).toContain('Bu kişiye çok sık istek gönderdin');
    expect(requests()).toHaveLength(3);

    // somebody else is not held up by it, and a day later it may ask again
    expect((await call({ method: 'POST', url: '/friends/request', payload: { username: 'kemal' } })).statusCode).toBe(201);
    h.advance(24 * 60 * 60 * 1000);
    expect((await call({ method: 'POST', url: '/friends/request', payload: { username: 'kurban' } })).statusCode).toBe(201);
  });

  it('lets one account ask at most 15 people by username an hour', async () => {
    const h = await boot();
    const troll = await registerUser(h.app, 'trol');
    const call = authed(h.app, troll.token);
    const ask = (username: string) => call({ method: 'POST', url: '/friends/request', payload: { username } });
    for (let i = 1; i <= 16; i += 1) await registerUser(h.app, `kurban${i}`);
    const asker = await registerUser(h.app, 'ahmet');
    const inviter = await registerUser(h.app, 'davetci');

    for (let i = 1; i <= 15; i += 1) expect((await ask(`kurban${i}`)).statusCode).toBe(201);
    const sixteenth = await ask('kurban16');
    expect(sixteenth.statusCode).toBe(429);
    expect(sixteenth.json<{ error: { code: string; message: string } }>().error).toEqual({
      code: 'too_many_requests',
      message: 'Çok fazla kanka isteği gönderdin. 60 dakika sonra tekrar dene.',
    });
    // nothing reached the sixteenth phone
    const pushed = h.db
      .prepare("SELECT count(*) AS n FROM notifications WHERE type = 'friend_request'")
      .get() as { n: number };
    expect(pushed.n).toBe(15);

    // saying yes to somebody who asked first is not a new request
    await authed(h.app, asker.token)({ method: 'POST', url: '/friends/request', payload: { username: 'trol' } });
    const answered = await ask('ahmet');
    expect(answered.statusCode).toBe(200);
    expect(answered.json<{ status: string }>().status).toBe('accepted');
    // nor is coming by somebody's own invite code
    const byCode = await call({ method: 'POST', url: '/friends/request', payload: { inviteCode: inviter.me.inviteCode } });
    expect(byCode.statusCode).toBe(200);
    expect(byCode.json<{ status: string }>().status).toBe('accepted');

    h.advance(61 * 60 * 1000);
    expect((await ask('kurban16')).statusCode).toBe(201);
  });

  it('does not let the addressee delete an incoming request, only decline it', async () => {
    const h = await boot();
    const asker = await registerUser(h.app, 'mustafa');
    const target = await registerUser(h.app, 'kemal');

    await authed(h.app, asker.token)({ method: 'POST', url: '/friends/request', payload: { username: 'kemal' } });
    const response = await authed(h.app, target.token)({ method: 'DELETE', url: `/friends/${asker.me.id}` });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('friendship_not_found');

    const rows = h.db.prepare('SELECT * FROM friendships').all() as { status: string }[];
    expect(rows.map((row) => row.status)).toEqual(['pending']);
    expect(
      h.db.prepare("SELECT * FROM notifications WHERE user_id = ? AND type = 'friend_request'").all(target.me.id),
    ).toHaveLength(1);
  });

  it('never ends a friendship through "Geri çek", even one accepted while the confirm was open', async () => {
    const h = await boot();
    const asker = await registerUser(h.app, 'mustafa');
    const target = await registerUser(h.app, 'mehmet');
    const stranger = await registerUser(h.app, 'kemal');
    const call = authed(h.app, asker.token);
    const friendIds = async () =>
      (await call({ method: 'GET', url: '/friends' })).json<FriendsView>().friends.map((u) => u.id);

    // an unanswered request still goes
    await call({ method: 'POST', url: '/friends/request', payload: { username: 'mehmet' } });
    const withdrawn = await call({ method: 'DELETE', url: `/friends/${target.me.id}?only=request` });
    expect(withdrawn.statusCode).toBe(200);
    expect(withdrawn.json()).toEqual({ status: 'withdrawn', userId: target.me.id });

    // asked again, and Mehmet says yes before the tap on "Geri çek" lands
    const sent = await call({ method: 'POST', url: '/friends/request', payload: { username: 'mehmet' } });
    const friendshipId = sent.json<{ friendshipId: string }>().friendshipId;
    await authed(h.app, target.token)({ method: 'POST', url: `/friends/${friendshipId}/accept` });
    const late = await call({ method: 'DELETE', url: `/friends/${target.me.id}?only=request` });
    expect(late.statusCode).toBe(409);
    expect(late.json<{ error: { code: string } }>().error.code).toBe('already_friends');
    expect(await friendIds()).toEqual([target.me.id]);

    // nothing to take back from somebody never asked
    const none = await call({ method: 'DELETE', url: `/friends/${stranger.me.id}?only=request` });
    expect(none.statusCode).toBe(404);
    expect(none.json<{ error: { code: string } }>().error.code).toBe('friendship_not_found');

    // "Arkadaşlıktan çıkar" is the plain DELETE, and it still ends it
    expect((await call({ method: 'DELETE', url: `/friends/${target.me.id}` })).json()).toEqual({
      status: 'removed',
      userId: target.me.id,
    });
    expect(await friendIds()).toEqual([]);
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

    // usernames are stored folded; the Turkish spelling of one still finds it
    await registerUser(h.app, 'cagri', { displayName: 'Cagri K.' });
    const folded = await call({ method: 'GET', url: `/users/search?q=${encodeURIComponent('Çağ')}` });
    expect(folded.json<{ username: string }[]>().map((u) => u.username)).toEqual(['cagri']);
    const spaced = await call({ method: 'GET', url: `/users/search?q=${encodeURIComponent('ca gri')}` });
    expect(spaced.json<{ username: string }[]>().map((u) => u.username)).toEqual(['cagri']);

    const byDisplayName = await call({ method: 'GET', url: '/users/search?q=Kem' });
    expect(byDisplayName.json<{ username: string }[]>().map((u) => u.username)).toEqual(['kemal']);

    const nothing = await call({ method: 'GET', url: '/users/search?q=zzz' });
    expect(nothing.json<unknown[]>()).toHaveLength(0);

    const invalid = await call({ method: 'GET', url: '/users/search?q=' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ error: { code: string } }>().error.code).toBe('validation');
  });

  it('finds a friend past thousands of accounts whose names sort before hers', async () => {
    const h = await boot();
    const me = await registerUser(h.app, 'mustafa');
    // written straight to the table: 2,100 sign-ups would take minutes of scrypt
    const insert = h.db.prepare(
      `INSERT INTO users (id, username, display_name, password_hash, invite_code, created_at)
       VALUES (?, ?, ?, 'x', ?, ?)`,
    );
    const at = nowIso(h.now());
    h.db.transaction(() => {
      for (let i = 0; i < 2_100; i += 1) {
        const n = String(i).padStart(5, '0');
        insert.run(newId(), `aa${n}`, `BOB HIRSIZ ${i}`, `J${n}`, at);
      }
    })();
    await registerUser(h.app, 'seyma', { displayName: 'Şeyma' });
    const call = authed(h.app, me.token);
    const usernames = async (q: string): Promise<string[]> =>
      (await call({ method: 'GET', url: `/users/search?q=${encodeURIComponent(q)}` }))
        .json<{ username: string }[]>()
        .map((u) => u.username);

    // a Turkish letter leaves SQL's LIKE nothing to narrow by, so every account is a candidate
    expect(await usernames('Şey')).toEqual(['seyma']);
    expect(await usernames('şeyma')).toEqual(['seyma']);
    expect(await usernames('seyma')).toEqual(['seyma']);
    // and the flood itself still comes back 20 at a time
    expect(await usernames('bob')).toEqual(Array.from({ length: 20 }, (_, i) => `aa${String(i).padStart(5, '0')}`));
    expect(await usernames('BOB HIRSIZ 2099')).toEqual(['aa02099']);
  });

  it('puts the username itself first, however many display names also match', async () => {
    const h = await boot();
    const me = await registerUser(h.app, 'mustafa');
    await registerUser(h.app, 'seyma', { displayName: 'Şeyma Yılmaz' });
    await registerUser(h.app, 'seymanur', { displayName: 'Nur' });
    // look-alikes: their usernames sort before hers, their display names match her name
    for (let i = 1; i <= 25; i += 1) {
      await registerUser(h.app, `a${String(i).padStart(2, '0')}`, { displayName: 'Seyma' });
    }
    const call = authed(h.app, me.token);
    const usernames = async (q: string): Promise<string[]> =>
      (await call({ method: 'GET', url: `/users/search?q=${encodeURIComponent(q)}` }))
        .json<{ username: string }[]>()
        .map((u) => u.username);

    for (const q of ['seyma', 'Seyma', 'SEYMA']) {
      const hits = await usernames(q);
      expect(hits, q).toHaveLength(20);
      // the exact username, then the usernames that start with it, then display names
      expect(hits.slice(0, 3), q).toEqual(['seyma', 'seymanur', 'a01']);
    }
    // the look-alikes' plain S does not match a Ş: only the folded usernames do
    expect(await usernames('Şeyma')).toEqual(['seyma', 'seymanur']);
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

  it('lists the blocks I placed, newest first, and never the ones placed on me', async () => {
    const h = await boot();
    const me = await registerUser(h.app, 'mustafa');
    const first = await registerUser(h.app, 'kemal');
    const second = await registerUser(h.app, 'zeynep');
    const hater = await registerUser(h.app, 'hasan');
    const call = authed(h.app, me.token);
    const blockedOf = async (token: string) =>
      (await authed(h.app, token)({ method: 'GET', url: '/users/blocked' })).json<{ username: string }[]>().map(
        (u) => u.username,
      );

    const empty = await call({ method: 'GET', url: '/users/blocked' });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual([]);

    await call({ method: 'POST', url: `/users/${first.me.id}/block` });
    h.advance(60_000);
    await call({ method: 'POST', url: `/users/${second.me.id}/block` });
    await authed(h.app, hater.token)({ method: 'POST', url: `/users/${me.me.id}/block` });

    expect(await blockedOf(me.token)).toEqual(['zeynep', 'kemal']);
    expect(await blockedOf(first.token)).toEqual([]);
    expect(await blockedOf(hater.token)).toEqual(['mustafa']);

    // A block back is the other side's own row: each list still shows only its owner's.
    await authed(h.app, first.token)({ method: 'POST', url: `/users/${me.me.id}/block` });
    expect(await blockedOf(first.token)).toEqual(['mustafa']);
    expect(await blockedOf(me.token)).toEqual(['zeynep', 'kemal']);

    // A deleted account drops off the list.
    await authed(h.app, second.token)({ method: 'DELETE', url: '/me' });
    expect(await blockedOf(me.token)).toEqual(['kemal']);
  });

  it('empties the list on unblock, and search and the profile work again', async () => {
    const h = await boot();
    const me = await registerUser(h.app, 'mustafa');
    const other = await registerUser(h.app, 'kemal');
    const call = authed(h.app, me.token);

    await call({ method: 'POST', url: `/users/${other.me.id}/block` });
    expect((await call({ method: 'GET', url: '/users/blocked' })).json<{ id: string }[]>().map((u) => u.id)).toEqual([
      other.me.id,
    ]);
    expect((await call({ method: 'GET', url: '/users/search?q=kem' })).json<unknown[]>()).toHaveLength(0);

    await call({ method: 'POST', url: `/users/${other.me.id}/unblock` });

    expect((await call({ method: 'GET', url: '/users/blocked' })).json<unknown[]>()).toEqual([]);
    expect((await call({ method: 'GET', url: '/users/search?q=kem' })).json<{ id: string }[]>().map((u) => u.id)).toEqual([
      other.me.id,
    ]);
    expect((await call({ method: 'GET', url: `/users/${other.me.id}` })).statusCode).toBe(200);
    expect((await authed(h.app, other.token)({ method: 'GET', url: `/users/${me.me.id}` })).statusCode).toBe(200);
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

  it('stores a reason without the escape sequences and line breaks that wiped the owner\'s console', async () => {
    const h = await boot();
    const me = await registerUser(h.app, 'mustafa');
    const other = await registerUser(h.app, 'kemal');

    const response = await authed(h.app, me.token)({
      method: 'POST',
      url: `/users/${other.me.id}/report`,
      payload: { reason: 'spam\u001b[8m\nkötü\u001b[2J' },
    });
    expect(response.statusCode).toBe(201);
    expect(h.db.prepare('SELECT reason FROM reports').all()).toEqual([{ reason: 'spam kötü' }]);
  });

  it('takes ten reports an hour from one account, and stores one per person and reason a day', async () => {
    const h = await boot();
    const me = await registerUser(h.app, 'mustafa');
    const call = authed(h.app, me.token);
    const others = [];
    for (let i = 0; i < REPORTS_PER_USER.max + 1; i++) others.push(await registerUser(h.app, `kisi${i}`));
    const report = (id: string, reason = 'Küfür ediyor.') =>
      call({ method: 'POST', url: `/users/${id}/report`, payload: { reason } });
    const stored = () => (h.db.prepare('SELECT COUNT(*) AS n FROM reports').get() as { n: number }).n;

    // the same report again within the day (a double tap, a retry): "alındı" on the phone, nothing new for the owner
    expect((await report(others[0]!.me.id)).statusCode).toBe(201);
    expect((await report(others[0]!.me.id)).statusCode).toBe(201);
    expect(stored()).toBe(1);
    // a new reason is news: the owner reads it
    expect((await report(others[0]!.me.id, 'Şimdi de tehdit etti.')).statusCode).toBe(201);
    expect(h.db.prepare('SELECT reason FROM reports ORDER BY created_at').all()).toEqual([
      { reason: 'Küfür ediyor.' },
      { reason: 'Şimdi de tehdit etti.' },
    ]);

    // two of the hour's ten went to that person
    for (const other of others.slice(1, REPORTS_PER_USER.max - 1)) expect((await report(other.me.id)).statusCode).toBe(201);
    expect(stored()).toBe(REPORTS_PER_USER.max);

    const over = await report(others[REPORTS_PER_USER.max]!.me.id);
    expect(over.statusCode).toBe(429);
    expect(over.json<{ error: { code: string; message: string } }>().error).toEqual({
      code: 'too_many_requests',
      message: 'Çok fazla şikayet gönderdin. 60 dakika sonra tekrar dene.',
    });
    expect(stored()).toBe(REPORTS_PER_USER.max);

    // a day on, the same report can be filed again, and the hour's budget is back
    h.advance(25 * 60 * 60 * 1000);
    expect((await report(others[0]!.me.id)).statusCode).toBe(201);
    expect((await report(others[REPORTS_PER_USER.max]!.me.id)).statusCode).toBe(201);
    expect(stored()).toBe(REPORTS_PER_USER.max + 2);
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
    // relative: each phone resolves it against the address it uses for the server
    expect(url).toMatch(/^\/uploads\/[0-9a-f-]{36}\.png$/);

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

  it('stores a camera shot without the EXIF that says where it was taken', async () => {
    const h = await boot();
    const me = await registerUser(h.app, 'mustafa');
    const form = multipart({ filename: 'kanit.jpg', contentType: 'image/jpeg', content: JPEG_WITH_GPS });

    const response = await authed(h.app, me.token)({ method: 'POST', url: '/uploads', ...form });
    expect(response.statusCode).toBe(201);

    const served = await h.app.inject({ method: 'GET', url: response.json<{ url: string }>().url });
    expect(served.statusCode).toBe(200);
    expect(served.rawPayload.subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(served.rawPayload.includes('Exif')).toBe(false);
    expect(served.rawPayload.includes(GPS_MARKER)).toBe(false);
  });

  it('drops the text chunks of a PNG and keeps the picture', async () => {
    const h = await boot();
    const me = await registerUser(h.app, 'mustafa');
    // signature, IHDR, a tEXt chunk, IEND: the walker copies or drops whole chunks, CRCs untouched
    const chunk = (type: string, data: Buffer): Buffer => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(data.length);
      return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
    };
    const signature = Buffer.from('89504e470d0a1a0a', 'hex');
    const ihdr = chunk('IHDR', Buffer.from('00000001000000010802000000', 'hex'));
    const iend = chunk('IEND', Buffer.alloc(0));
    const withText = Buffer.concat([signature, ihdr, chunk('tEXt', Buffer.from(`Comment\0${GPS_MARKER}`, 'latin1')), iend]);
    const form = multipart({ filename: 'kanit.png', contentType: 'image/png', content: withText });

    const response = await authed(h.app, me.token)({ method: 'POST', url: '/uploads', ...form });
    expect(response.statusCode).toBe(201);
    const filename = response.json<{ url: string }>().url.split('/').pop()!;
    expect(fs.readFileSync(path.join(h.config.uploadDir, filename))).toEqual(Buffer.concat([signature, ihdr, iend]));
  });

  it('refuses text that calls itself a photo, and a JPEG broken before its picture', async () => {
    const h = await boot();
    const me = await registerUser(h.app, 'mustafa');
    const call = authed(h.app, me.token);

    const text = multipart({ filename: 'kanit.png', contentType: 'image/png', content: Buffer.from('<html>koydum</html>') });
    const fake = await call({ method: 'POST', url: '/uploads', ...text });
    expect(fake.statusCode).toBe(400);
    expect(fake.json<{ error: { code: string } }>().error.code).toBe('invalid_file_type');

    // the APP1's length runs past the end of the file
    const cut = multipart({ filename: 'kanit.jpg', contentType: 'image/jpeg', content: JPEG_WITH_GPS.subarray(0, 12) });
    const broken = await call({ method: 'POST', url: '/uploads', ...cut });
    expect(broken.statusCode).toBe(400);
    expect(broken.json<{ error: { code: string; message: string } }>().error).toEqual({
      code: 'invalid_file_type',
      message: 'Bu fotoğraf bozuk görünüyor, başka bir tane seç.',
    });

    expect(fs.readdirSync(h.config.uploadDir)).toHaveLength(0);
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
