/**
 * The disk the database lives on: how much room is left, whether an error says
 * there is none, and the owner's hourly line when there is none.
 *
 * Everything shares one disk on the owner's PC: the database, its WAL, the proof
 * photos, the daily backup. Once it was full, every write failed with SQLite's
 * English "database or disk is full", which the friends saw as "Sunucuda bir
 * şeyler ters gitti" and the owner as the same English twice a minute, so nobody
 * thought of the disk. Freeing room is all it takes: SQLite writes again on the
 * next statement, no restart needed.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { MEMORY } from '../config.js';

/** The owner's window hears about a full disk once an hour, not once a request or a pass. */
export const OWNER_WARN_EVERY_MS = 60 * 60 * 1000;

/**
 * Free bytes for us on the disk under `dir`, or null when the system will not
 * say (the check is then skipped, never a reason to refuse).
 */
export async function freeBytes(dir: string): Promise<number | null> {
  try {
    // a folder deleted while the server runs is made again, so its disk can be asked
    await fs.promises.mkdir(dir, { recursive: true });
    const stats = await fs.promises.statfs(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

/**
 * `freeBytes` for a caller that cannot wait (the hourly line below, `geri-yukle`),
 * and without making the folder: on a full disk that would fail too. A folder
 * that does not exist yet (a new PC before its first restore) is asked through
 * the nearest one that does, which sits on the same disk.
 */
export function freeBytesSync(dir: string): number | null {
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    try {
      const stats = fs.statfsSync(at);
      return stats.bavail * stats.bsize;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(at) === at) return null;
    }
  }
}

/** SQLite's "database or disk is full", or the file system's "no space" / "over quota". */
export function isDiskFull(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return code === 'SQLITE_FULL' || code === 'ENOSPC' || code === 'EDQUOT';
}

/**
 * When the owner was last told. Kept per app rather than in a module variable,
 * so one test's warning never silences the next one's; keyed by the app's
 * `config`, an object the route plugins' child instances share with the root
 * (each child is an instance of its own).
 */
const warnedAt = new WeakMap<object, number>();

/**
 * Tells the owner, at most once an hour, that the disk is full and what that
 * stops. `atMs` is the app's clock (`app.now()`). The free room is read only when
 * the line is written, so a failing request costs no extra system call.
 */
export function warnDiskFull(app: FastifyInstance, atMs: number): void {
  const last = warnedAt.get(app.config);
  if (last !== undefined && atMs - last < OWNER_WARN_EVERY_MS) return;
  warnedAt.set(app.config, atMs);
  const free = app.config.dbPath === MEMORY ? null : freeBytesSync(path.dirname(path.resolve(app.config.dbPath)));
  app.log.warn(free === null ? {} : { freeMb: Math.floor(free / (1024 * 1024)) }, 'disk full, nothing can be saved');
}
