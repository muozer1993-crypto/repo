/**
 * One copy of the database per day, the last week kept.
 *
 * Everything a friend group has — accounts, çelınclar, every "KOYDUM" ever
 * sent — lives in one SQLite file on whoever runs the server, often a laptop.
 * A crash mid-write, a bad disk, a mistaken delete: without a copy it is gone.
 * `db.backup()` is SQLite's online backup, safe while the server is serving.
 *
 * Files: `<DATA_DIR>/backups/koydum-YYYY-MM-DD.db`. To restore, stop the server
 * and copy one over `<DATA_DIR>/koydum.db`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_TIMEZONE, todayKey } from '@koydum/shared';
import type { Config } from '../config.js';
import type { Database } from '../db/index.js';

export const BACKUPS_KEPT = 7;
const NAME_RE = /^koydum-\d{4}-\d{2}-\d{2}\.db$/;

export function backupDir(config: Pick<Config, 'dataDir'>): string {
  return path.join(path.resolve(config.dataDir), 'backups');
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
  if (config.dbPath === ':memory:' || config.dataDir === ':memory:') return null;
  const dir = backupDir(config);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `koydum-${todayKey(DEFAULT_TIMEZONE, now)}.db`);
  if (fs.existsSync(target)) return null;

  // write aside and rename, so a crash mid-copy never leaves a "backup" that is half a file
  const temp = `${target}.tmp`;
  await db.backup(temp);
  fs.renameSync(temp, target);

  const old = fs
    .readdirSync(dir)
    .filter((name) => NAME_RE.test(name))
    .sort()
    .slice(0, -BACKUPS_KEPT);
  for (const name of old) {
    // a copy somebody opened to look at grows -wal/-shm companions; they go with it
    for (const file of [name, `${name}-wal`, `${name}-shm`]) fs.rmSync(path.join(dir, file), { force: true });
  }
  return target;
}
