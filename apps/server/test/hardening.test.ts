/**
 * Regression tests for the review findings — one `describe` per fix.
 *
 * Every case here reproduces a concrete exploit or wrong answer that shipped once:
 * a blocked user erasing the victim's block, a step sync banking future days, a
 * timezone hop rescuing a late check-in, a rejected entry laundered by deleting it,
 * a cross-timezone penalty for a day the API refuses, and so on.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TIMEZONE,
  addDays,
  t,
  todayKey,
  type Challenge,
  type ChallengeDetail,
  type ChallengeResults,
  type Entry,
  type Notification,
  type ParticipantView,
  type PublicUser,
  type TauntTemplate,
} from '@koydum/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { notify } from '../src/services/notifications.js';
import { computeUserStats } from '../src/services/stats.js';
import { AttemptLimiter } from '../src/services/throttle.js';
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

interface Pair {
  ali: RegisteredUser;
  veli: RegisteredUser;
  challengeId: string;
}

/** Two friends, both accepted, in a challenge that is live right now. */
async function livePair(
  h: TestApp,
  typeKey: string,
  extra: Record<string, unknown> = {},
  durationDays = 3,
): Promise<Pair> {
  const ali = await registerUser(h.app, 'ali', { displayName: 'Ali' });
  const veli = await registerUser(h.app, 'veli', { displayName: 'Veli' });
  befriend(h.app, ali.me.id, veli.me.id);

  const created = await authed(h.app, ali.token)({
    method: 'POST',
    url: '/challenges',
    payload: {
      typeKey,
      startsAt: iso(h),
      endsAt: iso(h, durationDays * DAY_MS),
      participantIds: [veli.me.id],
      ...extra,
    },
  });
  expect(created.statusCode).toBe(201);
  const challengeId = created.json<Challenge>().id;
  expect((await authed(h.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` })).statusCode).toBe(200);
  return { ali, veli, challengeId };
}

function entries(h: TestApp, challengeId: string, userId: string): { day_key: string; value: number; status: string; session_id: string | null }[] {
  return h.db
    .prepare('SELECT day_key, value, status, session_id FROM entries WHERE challenge_id = ? AND user_id = ? ORDER BY day_key ASC')
    .all(challengeId, userId) as { day_key: string; value: number; status: string; session_id: string | null }[];
}

// ---------------------------------------------------------------------------
// POST /me/steps — SPEC 2.2 fan-out and SPEC 2.3 day rules
// ---------------------------------------------------------------------------

describe('POST /me/steps', () => {
  it('fans out into a pending challenge whose window already contains the day', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const veli = await registerUser(harness.app, 'veli');
    befriend(harness.app, ali.me.id, veli.me.id);

    // Starts at 18:00 local — still today, but the challenge is `pending`.
    const created = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/challenges',
      payload: {
        typeKey: 'adim_yarisi',
        startsAt: iso(harness, 6 * 60 * 60 * 1000),
        endsAt: iso(harness, 3 * DAY_MS),
        participantIds: [veli.me.id],
      },
    });
    const challengeId = created.json<Challenge>().id;
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    expect(harness.db.prepare('SELECT status FROM challenges WHERE id = ?').get(challengeId)).toEqual({ status: 'pending' });

    const synced = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/me/steps',
      payload: { days: [{ dayKey: today(harness), steps: 8000, source: 'pedometer' }] },
    });
    expect(synced.statusCode).toBe(200);
    expect(synced.json<{ updated: number }>().updated).toBe(1);
    expect(entries(harness, challengeId, ali.me.id)).toEqual([
      { day_key: today(harness), value: 8000, status: 'ok', session_id: null },
    ]);
  });

  it('never banks a future day or one past the backfill limit', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await livePair(harness, 'adim_yarisi', {}, 20);
    const startDay = today(harness);

    harness.advance(9 * DAY_MS);
    const now = today(harness);

    const synced = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/me/steps',
      payload: {
        days: [
          { dayKey: startDay, steps: 90_000, source: 'pedometer' }, // 9 days back: beyond the 7-day window
          { dayKey: addDays(now, 1), steps: 90_000, source: 'pedometer' }, // tomorrow
          { dayKey: addDays(now, 5), steps: 90_000, source: 'pedometer' }, // next week
          { dayKey: now, steps: 4_000, source: 'pedometer' },
        ],
      },
    });
    expect(synced.json<{ updated: number }>().updated).toBe(1);
    expect(entries(harness, challengeId, ali.me.id)).toEqual([
      { day_key: now, value: 4_000, status: 'ok', session_id: null },
    ]);

    // steps_daily still records everything the phone reported — only the challenge
    // fan-out is gated.
    const stored = harness.db.prepare('SELECT COUNT(*) AS n FROM steps_daily WHERE user_id = ?').get(ali.me.id) as { n: number };
    expect(stored.n).toBe(4);

    // The entry endpoint answers the same way for the same days.
    const future = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: addDays(now, 1), value: 5_000, source: 'pedometer', clientTime: iso(harness) },
    });
    expect(errorCode(future)).toBe('day_in_future');
    const old = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: startDay, value: 5_000, source: 'pedometer', clientTime: iso(harness) },
    });
    expect(errorCode(old)).toBe('day_too_old');
  });
});

// ---------------------------------------------------------------------------
// Check-in verdict is pinned to the timezone the player joined with
// ---------------------------------------------------------------------------

describe('checkin_deadline', () => {
  it('does not let a PATCH /me timezone hop turn a late check-in into an on-time one', async () => {
    harness = await makeApp({ now: NOW }); // 12:00 Istanbul, 04:00 New York
    const { ali, challengeId } = await livePair(harness, 'erken_kus', { deadlineTime: '07:00' }, 5);
    const call = authed(harness.app, ali.token);

    const moved = await call({ method: 'PATCH', url: '/me', payload: { timezone: 'America/New_York' } });
    expect(moved.statusCode).toBe(200);

    const checkin = await call({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: today(harness), value: 1, source: 'checkin', clientTime: iso(harness) },
    });
    expect(checkin.statusCode).toBe(201);
    const entry = checkin.json<{ entry: Entry; standings: ParticipantView[] }>();
    expect(entry.entry.value).toBe(0);
    expect(entry.entry.late).toBe(true);
    expect(entry.standings.find((p) => p.user.id === ali.me.id)?.score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Disputed entries cannot be laundered away
// ---------------------------------------------------------------------------

describe('DELETE /challenges/:id/entries/:entryId', () => {
  it('refuses to delete an entry an upheld dispute rejected', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await livePair(harness, 'sigara_yok', {}, 5);
    const aliCall = authed(harness.app, ali.token);

    const created = await aliCall({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: today(harness), value: 1, source: 'manual', clientTime: iso(harness) },
    });
    const entryId = created.json<{ entry: Entry }>().entry.id;

    const disputed = await authed(harness.app, veli.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${entryId}/dispute`,
      payload: { reason: 'Dün seni sigara içerken gördüm' },
    });
    expect(disputed.statusCode).toBe(201);
    expect(disputed.json<{ upheld: boolean; entry: Entry }>().upheld).toBe(true);
    expect(computeUserStats(harness.db, veli.me.id, harness.now()).disputesWon).toBe(1);

    const removed = await aliCall({ method: 'DELETE', url: `/challenges/${challengeId}/entries/${entryId}` });
    expect(removed.statusCode).toBe(400);
    expect(errorCode(removed)).toBe('entry_disputed');

    // Nothing was laundered: the row, its dispute and the score all stand.
    const again = await aliCall({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: today(harness), value: 1, source: 'manual', clientTime: iso(harness) },
    });
    expect(again.json<{ entry: Entry }>().entry.status).toBe('rejected');
    expect(again.json<{ standings: ParticipantView[] }>().standings.find((p) => p.user.id === ali.me.id)?.score).toBe(0);
    expect(harness.db.prepare('SELECT COUNT(*) AS n FROM disputes').get()).toEqual({ n: 1 });
    expect(computeUserStats(harness.db, veli.me.id, harness.now()).disputesWon).toBe(1);
  });

  it('refuses to delete an entry that is still under dispute', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const others = [] as RegisteredUser[];
    for (const name of ['veli', 'cem', 'deniz']) {
      const user = await registerUser(harness.app, name);
      befriend(harness.app, ali.me.id, user.me.id);
      others.push(user);
    }

    const created = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/challenges',
      payload: {
        typeKey: 'sigara_yok',
        startsAt: iso(harness),
        endsAt: iso(harness, 5 * DAY_MS),
        participantIds: others.map((u) => u.me.id),
      },
    });
    const challengeId = created.json<Challenge>().id;
    for (const user of others) {
      await authed(harness.app, user.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    }

    const entry = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: today(harness), value: 1, source: 'manual', clientTime: iso(harness) },
    });
    const entryId = entry.json<{ entry: Entry }>().entry.id;

    // Four accepted players: one dispute is not yet a majority, so the entry only
    // becomes `disputed` — and even that is enough to freeze it.
    const disputed = await authed(harness.app, others[0]!.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${entryId}/dispute`,
      payload: { reason: 'Dumanı üstünde gördüm' },
    });
    expect(disputed.json<{ upheld: boolean; entry: Entry }>().upheld).toBe(false);
    expect(disputed.json<{ entry: Entry }>().entry.status).toBe('disputed');

    const removed = await authed(harness.app, ali.token)({ method: 'DELETE', url: `/challenges/${challengeId}/entries/${entryId}` });
    expect(removed.statusCode).toBe(400);
    expect(errorCode(removed)).toBe('entry_disputed');
    expect(harness.db.prepare('SELECT COUNT(*) AS n FROM disputes').get()).toEqual({ n: 1 });
  });
});

// ---------------------------------------------------------------------------
// A block belongs to the person who placed it
// ---------------------------------------------------------------------------

describe('blocks', () => {
  it('survives the blocked user blocking back and unblocking', async () => {
    harness = await makeApp({ now: NOW });
    const victim = await registerUser(harness.app, 'kurban', { displayName: 'Kurban' });
    const stalker = await registerUser(harness.app, 'takipci', { displayName: 'Takipci' });
    const victimCall = authed(harness.app, victim.token);
    const stalkerCall = authed(harness.app, stalker.token);

    expect((await victimCall({ method: 'POST', url: `/users/${stalker.me.id}/block` })).statusCode).toBe(200);
    expect((await stalkerCall({ method: 'POST', url: `/users/${victim.me.id}/block` })).statusCode).toBe(200);
    expect((await stalkerCall({ method: 'POST', url: `/users/${victim.me.id}/unblock` })).statusCode).toBe(200);

    // The victim's own block is still standing after the round trip.
    const rows = harness.db
      .prepare('SELECT requester_id, addressee_id, status FROM friendships')
      .all() as { requester_id: string; addressee_id: string; status: string }[];
    expect(rows).toEqual([{ requester_id: victim.me.id, addressee_id: stalker.me.id, status: 'blocked' }]);

    const search = await stalkerCall({ method: 'GET', url: '/users/search?q=kurban' });
    expect(search.json<PublicUser[]>()).toHaveLength(0);
    expect((await stalkerCall({ method: 'GET', url: `/users/${victim.me.id}` })).statusCode).toBe(404);
    const request = await stalkerCall({ method: 'POST', url: '/friends/request', payload: { username: 'kurban' } });
    expect(request.statusCode).toBe(403);
    expect(errorCode(request)).toBe('blocked');

    // Only the victim can lift it.
    expect((await victimCall({ method: 'POST', url: `/users/${stalker.me.id}/unblock` })).statusCode).toBe(200);
    expect((await stalkerCall({ method: 'GET', url: '/users/search?q=kurban' })).json<PublicUser[]>()).toHaveLength(1);
  });

  it('tears down a friendship but keeps the other side out of my row', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const veli = await registerUser(harness.app, 'veli');
    befriend(harness.app, ali.me.id, veli.me.id);

    await authed(harness.app, ali.token)({ method: 'POST', url: `/users/${veli.me.id}/block` });
    const rows = harness.db.prepare('SELECT requester_id, status FROM friendships').all() as { requester_id: string; status: string }[];
    expect(rows).toEqual([{ requester_id: ali.me.id, status: 'blocked' }]);
  });
});

// ---------------------------------------------------------------------------
// Social writes go through the same block gate as an invite
// ---------------------------------------------------------------------------

/** Ali wins a step race against Veli and the challenge is finished. */
async function finishedPair(h: TestApp): Promise<Pair> {
  const pair = await livePair(h, 'adim_yarisi', {}, 3);
  await authed(h.app, pair.ali.token)({
    method: 'POST',
    url: `/challenges/${pair.challengeId}/entries`,
    payload: { dayKey: today(h), value: 12_000, source: 'pedometer', clientTime: iso(h) },
  });
  const finished = await h.app.inject({ method: 'POST', url: `/dev/finalize/${pair.challengeId}` });
  expect(finished.statusCode).toBe(200);
  expect(h.db.prepare('SELECT winner_id FROM challenges WHERE id = ?').get(pair.challengeId)).toEqual({
    winner_id: pair.ali.me.id,
  });
  return pair;
}

describe('poke / taunt / rematch across a block', () => {
  it('refuses a poke into a blocked pair', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await livePair(harness, 'adim_yarisi');

    await authed(harness.app, veli.token)({ method: 'POST', url: `/users/${ali.me.id}/block` });
    const poke = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/poke`,
      payload: { toUserId: veli.me.id },
    });
    expect(poke.statusCode).toBe(403);
    expect(errorCode(poke)).toBe('blocked');
    expect(harness.db.prepare('SELECT COUNT(*) AS n FROM pokes').get()).toEqual({ n: 0 });
  });

  it('refuses a taunt and a rematch after the loser blocked the winner', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await finishedPair(harness);
    const aliCall = authed(harness.app, ali.token);

    await authed(harness.app, veli.token)({ method: 'POST', url: `/users/${ali.me.id}/block` });

    const taunt = await aliCall({
      method: 'POST',
      url: `/challenges/${challengeId}/taunt`,
      payload: { toUserId: veli.me.id, templateId: 'l2_win_01' },
    });
    expect(taunt.statusCode).toBe(403);
    expect(errorCode(taunt)).toBe('blocked');

    const rematch = await aliCall({ method: 'POST', url: `/challenges/${challengeId}/rematch` });
    expect(rematch.statusCode).toBe(400);
    expect(errorCode(rematch)).toBe('no_participants');

    // Nothing was created and nothing was pushed at the blocker.
    expect(harness.db.prepare('SELECT COUNT(*) AS n FROM challenges').get()).toEqual({ n: 1 });
    const inbox = await authed(harness.app, veli.token)({ method: 'GET', url: '/me/inbox' });
    expect(inbox.json<Notification[]>().some((n) => n.type === 'rematch' || n.type === 'taunt')).toBe(false);
  });

  it('still rematches the friends who are left', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await finishedPair(harness);
    const rematch = await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` });
    expect(rematch.statusCode).toBe(201);
    const created = rematch.json<Challenge>();
    expect(created.rematchOfId).toBe(challengeId);
    const invited = harness.db
      .prepare('SELECT status FROM challenge_participants WHERE challenge_id = ? AND user_id = ?')
      .get(created.id, veli.me.id);
    expect(invited).toEqual({ status: 'invited' });
  });
});

// ---------------------------------------------------------------------------
// A stranger cannot tell an existing challenge from a made-up id
// ---------------------------------------------------------------------------

describe('POST /challenges/:id/entries', () => {
  it('answers 404 for an outsider, exactly like a made-up id', async () => {
    harness = await makeApp({ now: NOW });
    const { challengeId } = await livePair(harness, 'adim_yarisi');
    const outsider = await registerUser(harness.app, 'yabanci');
    const call = authed(harness.app, outsider.token);
    const payload = { dayKey: today(harness), value: 1_000, source: 'pedometer', clientTime: iso(harness) };

    const real = await call({ method: 'POST', url: `/challenges/${challengeId}/entries`, payload });
    expect(real.statusCode).toBe(404);
    expect(errorCode(real)).toBe('challenge_not_found');

    const fake = await call({ method: 'POST', url: `/challenges/${randomUUID()}/entries`, payload });
    expect(fake.statusCode).toBe(404);
    expect(errorCode(fake)).toBe('challenge_not_found');
  });
});

// ---------------------------------------------------------------------------
// Cross-timezone scoring: nobody is charged for a day they cannot log
// ---------------------------------------------------------------------------

describe('manual_lower_is_better across timezones', () => {
  it('scores every player against their own day window', async () => {
    harness = await makeApp({ now: '2026-01-05T00:30:00.000Z' }); // 03:30 Istanbul, 00:30 London
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali', timezone: 'Europe/Istanbul' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli', timezone: 'Europe/London' });
    befriend(harness.app, ali.me.id, veli.me.id);

    const created = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/challenges',
      payload: {
        typeKey: 'ekran_suresi_beyani',
        startsAt: '2026-01-05T00:30:00.000Z',
        endsAt: '2026-01-06T23:30:00.000Z',
        participantIds: [veli.me.id],
      },
    });
    const challengeId = created.json<Challenge>().id;
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });

    // Late enough that both players can still write their own last day.
    harness.setNow('2026-01-06T23:00:00.000Z'); // 02:00 on 01-07 in Istanbul, 23:00 on 01-06 in London
    const log = (user: RegisteredUser, dayKey: string, value: number) =>
      authed(harness!.app, user.token)({
        method: 'POST',
        url: `/challenges/${challengeId}/entries`,
        payload: {
          dayKey,
          value,
          source: 'manual',
          clientTime: iso(harness!),
          proofUrl: 'http://test.local/uploads/proof.jpg',
        },
      });

    for (const day of ['2026-01-05', '2026-01-06', '2026-01-07']) {
      expect((await log(ali, day, 100)).statusCode).toBe(201);
    }
    for (const day of ['2026-01-05', '2026-01-06']) {
      expect((await log(veli, day, 1)).statusCode).toBe(201);
    }
    // 2026-01-07 is outside Veli's own window — the API refuses it...
    const refused = await log(veli, '2026-01-07', 1);
    expect(refused.statusCode).toBe(400);
    expect(errorCode(refused)).toBe('day_out_of_range');

    harness.setNow('2026-01-06T23:31:00.000Z');
    const advanced = await harness.app.inject({ method: 'POST', url: '/dev/advance' });
    expect(advanced.json<{ finalized: number }>().finalized).toBe(1);

    // ...so it must not cost him the 1440 minute missing-day penalty either.
    const results = await authed(harness.app, veli.token)({ method: 'GET', url: `/challenges/${challengeId}/results` });
    const standings = results.json<ChallengeResults>().standings;
    expect(standings.map((p) => [p.user.username, p.score, p.rank])).toEqual([
      ['veli', 2, 1],
      ['ali', 300, 2],
    ]);
    expect(standings[0]?.isWinner).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A deleted account must not break the history it is part of
// ---------------------------------------------------------------------------

describe('a participant who deleted their account', () => {
  it('keeps the results screen and the taunt working for the winner', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await finishedPair(harness);
    const aliCall = authed(harness.app, ali.token);

    expect((await authed(harness.app, veli.token)({ method: 'DELETE', url: '/me' })).statusCode).toBe(200);
    expect(harness.db.prepare('SELECT status FROM challenge_participants WHERE challenge_id = ? AND user_id = ?').get(challengeId, veli.me.id)).toEqual({ status: 'accepted' });

    const results = await aliCall({ method: 'GET', url: `/challenges/${challengeId}/results` });
    expect(results.statusCode).toBe(200);
    const body = results.json<ChallengeResults>();
    expect(body.standings.find((p) => p.user.id === veli.me.id)?.user.displayName).toBe('Silinen kanka');
    expect(body.tauntTemplatesForWinner?.length).toBeGreaterThan(0);

    // `GET /challenges/:id` still advertises the taunt, so it has to work.
    const detail = await aliCall({ method: 'GET', url: `/challenges/${challengeId}` });
    expect(detail.json<ChallengeDetail>().canTaunt).toEqual([{ toUserId: veli.me.id, done: false }]);
    const taunt = await aliCall({
      method: 'POST',
      url: `/challenges/${challengeId}/taunt`,
      payload: { toUserId: veli.me.id, templateId: 'l2_win_01' },
    });
    expect(taunt.statusCode).toBe(201);
  });

  it('does not fail a dispute it committed', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const veli = await registerUser(harness.app, 'veli');
    const cem = await registerUser(harness.app, 'cem');
    befriend(harness.app, ali.me.id, veli.me.id);
    befriend(harness.app, ali.me.id, cem.me.id);

    const created = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/challenges',
      payload: {
        typeKey: 'sigara_yok',
        startsAt: iso(harness),
        endsAt: iso(harness, 5 * DAY_MS),
        participantIds: [veli.me.id, cem.me.id],
      },
    });
    const challengeId = created.json<Challenge>().id;
    for (const user of [veli, cem]) {
      await authed(harness.app, user.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    }

    const entry = await authed(harness.app, veli.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: today(harness), value: 1, source: 'manual', clientTime: iso(harness) },
    });
    const entryId = entry.json<{ entry: Entry }>().entry.id;
    await authed(harness.app, veli.token)({ method: 'DELETE', url: '/me' });

    const disputed = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${entryId}/dispute`,
      payload: { reason: 'Kanıt yok' },
    });
    expect(disputed.statusCode).toBe(201);
    expect(disputed.json<{ upheld: boolean }>().upheld).toBe(true);
    expect(harness.db.prepare('SELECT status FROM entries WHERE id = ?').get(entryId)).toEqual({ status: 'rejected' });
    expect(computeUserStats(harness.db, ali.me.id, harness.now()).disputesWon).toBe(1);
    // The deleted owner is simply not notified — nothing throws after the write.
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND type = 'entry_rejected'").get(veli.me.id)).toEqual({ n: 0 });
  });
});

