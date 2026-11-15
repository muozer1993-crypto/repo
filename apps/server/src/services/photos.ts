/**
 * The proof photos no entry shows, deleted once a day (SPEC 2.6, run from the
 * scheduler).
 *
 * A photo goes up the moment a friend picks it, before the entry it is for
 * exists. Picked again, or the screen left without "Kaydet": the first one was
 * never anybody's proof. A new photo for the same day, a phone's reading taking
 * back a typed day friends threw out, a deleted entry: the address leaves the
 * entry and the file stays.
 * At 1.5-2.5 MB each, a few çelınclar with photos fill the owner's laptop with
 * files nobody can open and nobody knows are there. A deleted account's photos
 * go with the account (services/accounts.ts); this takes everything else.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Database } from '../db/index.js';
import { UPLOADED_PHOTO } from './accounts.js';

/**
 * How old an unused photo must be before it goes. An upload is not an entry
 * yet: a phone that parked an entry keeps the path of the photo it already
 * uploaded and may send the entry days later (offlineQueue), and an itiraz's
 * answer goes up before it is posted. A week covers both.
 */
export const UNUSED_PHOTO_GRACE_MS = 7 * 24 * 60 * 60_000;

/** The names `POST /uploads` gives. Anything else in the folder (a `.tmp`, a file the owner put there) is not ours to delete. */
const PHOTO_NAME = /^[0-9a-f-]{36}\.(?:jpg|png|webp)$/;

export interface SweepResult {
  /** photos deleted */
  removed: number;
  /** their size together */
  bytes: number;
}

/**
 * Deletes every photo in `uploadDir` that `POST /uploads` named, that is older
 * than `graceMs` at `now`, and that no entry points at, in either form an
 * entry stores (`/uploads/<name>`, or with a server address in front). A file
 * the disk will not let go of (a locked file on Windows) is skipped, and the
 * next day's pass tries it again. A missing folder is nothing to do.
 */
export async function sweepOrphanPhotos(
  db: Database,
  uploadDir: string,
  now: Date,
  graceMs: number = UNUSED_PHOTO_GRACE_MS,
): Promise<SweepResult> {
  const result: SweepResult = { removed: 0, bytes: 0 };
  let names: string[];
  try {
    names = await fs.promises.readdir(uploadDir);
  } catch (err) {
    // no photo was ever uploaded, or no folder to hold one (app.ts already said so)
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return result;
    throw err;
  }

  const cutoff = now.getTime() - graceMs;
  const old: { name: string; file: string; size: number }[] = [];
  for (const name of names) {
    if (!PHOTO_NAME.test(name)) continue;
    const file = path.join(uploadDir, name);
    try {
      const stat = await fs.promises.lstat(file);
      if (stat.isFile() && stat.mtimeMs < cutoff) old.push({ name, file, size: stat.size });
    } catch {
      // gone since the listing
    }
  }
  if (old.length === 0) return result;

  // read after the folder, so an entry posted while it was listed still counts
  const shown = new Set<string>();
  const rows = db.prepare('SELECT proof_url FROM entries WHERE proof_url IS NOT NULL').all() as { proof_url: string }[];
  for (const { proof_url: url } of rows) {
    const name = UPLOADED_PHOTO.exec(url)?.[1];
    if (name) shown.add(name);
  }

  for (const photo of old) {
    if (shown.has(photo.name)) continue;
    try {
      await fs.promises.unlink(photo.file);
      result.removed += 1;
      result.bytes += photo.size;
    } catch {
      // a photo viewer holding it open on Windows, or gone already: leave it
    }
  }
  return result;
}
