/**
 * The daily sweep of the proof photos no entry shows (src/services/photos.ts):
 * a photo picked and then swapped for another, or one a new photo pushed out of
 * its entry, goes once it is a week old. A photo an entry shows (by its path or
 * with a server address in front), a younger one, anything `POST /uploads` did
 * not name, and a file the disk will not let go of all stay.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Challenge } from '@koydum/shared';
import { sweepOrphanPhotos, UNUSED_PHOTO_GRACE_MS } from '../src/services/photos.js';
import {
  authed,
  befriend,
  JPEG_1X1,
  makeApp,
  multipart,
  registerUser,
  type RegisteredUser,
  type TestApp,
} from './helpers.js';

const NOW = '2026-01-05T09:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;

let harness: TestApp | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  if (harness) {
    await harness.close();
    harness = null;
  }
});

/** Sets a file's modified time to `ageMs` before the harness's clock: the age the sweep reads. */
function age(h: TestApp, file: string, ageMs: number): void {
  const at = (h.now().getTime() - ageMs) / 1000;
  fs.utimesSync(file, at, at);
}

/** A file in the uploads folder, `ageMs` old. */
function put(h: TestApp, name: string, ageMs: number, content = 'x'.repeat(1000)): string {
  const file = path.join(h.config.uploadDir, name);
  fs.writeFileSync(file, content);
  age(h, file, ageMs);
  return file;
}

const photoName = (ext = 'jpg'): string => `${randomUUID()}.${ext}`;