// ---------------------------------------------------------------------------
// Finalization needs two players
// ---------------------------------------------------------------------------

describe('finalization', () => {
  it('cancels instead of crowning a lone survivor', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await livePair(harness, 'adim_yarisi', {}, 1);

    expect((await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/leave` })).statusCode).toBe(200);

    harness.advance(2 * DAY_MS);
    await harness.app.inject({ method: 'POST', url: '/dev/advance' });

    expect(harness.db.prepare('SELECT status, winner_id, is_tie FROM challenges WHERE id = ?').get(challengeId)).toEqual({
      status: 'cancelled',
      winner_id: null,
      is_tie: 0,
    });
    expect(computeUserStats(harness.db, ali.me.id, harness.now()).wins).toBe(0);

    const inbox = (await authed(harness.app, ali.token)({ method: 'GET', url: '/me/inbox' })).json<Notification[]>();
    expect(inbox.some((n) => n.type === 'challenge_finished')).toBe(false);
    expect(inbox.some((n) => n.type === 'challenge_cancelled')).toBe(true);
    expect(harness.db.prepare('SELECT COUNT(*) AS n FROM badges WHERE user_id = ?').get(ali.me.id)).toEqual({ n: 0 });
  });

  it('sends the SPEC 2.4 finish notification: short title, copy in the body', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await finishedPair(harness);

    const winner = (await authed(harness.app, ali.token)({ method: 'GET', url: '/me/inbox' }))
      .json<Notification[]>()
      .find((n) => n.type === 'challenge_finished');
    expect(winner?.title).toBe('KOYDUN! 👑');
    expect(winner?.body.startsWith(t('challenge_finished_won', 2))).toBe(true);
    expect(winner?.data).toMatchObject({ challengeId, role: 'winner' });

    const loser = (await authed(harness.app, veli.token)({ method: 'GET', url: '/me/inbox' }))
      .json<Notification[]>()
      .find((n) => n.type === 'challenge_finished');
    expect(loser?.title).toBe('Yedin lan');
    expect(loser?.body.startsWith(t('challenge_finished_lost', 2))).toBe(true);
    expect(loser?.data).toMatchObject({ challengeId, role: 'loser', winnerId: ali.me.id });
  });
});

// ---------------------------------------------------------------------------
// Reminders survive a DST spring forward
// ---------------------------------------------------------------------------

describe('daily reminder', () => {
  it('still fires when the reminder hour does not exist locally', async () => {
    harness = await makeApp({ now: '2026-03-08T06:00:00.000Z' });
    const ali = await registerUser(harness.app, 'ali', { timezone: 'America/New_York', reminderHour: 2 });
    const veli = await registerUser(harness.app, 'veli');
    befriend(harness.app, ali.me.id, veli.me.id);
    await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/challenges',
      payload: {
        typeKey: 'adim_yarisi',
        startsAt: iso(harness),
        endsAt: iso(harness, 30 * DAY_MS),
        participantIds: [veli.me.id],
      },
    });

    const advance = (now: string) => harness!.app.inject({ method: 'POST', url: '/dev/advance', payload: { now } });

    // 01:30 EST — before the reminder hour.
    expect((await advance('2026-03-08T06:30:00.000Z')).json<{ reminders: number }>().reminders).toBe(0);
    // 03:30 EDT — 02:00 never happened today, so equality would never match.
    expect((await advance('2026-03-08T07:30:00.000Z')).json<{ reminders: number }>().reminders).toBe(1);
    // Still one per local day.
    expect((await advance('2026-03-08T09:00:00.000Z')).json<{ reminders: number }>().reminders).toBe(0);

    const reminders = (await authed(harness.app, ali.token)({ method: 'GET', url: '/me/inbox' }))
      .json<Notification[]>()
      .filter((n) => n.type === 'reminder');
    expect(reminders).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// sessionId is a focus concept only
// ---------------------------------------------------------------------------

describe('entry sessionId', () => {
  it('does not swallow a second manual_count entry that reuses one', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await livePair(harness, 'su_bardak', {}, 3);
    const sessionId = randomUUID();
    const call = authed(harness.app, ali.token);
    const glass = (value: number) =>
      call({
        method: 'POST',
        url: `/challenges/${challengeId}/entries`,
        payload: { dayKey: today(harness!), value, source: 'manual', clientTime: iso(harness!), sessionId },
      });

    expect((await glass(2)).statusCode).toBe(201);
    const second = await glass(3);
    expect(second.statusCode).toBe(201);
    expect(second.json<{ standings: ParticipantView[] }>().standings.find((p) => p.user.id === ali.me.id)?.score).toBe(5);

    const rows = entries(harness, challengeId, ali.me.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.session_id === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Broken uploads and broken bodies are the client's fault, not a 500
// ---------------------------------------------------------------------------

describe('POST /uploads', () => {
  const boundary = 'koydumtest';

  function filePart(name: string): string {
    return [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${name}"`,
      'Content-Type: image/jpeg',
      '',
      'x'.repeat(64),
    ].join('\r\n');
  }

  it('answers 400 for a truncated multipart body', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');

    const response = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/uploads',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: filePart('proof.jpg'), // no closing boundary: the stream just stops
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('invalid_multipart');
  });

  it('answers 4xx for a second file part', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');

    const response = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/uploads',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: `${filePart('one.jpg')}\r\n${filePart('two.jpg')}\r\n--${boundary}--\r\n`,
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
    expect((response.json() as { error: { code: string } }).error.code).not.toBe('internal');
  });
});

