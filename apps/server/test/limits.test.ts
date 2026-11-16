/**
 * How much a request may make the server do. One process serves every friend, so a
 * body that keeps it parsing for seconds is the server going down for all of them:
 * a 3 MB list of `{}` to /me/screen-time held it for 14 s and answered with 279 MB,
 * and a few MB of `[[[...]]]` to /auth/login needed no account at all.
 *
 * The sizes here stay small on purpose: just over the limit, never the real thing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LIMITS, type Challenge, type ChallengeDetail } from '@koydum/shared';
import { JSON_BODY_LIMIT } from '../src/app.js';
import { MAX_ISSUES } from '../src/errors.js';
import { JPEG_1X1, authed, befriend, makeApp, multipart, registerUser, type TestApp } from './helpers.js';

let harness: TestApp | null = null;

afterEach(async () => {
  if (harness) {
    await harness.close();
    harness = null;
  }
});

const NOW = '2026-01-05T09:00:00.000Z';
const JSON_HEADERS = { 'content-type': 'application/json' };

/** `{"days":[{},{},...]}`: every item wrong, as cheap to send as a list gets. */
const emptyDays = (count: number): string => `{"days":[${Array.from({ length: count }, () => '{}').join(',')}]}`;

interface ErrorReply {
  error: { code: string; message: string; issues?: unknown[] };
}

describe('JSON body limit', () => {
  it('turns away a body over 64 KB before reading it', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const payload = emptyDays(100_000);
    expect(payload.length).toBeGreaterThan(JSON_BODY_LIMIT);

    const response = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/me/screen-time',
      headers: JSON_HEADERS,
      payload,
    });
    expect(response.statusCode).toBe(413);
    expect(response.json<ErrorReply>().error).toEqual({ code: 'body_too_large', message: 'Gönderdiğin veri çok büyük.' });
  });

  it('turns it away without an account too', async () => {
    harness = await makeApp({ now: NOW });
    const depth = 50 * 1024;
    const response = await harness.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: JSON_HEADERS,
      payload: `${'['.repeat(depth)}${']'.repeat(depth)}`,
    });
    expect(response.statusCode).toBe(413);
    expect(response.json<ErrorReply>().error.code).toBe('body_too_large');
  });

  it.each(['/me/screen-time', '/me/steps'])('answers a list of junk under the limit with one short 400 (%s)', async (url) => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const payload = emptyDays(20_000);
    expect(payload.length).toBeLessThan(JSON_BODY_LIMIT);

    const response = await authed(harness.app, ali.token)({ method: 'POST', url, headers: JSON_HEADERS, payload });
    expect(response.statusCode).toBe(400);
    const { error } = response.json<ErrorReply>();
    expect(error.code).toBe('validation');
    expect(error.issues?.length).toBeLessThanOrEqual(MAX_ISSUES);
    // every item an issue of its own came back as megabytes
    expect(response.body.length).toBeLessThan(10_000);
  });

  it(`lists at most ${MAX_ISSUES} issues`, async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    // `?status=` is a list nothing caps: each wrong name is an issue
    const status = Array.from({ length: 500 }, (_, i) => `yok${i}`).join(',');

    const response = await authed(harness.app, ali.token)({ method: 'GET', url: `/challenges?status=${status}` });
    expect(response.statusCode).toBe(400);
    const { error } = response.json<ErrorReply>();
    expect(error.code).toBe('validation');
    expect(error.issues).toHaveLength(MAX_ISSUES);
  });
});

describe('the biggest bodies the apps really send', () => {
  it('marks 500 notifications read in one go', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    // the longest ids the schema takes, so no list it accepts can weigh more
    const ids = Array.from({ length: 500 }, (_, i) => String(i).padStart(64, 'x'));
    const payload = JSON.stringify({ ids });
    expect(payload.length).toBeLessThan(JSON_BODY_LIMIT);

    const response = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/me/inbox/read',
      headers: JSON_HEADERS,
      payload,
    });
    expect(response.statusCode).toBe(200);
  });

  it(`opens a çelınc with ${LIMITS.PARTICIPANTS_MAX} friends and the longest stakes`, async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const participantIds: string[] = [];
    for (let i = 0; i < LIMITS.PARTICIPANTS_MAX; i += 1) {
      const friend = await registerUser(harness.app, `kanka${i}`);
      befriend(harness.app, ali.me.id, friend.me.id);
      participantIds.push(friend.me.id);
    }

    const response = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/challenges',
      payload: {
        typeKey: 'adim_yarisi',
        title: 'ş'.repeat(LIMITS.CHALLENGE_TITLE_MAX),
        startsAt: harness.now().toISOString(),
        endsAt: new Date(harness.now().getTime() + 3 * 24 * 60 * 60 * 1000).toISOString(),
        participantIds,
        rewardText: '🍆'.repeat(LIMITS.REWARD_TEXT_MAX / 2),
      },
    });
    expect(response.statusCode).toBe(201);
    const id = response.json<Challenge>().id;
    const detail = await authed(harness.app, ali.token)({ method: 'GET', url: `/challenges/${id}` });
    expect(detail.json<ChallengeDetail>().participants).toHaveLength(LIMITS.PARTICIPANTS_MAX + 1);
  });

  it('still takes a proof photo far over 64 KB: multipart has its own limit', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    // two comment segments right after SOI; the upload strips them back to JPEG_1X1
    const comment = (size: number): Buffer => {
      const head = Buffer.from([0xff, 0xfe, 0, 0]);
      head.writeUInt16BE(size + 2, 2);
      return Buffer.concat([head, Buffer.alloc(size, 0x20)]);
    };
    const photo = Buffer.concat([JPEG_1X1.subarray(0, 2), comment(50_000), comment(50_000), JPEG_1X1.subarray(2)]);
    expect(photo.length).toBeGreaterThan(JSON_BODY_LIMIT);

    const form = multipart({ filename: 'kanit.jpg', contentType: 'image/jpeg', content: photo });
    const response = await authed(harness.app, ali.token)({ method: 'POST', url: '/uploads', ...form });
    expect(response.statusCode).toBe(201);
    const stored = path.join(harness.config.uploadDir, path.basename(response.json<{ url: string }>().url));
    expect(fs.readFileSync(stored).equals(JPEG_1X1)).toBe(true);
  });
});
