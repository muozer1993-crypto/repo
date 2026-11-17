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
    addUser(harness.db, 'ali');
    const warn = vi.spyOn(harness.app.log, 'warn');
    // an hour between two beats also reads as a sleep, and says so: count only the copy's lines
    const copyWarnings = () => warn.mock.calls.filter((call) => String(call[1]).includes('BACKUP_DIR')).length;
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
      await vi.waitFor(() => expect(copyWarnings()).toBe(1), { interval: 10, timeout: 5000 });
      expect(fs.existsSync(path.join(backupDir(config), 'koydum-2026-09-22.db'))).toBe(true);

      // the next pass, 30 s on: still unreachable, not worth a second line yet
      await vi.advanceTimersByTimeAsync(SCHEDULER_INTERVAL_MS);
      await vi.waitFor(() => expect(flushes).toBe(2), { interval: 10, timeout: 5000 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(copyWarnings()).toBe(1);

      // an hour later it tries again
      harness.advance(BACKUP_COPY_RETRY_MS);
      await vi.advanceTimersByTimeAsync(SCHEDULER_INTERVAL_MS);
      await vi.waitFor(() => expect(flushes).toBe(3), { interval: 10, timeout: 5000 });
      await stop();
      expect(copyWarnings()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a day’s backup that does not fit on the disk', () => {
  it('leaves no half copy, says how much room it wants and waits an hour, never every pass', async () => {
    const config = tempData();
    harness = await makeApp({ now: day(22), config });
    addUser(harness.db, 'ali');
    // stubbed, never a real disk filled: SQLite gets part of the copy down, then runs out
    const backup = vi.spyOn(harness.db, 'backup').mockImplementation(async (destination: string) => {
      fs.writeFileSync(destination, 'yarım');
      throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });
    });
    const warn = vi.spyOn(harness.app.log, 'warn');
    const error = vi.spyOn(harness.app.log, 'error');
    const didNotFit = () =>
      warn.mock.calls.filter((call) => call[1] === 'database backup did not fit on the disk, trying again in an hour');
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
      await vi.waitFor(() => expect(didNotFit()).toHaveLength(1), { interval: 10, timeout: 5000 });
      expect(didNotFit()[0]?.[0]).toEqual({ neededMb: 1 });
      expect(error).not.toHaveBeenCalled();
      // the part written before the disk ran out is room the database needs
      expect(fs.readdirSync(backupDir(config))).toEqual([]);

      // the passes after it: no second try, no second line
      for (let pass = 2; pass <= 4; pass += 1) {
        harness.advance(SCHEDULER_INTERVAL_MS);
        await vi.advanceTimersByTimeAsync(SCHEDULER_INTERVAL_MS);
        await vi.waitFor(() => expect(flushes).toBe(pass), { interval: 10, timeout: 5000 });
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(backup).toHaveBeenCalledTimes(1);
      expect(didNotFit()).toHaveLength(1);

      // room again an hour later: the day gets its backup
      backup.mockRestore();
      harness.advance(BACKUP_COPY_RETRY_MS);
      await vi.advanceTimersByTimeAsync(SCHEDULER_INTERVAL_MS);
      await vi.waitFor(() => expect(fs.existsSync(path.join(backupDir(config), 'koydum-2026-09-22.db'))).toBe(true), {
        interval: 10,
        timeout: 5000,
      });
      await stop();
      expect(usernames(path.join(backupDir(config), 'koydum-2026-09-22.db'))).toEqual(['ali']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('listing and picking a backup', () => {
  it('lists newest first, ignores what is not a backup, and picks across both folders', async () => {
    const config = tempData();
    const db = openDb(config.dbPath);
    addUser(db, 'ali');
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

  it('empties the push slots of the backup, so every phone sends its own token again', async () => {
    const config = tempData();
    const db = openDb(config.dbPath);
    addUser(db, 'ali');
    addUser(db, 'veli');
    // the day of the backup: Ali's old phone P, Veli on Q
    db.prepare("UPDATE users SET push_token = 'ExponentPushToken[P]', push_platform = 'android' WHERE username = 'ali'").run();
    db.prepare("UPDATE users SET push_token = 'ExponentPushToken[Q]', push_platform = 'android' WHERE username = 'veli'").run();
    const backup = (await backupIfDue(db, config, day(22)))!;
    db.close();

    restoreBackup(config, backup, day(24));
    const restored = openDb(config.dbPath);
    expect(restored.prepare('SELECT username, push_token, push_platform FROM users ORDER BY username').all()).toEqual([
      { username: 'ali', push_token: null, push_platform: null },
      { username: 'veli', push_token: null, push_platform: null },
    ]);
    restored.close();
    // the backup itself is left as it was
    const kept = new BetterSqlite3(backup, { fileMustExist: true });
    expect(kept.prepare('SELECT COUNT(*) AS n FROM users WHERE push_token IS NOT NULL').get()).toEqual({ n: 2 });
    kept.close();
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

  it('refuses up front when the disk has no room for the copy', async () => {
    const { config, backup } = await withBackup();
    const before = fs.readdirSync(config.dataDir).sort();
    const size = fs.statSync(backup).size;
    // stubbed, never a real disk filled: 5 MB free, which a backup and its 10 MB margin do not fit in
    vi.spyOn(fs, 'statfsSync').mockReturnValue({ bavail: 1280, bsize: 4096 } as fs.StatsFs);
    try {
      expect(() => restoreBackup(config, backup, day(24))).toThrow(
        `Diskte yer yok: yedeği yüklemek için ~${Math.ceil((size + 10 * 1024 * 1024) / (1024 * 1024))} MB boş yer lazım, önce yer aç.`,
      );
    } finally {
      vi.restoreAllMocks();
    }
    expect(fs.readdirSync(config.dataDir).sort()).toEqual(before);
    expect(usernames(config.dbPath)).toEqual(['ali', 'veli']);
  });

  it('leaves no half-copied backup behind when the disk runs out during the copy', async () => {
    const { config, backup } = await withBackup();
    const before = fs.readdirSync(config.dataDir).sort();
    // the system would not say how much is free, so the copy is tried and runs out halfway
    vi.spyOn(fs, 'statfsSync').mockImplementation(() => {
      throw Object.assign(new Error('ENOSYS'), { code: 'ENOSYS' });
    });
    vi.spyOn(fs, 'copyFileSync').mockImplementation((_from, to) => {
      fs.writeFileSync(to as string, 'yarım');
      throw Object.assign(new Error('ENOSPC: no space left on device, copyfile'), { code: 'ENOSPC' });
    });
    try {
      expect(() => restoreBackup(config, backup, day(24))).toThrow(/^Diskte yer yok: yedeği yüklemek için ~\d+ MB boş yer lazım/);
    } finally {
      vi.restoreAllMocks();
    }
    expect(fs.readdirSync(config.dataDir).sort()).toEqual(before);
    expect(usernames(config.dbPath)).toEqual(['ali', 'veli']);
  });

  it('refuses while the server still has the database open', async () => {
    const { config, backup } = await withBackup();
    const server = openDb(config.dbPath);
    try {
      // the way to stop it that keeps the tunnel's address comes first
      expect(() => restoreBackup(config, backup, day(24))).toThrow(/^Sunucu açık,[^]*\n {2}npm run internet ile açtıysan o pencerede dur yazıp Enter'a bas/);
      expect(fs.readdirSync(config.dataDir).filter((name) => name.startsWith('koydum-onceki'))).toEqual([]);
      expect(usernames(config.dbPath)).toEqual(['ali', 'veli']);
    } finally {
      server.close();
    }
  });
});

describe('a database with no accounts is never backed up', () => {
  /** A real day's backup with `users` in it, written straight to `file`, the way it lies in BACKUP_DIR. */
  async function backupWith(file: string, users: string[]): Promise<void> {
    const source = tempData();
    const db = openDb(source.dbPath);
    for (const user of users) addUser(db, user);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await db.backup(file);
    db.close();
  }

  const nov = (n: number): Date => new Date(Date.UTC(2026, 10, n, 12));

  it('waits for the first account, then backs up as usual', async () => {
    const config = tempData();
    const db = openDb(config.dbPath);
    expect(await backupIfDue(db, config, nov(16))).toBeNull();
    expect(await copyBackupIfDue(config, nov(16))).toBeNull();
    expect(listBackups(backupDir(config))).toEqual([]);
    expect(listBackups(config.backupCopyDir)).toEqual([]);

    // the first friend signs up: the same day gets its backup on the next pass
    addUser(db, 'ali');
    expect(await backupIfDue(db, config, nov(16))).toBe(path.join(backupDir(config), 'koydum-2026-11-16.db'));
    expect(await copyBackupIfDue(config, nov(16))).toBe(path.join(config.backupCopyDir, 'koydum-2026-11-16.db'));
    db.close();
  });

  it('a week of an empty server on a new PC leaves the real backup in BACKUP_DIR, and geri-yukle finds it', async () => {
    const config = tempData();
    const real = path.join(config.backupCopyDir, 'koydum-2026-11-14.db');
    await backupWith(real, ['seyma', 'ali']);
    // the owner followed Hızlı başlangıç before he remembered the backup
    const empty = openDb(config.dbPath);
    for (let n = 16; n <= 23; n += 1) {
      await backupIfDue(empty, config, nov(n));
      await copyBackupIfDue(config, nov(n));
    }
    empty.close();
    expect(fs.readdirSync(config.backupCopyDir)).toEqual(['koydum-2026-11-14.db']);
    expect(listBackups(backupDir(config))).toEqual([]);

    expect(findBackup(config)?.file).toBe(real);
    const { previous, accounts } = restoreBackup(config, real, nov(23));
    expect(accounts).toBe(2);
    expect(usernames(config.dbPath)).toEqual(['ali', 'seyma']);
    expect(usernames(previous!)).toEqual([]);
    // checked next to the database, never opened where it lies: OneDrive gets no -wal/-shm
    expect(fs.readdirSync(config.backupCopyDir)).toEqual(['koydum-2026-11-14.db']);
  });

  it('an empty server started the same day does not shadow that day’s real backup', async () => {
    const config = tempData();
    const real = path.join(config.backupCopyDir, 'koydum-2026-11-16.db');
    await backupWith(real, ['seyma', 'ali']);
    const empty = openDb(config.dbPath);
    await backupIfDue(empty, config, nov(16));
    await copyBackupIfDue(config, nov(16));
    empty.close();

    expect(fs.readdirSync(config.backupCopyDir)).toEqual(['koydum-2026-11-16.db']);
    expect(findBackup(config, 'koydum-2026-11-16.db')?.file).toBe(real);
    expect(findBackup(config)?.file).toBe(real);
  });

  it('counts the open accounts in what it restores, none in an empty server’s copy', async () => {
    const config = tempData();
    // what an earlier version wrote for a server nobody had signed up to yet
    const empty = path.join(config.backupCopyDir, 'koydum-2026-11-16.db');
    await backupWith(empty, []);
    expect(restoreBackup(config, empty, nov(17)).accounts).toBe(0);
    expect(usernames(config.dbPath)).toEqual([]);

    // an account closed with `sil` brings nobody back either
    const closed = path.join(config.backupCopyDir, 'koydum-2026-11-15.db');
    const source = tempData();
    const db = openDb(source.dbPath);
    addUser(db, 'ali');
    addUser(db, 'veli');
    db.prepare("UPDATE users SET deleted_at = '2026-11-15T09:00:00.000Z' WHERE username = 'veli'").run();
    await db.backup(closed);
    db.close();
    expect(restoreBackup(config, closed, nov(17)).accounts).toBe(1);
  });
});
