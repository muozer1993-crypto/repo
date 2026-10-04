/**
 * One copy of the database per day, the last week kept, a second copy in
 * BACKUP_DIR when the owner named one, and the way back (`npm run yonet --
 * geri-yukle`).
 *
 * Everything a friend group has — accounts, çelınclar, every "KOYDUM" ever
 * sent — lives in one SQLite file on whoever runs the server, often a laptop.
 * A crash mid-write, a bad disk, a mistaken delete: without a copy it is gone.
 * `db.backup()` is SQLite's online backup, safe while the server is serving.
 *
 * Files: `<DATA_DIR>/backups/koydum-YYYY-MM-DD.db`, and the same names in
 * BACKUP_DIR (a OneDrive folder, say). The local folder sits on the database's
 * own disk, so it saves a mistake but not a dead laptop; the second folder is
 * fed from it and may fail (OneDrive signed out, a USB disk unplugged) without
 * costing the day its backup.
 */
import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { DEFAULT_TIMEZONE, dayKeyInTz, localTimeHHmm, todayKey } from '@koydum/shared';
import { MEMORY, type Config } from '../config.js';
import type { Database } from '../db/index.js';

export const BACKUPS_KEPT = 7;
const NAME_RE = /^koydum-\d{4}-\d{2}-\d{2}\.db$/;

/** Refusal shared by the CLI's /health probe and the check on the file itself. */
export const SERVER_OPEN =
  "Sunucu açık, açıkken yedek yüklersen veritabanı bozulur. Önce sunucunun penceresini kapat (ya da o pencerede Ctrl+C'ye bas), sonra tekrar dene.";
const BROKEN = 'Bu yedek bozuk, başka birini seç.';
const NOT_OURS = 'Bu dosya bir KOYDUM yedeği değil.';

export function backupDir(config: Pick<Config, 'dataDir'>): string {
  return path.join(path.resolve(config.dataDir), 'backups');
}

/** BACKUP_DIR as an absolute path; null when unset or when it names the local folder itself. */
export function backupCopyDir(config: Pick<Config, 'dataDir' | 'backupCopyDir'>): string | null {
  if (!config.backupCopyDir) return null;
  const dir = path.resolve(config.backupCopyDir);
  return dir === backupDir(config) ? null : dir;
}

function backupName(now: Date): string {
  return `koydum-${todayKey(DEFAULT_TIMEZONE, now)}.db`;
}

/** Keeps the newest `BACKUPS_KEPT` in `dir`. */
async function trim(dir: string): Promise<void> {
  const old = (await fs.promises.readdir(dir))
    .filter((name) => NAME_RE.test(name))
    .sort()
    .slice(0, -BACKUPS_KEPT);
  for (const name of old) {
    // a copy somebody opened to look at grows -wal/-shm companions; they go with it
    for (const file of [name, `${name}-wal`, `${name}-shm`]) await fs.promises.rm(path.join(dir, file), { force: true });
  }
}

/**
 * Writes today's copy if there is none yet and trims to the last
 * `BACKUPS_KEPT`. Returns the path written, or null when nothing was due (or the
 * database lives in memory).
 */
export async function backupIfDue(
  db: Database,
  config: Pick<Config, 'dataDir' | 'dbPath'>,
  now: Date,
): Promise<string | null> {
  if (config.dbPath === MEMORY || config.dataDir === MEMORY) return null;
  const dir = backupDir(config);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, backupName(now));
  if (fs.existsSync(target)) return null;

  // write aside and rename, so a crash mid-copy never leaves a "backup" that is half a file
  const temp = `${target}.tmp`;
  for (const stale of [temp, `${temp}-journal`, `${temp}-wal`, `${temp}-shm`]) fs.rmSync(stale, { force: true });
  await db.backup(temp);
  fs.renameSync(temp, target);
  await trim(dir);
  return target;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.promises.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Brings BACKUP_DIR up to date once today's local backup exists: every local
 * backup it lacks (the whole week the first time the owner sets it), then the
 * same trim. Returns today's copy, or null when nothing was due.
 *
 * Async all the way: a cloud or network folder that hangs must not freeze the
 * server. Throws when the folder cannot be reached; the scheduler logs it and
 * tries again later.
 */
