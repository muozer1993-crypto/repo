/**
 * `POST /me/screen-time` — the Android phone reports its own daily screen
 * minutes and the server fans them out into every open Ekran Süresi çelınc,
 * exactly like steps. Plus the two rules that keep the reading honest: a typed
 * number cannot replace a day the phone reported, and a device reading needs
 * no screenshot. And the days a player is scored against: today only once it
 * is over, and only the days they could write: from their invite, or from the
 * yes that started a çelınc set for later, never from a yes they sat on.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TIMEZONE,
  addDays,
  todayKey,
  type Challenge,
  type ChallengeDetail,
  type ChallengeResults,
  type ParticipantView,
} from '@koydum/shared';
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

function scores(standings: ParticipantView[]): [string, number, number][] {
  return standings.map((p) => [p.user.username, p.score, p.rank]);
}

async function liveStandings(h: TestApp, user: RegisteredUser, challengeId: string): Promise<ParticipantView[]> {
  const detail = await authed(h.app, user.token)({ method: 'GET', url: `/challenges/${challengeId}` });
  expect(detail.statusCode).toBe(200);
  return detail.json<ChallengeDetail>().participants;
}

/** A screenshot-backed typed number, the way an iPhone enters screen time. */
async function typeMinutes(h: TestApp, user: RegisteredUser, challengeId: string, dayKey: string, value: number): Promise<void> {
  const response = await authed(h.app, user.token)({
    method: 'POST',
    url: `/challenges/${challengeId}/entries`,
    payload: { dayKey, value, source: 'manual', proofUrl: '/uploads/x.jpg', clientTime: iso(h) },
  });
  expect(response.statusCode).toBeLessThan(300);
}

describe('screen-time standings while the çelınc runs', () => {
  it('leaves today out until it is over, so an Android half day at noon does not put the iPhone that types at night behind', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await screenTimePair(harness);
    const dayOne = today(harness);
    await typeMinutes(harness, veli, challengeId, dayOne, 250);

    // day 2, 13:00 in Istanbul: Ali's phone has synced day one and the 40
    // minutes of today so far; Veli types today's tonight
    harness.setNow('2026-01-06T10:00:00.000Z');
    const synced = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/me/screen-time',
      payload: { days: [{ dayKey: dayOne, minutes: 300 }, { dayKey: today(harness), minutes: 40 }] },
    });
    expect(synced.json<{ updated: number }>().updated).toBe(2);

    // (300 + 40) / 2 = 170 would put Ali ahead on a day only half lived
    expect(scores(await liveStandings(harness, ali, challengeId))).toEqual([
      ['veli', 250, 1],
      ['ali', 300, 2],
    ]);

    // typed tonight, today still waits for tomorrow, the same as the phone's
    await typeMinutes(harness, veli, challengeId, today(harness), 50);
    expect(scores(await liveStandings(harness, ali, challengeId))).toEqual([
      ['veli', 250, 1],
      ['ali', 300, 2],
    ]);

    // day 3: day two is over and counts for both
    harness.setNow('2026-01-07T10:00:00.000Z');
    expect(scores(await liveStandings(harness, ali, challengeId))).toEqual([
      ['veli', 150, 1],
      ['ali', 170, 2],
    ]);
  });

  it('shows somebody silent on day one at the worst case, never at a free 0', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await screenTimePair(harness);
    await authed(harness.app, ali.token)({ method: 'POST', url: '/me/screen-time', payload: { days: [{ dayKey: today(harness), minutes: 60 }] } });

    expect(scores(await liveStandings(harness, veli, challengeId))).toEqual([
      ['ali', 60, 1],
      ['veli', 1440, 2],
    ]);
  });
});

