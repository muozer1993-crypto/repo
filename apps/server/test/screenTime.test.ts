/**
 * `POST /me/screen-time` — the Android phone reports its own daily screen
 * minutes and the server fans them out into every open Ekran Süresi çelınc,
 * exactly like steps. Plus the two rules that keep the reading honest: a typed
 * number cannot replace a day the phone reported, and a device reading needs
 * no screenshot.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_TIMEZONE, addDays, todayKey, type Challenge, type ChallengeDetail } from '@koydum/shared';
import { authed, befriend, makeApp, registerUser, type RegisteredUser, type TestApp } from './helpers.js';

let harness: TestApp | null = null;

afterEach(async () => {
  if (harness) {
    await harness.close();
    harness = null;
  }
});

const NOW = '2026-01-05T09:00:00.000Z'; // 12:00 in Europe/Istanbul
const DAY_MS = 24 * 60 * 60 * 1000;

function iso(h: TestApp, offsetMs = 0): string {
  return new Date(h.now().getTime() + offsetMs).toISOString();
}

function today(h: TestApp, tz: string = DEFAULT_TIMEZONE): string {
  return todayKey(tz, h.now());
}

function errorCode(response: { json: () => unknown }): string {
  return (response.json() as { error: { code: string } }).error.code;
}

function entries(h: TestApp, challengeId: string, userId: string): { day_key: string; value: number; source: string; proof_url: string | null }[] {
  return h.db
    .prepare('SELECT day_key, value, source, proof_url FROM entries WHERE challenge_id = ? AND user_id = ? ORDER BY day_key ASC')
    .all(challengeId, userId) as { day_key: string; value: number; source: string; proof_url: string | null }[];
}

interface Pair {
  ali: RegisteredUser;
  veli: RegisteredUser;
  challengeId: string;
}

/** Ali and Veli in a live Ekran Süresi Düellosu. */
async function screenTimePair(h: TestApp, durationDays = 7, startOffsetMs = 0): Promise<Pair> {
  const ali = await registerUser(h.app, 'ali', { displayName: 'Ali' });
  const veli = await registerUser(h.app, 'veli', { displayName: 'Veli' });
  befriend(h.app, ali.me.id, veli.me.id);
  const created = await authed(h.app, ali.token)({
    method: 'POST',
    url: '/challenges',
    payload: {
      typeKey: 'ekran_suresi_beyani',
      startsAt: iso(h, startOffsetMs),
      endsAt: iso(h, startOffsetMs + durationDays * DAY_MS),
      participantIds: [veli.me.id],
    },
  });
  expect(created.statusCode).toBe(201);
  const challengeId = created.json<Challenge>().id;
  expect((await authed(h.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` })).statusCode).toBe(200);
  return { ali, veli, challengeId };
}

describe('POST /me/screen-time', () => {
  it('fans the phone reading out into every open screen-time çelınc, without a screenshot', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await screenTimePair(harness);

    const synced = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/me/screen-time',
      payload: { days: [{ dayKey: today(harness), minutes: 187 }] },
    });
    expect(synced.statusCode).toBe(200);
    expect(synced.json<{ updated: number }>().updated).toBe(1);
    expect(entries(harness, challengeId, ali.me.id)).toEqual([
      { day_key: today(harness), value: 187, source: 'usage_stats', proof_url: null },
    ]);

    // the raw reading is kept regardless of challenges
    const stored = harness.db.prepare('SELECT minutes FROM screen_time_daily WHERE user_id = ? AND day_key = ?').get(ali.me.id, today(harness));
    expect(stored).toEqual({ minutes: 187 });

    // and the detail shows it as the day's value
    const detail = await authed(harness.app, ali.token)({ method: 'GET', url: `/challenges/${challengeId}` });
    expect(detail.json<ChallengeDetail>().myEntries.map((entry) => [entry.dayKey, entry.value, entry.source])).toEqual([
      [today(harness), 187, 'usage_stats'],
    ]);
  });

  it('overwrites the same day on every sync (today keeps growing) and reaches a pending çelınc', async () => {
    harness = await makeApp({ now: NOW });
    // starts in six hours: still today, so `pending` but the window already has today
    const { ali, challengeId } = await screenTimePair(harness, 7, 6 * 60 * 60 * 1000);
    expect(harness.db.prepare('SELECT status FROM challenges WHERE id = ?').get(challengeId)).toEqual({ status: 'pending' });
    const call = authed(harness.app, ali.token);

    await call({ method: 'POST', url: '/me/screen-time', payload: { days: [{ dayKey: today(harness), minutes: 40 }] } });
    harness.advance(2 * 60 * 60 * 1000);
    const again = await call({ method: 'POST', url: '/me/screen-time', payload: { days: [{ dayKey: today(harness), minutes: 95 }] } });
    expect(again.json<{ updated: number }>().updated).toBe(1);
    expect(entries(harness, challengeId, ali.me.id)).toEqual([
      { day_key: today(harness), value: 95, source: 'usage_stats', proof_url: null },
    ]);
  });

  it('skips future days and days older than the device window, but records the reading itself', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await screenTimePair(harness, 20);
    const startDay = today(harness);
    harness.advance(9 * DAY_MS);
    const now = today(harness);

    const synced = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/me/screen-time',
      payload: {
        days: [
          { dayKey: startDay, minutes: 10 }, // 9 days back: beyond the 7-day device window
          { dayKey: addDays(now, 1), minutes: 10 }, // tomorrow
          { dayKey: addDays(now, -3), minutes: 300 }, // three days back: a typed entry could not, the phone can
          { dayKey: now, minutes: 120 },
        ],
      },
    });
    expect(synced.json<{ updated: number }>().updated).toBe(2);
    expect(entries(harness, challengeId, ali.me.id)).toEqual([
      { day_key: addDays(now, -3), value: 300, source: 'usage_stats', proof_url: null },
      { day_key: now, value: 120, source: 'usage_stats', proof_url: null },
    ]);
    const stored = harness.db.prepare('SELECT COUNT(*) AS n FROM screen_time_daily WHERE user_id = ?').get(ali.me.id) as { n: number };
    expect(stored.n).toBe(4);
  });

  it('caps a day at the type maximum and rejects more than a day of minutes outright', async () => {
    harness = await makeApp({ now: NOW });
    const { ali } = await screenTimePair(harness);
    const call = authed(harness.app, ali.token);

    const tooMany = await call({ method: 'POST', url: '/me/screen-time', payload: { days: [{ dayKey: today(harness), minutes: 1441 }] } });
    expect(tooMany.statusCode).toBe(400);

    const fractional = await call({ method: 'POST', url: '/me/screen-time', payload: { days: [{ dayKey: today(harness), minutes: 12.5 }] } });
    expect(fractional.statusCode).toBe(400);

    const todayKeyNow = today(harness);
    const days = Array.from({ length: 15 }, (_, i) => ({ dayKey: addDays(todayKeyNow, -i), minutes: 1 }));
    const tooLong = await call({ method: 'POST', url: '/me/screen-time', payload: { days } });
    expect(tooLong.statusCode).toBe(400);
  });

  it('does not touch challenges of other types', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const veli = await registerUser(harness.app, 'veli');
    befriend(harness.app, ali.me.id, veli.me.id);
    const created = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/challenges',
      payload: { typeKey: 'adim_yarisi', startsAt: iso(harness), endsAt: iso(harness, 3 * DAY_MS), participantIds: [veli.me.id] },
    });
    const stepsId = created.json<Challenge>().id;
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${stepsId}/accept` });

    const synced = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/me/screen-time',
      payload: { days: [{ dayKey: today(harness), minutes: 200 }] },
    });
    expect(synced.json<{ updated: number }>().updated).toBe(0);
    expect(entries(harness, stepsId, ali.me.id)).toEqual([]);
  });
});

