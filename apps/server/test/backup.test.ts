/**
 * The daily database copy: written once a day, readable as a real database,
 * trimmed to a week, never attempted for an in-memory database; copied on to
 * BACKUP_DIR (a OneDrive folder) whose failure never costs the day its backup;
 * and `geri-yukle`'s restore, which refuses a broken or foreign file and a
 * database somebody still has open, and never deletes the one it replaces.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openDb, type Database } from '../src/db/index.js';
import {
  BACKUPS_KEPT,
  backupCopyDir,
  backupDir,
  backupIfDue,
  copyBackupIfDue,
  findBackup,
  listBackups,
  restoreBackup,
} from '../src/services/backup.js';
import type { PushSender } from '../src/services/push.js';
import { BACKUP_COPY_RETRY_MS, SCHEDULER_INTERVAL_MS, startScheduler } from '../src/services/scheduler.js';
import { makeApp, type TestApp } from './helpers.js';

const dirs: string[] = [];
let harness: TestApp | null = null;
afterEach(async () => {
  if (harness) {
    await harness.close();
    harness = null;
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface TempData {
  dataDir: string;
  dbPath: string;
  /** BACKUP_DIR, outside dataDir, with the spaces and Turkish letters of a real Windows profile path. */
  backupCopyDir: string;
}

function tempData(): TempData {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koydum-backup-'));
  const cloud = fs.mkdtempSync(path.join(os.tmpdir(), 'koydum-OneDrive Şükrü-'));
  dirs.push(dataDir, cloud);
  return { dataDir, dbPath: path.join(dataDir, 'koydum.db'), backupCopyDir: path.join(cloud, 'KOYDUM yedekleri ığüşöçİ') };
}