/** Ali and Veli in a typed screen-time çelınc that started now: one entry a day each, with a photo. */
async function screenChallenge(h: TestApp): Promise<{ ali: RegisteredUser; veli: RegisteredUser; challengeId: string }> {
  const ali = await registerUser(h.app, 'ali');
  const veli = await registerUser(h.app, 'veli');
  befriend(h.app, ali.me.id, veli.me.id);
  const created = await authed(h.app, ali.token)({
    method: 'POST',
    url: '/challenges',
    payload: {
      typeKey: 'ekran_suresi_beyani',
      startsAt: h.now().toISOString(),
      endsAt: new Date(h.now().getTime() + 3 * DAY).toISOString(),
      participantIds: [veli.me.id],
    },
  });
  expect(created.statusCode).toBe(201);
  const challengeId = created.json<Challenge>().id;
  await authed(h.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
  return { ali, veli, challengeId };
}

/** What picking a photo in the app does: it goes up at once, before any entry. */
async function upload(h: TestApp, user: RegisteredUser): Promise<string> {
  const form = multipart({ filename: 'kanit.jpg', contentType: 'image/jpeg', content: JPEG_1X1 });
  const response = await authed(h.app, user.token)({ method: 'POST', url: '/uploads', ...form });
  expect(response.statusCode).toBe(201);
  return response.json<{ url: string }>().url;
}

/** Today's minutes; a second one for the same day takes the place of the first, photo and all. */
async function postEntry(h: TestApp, user: RegisteredUser, challengeId: string, value: number, proofUrl: string): Promise<void> {
  const response = await authed(h.app, user.token)({
    method: 'POST',
    url: `/challenges/${challengeId}/entries`,
    payload: { dayKey: '2026-01-05', value, source: 'manual', proofUrl, clientTime: h.now().toISOString() },
  });
  expect(response.statusCode).toBeLessThan(300);
}

const fileOf = (h: TestApp, url: string): string => path.join(h.config.uploadDir, path.basename(url));

describe('sweepOrphanPhotos', () => {
  it('deletes a week-old photo that was picked and swapped, and one a new photo pushed out, and counts their bytes', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await screenChallenge(harness);
    // picked, then picked again: the first one never made it into an entry
    const dropped = await upload(harness, ali);
    const replaced = await upload(harness, ali);
    await postEntry(harness, ali, challengeId, 240, replaced);
    // later that evening the day gets a new number and a new photo
    const shown = await upload(harness, ali);
    await postEntry(harness, ali, challengeId, 180, shown);
    for (const url of [dropped, replaced, shown]) age(harness, fileOf(harness, url), 0);
    const bytes = fs.statSync(fileOf(harness, dropped)).size + fs.statSync(fileOf(harness, replaced)).size;

    harness.advance(UNUSED_PHOTO_GRACE_MS + 60_000);
    const result = await sweepOrphanPhotos(harness.db, harness.config.uploadDir, harness.now());

    expect(result).toEqual({ removed: 2, bytes });
    expect(fs.existsSync(fileOf(harness, dropped))).toBe(false);
    expect(fs.existsSync(fileOf(harness, replaced))).toBe(false);
    expect(fs.existsSync(fileOf(harness, shown))).toBe(true);
  });

  it('keeps an unused photo younger than a week: its entry may still be on its way from a phone', async () => {
    harness = await makeApp({ now: NOW });
    const yesterday = put(harness, photoName(), DAY);
    const almost = put(harness, photoName('png'), UNUSED_PHOTO_GRACE_MS - 60_000);
    const old = put(harness, photoName('webp'), 8 * DAY, 'y'.repeat(2500));

    const result = await sweepOrphanPhotos(harness.db, harness.config.uploadDir, harness.now());

    expect(result).toEqual({ removed: 1, bytes: 2500 });
    expect(fs.existsSync(yesterday)).toBe(true);
    expect(fs.existsSync(almost)).toBe(true);
    expect(fs.existsSync(old)).toBe(false);
  });

  it('keeps an old photo an entry shows, by its path or with a server address in front', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await screenChallenge(harness);
    const relative = photoName();
    const absolute = photoName('png');
    // the API takes any address as a proof; older apps stored the full one
    await postEntry(harness, ali, challengeId, 240, `/uploads/${relative}`);
    await postEntry(harness, veli, challengeId, 200, `http://192.168.1.20:4000/uploads/${absolute}`);
    const files = [put(harness, relative, 30 * DAY), put(harness, absolute, 30 * DAY)];
    const unused = put(harness, photoName(), 30 * DAY);

    const result = await sweepOrphanPhotos(harness.db, harness.config.uploadDir, harness.now());

    expect(result.removed).toBe(1);
    for (const file of files) expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(unused)).toBe(false);
  });

  it('never touches a file whose name POST /uploads did not give', async () => {
    harness = await makeApp({ now: NOW });
    const id = randomUUID();
    const strangers = [
      put(harness, 'notlar.txt', 30 * DAY),
      put(harness, 'kanit.jpg', 30 * DAY),
      // what scrubUploadDir writes aside before a rename
      put(harness, `${id}.jpg.4242.tmp`, 30 * DAY),
      put(harness, `${id.toUpperCase()}.JPG`, 30 * DAY),
      put(harness, `${id}.gif`, 30 * DAY),
    ];
    const folder = path.join(harness.config.uploadDir, `${randomUUID()}.jpg`);
    fs.mkdirSync(folder);
    age(harness, folder, 30 * DAY);

    const result = await sweepOrphanPhotos(harness.db, harness.config.uploadDir, harness.now());

    expect(result).toEqual({ removed: 0, bytes: 0 });
    for (const file of [...strangers, folder]) expect(fs.existsSync(file)).toBe(true);
  });

  it('has nothing to do when no photo was ever uploaded', async () => {
    harness = await makeApp({ now: NOW });
    const missing = path.join(harness.config.uploadDir, 'yok');
    expect(await sweepOrphanPhotos(harness.db, missing, harness.now())).toEqual({ removed: 0, bytes: 0 });
  });

  it('skips a photo the disk will not let go of, and deletes the rest', async () => {
    harness = await makeApp({ now: NOW });
    const locked = put(harness, photoName(), 30 * DAY);
    const free = put(harness, photoName(), 30 * DAY, 'z'.repeat(1500));
    const unlink = fs.promises.unlink;
    // a photo viewer on Windows holding the file open
    vi.spyOn(fs.promises, 'unlink').mockImplementation((file) =>
      file === locked
        ? Promise.reject(Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }))
        : unlink(file),
    );

    const result = await sweepOrphanPhotos(harness.db, harness.config.uploadDir, harness.now());

    expect(result).toEqual({ removed: 1, bytes: 1500 });
    expect(fs.existsSync(locked)).toBe(true);
    expect(fs.existsSync(free)).toBe(false);
  });
});
