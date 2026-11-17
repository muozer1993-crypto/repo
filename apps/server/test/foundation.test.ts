/**
 * Foundation tests: the pieces every route module builds on.
 */
import { createHmac } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { DEFAULT_TTL_SECONDS, bearerToken, signToken, verifyToken } from '../src/auth/jwt.js';
import { migrate, newInviteCode, openDb } from '../src/db/index.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { loadConfig } from '../src/config.js';
import { listInbox, markRead, notify, unreadCount } from '../src/services/notifications.js';
import { readLastBeat, writeLastBeat } from '../src/services/pauses.js';
import { computeUserStats, getBadges } from '../src/services/stats.js';
import { conflict } from '../src/errors.js';
import { TEST_SECRET, authed, befriend, makeApp, registerUser, type TestApp } from './helpers.js';

let harness: TestApp | null = null;

afterEach(async () => {
  if (harness) {
    await harness.close();
    harness = null;
  }
});

describe('config', () => {
  it('builds without touching the filesystem for an in-memory data dir', () => {
    const config = loadConfig({ dataDir: ':memory:', port: 4321 });
    expect(config.dbPath).toBe(':memory:');
    expect(config.jwtSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(config.publicUrl).toBe('http://localhost:4321');
  });

  it('lets overrides win over the environment', () => {
    const config = loadConfig({ dataDir: ':memory:', publicUrl: 'https://koydum.example.com/', logLevel: 'silent' });
    expect(config.publicUrl).toBe('https://koydum.example.com');
    expect(config.logLevel).toBe('silent');
  });
});

describe('password hashing', () => {
  it('hashes and verifies', async () => {
    const stored = await hashPassword('sifre123');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(stored.split('$')).toHaveLength(3);
    expect(await verifyPassword('sifre123', stored)).toBe(true);
    expect(await verifyPassword('sifre124', stored)).toBe(false);
  });

  it('uses a fresh salt every time', async () => {
    const a = await hashPassword('aynisifre');
    const b = await hashPassword('aynisifre');
    expect(a).not.toBe(b);
    expect(await verifyPassword('aynisifre', a)).toBe(true);
    expect(await verifyPassword('aynisifre', b)).toBe(true);
  });

  it('never throws on malformed stored values', async () => {
    for (const stored of ['', 'nope', 'scrypt$zz', 'bcrypt$aa$bb', 'scrypt$$']) {
      expect(await verifyPassword('sifre123', stored)).toBe(false);
    }
  });
});

describe('jwt', () => {
  const secret = 'cok-gizli';

  it('signs and verifies', () => {
    const token = signToken({ sub: 'user-1' }, secret);
    expect(token.split('.')).toHaveLength(3);
    expect(verifyToken(token, secret)).toEqual({ sub: 'user-1', ver: 0 });
  });

  it('carries the token version, and reads a token from before versions as version 0', () => {
    expect(verifyToken(signToken({ sub: 'user-1', ver: 3 }, secret), secret)).toEqual({ sub: 'user-1', ver: 3 });

    // signed the way every token was before `ver` existed: { sub, iat, exp }
    const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ sub: 'user-1', iat: 1, exp: 9999999999 })).toString('base64url');
    const signature = createHmac('sha256', secret).update(`${head}.${claims}`).digest('base64url');
    expect(verifyToken(`${head}.${claims}.${signature}`, secret)).toEqual({ sub: 'user-1', ver: 0 });
  });

  it('rejects a wrong secret and a tampered payload', () => {
    const token = signToken({ sub: 'user-1' }, secret);
    expect(verifyToken(token, 'baska-secret')).toBeNull();

    const [head, , signature] = token.split('.') as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ sub: 'admin', exp: 9999999999 })).toString('base64url');
    expect(verifyToken(`${head}.${forged}.${signature}`, secret)).toBeNull();
  });

  it('rejects an expired token and accepts one inside its ttl', () => {
    const issuedAt = new Date('2026-01-01T00:00:00.000Z');
    const token = signToken({ sub: 'user-1' }, secret, 60, issuedAt);
    expect(verifyToken(token, secret, new Date('2026-01-01T00:00:30.000Z'))).toEqual({ sub: 'user-1', ver: 0 });
    expect(verifyToken(token, secret, new Date('2026-01-01T00:01:01.000Z'))).toBeNull();

    const long = signToken({ sub: 'user-1' }, secret, DEFAULT_TTL_SECONDS, issuedAt);
    expect(verifyToken(long, secret, new Date('2026-03-01T00:00:00.000Z'))).toEqual({ sub: 'user-1', ver: 0 });
  });

  it('rejects garbage and reads bearer headers', () => {
    expect(verifyToken('a.b', secret)).toBeNull();
    expect(verifyToken('a.b.c', secret)).toBeNull();
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer abc')).toBe('abc');
    expect(bearerToken('abc')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

describe('migrations', () => {
  it('applies every migration once and is idempotent', () => {
    const db = openDb(':memory:');
    const applied = (db.prepare('SELECT id FROM _migrations ORDER BY id').all() as { id: string }[]).map((r) => r.id);
    expect(applied).toEqual(MIGRATIONS.map((m) => m.id));

    expect(migrate(db)).toEqual([]);
    expect(migrate(db)).toEqual([]);

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (r) => r.name,
    );
    for (const table of [
      'users',
      'friendships',
      'challenges',
      'challenge_participants',
      'entries',
      'steps_daily',
      'disputes',
      'taunts',
      'pokes',
      'notifications',
      'badges',
      'reports',
      'reminders_sent',
    ]) {
      expect(tables).toContain(table);
    }

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('seeds the last beat a server from before 014 never wrote', () => {
    // the database an owner on an older version has: at 013, never a beat
    const db = new BetterSqlite3(':memory:');
    db.exec('CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const migration of MIGRATIONS.slice(0, 13)) {
      db.exec(migration.sql);
      db.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)').run(migration.id, '2026-11-01T10:00:00.000Z');
    }
    db.prepare(
      `INSERT INTO users (id, username, display_name, password_hash, invite_code, created_at, last_seen_at)
       VALUES ('u1', 'ali', 'Ali', 'x', 'K7QF2M', '2026-11-01T10:00:00.000Z', '2026-11-16T20:19:00.000Z')`,
    ).run();

    db.prepare(
      `INSERT INTO challenges (id, creator_id, type_key, metric_type, direction, unit, title, starts_at, ends_at, created_at)
       VALUES ('c1', 'u1', 'erken_kus', 'checkin_deadline', 'higher', 'gün', 'Erken Kuş',
               '2026-11-15T21:00:00.000Z', '2026-11-22T20:59:59.999Z', '2026-11-14T10:00:00.000Z')`,
    ).run();

    expect(migrate(db)).toEqual([
      '014_server_pauses',
      '015_participant_invited_by',
      '016_friend_refusals',
      '017_seed_last_beat',
      '018_read_answered_requests',
      '019_window_rule',
    ]);
    // the first start of the new version writes the pause from here
    expect(readLastBeat(db)?.toISOString()).toBe('2026-11-16T20:19:00.000Z');
    // a çelınc made before 019 keeps the old trim of a friend abroad's days; one made after gets the new one
    db.prepare(
      `INSERT INTO challenges (id, creator_id, type_key, metric_type, direction, unit, title, starts_at, ends_at, created_at)
       SELECT 'c2', creator_id, type_key, metric_type, direction, unit, title, starts_at, ends_at, created_at
         FROM challenges WHERE id = 'c1'`,
    ).run();
    expect(db.prepare('SELECT id, window_rule FROM challenges ORDER BY id').all()).toEqual([
      { id: 'c1', window_rule: 0 },
      { id: 'c2', window_rule: 1 },
    ]);

    // one at 016 that already beats keeps its own beat, even behind a later request
    writeLastBeat(db, new Date('2026-11-16T21:00:00.000Z'));
    db.prepare("UPDATE users SET last_seen_at = '2026-11-16T22:00:00.000Z'").run();
    db.prepare("DELETE FROM _migrations WHERE id = '017_seed_last_beat'").run();
    expect(migrate(db)).toEqual(['017_seed_last_beat']);
    expect(readLastBeat(db)?.toISOString()).toBe('2026-11-16T21:00:00.000Z');
    db.close();

    // a new database (every test's) has nobody yet, so no beat either
    const fresh = openDb(':memory:');
    expect(readLastBeat(fresh)).toBeNull();
    fresh.close();
  });

  // Answering now reads the row (`markAnsweredRead`); the badge friends already
  // carry counted every request and invite they had answered before that.
  it('reads the requests and invites answered before answering read them', async () => {
    harness = await makeApp();
    const h = harness;
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
    const accepted = await ask(mustafa);
    const declined = await ask(ayse);
    const waiting = await ask(deniz);
    expect((await kemalCall({ method: 'POST', url: `/friends/${accepted}/accept` })).statusCode).toBe(200);
    expect((await kemalCall({ method: 'POST', url: `/friends/${declined}/decline` })).statusCode).toBe(200);

    befriend(h.app, ece.me.id, kemal.me.id);
    const invite = async (title: string) =>
      (
        await authed(h.app, ece.token)({
          method: 'POST',
          url: '/challenges',
          payload: {
            typeKey: 'adim_yarisi',
            title,
            startsAt: h.now().toISOString(),
            endsAt: new Date(h.now().getTime() + 3 * 86_400_000).toISOString(),
            participantIds: [kemal.me.id],
          },
        })
      ).json<{ id: string }>().id;
    const yes = await invite('Bir');
    const no = await invite('İki');
    const open = await invite('Üç');
    expect((await kemalCall({ method: 'POST', url: `/challenges/${yes}/accept` })).statusCode).toBe(200);
    expect((await kemalCall({ method: 'POST', url: `/challenges/${no}/decline` })).statusCode).toBe(200);

    // the database as the version before left it: every answer unread, beside
    // a poke nobody has looked at and a row whose data cannot be read
    h.db.prepare('UPDATE notifications SET read_at = NULL').run();
    h.db
      .prepare(
        `INSERT INTO notifications (id, user_id, type, title, body, data, created_at)
         VALUES ('poke-1', ?, 'poke', 'Dürtüldün', 'Kalk lan', '{"challengeId":"${yes}"}', ?),
                ('broken-1', ?, 'friend_request', 'İstek', 'Eski', 'bozuk', ?)`,
      )
      .run(kemal.me.id, h.now().toISOString(), kemal.me.id, h.now().toISOString());
    h.db.prepare("DELETE FROM _migrations WHERE id = '018_read_answered_requests'").run();
    expect(migrate(h.db)).toEqual(['018_read_answered_requests']);

    const readAt = (id: string) =>
      (h.db.prepare('SELECT read_at FROM notifications WHERE id = ?').get(id) as { read_at: string | null }).read_at;
    expect(readAt('broken-1')).toBeNull();
    expect(readAt('poke-1')).toBeNull();
    h.db.prepare("DELETE FROM notifications WHERE id = 'broken-1'").run();

    const isRead = (type: string, key: string, id: string) =>
      (
        h.db
          .prepare(`SELECT read_at FROM notifications WHERE user_id = ? AND type = ? AND json_extract(data, '$.${key}') = ?`)
          .get(kemal.me.id, type, id) as { read_at: string | null }
      ).read_at !== null;
    expect([accepted, declined, waiting].map((id) => isRead('friend_request', 'friendshipId', id))).toEqual([true, true, false]);
    expect([yes, no, open].map((id) => isRead('challenge_invite', 'challengeId', id))).toEqual([true, true, false]);
    // only answers: the news they brought ("Kanka oldunuz", "başladı") is still to be read
    const readOthers = h.db
      .prepare("SELECT id FROM notifications WHERE type NOT IN ('friend_request', 'challenge_invite') AND read_at IS NOT NULL")
      .all();
    expect(readOthers).toEqual([]);
    expect(unreadCount(h.db, mustafa.me.id).count).toBe(1);
  });

  it('generates readable invite codes', () => {
    const code = newInviteCode();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  });
});

describe('notifications', () => {
  it('inserts, counts, lists and marks read', async () => {
    harness = await makeApp();
    const { db, app } = harness;
    const user = await registerUser(app, 'ali');
    const other = await registerUser(app, 'veli');

    expect(unreadCount(db, user.me.id)).toEqual({ count: 0, latestId: null });

    const first = notify(db, {
      userId: user.me.id,
      type: 'poke',
      title: 'Dürt',
      body: 'Kalk lan',
      data: { challengeId: 'c1' },
      createdAt: '2026-01-05T09:00:00.000Z',
    });
    const second = notify(db, {
      userId: user.me.id,
      type: 'taunt',
      title: 'KOYDUM MU?',
      body: 'Yedin',
      createdAt: '2026-01-05T10:00:00.000Z',
    });
    notify(db, { userId: other.me.id, type: 'reminder', title: 'Hatırlatma', body: 'Bugün ne yaptın?' });

    const unread = unreadCount(db, user.me.id);
    expect(unread.count).toBe(2);
    expect(unread.latestId).toBe(second.id);

    const inbox = listInbox(db, user.me.id, { limit: 10 });
    expect(inbox.map((n) => n.id)).toEqual([second.id, first.id]);
    expect(JSON.parse(inbox[1]!.data)).toEqual({ challengeId: 'c1' });

    const paged = listInbox(db, user.me.id, { before: '2026-01-05T10:00:00.000Z' });
    expect(paged.map((n) => n.id)).toEqual([first.id]);

    expect(markRead(db, user.me.id, [first.id])).toBe(1);
    expect(markRead(db, user.me.id, [first.id])).toBe(0);
    expect(unreadCount(db, user.me.id).count).toBe(1);

    expect(markRead(db, user.me.id, { all: true })).toBe(1);
    expect(unreadCount(db, user.me.id).count).toBe(0);

    // the other user's inbox is untouched
    expect(unreadCount(db, other.me.id).count).toBe(1);
  });
});

describe('stats', () => {
  it('is all zeroes for a brand new user', async () => {
    harness = await makeApp();
    const { db, app } = harness;
    const user = await registerUser(app, 'yeni');

    const stats = computeUserStats(db, user.me.id, app.now());
    expect(stats).toEqual({
      wins: 0,
      losses: 0,
      ties: 0,
      tauntsSent: 0,
      tauntsReceived: 0,
      stepsSingleDayMax: 0,
      focusTotalMinutes: 0,
      checkinsStreakMax: 0,
      disputesWon: 0,
      challengesPlayed: 0,
      pokesSent: 0,
      revengeWins: 0,
      stepsToday: 0,
    });
    expect(getBadges(db, user.me.id)).toEqual([]);
    expect(user.me.badges).toEqual([]);
    expect(user.me.hasPushToken).toBe(false);
    expect(user.me.inviteCode).toHaveLength(6);
  });

  it('counts steps for today in the user timezone', async () => {
    harness = await makeApp({ now: '2026-01-05T21:30:00.000Z' }); // 2026-01-06 00:30 in Istanbul
    const { db, app } = harness;
    const user = await registerUser(app, 'adimci', { timezone: 'Europe/Istanbul' });

    db.prepare("INSERT INTO steps_daily (user_id, day_key, steps, source, updated_at) VALUES (?, ?, ?, 'pedometer', ?)").run(
      user.me.id,
      '2026-01-06',
      8421,
      app.now().toISOString(),
    );
    db.prepare("INSERT INTO steps_daily (user_id, day_key, steps, source, updated_at) VALUES (?, ?, ?, 'pedometer', ?)").run(
      user.me.id,
      '2026-01-05',
      15000,
      app.now().toISOString(),
    );

    const stats = computeUserStats(db, user.me.id, app.now());
    expect(stats.stepsToday).toBe(8421);
    expect(stats.stepsSingleDayMax).toBe(15000);
  });
});

describe('authenticate + error envelope', () => {
  it('guards routes, loads the user row and renders HttpErrors', async () => {
    harness = await makeApp({
      beforeReady: (app) => {
        app.get('/__protected', { preHandler: app.authenticate }, async (request) => ({
          id: request.user.id,
          username: request.user.row.username,
        }));
        app.get('/__boom', async () => {
          throw conflict('already_taunted', 'Bu kankaya zaten koydun.');
        });
      },
    });
    const { app, db } = harness;
    const ali = await registerUser(app, 'ali');

    const anonymous = await app.inject({ method: 'GET', url: '/__protected' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toEqual({ error: { code: 'unauthorized', message: 'Giriş yapman gerekiyor.' } });

    const garbage = await app.inject({
      method: 'GET',
      url: '/__protected',
      headers: { authorization: 'Bearer not.a.token' },
    });
    expect(garbage.statusCode).toBe(401);
    // SPEC 2.2 documents a single auth failure code, so an invalid or expired
    // session answers `unauthorized` too — the Turkish message is what differs.
    expect(garbage.json().error.code).toBe('unauthorized');
    expect(garbage.json().error.message).toContain('Oturumun');

    const ok = await app.inject({ method: 'GET', url: '/__protected', headers: { authorization: `Bearer ${ali.token}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ id: ali.me.id, username: 'ali' });

    // an expired token is refused
    const expired = signToken({ sub: ali.me.id }, harness.config.jwtSecret, 60, new Date('2026-01-01T00:00:00.000Z'));
    const stale = await app.inject({ method: 'GET', url: '/__protected', headers: { authorization: `Bearer ${expired}` } });
    expect(stale.statusCode).toBe(401);

    // soft-deleted users cannot use their old token
    db.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').run(app.now().toISOString(), ali.me.id);
    const deleted = await app.inject({
      method: 'GET',
      url: '/__protected',
      headers: { authorization: `Bearer ${ali.token}` },
    });
    expect(deleted.statusCode).toBe(401);

    const boom = await app.inject({ method: 'GET', url: '/__boom' });
    expect(boom.statusCode).toBe(409);
    expect(boom.json()).toEqual({ error: { code: 'already_taunted', message: 'Bu kankaya zaten koydun.' } });
  });
});

describe('GET /health', () => {
  it('answers with ok, version and the injected time', async () => {
    harness = await makeApp({ now: '2026-01-05T09:00:00.000Z' });
    const response = await harness.app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      version: harness.config.version,
      time: '2026-01-05T09:00:00.000Z',
      // no Android build published on this server
      app: null,
      // the harness's PUBLIC_URL is http://test.local: that is the address to share
      publicUrl: 'http://test.local',
      serverId: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
  });

  it('names the server by its secret, not by its address', async () => {
    const serverIdOf = async (config: Parameters<typeof makeApp>[0]) => {
      const built = await makeApp(config);
      try {
        const response = await built.app.inject({ method: 'GET', url: '/health' });
        return { id: response.json<{ serverId: string }>().serverId, body: response.body };
      } finally {
        await built.close();
      }
    };

    // a restart behind a new tunnel address: same secret, so old tokens still work
    const first = await serverIdOf({ config: { publicUrl: 'https://eski-adres.trycloudflare.com' } });
    const second = await serverIdOf({ config: { publicUrl: 'https://yeni-adres.trycloudflare.com' } });
    expect(second.id).toBe(first.id);

    // a new secret invalidates every token, and the id says so
    const other = await serverIdOf({ config: { jwtSecret: 'baska-bir-sunucu' } });
    expect(other.id).not.toBe(first.id);

    // the id is a one-way derivative: the secret itself never leaves
    expect(first.body).not.toContain(TEST_SECRET);
    expect(other.body).not.toContain('baska-bir-sunucu');
  });

  it('renders unknown routes and auth failures as Turkish error envelopes', async () => {
    harness = await makeApp();
    const missing = await harness.app.inject({ method: 'GET', url: '/yok-boyle-bir-sey' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: { code: 'not_found', message: 'Böyle bir uç yok.' } });
  });
});