describe('screen-time standings once the çelınc is over', () => {
  it('charges an unreported last day even when the end cut it in half', async () => {
    harness = await makeApp({ now: NOW });
    // ends at 18:00 on day 2 in Istanbul; the result comes out the same evening
    const { ali, veli, challengeId } = await screenTimePair(harness, 1 + 6 / 24);
    const dayOne = today(harness);
    await typeMinutes(harness, ali, challengeId, dayOne, 200);
    await typeMinutes(harness, veli, challengeId, dayOne, 100);
    harness.setNow('2026-01-06T12:00:00.000Z');
    await typeMinutes(harness, ali, challengeId, today(harness), 50);

    harness.setNow('2026-01-06T16:30:00.000Z'); // 19:30, still day 2: typing is over
    const advanced = await harness.app.inject({ method: 'POST', url: '/dev/advance' });
    expect(advanced.json<{ finalized: number }>().finalized).toBe(1);

    const results = await authed(harness.app, veli.token)({ method: 'GET', url: `/challenges/${challengeId}/results` });
    expect(scores(results.json<ChallengeResults>().standings)).toEqual([
      ['ali', 125, 1],
      ['veli', 770, 2],
    ]);
  });
});

/** Start of the screen-time çelınc below: 12:00 on 2026-01-05 in Istanbul. */
const TRIO_START = NOW;
/** The last millisecond of 2026-01-11 in Istanbul: seven whole days. */
const TRIO_END = '2026-01-11T20:59:59.999Z';

/** Noon in Istanbul on day `n` (1-based) of the çelınc. */
function noonOfDay(n: number): string {
  return new Date(Date.parse(TRIO_START) + (n - 1) * DAY_MS).toISOString();
}