export async function copyBackupIfDue(
  config: Pick<Config, 'dataDir' | 'dbPath' | 'backupCopyDir'>,
  now: Date,
): Promise<string | null> {
  const dir = backupCopyDir(config);
  if (!dir || config.dbPath === MEMORY || config.dataDir === MEMORY) return null;
  const local = backupDir(config);
  const today = backupName(now);
  // no local copy today means backupIfDue failed, and said so already
  if (!(await exists(path.join(local, today)))) return null;
  if (await exists(path.join(dir, today))) return null;

  await fs.promises.mkdir(dir, { recursive: true });
  const present = new Set(await fs.promises.readdir(dir));
  const missing = (await fs.promises.readdir(local)).filter((name) => NAME_RE.test(name) && !present.has(name));
  for (const name of missing) {
    // aside and renamed here too: a sync client must never upload half a file as a backup
    const temp = path.join(dir, `${name}.tmp`);
    await fs.promises.rm(temp, { force: true });
    await fs.promises.copyFile(path.join(local, name), temp);
    await fs.promises.rename(temp, path.join(dir, name));
  }
  await trim(dir);
  return path.join(dir, today);
}

export interface BackupFile {
  /** Absolute path. */
  file: string;
  /** `koydum-YYYY-MM-DD.db`, or whatever file the owner pointed at. */
  name: string;
  size: number;
  modifiedAt: Date;
}

function fileInfo(file: string): BackupFile {
  const stat = fs.statSync(file);
  return { file, name: path.basename(file), size: stat.size, modifiedAt: stat.mtime };
}

/** The backups in `dir`, newest day first; none when the folder does not exist yet. */
export function listBackups(dir: string): BackupFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return names
    .filter((name) => NAME_RE.test(name))
    .sort()
    .reverse()
    .map((name) => fileInfo(path.join(dir, name)));
}

/**
 * What `geri-yukle` restores. No argument: the newest day in either folder (the
 * local one on a tie, it is the original). Otherwise a file the owner points at
 * (an earlier `koydum-onceki-*.db`, say), a backup's name, or just its day.
 */
export function findBackup(
  config: Pick<Config, 'dataDir' | 'backupCopyDir'>,
  wanted?: string,
): BackupFile | null {
  const folders = [backupDir(config), backupCopyDir(config)].filter((dir): dir is string => dir !== null);
  const readable = (dir: string): BackupFile[] => {
    try {
      return listBackups(dir);
    } catch {
      // an unreachable BACKUP_DIR must not hide the local backups
      return [];
    }
  };

  if (wanted === undefined || wanted.trim() === '') {
    const all = folders.flatMap(readable);
    // stable sort: the local copy stays ahead of its twin
    return all.sort((a, b) => b.name.localeCompare(a.name))[0] ?? null;
  }
  const direct = path.resolve(wanted);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return fileInfo(direct);
  const name = /^\d{4}-\d{2}-\d{2}$/.test(wanted.trim()) ? `koydum-${wanted.trim()}.db` : path.basename(wanted.trim());
  for (const dir of folders) {
    const match = readable(dir).find((backup) => backup.name === name);
    if (match) return match;
  }
  return null;
}

/** Null when `file` is a healthy KOYDUM database, else the reason it is not, for the owner. */
function verdict(file: string): string | null {
  let db: BetterSqlite3.Database;
  try {
    db = new BetterSqlite3(file, { fileMustExist: true });
  } catch {
    return BROKEN;
  }
  try {
    try {
      if (db.pragma('integrity_check', { simple: true }) !== 'ok') return BROKEN;
    } catch {
      // not a database at all
      return BROKEN;
    }
    try {
      const row = db.prepare('SELECT count(*) AS n FROM _migrations').get() as { n: number };
      return row.n > 0 ? null : NOT_OURS;
    } catch {
      // a database, but some other program's
      return NOT_OURS;
    }
  } finally {
    db.close();
  }
}

