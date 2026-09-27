/**
 * The owner's `npm run yonet`: a friend who forgot the password gets back in
 * with the one it prints, reports are finally readable, and the user list shows
 * who is still around. The CLI itself is spawned against a throwaway DATA_DIR,
 * the way npm runs it.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Challenge } from '@koydum/shared';
import { hashPassword } from '../src/auth/password.js';
import { openDb } from '../src/db/index.js';
import { createUser } from '../src/services/accounts.js';
import { listReports, listUsers, resetPassword } from '../src/services/admin.js';
import { authed, befriend, DEFAULT_PASSWORD, makeApp, registerUser, type TestApp } from './helpers.js';

const serverRoot = path.resolve(__dirname, '..');
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

let h: TestApp;
const dirs: string[] = [];

beforeEach(async () => {
  h = await makeApp();
});

afterEach(async () => {
  await h.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function login(app: TestApp['app'], username: string, password: string) {
  return app.inject({ method: 'POST', url: '/auth/login', payload: { username, password } });
}

describe('resetPassword', () => {
  it('lets the friend in with the new password and not with the old one', async () => {
    await registerUser(h.app, 'ali', { displayName: 'Ali' });

    const reset = await resetPassword(h.db, ' @Ali ');
    expect(reset).toMatchObject({ username: 'ali', displayName: 'Ali' });
    // readable off a chat message: no i/l/o/0/1, nothing to shift for
    expect(reset.password).toMatch(/^[a-hjkmnp-z2-9]{8}$/);

    expect((await login(h.app, 'ali', reset.password)).statusCode).toBe(200);
    expect((await login(h.app, 'ali', DEFAULT_PASSWORD)).statusCode).toBe(401);
  });

  it('refuses an unknown name and a deleted account', async () => {
    const veli = await registerUser(h.app, 'veli');
    expect((await authed(h.app, veli.token)({ method: 'DELETE', url: '/me' })).statusCode).toBe(200);
    const anonymised = (h.db.prepare('SELECT username FROM users WHERE id = ?').get(veli.me.id) as { username: string })
      .username;

    await expect(resetPassword(h.db, 'kimse')).rejects.toThrow('diye bir kullanıcı yok');
    // deleting frees the name, so the old one is simply unknown now
    await expect(resetPassword(h.db, 'veli')).rejects.toThrow('diye bir kullanıcı yok');
    await expect(resetPassword(h.db, anonymised)).rejects.toThrow('hesabını silmiş');
  });
});

describe('listReports', () => {
  it('shows both usernames and the reason, newest first', async () => {
    const ali = await registerUser(h.app, 'ali');
    const veli = await registerUser(h.app, 'veli');
    const first = await authed(h.app, ali.token)({
      method: 'POST',
      url: `/users/${veli.me.id}/report`,
      payload: { reason: 'Adımları elle şişiriyor' },
    });
    expect(first.statusCode).toBe(201);
    h.advance(60_000);
    await authed(h.app, veli.token)({ method: 'POST', url: `/users/${ali.me.id}/report`, payload: { reason: 'Küfür' } });

    expect(listReports(h.db)).toEqual([
      { reporter: 'veli', reported: 'ali', reason: 'Küfür', createdAt: '2026-01-05T09:01:00.000Z' },
      { reporter: 'ali', reported: 'veli', reason: 'Adımları elle şişiriyor', createdAt: '2026-01-05T09:00:00.000Z' },
    ]);
  });
});

describe('listUsers', () => {
  it('shows when everybody was last seen and how many çelınclar they are in', async () => {
    const ali = await registerUser(h.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(h.app, 'veli', { displayName: 'Veli' });
    const deli = await registerUser(h.app, 'deli', { displayName: 'Deli' });
    befriend(h.app, ali.me.id, veli.me.id);
    befriend(h.app, ali.me.id, deli.me.id);

    const created = await authed(h.app, ali.token)({
      method: 'POST',
      url: '/challenges',
      payload: {
        typeKey: 'adim_yarisi',
        startsAt: h.now().toISOString(),
        endsAt: new Date(h.now().getTime() + 3 * 24 * 3600_000).toISOString(),
        participantIds: [veli.me.id, deli.me.id],
      },
    });
    const challengeId = created.json<Challenge>().id;
    // Veli plays; Deli never answers the invite, so it is not his çelınc yet
    h.advance(10 * 60_000);
    await authed(h.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });

    const byName = Object.fromEntries(listUsers(h.db).map((u) => [u.username, u]));
    expect(byName.ali).toMatchObject({ displayName: 'Ali', activeChallenges: 1, deletedAt: null });
    expect(byName.veli).toMatchObject({ activeChallenges: 1, lastSeenAt: '2026-01-05T09:10:00.000Z' });
    expect(byName.deli).toMatchObject({ activeChallenges: 0, lastSeenAt: '2026-01-05T09:00:00.000Z' });
  });

  it('puts deleted accounts last', async () => {
    await registerUser(h.app, 'zeki');
    const ali = await registerUser(h.app, 'ali');
    await authed(h.app, ali.token)({ method: 'DELETE', url: '/me' });

    const users = listUsers(h.db);
    expect(users.map((u) => u.deletedAt !== null)).toEqual([false, true]);
    expect(users[0]!.username).toBe('zeki');
  });
});

describe('npm run yonet', () => {
  function run(dataDir: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [tsxCli, 'src/cli/yonet.ts', ...args], {
        cwd: serverRoot,
        env: { ...process.env, DATA_DIR: dataDir, JWT_SECRET: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d.toString()));
      child.stderr.on('data', (d) => (err += d.toString()));
      child.on('exit', (code) => resolve({ code, out, err }));
    });
  }

  function tempDataDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koydum-yonet-'));
    dirs.push(dir);
    return dir;
  }

  it('prints a password that logs in', async () => {
    const dataDir = tempDataDir();
    const dbPath = path.join(dataDir, 'koydum.db');
    const db = openDb(dbPath);
    createUser(db, { username: 'ali', displayName: 'Ali', passwordHash: await hashPassword('unuttum'), timezone: 'Europe/Istanbul' });
    db.close();

    const result = await run(dataDir, ['sifre', 'ali']);
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    const password = /yeni şifre:\s+(\S+)/.exec(result.out)?.[1];
    expect(password).toBeDefined();
    // it reads the very file, and leaves no secret next to it
    expect(fs.existsSync(path.join(dataDir, 'secret'))).toBe(false);

    const server = await makeApp({ config: { dbPath } });
    try {
      expect((await login(server.app, 'ali', password!)).statusCode).toBe(200);
      expect((await login(server.app, 'ali', 'unuttum')).statusCode).toBe(401);
    } finally {
      await server.close();
    }
  }, 60_000);

  it('answers an unknown command with the help and a failure', async () => {
    const result = await run(tempDataDir(), ['sil-her-seyi']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('"sil-her-seyi" diye bir komut yok');
    expect(result.err).toContain('npm run yonet -- sifre <kullanici>');
  }, 60_000);

  it('refuses to invent an empty database in the wrong folder', async () => {
    const dataDir = tempDataDir();
    const result = await run(dataDir, ['kullanicilar']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('Veritabanı bulunamadı');
    expect(fs.readdirSync(dataDir)).toEqual([]);
  }, 60_000);
});
