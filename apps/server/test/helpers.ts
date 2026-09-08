/**
 * Test harness: an app on an in-memory database with a controllable clock.
 *
 * Every test file should build its app through `makeApp()` so time is injectable
 * (`setNow` / `advance`) and nothing touches the real filesystem except a throwaway
 * uploads directory under the OS temp dir.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { DEFAULT_TIMEZONE, type Me } from '@koydum/shared';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { newId, newInviteCode, nowIso, type Database, type UserRow } from '../src/db/index.js';
import { hashPassword } from '../src/auth/password.js';
import { signToken } from '../src/auth/jwt.js';
import { toMe } from '../src/serialize.js';

export const TEST_SECRET = 'test-secret-koydum';
export const DEFAULT_PASSWORD = 'sifre123';

export interface MakeAppOptions {
  /** Starting instant of the injected clock (default 2026-01-05T09:00:00Z). */
  now?: Date | string;
  /** Extra config overrides (in-memory db, silent log and test secret are preset). */
  config?: Partial<Config>;
}

export interface TestApp {
  app: FastifyInstance;
  db: Database;
  config: Config;
  /** Current injected time. */
  now: () => Date;
  /** Move the clock to an absolute instant. */
  setNow: (value: Date | string) => void;
  /** Move the clock forward. */
  advance: (ms: number) => void;
  close: () => Promise<void>;
}

export const DEFAULT_NOW = '2026-01-05T09:00:00.000Z';

export async function makeApp(overrides: MakeAppOptions = {}): Promise<TestApp> {
  let current = new Date(overrides.now ?? DEFAULT_NOW);
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koydum-test-'));

  const { app, db, config } = await buildApp({
    now: () => current,
    config: {
      dataDir: ':memory:',
      dbPath: ':memory:',
      uploadDir,
      jwtSecret: TEST_SECRET,
      logLevel: 'silent',
      publicUrl: 'http://test.local',
      enableDevRoutes: true,
      ...overrides.config,
    },
  });
  await app.ready();

  return {
    app,
    db,
    config,
    now: () => current,
    setNow: (value) => {
      current = new Date(value);
    },
    advance: (ms) => {
      current = new Date(current.getTime() + ms);
    },
    close: async () => {
      await app.close();
      fs.rmSync(uploadDir, { recursive: true, force: true });
    },
  };
}

export interface RegisterExtras {
  password?: string;
  displayName?: string;
  timezone?: string;
  vulgarityMax?: 1 | 2 | 3;
  reminderHour?: number | null;
  avatarEmoji?: string;
  pushToken?: string;
}

export interface RegisteredUser {
  token: string;
  me: Me;
}

/**
 * Registers a user through POST /auth/register when that route exists, and falls
 * back to creating the row directly (the foundation ships before the auth routes),
 * so this helper works for every agent at every stage.
 */
export async function registerUser(
  app: FastifyInstance,
  username: string,
  extras: RegisterExtras = {},
): Promise<RegisteredUser> {
  const password = extras.password ?? DEFAULT_PASSWORD;
  const displayName = extras.displayName ?? username;
  const timezone = extras.timezone ?? DEFAULT_TIMEZONE;

  const response = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { username, password, displayName, timezone },
  });

  let created: RegisteredUser;
  if (response.statusCode === 200 || response.statusCode === 201) {
    created = response.json<RegisteredUser>();
  } else if (response.statusCode === 404) {
    created = await createUserDirectly(app, { username, password, displayName, timezone });
  } else {
    throw new Error(`register(${username}) failed: ${response.statusCode} ${response.body}`);
  }

  const patch: string[] = [];
  const params: unknown[] = [];
  if (extras.vulgarityMax !== undefined) {
    patch.push('vulgarity_max = ?');
    params.push(extras.vulgarityMax);
  }
  if (extras.reminderHour !== undefined) {
    patch.push('reminder_hour = ?');
    params.push(extras.reminderHour);
  }
  if (extras.avatarEmoji !== undefined) {
    patch.push('avatar_emoji = ?');
    params.push(extras.avatarEmoji);
  }
  if (extras.pushToken !== undefined) {
    patch.push('push_token = ?', "push_platform = 'ios'");
    params.push(extras.pushToken);
  }
  if (patch.length > 0) {
    app.db.prepare(`UPDATE users SET ${patch.join(', ')} WHERE id = ?`).run(...(params as never[]), created.me.id);
    const row = app.db.prepare('SELECT * FROM users WHERE id = ?').get(created.me.id) as UserRow;
    created = { token: created.token, me: toMe(app.db, row, app.now()) };
  }

  return created;
}

async function createUserDirectly(
  app: FastifyInstance,
  input: { username: string; password: string; displayName: string; timezone: string },
): Promise<RegisteredUser> {
  const id = newId();
  const createdAt = nowIso(app.now());
  app.db
    .prepare(
      `INSERT INTO users (id, username, display_name, password_hash, avatar_emoji, vulgarity_max, timezone,
                          invite_code, push_token, push_platform, reminder_hour, created_at, last_seen_at, deleted_at)
       VALUES (?, ?, ?, ?, '🍆', 2, ?, ?, NULL, NULL, 20, ?, NULL, NULL)`,
    )
    .run(id, input.username, input.displayName, await hashPassword(input.password), input.timezone, newInviteCode(), createdAt);

  const row = app.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow;
  return { token: signToken({ sub: id }, app.config.jwtSecret, undefined, app.now()), me: toMe(app.db, row, app.now()) };
}

/** `const call = authed(app, token); await call({ method: 'GET', url: '/me' })`. */
export function authed(app: FastifyInstance, token: string) {
  return (options: InjectOptions) =>
    app.inject({
      ...options,
      headers: { ...(options.headers ?? {}), authorization: `Bearer ${token}` },
    });
}

/**
 * Makes two users friends (accepted friendship, requester = `userIdA`).
 * Writes directly to the database so it works before the friends routes exist.
 */
export function befriend(app: FastifyInstance, userIdA: string, userIdB: string): string {
  const existing = app.db
    .prepare(
      'SELECT id FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)',
    )
    .get(userIdA, userIdB, userIdB, userIdA) as { id: string } | undefined;

  const at = nowIso(app.now());
  if (existing) {
    app.db.prepare("UPDATE friendships SET status = 'accepted', updated_at = ? WHERE id = ?").run(at, existing.id);
    return existing.id;
  }

  const id = newId();
  app.db
    .prepare(
      "INSERT INTO friendships (id, requester_id, addressee_id, status, created_at, updated_at) VALUES (?, ?, ?, 'accepted', ?, ?)",
    )
    .run(id, userIdA, userIdB, at, at);
  return id;
}