/**
 * The server keeps its database in WAL mode, and SQLite deletes `-wal` when the
 * last connection closes. So open, read, close: a `-wal` still there means
 * somebody else (a server the /health probe missed) has the file open. On a
 * closed database the same open folds a crash's leftover WAL into the file
 * before it moves aside.
 */
function assertClosed(dbPath: string): void {
  const wal = `${dbPath}-wal`;
  if (!fs.existsSync(wal)) return;
  try {
    const probe = new BetterSqlite3(dbPath, { fileMustExist: true });
    try {
      probe.prepare('SELECT count(*) FROM sqlite_master').get();
    } finally {
      probe.close();
    }
  } catch {
    // too broken to read, so nobody is serving from it: it moves aside, WAL and all
    return;
  }
  if (fs.existsSync(wal)) throw new Error(SERVER_OPEN);
}

/** `koydum-onceki-2026-10-04-1432.db` beside the database: Istanbul time, no ':' (Windows refuses it). */
function asideName(dir: string, now: Date): string {
  const stamp = `${dayKeyInTz(now, DEFAULT_TIMEZONE)}-${localTimeHHmm(now, DEFAULT_TIMEZONE).replace(':', '')}`;
  let candidate = path.join(dir, `koydum-onceki-${stamp}.db`);
  for (let n = 2; fs.existsSync(candidate); n += 1) candidate = path.join(dir, `koydum-onceki-${stamp}-${n}.db`);
  return candidate;
}

function removeWithCompanions(file: string): void {
  for (const stale of [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]) fs.rmSync(stale, { force: true });
}

/**
 * Puts the backup `file` in place of the database, only with the server closed.
 * Nothing is deleted: the database that was there moves aside to
 * `koydum-onceki-<time>.db` next to it, so a wrong pick is undone by restoring
 * that file. Throws with a Turkish reason the CLI prints as is.
 */
export function restoreBackup(config: Pick<Config, 'dbPath'>, file: string, now: Date): { previous: string | null } {
  if (config.dbPath === MEMORY) throw new Error('Bellekteki veritabanına yedek yüklenmez.');
  const dbPath = path.resolve(config.dbPath);
  const wal = `${dbPath}-wal`;
  if (fs.existsSync(dbPath)) assertClosed(dbPath);

  // Copied next to the database and checked there, before the old one moves: a
  // OneDrive file may have to download first and can fail halfway, and opening a
  // backup where it lies would leave -wal/-shm files in the backup folder.
  const incoming = `${dbPath}.gelen`;
  removeWithCompanions(incoming);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.copyFileSync(path.resolve(file), incoming);
  const problem = verdict(incoming);
  if (problem) {
    removeWithCompanions(incoming);
    throw new Error(problem);
  }

  let previous: string | null = null;
  if (fs.existsSync(dbPath)) {
    previous = asideName(path.dirname(dbPath), now);
    fs.renameSync(dbPath, previous);
    // a WAL the check could not fold in belongs to that file, not to the restored one
    if (fs.existsSync(wal)) fs.renameSync(wal, `${previous}-wal`);
  }
  // a stale WAL replayed onto the restored file would corrupt it
  fs.rmSync(wal, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  try {
    fs.renameSync(incoming, dbPath);
  } catch (err) {
    // never leave the folder without a database: the server would start an empty one
    if (previous) {
      fs.renameSync(previous, dbPath);
      if (fs.existsSync(`${previous}-wal`)) fs.renameSync(`${previous}-wal`, wal);
    }
    throw err;
  }
  return { previous };
}