describe('usage_stats as an entry source', () => {
  it('is accepted on the entry endpoint for screen time, with no proof, and locks the day against typing', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await screenTimePair(harness);
    const call = authed(harness.app, ali.token);

    const device = await call({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: today(harness), value: 150, source: 'usage_stats', clientTime: iso(harness) },
    });
    expect(device.statusCode).toBe(201);

    // a screenshot-backed typed value may not replace what the phone said
    const typed = await call({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: today(harness), value: 20, source: 'manual', proofUrl: '/uploads/x.jpg', clientTime: iso(harness) },
    });
    expect(typed.statusCode).toBe(409);
    expect(errorCode(typed)).toBe('device_locked');
    expect(entries(harness, challengeId, ali.me.id)).toEqual([
      { day_key: today(harness), value: 150, source: 'usage_stats', proof_url: null },
    ]);

    // the phone, however, may keep correcting itself
    const later = await call({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: today(harness), value: 160, source: 'usage_stats', clientTime: iso(harness) },
    });
    expect(later.statusCode).toBe(200);
    expect(entries(harness, challengeId, ali.me.id)[0]?.value).toBe(160);
  });

  it('lets the phone overwrite a day that was typed earlier (an iPhone that became an Android, or a guess)', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await screenTimePair(harness);
    const call = authed(harness.app, ali.token);

    const typed = await call({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: today(harness), value: 30, source: 'manual', proofUrl: '/uploads/x.jpg', clientTime: iso(harness) },
    });
    expect(typed.statusCode).toBe(201);

    const synced = await call({ method: 'POST', url: '/me/screen-time', payload: { days: [{ dayKey: today(harness), minutes: 240 }] } });
    expect(synced.json<{ updated: number }>().updated).toBe(1);
    expect(entries(harness, challengeId, ali.me.id)).toEqual([
      { day_key: today(harness), value: 240, source: 'usage_stats', proof_url: '/uploads/x.jpg' },
    ]);
  });

  it('is refused on every other metric', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const veli = await registerUser(harness.app, 'veli');
    befriend(harness.app, ali.me.id, veli.me.id);
    const created = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/challenges',
      payload: { typeKey: 'su_bardak', startsAt: iso(harness), endsAt: iso(harness, 3 * DAY_MS), participantIds: [veli.me.id] },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<Challenge>().id;
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${id}/accept` });

    const response = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${id}/entries`,
      payload: { dayKey: today(harness), value: 3, source: 'usage_stats', clientTime: iso(harness) },
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('invalid_source');
  });
});
