/**
 * Foundation tests: the pieces every route module builds on.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { DEFAULT_TTL_SECONDS, bearerToken, signToken, verifyToken } from '../src/auth/jwt.js';
import { migrate, newInviteCode, openDb } from '../src/db/index.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { loadConfig } from '../src/config.js';
import { listInbox, markRead, notify, unreadCount } from '../src/services/notifications.js';
import { computeUserStats, getBadges } from '../src/services/stats.js';
import { conflict } from '../src/errors.js';
import { makeApp, registerUser, type TestApp } from './helpers.js';

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
    expect(verifyToken(token, secret)).toEqual({ sub: 'user-1' });
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
    expect(verifyToken(token, secret, new Date('2026-01-01T00:00:30.000Z'))).toEqual({ sub: 'user-1' });
    expect(verifyToken(token, secret, new Date('2026-01-01T00:01:01.000Z'))).toBeNull();

    const long = signToken({ sub: 'user-1' }, secret, DEFAULT_TTL_SECONDS, issuedAt);
    expect(verifyToken(long, secret, new Date('2026-03-01T00:00:00.000Z'))).toEqual({ sub: 'user-1' });
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
    expect(garbage.json().error.code).toBe('invalid_token');

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
    });
  });

  it('renders unknown routes and auth failures as Turkish error envelopes', async () => {
    harness = await makeApp();
    const missing = await harness.app.inject({ method: 'GET', url: '/yok-boyle-bir-sey' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: { code: 'not_found', message: 'Böyle bir uç yok.' } });
  });
});
