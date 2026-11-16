/**
 * POST /uploads and the disk it writes to (src/routes/uploads.ts): a nearly full
 * disk and one that runs out mid-write both answer 507 `disk_full` and leave
 * nothing behind; an hour's photos are capped per client as well as per account
 * (a second account is one registration away, and an IPv6 client is its /64);
 * the whole server takes at most a day's budget of bytes; and the owner hears
 * about a full disk once an hour, not once a photo.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { UPLOADS_PER_USER } from '../src/routes/uploads.js';
import { retryAfterText } from '../src/services/throttle.js';
import { JPEG_1X1, TEST_SECRET, authed, makeApp, multipart, registerUser, type TestApp } from './helpers.js';

const NOW = '2026-01-05T09:00:00.000Z';
const HOUR = 60 * 60 * 1000;
const DISK_FULL = 'Sunucunun diski dolmak üzere, şimdilik fotoğraf alınmıyor. Sunucuyu açan kankana haber ver.';

let harness: TestApp | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  if (harness) {
    await harness.close();
    harness = null;
  }
});

const form = multipart({ filename: 'kanit.jpg', contentType: 'image/jpeg', content: JPEG_1X1 });

function upload(h: TestApp, token: string, remoteAddress = '127.0.0.1') {
  return authed(h.app, token)({ method: 'POST', url: '/uploads', ...form, remoteAddress });
}

function error(response: { json: () => unknown }): { code: string; message: string } {
  return (response.json() as { error: { code: string; message: string } }).error;
}

const stored = (h: TestApp): string[] => fs.readdirSync(h.config.uploadDir);

describe('POST /uploads on a nearly full disk', () => {
  it('turns the photo away with 507 disk_full before storing anything', async () => {
    harness = await makeApp({ now: NOW, config: { uploadMinFreeBytes: Number.MAX_SAFE_INTEGER } });
    const ali = await registerUser(harness.app, 'ali');

    const response = await upload(harness, ali.token);
    expect(response.statusCode).toBe(507);
    expect(error(response)).toEqual({ code: 'disk_full', message: DISK_FULL });
    expect(stored(harness)).toEqual([]);
  });

  it('stores the photo when the system cannot say how much room is left', async () => {
    harness = await makeApp({ now: NOW, config: { uploadMinFreeBytes: Number.MAX_SAFE_INTEGER } });
    const ali = await registerUser(harness.app, 'ali');
    vi.spyOn(fs.promises, 'statfs').mockRejectedValue(Object.assign(new Error('ENOSYS'), { code: 'ENOSYS' }));

    expect((await upload(harness, ali.token)).statusCode).toBe(201);
    expect(stored(harness)).toHaveLength(1);
  });

  it('answers 507 and deletes the half-written file when the disk runs out mid-write', async () => {
    // room for one photo a day: the failed write must give its bytes back
    harness = await makeApp({ now: NOW, config: { uploadDailyBudgetBytes: JPEG_1X1.length } });
    const ali = await registerUser(harness.app, 'ali');
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file) => {
      fs.writeFileSync(file as string, JPEG_1X1.subarray(0, 8));
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    });

    const response = await upload(harness, ali.token);
    expect(response.statusCode).toBe(507);
    expect(error(response).code).toBe('disk_full');
    expect(stored(harness)).toEqual([]);

    vi.restoreAllMocks();
    expect((await upload(harness, ali.token)).statusCode).toBe(201);
  });

  it('still answers 500 for a write that failed for another reason', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    vi.spyOn(fs.promises, 'writeFile').mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));

    expect((await upload(harness, ali.token)).statusCode).toBe(500);
  });

  it("tells the owner once an hour, not once a photo, and not as a request that blew up", async () => {
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koydum-test-'));
    const lines: string[] = [];
    let now = new Date(NOW);
    const built = await buildApp({
      now: () => now,
      config: {
        dataDir: ':memory:',
        dbPath: ':memory:',
        uploadDir,
        uploadMinFreeBytes: Number.MAX_SAFE_INTEGER,
        jwtSecret: TEST_SECRET,
        logLevel: 'info',
        publicUrl: 'http://test.local',
      },
      logStream: { write: (line) => lines.push(line) },
    });
    try {
      await built.app.ready();
      const ali = await registerUser(built.app, 'ali');
      const send = () => authed(built.app, ali.token)({ method: 'POST', url: '/uploads', ...form });
      const said = () =>
        lines
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((entry) => entry.msg === 'disk almost full, uploads refused' || entry.msg === 'request failed');

      expect((await send()).statusCode).toBe(507);
      expect((await send()).statusCode).toBe(507);
      expect(said()).toEqual([
        expect.objectContaining({ msg: 'disk almost full, uploads refused', uploadDir: path.resolve(uploadDir) }),
      ]);
      expect(typeof said()[0]?.freeMb).toBe('number');

      now = new Date(now.getTime() + HOUR);
      expect((await send()).statusCode).toBe(507);
      expect(said()).toHaveLength(2);
    } finally {
      await built.app.close();
      fs.rmSync(uploadDir, { recursive: true, force: true });
    }
  });
});

describe('POST /uploads per-client cap', () => {
  it('counts every account on one address together, and another address apart', async () => {
    harness = await makeApp({ now: NOW });
    const a = await registerUser(harness.app, 'ali');
    const b = await registerUser(harness.app, 'veli');
    const c = await registerUser(harness.app, 'ayse');

    for (let i = 0; i < UPLOADS_PER_USER.max; i += 1) {
      expect((await upload(harness, a.token, '203.0.113.7')).statusCode).toBe(201);
    }
    const blocked = await upload(harness, b.token, '203.0.113.7');
    expect(blocked.statusCode).toBe(429);
    expect(error(blocked)).toEqual({
      code: 'upload_limit',
      message: 'Bu ağdan bir saatte çok fazla fotoğraf yüklendi. 60 dakika sonra tekrar dene.',
    });
    expect((await upload(harness, c.token, '198.51.100.9')).statusCode).toBe(201);

    harness.advance(HOUR + 60_000);
    expect((await upload(harness, b.token, '203.0.113.7')).statusCode).toBe(201);
  });

  it('counts an IPv6 client as its /64', async () => {
    harness = await makeApp({ now: NOW });
    const a = await registerUser(harness.app, 'ali');
    const b = await registerUser(harness.app, 'veli');

    for (let i = 0; i < UPLOADS_PER_USER.max; i += 1) {
      expect((await upload(harness, a.token, `2001:db8:1:2::${(i + 1).toString(16)}`)).statusCode).toBe(201);
    }
    expect((await upload(harness, b.token, '2001:db8:1:2:ffff::1')).statusCode).toBe(429);
    expect((await upload(harness, b.token, '2001:db8:1:3::1')).statusCode).toBe(201);
  });
});

describe('POST /uploads under a burst', () => {
  it('holds the hourly cap for photos sent side by side', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');

    const answers = await Promise.all(Array.from({ length: 100 }, () => upload(harness!, ali.token, '192.0.2.78')));
    const codes = answers.map((answer) => answer.statusCode);
    expect(codes.filter((code) => code === 201)).toHaveLength(UPLOADS_PER_USER.max);
    expect(codes.filter((code) => code === 429)).toHaveLength(100 - UPLOADS_PER_USER.max);
    expect(stored(harness)).toHaveLength(UPLOADS_PER_USER.max);
  });

  it('gives the hour back for a photo it did not store', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const notImage = multipart({ filename: 'x.jpg', contentType: 'image/jpeg', content: Buffer.from('not a photo') });

    for (let i = 0; i < UPLOADS_PER_USER.max; i += 1) {
      const refused = await authed(harness.app, ali.token)({ method: 'POST', url: '/uploads', ...notImage, remoteAddress: '192.0.2.5' });
      expect(refused.statusCode).toBe(400);
    }
    expect((await upload(harness, ali.token, '192.0.2.5')).statusCode).toBe(201);
  });
});

describe('POST /uploads text fields', () => {
  function withFields(count: number, size: number) {
    const boundary = '----koydumfields';
    const fields = Array.from(
      { length: count },
      (_, i) => `--${boundary}\r\nContent-Disposition: form-data; name="f${i}"\r\n\r\n${'x'.repeat(size)}\r\n`,
    ).join('');
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="kanit.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`;
    return {
      payload: Buffer.concat([Buffer.from(fields + head), JPEG_1X1, Buffer.from(`\r\n--${boundary}--\r\n`)]),
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    };
  }

  it('turns away a photo with a pile of text fields in front of it', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');

    const refused = await authed(harness.app, ali.token)({ method: 'POST', url: '/uploads', ...withFields(50, 10) });
    expect(refused.statusCode).toBe(400);
    expect(error(refused)).toEqual({ code: 'too_many_parts', message: 'Fotoğrafın yanında çok fazla alan gönderdin.' });
    expect(stored(harness)).toHaveLength(0);
  });

  it('keeps no more than a kilobyte of a field, and still takes the photo behind it', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');

    const response = await authed(harness.app, ali.token)({ method: 'POST', url: '/uploads', ...withFields(1, 2 * 1024 * 1024) });
    expect(response.statusCode).toBe(201);
    expect(stored(harness)).toHaveLength(1);
  });
});

describe('POST /uploads daily budget', () => {
  it("stops the whole server at the day's bytes, whoever sends them, until the oldest are a day old", async () => {
    harness = await makeApp({ now: NOW, config: { uploadDailyBudgetBytes: 3 * JPEG_1X1.length } });
    const users = await Promise.all(['ali', 'veli', 'ayse', 'can'].map((name) => registerUser(harness!.app, name)));
    const [first, second, third, fourth] = users.map((user) => user.token) as [string, string, string, string];

    expect((await upload(harness, first, '203.0.113.1')).statusCode).toBe(201);
    expect((await upload(harness, second, '203.0.113.2')).statusCode).toBe(201);
    expect((await upload(harness, third, '203.0.113.3')).statusCode).toBe(201);
    const blocked = await upload(harness, fourth, '203.0.113.4');
    expect(blocked.statusCode).toBe(429);
    expect(error(blocked)).toEqual({
      code: 'upload_limit',
      message: 'Sunucu bugün çok fazla fotoğraf aldı. 24 saat sonra tekrar dene.',
    });
    expect(stored(harness)).toHaveLength(3);

    harness.advance(24 * HOUR + 60_000);
    expect((await upload(harness, fourth, '203.0.113.4')).statusCode).toBe(201);
  });
});

describe('retryAfterText', () => {
  it('says seconds, then minutes up to an hour and a half, then hours', () => {
    expect(retryAfterText(12_000)).toBe('12 saniye sonra tekrar dene.');
    expect(retryAfterText(HOUR)).toBe('60 dakika sonra tekrar dene.');
    expect(retryAfterText(90 * 60_000)).toBe('90 dakika sonra tekrar dene.');
    expect(retryAfterText(90 * 60_000 + 1)).toBe('2 saat sonra tekrar dene.');
    expect(retryAfterText(24 * HOUR)).toBe('24 saat sonra tekrar dene.');
  });
});