/** Ali and Veli in a seven-day Ekran Süresi Düellosu; Can is Ali's friend, not in it yet. */
async function screenTimeTrio(h: TestApp): Promise<Pair & { can: RegisteredUser }> {
  const ali = await registerUser(h.app, 'ali', { displayName: 'Ali' });
  const veli = await registerUser(h.app, 'veli', { displayName: 'Veli' });
  const can = await registerUser(h.app, 'can', { displayName: 'Can' });
  befriend(h.app, ali.me.id, veli.me.id);
  befriend(h.app, ali.me.id, can.me.id);
  const created = await authed(h.app, ali.token)({
    method: 'POST',
    url: '/challenges',
    payload: { typeKey: 'ekran_suresi_beyani', startsAt: TRIO_START, endsAt: TRIO_END, participantIds: [veli.me.id] },
  });
  expect(created.statusCode).toBe(201);
  const challengeId = created.json<Challenge>().id;
  expect((await authed(h.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` })).statusCode).toBe(200);
  return { ali, veli, can, challengeId };
}

/** Ali brings Can in with "Kanka ekle" and Can says "Varım". */
async function bringIn(h: TestApp, pair: Pair & { can: RegisteredUser }): Promise<void> {
  const invited = await authed(h.app, pair.ali.token)({
    method: 'POST',
    url: `/challenges/${pair.challengeId}/invite`,
    payload: { userIds: [pair.can.me.id] },
  });
  expect(invited.statusCode).toBe(200);
  const accepted = await authed(h.app, pair.can.token)({ method: 'POST', url: `/challenges/${pair.challengeId}/accept` });
  expect(accepted.statusCode).toBe(200);
}

describe('a friend who joined a screen-time çelınc late', () => {
  it('is scored from the first day the app let them type, and can win', async () => {
    harness = await makeApp({ now: TRIO_START });
    const trio = await screenTimeTrio(harness);
    const { ali, veli, can, challengeId } = trio;

    for (let day = 1; day <= 7; day += 1) {
      harness.setNow(noonOfDay(day));
      if (day === 4) {
        await bringIn(harness, trio);
        // the entry picker offers today and yesterday, no further
        await typeMinutes(harness, can, challengeId, addDays(today(harness), -1), 100);
      }
      await typeMinutes(harness, ali, challengeId, today(harness), 200);
      await typeMinutes(harness, veli, challengeId, today(harness), 200);
      if (day >= 4) await typeMinutes(harness, can, challengeId, today(harness), 100);
    }

    // past the end and the hour the phones get to report screen time
    harness.setNow(new Date(Date.parse(TRIO_END) + 2 * 60 * 60 * 1000));
    const advanced = await harness.app.inject({ method: 'POST', url: '/dev/advance' });
    expect(advanced.json<{ finalized: number }>().finalized).toBe(1);

    // Days 1 and 2 were never Can's to write: charged 1440 each, he would
    // average 483 and finish last with the best week of the three.
    const results = await authed(harness.app, can.token)({ method: 'GET', url: `/challenges/${challengeId}/results` });
    const standings = results.json<ChallengeResults>().standings;
    expect(scores(standings)).toEqual([
      ['can', 100, 1],
      ['ali', 200, 2],
      ['veli', 200, 2],
    ]);
    expect(standings[0]?.isWinner).toBe(true);
  });

  it('drops what an Android phone synced for the days before that, instead of averaging it in', async () => {
    harness = await makeApp({ now: TRIO_START });
    const trio = await screenTimeTrio(harness);
    const { ali, veli, can, challengeId } = trio;

    for (let day = 1; day <= 4; day += 1) {
      harness.setNow(noonOfDay(day));
      await typeMinutes(harness, ali, challengeId, today(harness), 200);
      await typeMinutes(harness, veli, challengeId, today(harness), 200);
    }
    await bringIn(harness, trio);
    // the first sync after joining reports the whole week the phone remembers
    const dayFour = today(harness);
    const days = [600, 600, 100, 100].map((minutes, i) => ({ dayKey: addDays(dayFour, i - 3), minutes }));
    const synced = await authed(harness.app, can.token)({ method: 'POST', url: '/me/screen-time', payload: { days } });
    expect(synced.json<{ updated: number }>().updated).toBe(4);
    expect(entries(harness, challengeId, can.me.id)).toHaveLength(4);

    // only yesterday counts (today joins tomorrow): (600 + 600 + 100) / 3 would be 433
    const standings = await liveStandings(harness, can, challengeId);
    expect(scores(standings)).toEqual([
      ['can', 100, 1],
      ['ali', 200, 2],
      ['veli', 200, 2],
    ]);
    expect(standings.find((p) => p.user.id === can.me.id)?.days).toBe(1);
  });
});

describe('an invitee who waits to say yes', () => {
  it('is scored over the whole window, so sitting on the invite cannot drop the bad days', async () => {
    harness = await makeApp({ now: TRIO_START });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    befriend(harness.app, ali.me.id, veli.me.id);
    const created = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/challenges',
      payload: { typeKey: 'ekran_suresi_beyani', startsAt: TRIO_START, endsAt: TRIO_END, participantIds: [veli.me.id] },
    });
    expect(created.statusCode).toBe(201);
    const challengeId = created.json<Challenge>().id;

    // Veli's phone reports every day while he watches the standings: five bad
    // days, then two good ones
    for (let day = 1; day <= 7; day += 1) {
      harness.setNow(noonOfDay(day));
      await typeMinutes(harness, ali, challengeId, today(harness), 200);
      const synced = await authed(harness.app, veli.token)({
        method: 'POST',
        url: '/me/screen-time',
        payload: { days: [{ dayKey: today(harness), minutes: day <= 5 ? 400 : 100 }] },
      });
      expect(synced.statusCode).toBe(200);
    }

    // day 7, 22:30 in Istanbul, just before the door closes
    harness.setNow('2026-01-11T19:30:00.000Z');
    const accepted = await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    expect(accepted.statusCode).toBe(200);
    expect(entries(harness, challengeId, veli.me.id)).toHaveLength(7);

    harness.setNow(new Date(Date.parse(TRIO_END) + 2 * 60 * 60 * 1000));
    const advanced = await harness.app.inject({ method: 'POST', url: '/dev/advance' });
    expect(advanced.json<{ finalized: number }>().finalized).toBe(1);

    // scored from day 6 he would win on 100; over the week he averages 314
    const results = await authed(harness.app, veli.token)({ method: 'GET', url: `/challenges/${challengeId}/results` });
    const standings = results.json<ChallengeResults>().standings;
    expect(standings.map((p) => [p.user.username, p.rank])).toEqual([
      ['ali', 1],
      ['veli', 2],
    ]);
    expect(standings[1]?.score).toBeCloseTo((5 * 400 + 2 * 100) / 7, 2);
    expect(standings[1]?.days).toBe(7);
  });
});

describe('a screen-time çelınc set for later that waited for a yes', () => {
  /** 00:00 on 2026-01-06 in Istanbul, the day after creation; seven whole days. */
  const LATER_START = '2026-01-05T21:00:00.000Z';
  const LATER_END = '2026-01-12T20:59:59.999Z';
  /** Noon in Istanbul on day `n` (1-based) of it. */
  const noonOf = (n: number): string => new Date(Date.parse('2026-01-06T09:00:00.000Z') + (n - 1) * DAY_MS).toISOString();

  it('charges nobody, its creator included, for the days before it could be played', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    befriend(harness.app, ali.me.id, veli.me.id);
    const created = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/challenges',
      payload: { typeKey: 'ekran_suresi_beyani', startsAt: LATER_START, endsAt: LATER_END, participantIds: [veli.me.id] },
    });
    expect(created.statusCode).toBe(201);
    const challengeId = created.json<Challenge>().id;

    // day 1 goes by `pending`: nobody said yes, and Ali's number is refused
    harness.setNow(noonOf(1));
    await harness.app.inject({ method: 'POST', url: '/dev/advance' });
    const refused = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: today(harness), value: 100, source: 'manual', proofUrl: '/uploads/x.jpg', clientTime: iso(harness) },
    });
    expect(errorCode(refused)).toBe('challenge_not_active');

    // day 3 at noon Veli says "Varım" and the scheduler starts it
    harness.setNow(noonOf(3));
    expect((await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` })).statusCode).toBe(200);
    await harness.app.inject({ method: 'POST', url: '/dev/advance' });

    // from here both write every day they can, yesterday included
    for (let day = 3; day <= 7; day += 1) {
      harness.setNow(noonOf(day));
      if (day === 3) {
        await typeMinutes(harness, ali, challengeId, addDays(today(harness), -1), 100);
        await typeMinutes(harness, veli, challengeId, addDays(today(harness), -1), 200);
      }
      await typeMinutes(harness, ali, challengeId, today(harness), 100);
      await typeMinutes(harness, veli, challengeId, today(harness), 200);
    }

    harness.setNow(new Date(Date.parse(LATER_END) + 2 * 60 * 60 * 1000));
    const advanced = await harness.app.inject({ method: 'POST', url: '/dev/advance' });
    expect(advanced.json<{ finalized: number }>().finalized).toBe(1);

    // with day 1 at 1440 for Ali alone he would lose on (1440 + 600) / 7 = 291
    const results = await authed(harness.app, ali.token)({ method: 'GET', url: `/challenges/${challengeId}/results` });
    const standings = results.json<ChallengeResults>().standings;
    expect(scores(standings)).toEqual([
      ['ali', 100, 1],
      ['veli', 200, 2],
    ]);
    expect(standings.map((p) => p.days)).toEqual([6, 6]);
  });
});

