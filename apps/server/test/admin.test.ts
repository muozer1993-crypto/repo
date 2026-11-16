/**
 * The owner's `npm run yonet`: a friend who forgot the password gets back in
 * with the one it prints, reports are finally readable, the user list shows
 * who is still around and a stranger who signed up can be closed out. The CLI
 * itself is spawned against a throwaway DATA_DIR, the way npm runs it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Challenge } from '@koydum/shared';
import { hashPassword } from '../src/auth/password.js';
import { newId, openDb, type Database } from '../src/db/index.js';
import { createUser } from '../src/services/accounts.js';
import { accountToDelete, deleteAccount, listReports, listUsers, resetPassword } from '../src/services/admin.js';
import { backupIfDue, copyBackupIfDue } from '../src/services/backup.js';
import { authed, befriend, DEFAULT_PASSWORD, makeApp, registerUser, type TestApp } from './helpers.js';

const serverRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(serverRoot, '../..');
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

  it('finds a username the owner typed with Turkish letters', async () => {
    await registerUser(h.app, 'seyma', { displayName: 'Şeyma' });
    const reset = await resetPassword(h.db, 'Şeyma');
    expect(reset).toMatchObject({ username: 'seyma', displayName: 'Şeyma' });
    expect((await login(h.app, 'Şeyma', reset.password)).statusCode).toBe(200);
  });

  it('signs out every phone still signed in, and the new password signs back in', async () => {
    const seyma = await registerUser(h.app, 'seyma', { displayName: 'Şeyma' });
    const me = authed(h.app, seyma.token);
    await me({ method: 'POST', url: '/me/push-token', payload: { token: 'ExponentPushToken[seyma]', platform: 'android' } });

    const reset = await resetPassword(h.db, 'Şeyma');

    const kicked = await me({ method: 'GET', url: '/me' });
    expect(kicked.statusCode).toBe(401);
    expect(kicked.json<{ error: { code: string; message: string } }>().error).toEqual({
      code: 'unauthorized',
      message: 'Şifren değişti, bu telefondaki oturum kapandı. Yeni şifreyle gir.',
    });

    const back = await login(h.app, 'seyma', reset.password);
    expect(back.statusCode).toBe(200);
    const fresh = authed(h.app, back.json<{ token: string }>().token);
    const profile = await fresh({ method: 'GET', url: '/me' });
    expect(profile.statusCode).toBe(200);
    // nothing is pushed to a phone that may no longer be hers
    expect(profile.json<{ hasPushToken: boolean }>().hasPushToken).toBe(false);
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

describe('deleteAccount', () => {
  it('closes the account the owner names, Turkish letters and all, and its phone is out at once', async () => {
    const seyma = await registerUser(h.app, 'seyma', { displayName: 'Şeyma' });
    const me = authed(h.app, seyma.token);
    expect((await me({ method: 'GET', url: '/me' })).statusCode).toBe(200);

    expect(accountToDelete(h.db, 'Şeyma')).toEqual({ username: 'seyma', displayName: 'Şeyma' });
    expect(deleteAccount(h.db, ' @Şeyma ', h.now(), h.config.uploadDir)).toEqual({ username: 'seyma', displayName: 'Şeyma' });

    const out = await me({ method: 'GET', url: '/me' });
    expect(out.statusCode).toBe(401);
    // the one code SPEC knows, and a message that does not send her back to the login
    expect(out.json<{ error: { code: string; message: string } }>().error).toEqual({
      code: 'unauthorized',
      message: 'Bu hesap kapatıldı, bununla bir daha giriş yapılamaz. Bir yanlışlık varsa sunucuyu kuran kişiye sor.',
    });
    expect((await login(h.app, 'seyma', DEFAULT_PASSWORD)).statusCode).toBe(401);
    const row = listUsers(h.db).find((u) => u.deletedAt !== null);
    expect(row).toMatchObject({ displayName: 'Silinen kanka', deletedAt: h.now().toISOString() });
  });

  it('refuses an unknown name and an account already deleted', async () => {
    const veli = await registerUser(h.app, 'veli');
    await authed(h.app, veli.token)({ method: 'DELETE', url: '/me' });
    const anonymised = listUsers(h.db)[0]!.username;

    expect(() => deleteAccount(h.db, 'kimse')).toThrow('"kimse" diye bir kullanıcı yok. Liste için: npm run yonet -- kullanicilar');
    expect(() => accountToDelete(h.db, anonymised)).toThrow(`"${anonymised}" hesabı zaten silinmiş.`);
    expect(() => deleteAccount(h.db, anonymised)).toThrow('hesabı zaten silinmiş');
  });

  it('walks out of a running 1v1, which is cancelled for the one left in it', async () => {
    const ali = await registerUser(h.app, 'ali');
    const veli = await registerUser(h.app, 'veli');
    befriend(h.app, ali.me.id, veli.me.id);
    const created = await authed(h.app, ali.token)({
      method: 'POST',
      url: '/challenges',
      payload: {
        typeKey: 'adim_yarisi',
        startsAt: h.now().toISOString(),
        endsAt: new Date(h.now().getTime() + 3 * 24 * 3600_000).toISOString(),
        participantIds: [veli.me.id],
      },
    });
    const challengeId = created.json<Challenge>().id;
    await authed(h.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });

    h.advance(60 * 60_000);
    deleteAccount(h.db, 'veli', h.now(), h.config.uploadDir);

    expect(h.db.prepare('SELECT status FROM challenges WHERE id = ?').get(challengeId)).toEqual({ status: 'cancelled' });
    expect(
      h.db.prepare('SELECT status FROM challenge_participants WHERE challenge_id = ? AND user_id = ?').get(challengeId, veli.me.id),
    ).toEqual({ status: 'left' });
    expect(
      h.db.prepare("SELECT data FROM notifications WHERE user_id = ? AND type = 'challenge_cancelled'").get(ali.me.id),
    ).toEqual({ data: JSON.stringify({ challengeId, reason: 'everyone_left' }) });
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
  type Result = { code: number | null; out: string; err: string };

  /** Everything the child printed; 'close', not 'exit', so a grandchild's last lines are in too. */
  function printed(child: ChildProcess, input?: string): Promise<Result> {
    return new Promise((resolve) => {
      let out = '';
      let err = '';
      child.stdout!.on('data', (d) => (out += d.toString()));
      child.stderr!.on('data', (d) => (err += d.toString()));
      child.on('close', (code) => resolve({ code, out, err }));
      if (input !== undefined) child.stdin!.end(input);
    });
  }

  function run(dataDir: string, args: string[], env: NodeJS.ProcessEnv = {}, input?: string): Promise<Result> {
    const child = spawn(process.execPath, [tsxCli, 'src/cli/yonet.ts', ...args], {
      cwd: serverRoot,
      env: { ...process.env, DATA_DIR: dataDir, JWT_SECRET: '', BACKUP_DIR: '', ...env },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    return printed(child, input);
  }

  /**
   * The root script, typed the owner's way, so whatever npm itself prints around
   * the CLI is on screen too. The npm running these tests when there is one, else
   * the one on PATH (npm.cmd on Windows, which only starts through a shell).
   */
  function runFromRoot(dataDir: string, args: string[]): Promise<Result> {
    const npmCli = process.env.npm_execpath;
    const viaNode = npmCli !== undefined && /npm-cli\.c?js$/.test(npmCli);
    const child = spawn(viaNode ? process.execPath : 'npm', [...(viaNode ? [npmCli] : []), 'run', 'yonet', '--', ...args], {
      cwd: repoRoot,
      env: { ...process.env, DATA_DIR: dataDir, JWT_SECRET: '', BACKUP_DIR: '' },
      shell: !viaNode && process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return printed(child);
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

  /** Veli's finished çelınc with Ali, his day in it backed by a photo in DATA_DIR/uploads. */
  function veliWithPhoto(db: Database, dataDir: string): { photo: string; entryId: string } {
    const ali = createUser(db, { username: 'ali', displayName: 'Ali', passwordHash: 'x', timezone: 'Europe/Istanbul' });
    const veli = createUser(db, { username: 'veli', displayName: 'Veli', passwordHash: 'x', timezone: 'Europe/Istanbul' });
    const at = '2025-12-08T00:00:00.000Z';
    const challengeId = newId();
    db.prepare(
      `INSERT INTO challenges (id, creator_id, type_key, metric_type, direction, unit, title, starts_at, ends_at, status, created_at)
       VALUES (?, ?, 'adim_yarisi', 'auto_steps', 'higher', 'adım', 'Adım yarışı', '2025-12-01T00:00:00.000Z', ?, 'finished', ?)`,
    ).run(challengeId, ali.id, at, at);
    const join = db.prepare(
      "INSERT INTO challenge_participants (challenge_id, user_id, status, invited_at, joined_at) VALUES (?, ?, 'accepted', ?, ?)",
    );
    for (const user of [ali, veli]) join.run(challengeId, user.id, at, at);
    const name = `${randomUUID()}.jpg`;
    fs.mkdirSync(path.join(dataDir, 'uploads'));
    fs.writeFileSync(path.join(dataDir, 'uploads', name), 'jpeg');
    const entryId = newId();
    db.prepare(
      `INSERT INTO entries (id, challenge_id, user_id, day_key, value, source, note, proof_url, created_at, updated_at)
       VALUES (?, ?, ?, '2025-12-02', 12000, 'manual', 'Sahilde', ?, ?, ?)`,
    ).run(entryId, challengeId, veli.id, `/uploads/${name}`, at, at);
    return { photo: path.join(dataDir, 'uploads', name), entryId };
  }

  it('sil asks first, goes ahead with --evet and takes the proof photos with the account', async () => {
    const dataDir = tempDataDir();
    const dbPath = path.join(dataDir, 'koydum.db');
    const db = openDb(dbPath);
    const { photo, entryId } = veliWithPhoto(db, dataDir);
    db.close();
    const env = { UPLOAD_DIR: '' };

    // no terminal to answer on: nothing is deleted on a guess
    const unasked = await run(dataDir, ['sil', 'veli'], env);
    expect(unasked.code).toBe(1);
    expect(unasked.err).toContain('npm run yonet -- sil veli --evet');
    expect(usersIn(dbPath).sort()).toEqual(['ali', 'veli']);
    expect(fs.existsSync(photo)).toBe(true);

    const closed = await run(dataDir, ['SİL', '@Veli', '--evet'], env);
    expect(closed.err).toBe('');
    expect(closed.code).toBe(0);
    expect(closed.out).toContain('Tamam, @veli kapatıldı. Telefonundaki oturum hemen düştü.');
    expect(fs.existsSync(photo)).toBe(false);
    const after = openDb(dbPath);
    try {
      expect(listUsers(after).map((u) => [u.username === 'ali' ? 'ali' : 'silinen', u.deletedAt !== null])).toEqual([
        ['ali', false],
        ['silinen', true],
      ]);
      expect(after.prepare('SELECT value, note, proof_url FROM entries WHERE id = ?').get(entryId)).toEqual({
        value: 12000,
        note: null,
        proof_url: null,
      });
    } finally {
      after.close();
    }

    const again = await run(dataDir, ['kapat', 'veli', '--evet'], env);
    expect(again.code).toBe(1);
    expect(again.err).toContain('"veli" diye bir kullanıcı yok');
  }, 60_000);

  it('sil takes a "hayır" at the prompt as an answer, not a failure', async () => {
    const dataDir = tempDataDir();
    const dbPath = path.join(dataDir, 'koydum.db');
    const db = openDb(dbPath);
    createUser(db, { username: 'veli', displayName: 'Veli', passwordHash: 'x', timezone: 'Europe/Istanbul' });
    db.close();
    // sil only asks on a terminal: a pipe that says it is one stands in for the owner's keyboard
    const fakeTerminal = '--import=data:text/javascript,process.stdin.isTTY=true';
    const env = { UPLOAD_DIR: '', NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} ${fakeTerminal}`.trim() };

    const declined = await run(dataDir, ['sil', 'veli'], env, 'hayır\n');
    expect(declined.out).toContain('Veli (@veli) silinsin mi? Geri alınamaz. (evet/hayır)');
    expect(declined.out).toContain('Peki, hesaba dokunmadım.');
    expect(declined.err).toBe('');
    expect(declined.code).toBe(0);
    expect(usersIn(dbPath)).toEqual(['veli']);

    const agreed = await run(dataDir, ['sil', 'veli'], env, 'evet\n');
    expect(agreed.code).toBe(0);
    expect(agreed.out).toContain('Tamam, @veli kapatıldı.');
    expect(usersIn(dbPath)).not.toContain('veli');
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

  /** npm's own block after a non-zero exit: English, red, and reads like a crash. */
  function expectNoNpmError(result: Result): void {
    for (const line of ['npm error', 'Lifecycle script', 'command failed']) {
      expect(result.out + result.err).not.toContain(line);
    }
  }

  it('fails through the root script with its own Turkish lines and no npm error block under them', async () => {
    const dataDir = tempDataDir();
    openDb(path.join(dataDir, 'koydum.db')).close();

    const unknown = await runFromRoot(dataDir, ['sifre', 'yokboyle']);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('✗ "yokboyle" diye bir kullanıcı yok');
    expectNoNpmError(unknown);

    const missing = await runFromRoot(tempDataDir(), ['kullanicilar']);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('✗ Veritabanı bulunamadı');
    expectNoNpmError(missing);
  }, 60_000);

  /** A database with ali in its backup and veli only after it, the backup also in BACKUP_DIR. */
  async function withBackups(): Promise<{ dataDir: string; dbPath: string; copyDir: string }> {
    const dataDir = tempDataDir();
    const copyDir = path.join(tempDataDir(), 'OneDrive Şükrü', 'KOYDUM yedek');
    const dbPath = path.join(dataDir, 'koydum.db');
    const db = openDb(dbPath);
    createUser(db, { username: 'ali', displayName: 'Ali', passwordHash: 'x', timezone: 'Europe/Istanbul' });
    await backupIfDue(db, { dataDir, dbPath }, new Date());
    await copyBackupIfDue({ dataDir, dbPath, backupCopyDir: copyDir }, new Date());
    createUser(db, { username: 'veli', displayName: 'Veli', passwordHash: 'x', timezone: 'Europe/Istanbul' });
    db.close();
    return { dataDir, dbPath, copyDir };
  }

  function usersIn(dbPath: string): string[] {
    const db = openDb(dbPath);
    try {
      return listUsers(db).map((u) => u.username);
    } finally {
      db.close();
    }
  }

  /** A port nothing listens on, so no server on the test machine answers for ours. */
  async function freePort(): Promise<number> {
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise((resolve) => server.close(resolve));
    return port;
  }

  it('lists the backups and puts the newest back from BACKUP_DIR when the local ones are gone', async () => {
    const { dataDir, dbPath, copyDir } = await withBackups();
    // the data folder lost its backups (deleted by mistake): OneDrive still has them
    fs.rmSync(path.join(dataDir, 'backups'), { recursive: true });
    const env = { BACKUP_DIR: copyDir, PORT: String(await freePort()) };

    const listed = await run(dataDir, ['yedekler'], env);
    expect(listed.err).toBe('');
    expect(listed.code).toBe(0);
    expect(listed.out).toContain(`BACKUP_DIR: ${copyDir}`);
    expect(listed.out).toMatch(/geri-yukle koydum-\d{4}-\d{2}-\d{2}\.db/);

    const restored = await run(dataDir, ['GERİ-YÜKLE'], env);
    expect(restored.err).toBe('');
    expect(restored.code).toBe(0);
    expect(restored.out).toContain('Şimdi sunucuyu aç.');
    expect(usersIn(dbPath)).toEqual(['ali']);
    const aside = fs.readdirSync(dataDir).filter((name) => name.startsWith('koydum-onceki-'));
    expect(aside).toHaveLength(1);
    expect(restored.out).toContain(`geri-yukle "${path.join(dataDir, aside[0]!)}"`);
    expect(usersIn(path.join(dataDir, aside[0]!)).sort()).toEqual(['ali', 'veli']);
  }, 60_000);

  it('says how many accounts geri-yukle brought back, and warns when it brought none', async () => {
    const dataDir = tempDataDir();
    const dbPath = path.join(dataDir, 'koydum.db');
    // an earlier version's copy of a server nobody had signed up to yet, and a real day
    const empty = path.join(tempDataDir(), 'koydum-2026-11-16.db');
    const real = path.join(tempDataDir(), 'koydum-2026-11-14.db');
    const db = openDb(path.join(tempDataDir(), 'koydum.db'));
    await db.backup(empty);
    for (const username of ['ali', 'veli']) {
      createUser(db, { username, displayName: username, passwordHash: 'x', timezone: 'Europe/Istanbul' });
    }
    await db.backup(real);
    db.close();
    const env = { PORT: String(await freePort()) };

    const wrong = await run(dataDir, ['geri-yukle', empty], env);
    expect(wrong.err).toBe('');
    expect(wrong.code).toBe(0);
    expect(wrong.out).toContain(', 0 hesap)');
    expect(wrong.out).toContain('Bu yedekte hiç hesap yok');
    expect(wrong.out).not.toContain('Şimdi sunucuyu aç.');

    const right = await run(dataDir, ['geri-yukle', real], env);
    expect(right.err).toBe('');
    expect(right.code).toBe(0);
    expect(right.out).toContain(', 2 hesap)');
    expect(right.out).not.toContain('hiç hesap yok');
    expect(right.out).toContain('Şimdi sunucuyu aç.');
    expect(usersIn(dbPath).sort()).toEqual(['ali', 'veli']);
  }, 60_000);

  // A same-day restart on an emptied data folder (Windows locks the open database,
  // so the folder goes while the server is down) left this computer an empty
  // koydum-<day>.db, and BACKUP_DIR the real one of that day under the same name:
  // its day and its name load the empty one, and "başka bir günün yedeği" lost a day.
  it('points to the same day\'s copy in BACKUP_DIR when the one it loaded is empty', async () => {
    const dataDir = tempDataDir();
    const copyDir = tempDataDir();
    fs.mkdirSync(path.join(dataDir, 'backups'));
    const empty = path.join(dataDir, 'backups', 'koydum-2026-11-16.db');
    const real = path.join(copyDir, 'koydum-2026-11-16.db');
    const db = openDb(path.join(tempDataDir(), 'koydum.db'));
    await db.backup(empty);
    createUser(db, { username: 'ali', displayName: 'Ali', passwordHash: 'x', timezone: 'Europe/Istanbul' });
    await db.backup(real);
    db.close();
    const env = { BACKUP_DIR: copyDir, PORT: String(await freePort()) };

    const byDay = await run(dataDir, ['geri-yukle', '2026-11-16'], env);
    expect(byDay.err).toBe('');
    expect(byDay.out).toContain(', 0 hesap)');
    expect(byDay.out).toContain('Sunucuyu açmadan önce başka bir yedek yükle.');
    expect(byDay.out).toContain('Aynı günün bir kopyası daha var, önce onu dene (tarihini yazarsan yine bunu yükler):');
    expect(byDay.out).toContain(`npm run yonet -- geri-yukle "${real}"`);

    const twin = await run(dataDir, ['geri-yukle', real], env);
    expect(twin.err).toBe('');
    expect(twin.out).toContain(', 1 hesap)');
    expect(twin.out).toContain('Şimdi sunucuyu aç.');
    expect(usersIn(path.join(dataDir, 'koydum.db'))).toEqual(['ali']);
  }, 60_000);

  it('refuses geri-yukle while the server answers on its port', async () => {
    const { dataDir, dbPath } = await withBackups();
    const stub = http.createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, version: '1.0.0' }));
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    try {
      const result = await run(dataDir, ['geri-yukle'], { PORT: String((stub.address() as AddressInfo).port) });
      expect(result.code).toBe(1);
      expect(result.err).toContain('Sunucu açık');
      expect(fs.readdirSync(dataDir).filter((name) => name.startsWith('koydum-onceki-'))).toEqual([]);
      expect(usersIn(dbPath).sort()).toEqual(['ali', 'veli']);
    } finally {
      await new Promise((resolve) => stub.close(resolve));
    }
  }, 60_000);
});
