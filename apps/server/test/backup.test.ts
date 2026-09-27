/**
 * The daily database copy: written once a day, readable as a real database,
 * trimmed to a week, never attempted for an in-memory database.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { BACKUPS_KEPT, backupDir, backupIfDue } from '../src/services/backup.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempData(): { dataDir: string; dbPath: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koydum-backup-'));
  dirs.push(dataDir);
  return { dataDir, dbPath: path.join(dataDir, 'koydum.db') };
}

describe('daily database backup', () => {
  it('writes one readable copy per day and keeps the last week', async () => {
    const config = tempData();
    const db = openDb(config.dbPath);
    db.prepare(
      `INSERT INTO users (id, username, display_name, password_hash, avatar_emoji, vulgarity_max, timezone, invite_code, created_at)
       VALUES ('u1', 'ali', 'Ali', 'x', '🐐', 2, 'Europe/Istanbul', 'ABC234', '2026-01-01T00:00:00.000Z')`,
    ).run();

    const first = await backupIfDue(db, config, new Date('2026-09-27T10:00:00Z'));
    expect(first).toBe(path.join(backupDir(config), 'koydum-2026-09-27.db'));
    // same day again: nothing to do
    expect(await backupIfDue(db, config, new Date('2026-09-27T20:00:00Z'))).toBeNull();

    const copy = new BetterSqlite3(first!, { readonly: true });
    expect(copy.prepare('SELECT username FROM users').all()).toEqual([{ username: 'ali' }]);
    copy.close();

    for (let day = 28; day <= 30 + BACKUPS_KEPT; day += 1) {
      const date = new Date(Date.UTC(2026, 8, day, 10));
      await backupIfDue(db, config, date);
    }
    const kept = fs.readdirSync(backupDir(config)).sort();
    expect(kept).toHaveLength(BACKUPS_KEPT);
    expect(kept.every((name) => /^koydum-\d{4}-\d{2}-\d{2}\.db$/.test(name))).toBe(true);
    expect(kept).not.toContain('koydum-2026-09-27.db');
    db.close();
  });

  it('does nothing for an in-memory database', async () => {
    const db = openDb(':memory:');
    expect(await backupIfDue(db, { dataDir: ':memory:', dbPath: ':memory:' }, new Date())).toBeNull();
    db.close();
  });
});