describe('a friend brought in late in the evening', () => {
  it('can still type the first scored day the next day', async () => {
    harness = await makeApp({ now: TRIO_START });
    const trio = await screenTimeTrio(harness);
    const { ali, veli, can, challengeId } = trio;

    for (let day = 1; day <= 7; day += 1) {
      harness.setNow(noonOfDay(day));
      await typeMinutes(harness, ali, challengeId, today(harness), 200);
      await typeMinutes(harness, veli, challengeId, today(harness), 200);
      if (day >= 5) await typeMinutes(harness, can, challengeId, today(harness), 100);
      if (day === 4) {
        // 23:40 in Istanbul: "Kanka ekle" and a yes, too late to type yesterday tonight
        harness.setNow(new Date(Date.parse(noonOfDay(4)) + (11 * 60 + 40) * 60 * 1000));
        await bringIn(harness, trio);
        await typeMinutes(harness, can, challengeId, today(harness), 100);
      }
      if (day === 5) {
        // the morning after: day 3, the first day he is scored from, two days back
        await typeMinutes(harness, can, challengeId, addDays(today(harness), -2), 100);
      }
    }

    harness.setNow(new Date(Date.parse(TRIO_END) + 2 * 60 * 60 * 1000));
    const advanced = await harness.app.inject({ method: 'POST', url: '/dev/advance' });
    expect(advanced.json<{ finalized: number }>().finalized).toBe(1);

    const results = await authed(harness.app, can.token)({ method: 'GET', url: `/challenges/${challengeId}/results` });
    const standings = results.json<ChallengeResults>().standings;
    expect(scores(standings)).toEqual([
      ['can', 100, 1],
      ['ali', 200, 2],
      ['veli', 200, 2],
    ]);
    expect(standings[0]?.days).toBe(5);
  });
});