describe('JSON parsing', () => {
  it('keeps the Turkish invalid_json answer for a malformed body', async () => {
    harness = await makeApp({ now: NOW });
    const response = await harness.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"username": "abc",,}',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { code: 'invalid_json', message: 'Geçersiz JSON gönderdin.' } });
  });
});

describe('buildApp', () => {
  it('boots without the upload directory instead of dying on the static mount', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koydum-noupload-'));
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');

    const built = await buildApp({
      config: {
        dataDir: ':memory:',
        dbPath: ':memory:',
        uploadDir: path.join(blocker, 'uploads'),
        jwtSecret: 'test-secret-koydum',
        logLevel: 'silent',
        publicUrl: 'http://test.local',
      },
    });
    try {
      await built.app.ready();
      expect((await built.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    } finally {
      await built.app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Inbox paging on any ISO form of the same instant
// ---------------------------------------------------------------------------

describe('GET /me/inbox', () => {
  it('treats every ISO spelling of the cursor as the same instant', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const call = authed(harness.app, ali.token);

    harness.db.prepare('DELETE FROM notifications WHERE user_id = ?').run(ali.me.id);
    notify(harness.db, { userId: ali.me.id, type: 'poke', title: 'eski', body: 'eski', createdAt: '2026-01-05T08:00:00.000Z' });
    notify(harness.db, { userId: ali.me.id, type: 'poke', title: 'yeni', body: 'yeni', createdAt: '2026-01-05T08:01:00.000Z' });

    const cursors = [
      '2026-01-05T08:01:00.000Z', // exactly what the server writes
      '2026-01-05T08:01:00Z', // no milliseconds
      '2026-01-05T11:01:00+03:00', // same instant, Istanbul offset
    ];
    for (const cursor of cursors) {
      const page = await call({ method: 'GET', url: `/me/inbox?before=${encodeURIComponent(cursor)}` });
      expect(page.statusCode).toBe(200);
      expect(page.json<Notification[]>().map((n) => n.title)).toEqual(['eski']);
    }
  });
});

// ---------------------------------------------------------------------------
// One unreadable timezone degrades one number, not every reader
// ---------------------------------------------------------------------------

describe('a timezone this runtime does not know', () => {
  it('never 500s a profile or the leaderboard', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const veli = await registerUser(harness.app, 'veli');
    befriend(harness.app, ali.me.id, veli.me.id);
    harness.db.prepare('UPDATE users SET timezone = ? WHERE id = ?').run('Mars/Phobos', veli.me.id);

    const call = authed(harness.app, ali.token);
    expect((await call({ method: 'GET', url: `/users/${veli.me.id}` })).statusCode).toBe(200);
    expect((await call({ method: 'GET', url: '/leaderboard' })).statusCode).toBe(200);
    expect((await authed(harness.app, veli.token)({ method: 'GET', url: '/me' })).statusCode).toBe(200);
    expect(computeUserStats(harness.db, veli.me.id, harness.now()).stepsToday).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Poke cooldown with a clock that jumped backwards
// ---------------------------------------------------------------------------

describe('poke cooldown', () => {
  it('never reports a wait longer than the cooldown itself', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await livePair(harness, 'adim_yarisi');
    const poke = () =>
      authed(harness!.app, ali.token)({
        method: 'POST',
        url: `/challenges/${challengeId}/poke`,
        payload: { toUserId: veli.me.id },
      });

    expect((await poke()).statusCode).toBe(201);

    const tooSoon = await poke();
    expect(tooSoon.statusCode).toBe(429);
    const minutes = Number(/(\d+) dakika/.exec((tooSoon.json() as { error: { message: string } }).error.message)?.[1]);
    expect(minutes).toBeGreaterThan(0);
    expect(minutes).toBeLessThanOrEqual(120);

    // A clock stepped back a year must not produce "525720 dakika sonra tekrar dene".
    harness.setNow(new Date(harness.now().getTime() - 365 * DAY_MS));
    const afterJump = await poke();
    expect(afterJump.statusCode).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Login: no enumeration oracle, no unbounded scrypt
// ---------------------------------------------------------------------------

describe('POST /auth/login', () => {
  it('spends a real scrypt on an unknown username too', async () => {
    harness = await makeApp({ now: NOW });
    await registerUser(harness.app, 'ali');

    const measure = async (username: string): Promise<number> => {
      const started = process.hrtime.bigint();
      const response = await harness!.app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { username, password: 'yanlissifre' },
      });
      expect(response.statusCode).toBe(401);
      expect(errorCode(response)).toBe('bad_credentials');
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    const known = await measure('ali');
    const unknown = await measure('kimseyok');
    // The old decoy (`scrypt$00$00`) failed a length check before scrypt ran and
    // answered in ~0.1 ms — an ~88x oracle. Both branches must now do the work.
    expect(unknown).toBeGreaterThan(5);
    expect(unknown).toBeGreaterThan(known / 5);
  });

  it('throttles a burst of failures and forgives a success', async () => {
    harness = await makeApp({ now: NOW });
    await registerUser(harness.app, 'ali', { password: 'dogrusifre' });
    const attempt = (password: string) =>
      harness!.app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'ali', password } });

    for (let i = 0; i < 5; i++) expect((await attempt('yanlis')).statusCode).toBe(401);
    // A correct password clears the failures, so the next five are 401 again.
    expect((await attempt('dogrusifre')).statusCode).toBe(200);
    for (let i = 0; i < 5; i++) expect((await attempt('yanlis')).statusCode).toBe(401);

    for (let i = 0; i < 3; i++) expect((await attempt('yanlis')).statusCode).toBe(401);
    const blocked = await attempt('yanlis');
    expect(blocked.statusCode).toBe(429);
    expect(errorCode(blocked)).toBe('too_many_attempts');
    // Even the right password has to wait out the lockout.
    expect((await attempt('dogrusifre')).statusCode).toBe(429);
  });
});

describe('AttemptLimiter', () => {
  it('counts inside a sliding window and forgets what falls out of it', () => {
    const limiter = new AttemptLimiter(2, 1000);
    const at = (ms: number): Date => new Date(1_000_000 + ms);

    expect(limiter.retryAfterMs('ip', at(0))).toBe(0);
    limiter.record('ip', at(0));
    limiter.record('ip', at(200));
    expect(limiter.retryAfterMs('ip', at(300))).toBe(700);
    // The first hit leaves the window at 1000 ms.
    expect(limiter.retryAfterMs('ip', at(1001))).toBe(0);

    limiter.record('other', at(0));
    limiter.record('other', at(0));
    expect(limiter.retryAfterMs('other', at(0))).toBeGreaterThan(0);
    limiter.reset('other');
    expect(limiter.retryAfterMs('other', at(0))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Documented defaults the reviewers questioned (SPEC 2 config line, SPEC 2.2 results)
// ---------------------------------------------------------------------------

describe('config', () => {
  it('keeps the uploads folder inside DATA_DIR so one volume holds everything', () => {
    const previous = process.env.UPLOAD_DIR;
    delete process.env.UPLOAD_DIR;
    try {
      expect(loadConfig({ dataDir: './data', jwtSecret: 'x' }).uploadDir).toBe(path.join('./data', 'uploads'));
    } finally {
      if (previous !== undefined) process.env.UPLOAD_DIR = previous;
    }
  });
});

describe('GET /challenges/:id/results', () => {
  it('renders the winner previews with real names and scores', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await finishedPair(harness);

    const results = (await authed(harness.app, ali.token)({ method: 'GET', url: `/challenges/${challengeId}/results` }))
      .json<ChallengeResults>();
    const previews: TauntTemplate[] = results.tauntTemplatesForWinner ?? [];
    expect(previews.length).toBeGreaterThan(0);
    expect(previews.every((tpl) => typeof tpl.id === 'string' && tpl.level >= 1 && tpl.level <= 3)).toBe(true);
    // Rendered, not raw: no placeholder survives.
    expect(previews.every((tpl) => !`${tpl.title}${tpl.body}`.includes('{'))).toBe(true);
    expect(previews.some((tpl) => `${tpl.title}${tpl.body}`.includes('Veli'))).toBe(true);
  });
});