function addUser(db: Database, username: string): void {
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, avatar_emoji, vulgarity_max, timezone, invite_code, created_at)
     VALUES (?, ?, ?, 'x', '🐐', 2, 'Europe/Istanbul', ?, '2026-01-01T00:00:00.000Z')`,
  ).run(`id-${username}`, username, username, username.toUpperCase().padEnd(6, 'X').slice(0, 6));
}

/** Read-write, so closing cleans up: a read-only look leaves -wal/-shm files behind. */
function usernames(file: string): string[] {
  const db = new BetterSqlite3(file, { fileMustExist: true });
  try {
    return (db.prepare('SELECT username FROM users ORDER BY username').all() as { username: string }[]).map((row) => row.username);
  } finally {
    db.close();
  }
}

const day = (n: number): Date => new Date(Date.UTC(2026, 8, n, 10));

describe('daily database backup', () => {
  it('writes one readable copy per day and keeps the last week', async () => {
    const config = tempData();
    const db = openDb(config.dbPath);
    addUser(db, 'ali');

    const first = await backupIfDue(db, config, new Date('2026-09-27T10:00:00Z'));
    expect(first).toBe(path.join(backupDir(config), 'koydum-2026-09-27.db'));
    // same day again: nothing to do
    expect(await backupIfDue(db, config, new Date('2026-09-27T20:00:00Z'))).toBeNull();

    const copy = new BetterSqlite3(first!, { readonly: true });
    expect(copy.prepare('SELECT username FROM users').all()).toEqual([{ username: 'ali' }]);
    copy.close();

    for (let n = 28; n <= 30 + BACKUPS_KEPT; n += 1) await backupIfDue(db, config, day(n));
    const kept = fs.readdirSync(backupDir(config)).sort();
    expect(kept).toHaveLength(BACKUPS_KEPT);
    expect(kept.every((name) => /^koydum-\d{4}-\d{2}-\d{2}\.db$/.test(name))).toBe(true);
    expect(kept).not.toContain('koydum-2026-09-27.db');
    db.close();
  });

  it('does nothing for an in-memory database', async () => {
    const db = openDb(':memory:');
    expect(await backupIfDue(db, { dataDir: ':memory:', dbPath: ':memory:' }, new Date())).toBeNull();
    expect(await copyBackupIfDue({ dataDir: ':memory:', dbPath: ':memory:', backupCopyDir: os.tmpdir() }, new Date())).toBeNull();
    db.close();
  });
});

describe('BACKUP_DIR', () => {
  it('is read from the environment, trimmed, and left out when blank', () => {
    const saved = process.env.BACKUP_DIR;
    try {
      const { dataDir } = tempData();
      process.env.BACKUP_DIR = '  C:\\Users\\Şükrü\\OneDrive\\KOYDUM yedek  ';
      expect(loadConfig({ dataDir, jwtSecret: 'x' }).backupCopyDir).toBe('C:\\Users\\Şükrü\\OneDrive\\KOYDUM yedek');
      process.env.BACKUP_DIR = '   ';
      expect(loadConfig({ dataDir, jwtSecret: 'x' }).backupCopyDir).toBeUndefined();
      // a test's in-memory server never writes into the owner's real folder
      process.env.BACKUP_DIR = '/srv/yedek';
      expect(loadConfig({ dataDir: ':memory:' }).backupCopyDir).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.BACKUP_DIR;
      else process.env.BACKUP_DIR = saved;
    }
  });

  it('gets the whole week the first time, then each new day, created if missing and trimmed alike', async () => {
    const config = tempData();
    const db = openDb(config.dbPath);
    addUser(db, 'ali');
    for (let n = 20; n <= 22; n += 1) await backupIfDue(db, config, day(n));
    expect(fs.existsSync(config.backupCopyDir)).toBe(false);

    const copied = await copyBackupIfDue(config, day(22));
    expect(copied).toBe(path.join(config.backupCopyDir, 'koydum-2026-09-22.db'));
    expect(fs.readdirSync(config.backupCopyDir).sort()).toEqual([
      'koydum-2026-09-20.db',
      'koydum-2026-09-21.db',
      'koydum-2026-09-22.db',
    ]);
    expect(usernames(copied!)).toEqual(['ali']);
    // already there: nothing to do
    expect(await copyBackupIfDue(config, day(22))).toBeNull();

    for (let n = 23; n <= 22 + BACKUPS_KEPT; n += 1) {
      await backupIfDue(db, config, day(n));
      await copyBackupIfDue(config, day(n));
    }
    expect(fs.readdirSync(config.backupCopyDir).sort()).toEqual(fs.readdirSync(backupDir(config)).sort());
    expect(fs.readdirSync(config.backupCopyDir)).toHaveLength(BACKUPS_KEPT);
    db.close();
  });

  it('waits for the day’s own backup before copying anything', async () => {
    const config = tempData();
    expect(await copyBackupIfDue(config, day(22))).toBeNull();
    expect(fs.existsSync(config.backupCopyDir)).toBe(false);
  });

  it('costs a warning once an hour when unreachable, never the day’s own backup', async () => {
    const config = tempData();
    // a file where the folder should be: what an unplugged drive looks like to mkdir
    const blocked = path.join(config.dataDir, 'D-surucusu');
    fs.writeFileSync(blocked, '');
    harness = await makeApp({ now: day(22), config: { ...config, backupCopyDir: path.join(blocked, 'yedek') } });
    const warn = vi.spyOn(harness.app.log, 'warn');
    let flushes = 0;
    const push: PushSender = {
      flush: async () => {
        flushes += 1;
        return { sent: 0, failed: 0 };
      },
    };

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const stop = startScheduler(harness.app, harness.db, harness.config, { push });
      await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1), { interval: 10, timeout: 5000 });
      expect(fs.existsSync(path.join(backupDir(config), 'koydum-2026-09-22.db'))).toBe(true);

      // the next pass, 30 s on: still unreachable, not worth a second line yet
      await vi.advanceTimersByTimeAsync(SCHEDULER_INTERVAL_MS);
      await vi.waitFor(() => expect(flushes).toBe(2), { interval: 10, timeout: 5000 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(warn).toHaveBeenCalledTimes(1);

      // an hour later it tries again
      harness.advance(BACKUP_COPY_RETRY_MS);
      await vi.advanceTimersByTimeAsync(SCHEDULER_INTERVAL_MS);
      await vi.waitFor(() => expect(flushes).toBe(3), { interval: 10, timeout: 5000 });
      await stop();
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[0]![1]).toContain('BACKUP_DIR');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('listing and picking a backup', () => {
  it('lists newest first, ignores what is not a backup, and picks across both folders', async () => {
    const config = tempData();
    const db = openDb(config.dbPath);
    for (const n of [20, 21]) await backupIfDue(db, config, day(n));
    await copyBackupIfDue(config, day(21));
    db.close();
    // OneDrive still holds a newer day from the laptop that died
    fs.copyFileSync(path.join(backupDir(config), 'koydum-2026-09-21.db'), path.join(config.backupCopyDir, 'koydum-2026-09-23.db'));
    for (const stranger of ['notlar.txt', 'koydum-2026-09-21.db.tmp', 'koydum-2026-09-21.db-wal', 'koydum.db']) {
      fs.writeFileSync(path.join(backupDir(config), stranger), 'x');
    }

    expect(listBackups(backupDir(config)).map((b) => b.name)).toEqual(['koydum-2026-09-21.db', 'koydum-2026-09-20.db']);
    expect(listBackups(path.join(config.dataDir, 'yok'))).toEqual([]);
    expect(backupCopyDir(config)).toBe(path.resolve(config.backupCopyDir));
    // BACKUP_DIR naming the local folder itself is no second copy
    expect(backupCopyDir({ ...config, backupCopyDir: path.join(config.dataDir, 'backups') })).toBeNull();

    expect(findBackup(config)?.file).toBe(path.join(config.backupCopyDir, 'koydum-2026-09-23.db'));
    // a day both folders hold comes from this computer
    expect(findBackup(config, 'koydum-2026-09-21.db')?.file).toBe(path.join(backupDir(config), 'koydum-2026-09-21.db'));
    expect(findBackup(config, '2026-09-20')?.file).toBe(path.join(backupDir(config), 'koydum-2026-09-20.db'));
    const elsewhere = path.join(config.dataDir, 'koydum-onceki-2026-09-24-1432.db');
    fs.writeFileSync(elsewhere, 'x');
    expect(findBackup(config, elsewhere)?.file).toBe(elsewhere);
    expect(findBackup(config, 'koydum-2026-01-01.db')).toBeNull();
    // an unreachable BACKUP_DIR does not hide the local ones
    expect(findBackup({ ...config, backupCopyDir: path.join(elsewhere, 'yedek') })?.name).toBe('koydum-2026-09-21.db');
  });
});

describe('restoring a backup', () => {
  async function withBackup(): Promise<{ config: TempData; backup: string }> {
    const config = tempData();
    const db = openDb(config.dbPath);
    addUser(db, 'ali');
    const backup = (await backupIfDue(db, config, day(22)))!;
    // what the backup does not have: a friend who joined after it
    addUser(db, 'veli');
    db.close();
    return { config, backup };
  }

  it('puts the backup in place, keeps the old database aside and drops a stale WAL', async () => {
    const { config, backup } = await withBackup();
    // leftovers that belong to no live connection; replayed onto the restored file they would corrupt it
    fs.writeFileSync(`${config.dbPath}-wal`, 'eski');
    fs.writeFileSync(`${config.dbPath}-shm`, 'eski');

    const { previous } = restoreBackup(config, backup, new Date('2026-09-24T11:32:00Z'));
    expect(previous).toBe(path.join(config.dataDir, 'koydum-onceki-2026-09-24-1432.db'));
    expect(fs.existsSync(`${config.dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${config.dbPath}-shm`)).toBe(false);
    expect(fs.readdirSync(config.dataDir).filter((name) => name.includes('gelen'))).toEqual([]);
    expect(usernames(config.dbPath)).toEqual(['ali']);
    expect(usernames(previous!)).toEqual(['ali', 'veli']);

    // the restored file is what the server opens next
    const db = openDb(config.dbPath);
    expect(db.prepare('SELECT username FROM users').all()).toEqual([{ username: 'ali' }]);
    db.close();

    // a second restore in the same minute does not overwrite the first file set aside
    expect(restoreBackup(config, previous!, new Date('2026-09-24T11:32:30Z')).previous).toBe(
      path.join(config.dataDir, 'koydum-onceki-2026-09-24-1432-2.db'),
    );
    expect(usernames(config.dbPath)).toEqual(['ali', 'veli']);
  });

  it('folds a crash’s leftover WAL into the file set aside, so nothing in it is lost', async () => {
    const { config, backup } = await withBackup();
    // a server that died mid-flight: its last write is still only in the WAL
    const server = openDb(config.dbPath);
    server.pragma('wal_autocheckpoint = 0');
    addUser(server, 'zeki');
    const copyWhileOpen = path.join(config.dataDir, 'crash');
    fs.mkdirSync(copyWhileOpen);
    for (const suffix of ['', '-wal']) fs.copyFileSync(`${config.dbPath}${suffix}`, path.join(copyWhileOpen, `koydum.db${suffix}`));
    server.close();
    for (const suffix of ['', '-wal']) fs.copyFileSync(path.join(copyWhileOpen, `koydum.db${suffix}`), `${config.dbPath}${suffix}`);

    const { previous } = restoreBackup(config, backup, day(24));
    expect(usernames(previous!)).toEqual(['ali', 'veli', 'zeki']);
    expect(usernames(config.dbPath)).toEqual(['ali']);
  });

  it('works on a new computer with no database yet', async () => {
    const { config, backup } = await withBackup();
    const fresh = tempData();
    const { previous } = restoreBackup({ dbPath: path.join(fresh.dataDir, 'yeni klasör', 'koydum.db') }, backup, day(24));
    expect(previous).toBeNull();
    expect(usernames(path.join(fresh.dataDir, 'yeni klasör', 'koydum.db'))).toEqual(['ali']);
    expect(usernames(config.dbPath)).toEqual(['ali', 'veli']);
  });

  it('refuses a broken file and somebody else’s database, and leaves everything as it was', async () => {
    const { config } = await withBackup();
    const before = fs.readdirSync(config.dataDir).sort();

    const garbage = path.join(config.dataDir, 'bozuk.db');
    fs.writeFileSync(garbage, Buffer.from(Array.from({ length: 8192 }, (_, i) => (i * 37) % 256)));
    expect(() => restoreBackup(config, garbage, day(24))).toThrow('Bu yedek bozuk');

    const foreign = path.join(config.dataDir, 'baska.db');
    const other = new BetterSqlite3(foreign);
    other.exec("CREATE TABLE notlar (metin TEXT); INSERT INTO notlar VALUES ('selam')");
    other.close();
    expect(() => restoreBackup(config, foreign, day(24))).toThrow('KOYDUM yedeği değil');

    expect(fs.readdirSync(config.dataDir).sort()).toEqual([...before, 'baska.db', 'bozuk.db'].sort());
    expect(usernames(config.dbPath)).toEqual(['ali', 'veli']);
  });

  it('refuses while the server still has the database open', async () => {
    const { config, backup } = await withBackup();
    const server = openDb(config.dbPath);
    try {
      expect(() => restoreBackup(config, backup, day(24))).toThrow('Sunucu açık');
      expect(fs.readdirSync(config.dataDir).filter((name) => name.startsWith('koydum-onceki'))).toEqual([]);
      expect(usernames(config.dbPath)).toEqual(['ali', 'veli']);
    } finally {
      server.close();
    }
  });
});
