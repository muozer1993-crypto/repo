/**
 * The scheduler pass (SPEC 2.4) driven end-to-end with an injected clock.
 *
 * Everything here goes through the real HTTP routes to build the state and then
 * calls `runSchedulerOnce(db, now)` — the same function `startScheduler` calls on
 * its 30-second timer — so the test covers exactly what the running server does:
 * a challenge going live at its start time, finishing at its end time (a step
 * çelınc once the phones have had their hour) with the right winner (or no winner
 * at all), telling every participant, handing out badges, throwing out a disputed
 * entry whose owner never answered (and holding the result for one who still may),
 * and cancelling a pending challenge nobody joined. The last block is
 * `startScheduler`'s stop, which a clean shutdown awaits before closing the database.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TIMEZONE, LIMITS, todayKey, type Challenge } from '@koydum/shared';
import { runSchedulerOnce } from '../src/services/challenges.js';
import { listByType } from '../src/services/notifications.js';
import type { FlushResult, PushSender } from '../src/services/push.js';
import { startScheduler, STOP_WAIT_MS } from '../src/services/scheduler.js';
import { getBadges } from '../src/services/stats.js';
import type { ChallengeRow, ParticipantRow } from '../src/db/index.js';
import { authed, befriend, makeApp, registerUser, type RegisteredUser, type TestApp } from './helpers.js';

let harness: TestApp | null = null;

afterEach(async () => {
  if (harness) {
    await harness.close();
    harness = null;
  }
});

const NOW = '2026-01-05T09:00:00.000Z'; // 12:00 in Europe/Istanbul
const HOUR = 60 * 60 * 1000;

function iso(h: TestApp, offsetMs = 0): string {
  return new Date(h.now().getTime() + offsetMs).toISOString();
}

function today(h: TestApp): string {
  return todayKey(DEFAULT_TIMEZONE, h.now());
}

function tick(h: TestApp) {
  return runSchedulerOnce(h.db, h.now());
}

function challengeRow(h: TestApp, id: string): ChallengeRow {
  return h.db.prepare('SELECT * FROM challenges WHERE id = ?').get(id) as ChallengeRow;
}

function participant(h: TestApp, id: string, userId: string): ParticipantRow {
  return h.db
    .prepare('SELECT * FROM challenge_participants WHERE challenge_id = ? AND user_id = ?')
    .get(id, userId) as ParticipantRow;
}

function dataOf(row: { data: string }): Record<string, unknown> {
  return JSON.parse(row.data) as Record<string, unknown>;
}

/** Two friends and a steps challenge that starts in two hours and runs for two days. */
async function pendingChallenge(
  h: TestApp,
  options: { startsIn?: number; runsFor?: number; accept?: boolean } = {},
): Promise<{ ali: RegisteredUser; veli: RegisteredUser; challengeId: string }> {
  const ali = await registerUser(h.app, 'ali', { displayName: 'Ali' });
  const veli = await registerUser(h.app, 'veli', { displayName: 'Veli' });
  befriend(h.app, ali.me.id, veli.me.id);

  const startsIn = options.startsIn ?? 2 * HOUR;
  const created = await authed(h.app, ali.token)({
    method: 'POST',
    url: '/challenges',
    payload: {
      typeKey: 'adim_yarisi',
      startsAt: iso(h, startsIn),
      endsAt: iso(h, startsIn + (options.runsFor ?? 48 * HOUR)),
      participantIds: [veli.me.id],
      rewardText: 'Döner',
    },
  });
  expect(created.statusCode).toBe(201);
  const challengeId = created.json<Challenge>().id;
  expect(challengeRow(h, challengeId).status).toBe('pending');

  if (options.accept !== false) {
    const accepted = await authed(h.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    expect(accepted.statusCode).toBe(200);
  }
  return { ali, veli, challengeId };
}

async function postSteps(h: TestApp, user: RegisteredUser, challengeId: string, value: number) {
  const response = await authed(h.app, user.token)({
    method: 'POST',
    url: `/challenges/${challengeId}/entries`,
    payload: { dayKey: today(h), value, source: 'pedometer', clientTime: iso(h) },
  });
  expect(response.statusCode).toBe(201);
  return response;
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

describe('scheduler: activation', () => {
  it('leaves a pending challenge alone until its start time, then starts it once', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await pendingChallenge(harness);

    expect(tick(harness)).toMatchObject({ activated: 0, finalized: 0, cancelled: 0 });
    expect(challengeRow(harness, challengeId).status).toBe('pending');

    harness.advance(2 * HOUR);
    expect(tick(harness)).toMatchObject({ activated: 1, finalized: 0, cancelled: 0 });
    expect(challengeRow(harness, challengeId).status).toBe('active');

    // Everybody who accepted hears about it, at their own level.
    for (const user of [ali, veli]) {
      const started = listByType(harness.db, user.me.id, 'challenge_started');
      expect(started, user.me.username).toHaveLength(1);
      expect(dataOf(started[0])).toMatchObject({ challengeId });
    }

    // A second pass is a no-op — no duplicate notifications, no status churn.
    expect(tick(harness)).toMatchObject({ activated: 0 });
    expect(listByType(harness.db, ali.me.id, 'challenge_started')).toHaveLength(1);
  });

  it('waits for a second player instead of starting a solo challenge', async () => {
    harness = await makeApp({ now: NOW });
    const { challengeId } = await pendingChallenge(harness, { accept: false });

    harness.advance(3 * HOUR);
    expect(tick(harness)).toMatchObject({ activated: 0, cancelled: 0 });
    expect(challengeRow(harness, challengeId).status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// Finalization
// ---------------------------------------------------------------------------

describe('scheduler: finalization', () => {
  it('finishes after the end, crowns the winner, tells everyone and hands out badges', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await pendingChallenge(harness);

    harness.advance(2 * HOUR);
    tick(harness);
    await postSteps(harness, ali, challengeId, 12430);
    await postSteps(harness, veli, challengeId, 8000);

    // One minute before the end nothing has happened yet.
    harness.advance(48 * HOUR - 60_000);
    expect(tick(harness)).toMatchObject({ finalized: 0 });
    expect(challengeRow(harness, challengeId).status).toBe('active');

    // A step çelınc gives the phones an hour past the end (see the block below).
    harness.advance(60_000 + LIMITS.DEVICE_SETTLE_MS);
    expect(tick(harness)).toMatchObject({ finalized: 1 });

    const row = challengeRow(harness, challengeId);
    expect(row.status).toBe('finished');
    expect(row.winner_id).toBe(ali.me.id);
    expect(row.is_tie).toBe(0);
    expect(row.finalized_at).toBe(harness.now().toISOString());

    // Final scores and ranks are frozen on the participant rows.
    expect(participant(harness, challengeId, ali.me.id)).toMatchObject({ final_score: 12430, final_rank: 1 });
    expect(participant(harness, challengeId, veli.me.id)).toMatchObject({ final_score: 8000, final_rank: 2 });

    const won = listByType(harness.db, ali.me.id, 'challenge_finished');
    expect(won).toHaveLength(1);
    expect(dataOf(won[0])).toMatchObject({ challengeId, role: 'winner' });

    const lost = listByType(harness.db, veli.me.id, 'challenge_finished');
    expect(lost).toHaveLength(1);
    expect(dataOf(lost[0])).toMatchObject({ challengeId, role: 'loser', winnerId: ali.me.id });
    expect(lost[0].body).toContain('Ali');

    // Badges are recomputed for every participant as part of finalizing.
    expect(getBadges(harness.db, ali.me.id)).toContain('koyus_1');
    expect(getBadges(harness.db, veli.me.id)).toContain('yiyis_1');
    expect(listByType(harness.db, ali.me.id, 'badge').length).toBeGreaterThan(0);

    // Finished is final: the next pass does not finalize it twice.
    harness.advance(HOUR);
    expect(tick(harness)).toMatchObject({ finalized: 0 });
    expect(listByType(harness.db, ali.me.id, 'challenge_finished')).toHaveLength(1);
  });

  it('leaves a dead heat without a winner and says so to both of them', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await pendingChallenge(harness);

    harness.advance(2 * HOUR);
    tick(harness);
    await postSteps(harness, ali, challengeId, 9000);
    await postSteps(harness, veli, challengeId, 9000);

    harness.advance(48 * HOUR + LIMITS.DEVICE_SETTLE_MS);
    expect(tick(harness)).toMatchObject({ finalized: 1 });

    const row = challengeRow(harness, challengeId);
    expect(row.status).toBe('finished');
    expect(row.winner_id).toBeNull();
    expect(row.is_tie).toBe(1);
    // A shared top score is rank 1 for both.
    expect(participant(harness, challengeId, ali.me.id).final_rank).toBe(1);
    expect(participant(harness, challengeId, veli.me.id).final_rank).toBe(1);

    for (const user of [ali, veli]) {
      const finished = listByType(harness.db, user.me.id, 'challenge_finished');
      expect(finished, user.me.username).toHaveLength(1);
      expect(dataOf(finished[0])).toMatchObject({ challengeId, role: 'tie' });
    }
    // Nobody earned the right to "KOYDUM MU?" — so nobody won or lost.
    expect(getBadges(harness.db, ali.me.id)).not.toContain('koyus_1');
    expect(getBadges(harness.db, veli.me.id)).not.toContain('yiyis_1');
  });
});

// ---------------------------------------------------------------------------
// The hour the phones get
// ---------------------------------------------------------------------------

/** 23:59:59.999 on 6 January in Istanbul — where the app snaps every end. */
const MIDNIGHT_END = '2026-01-06T20:59:59.999Z';
const MINUTE = 60 * 1000;

/** Ali and Veli in a live çelınc of `typeKey` that ends at local midnight. */
async function endingAtMidnight(
  h: TestApp,
  typeKey: string,
  extras: { reminderHour?: number } = {},
): Promise<{ ali: RegisteredUser; veli: RegisteredUser; challengeId: string }> {
  const ali = await registerUser(h.app, 'ali', { displayName: 'Ali', ...extras });
  const veli = await registerUser(h.app, 'veli', { displayName: 'Veli', ...extras });
  befriend(h.app, ali.me.id, veli.me.id);
  const created = await authed(h.app, ali.token)({
    method: 'POST',
    url: '/challenges',
    payload: { typeKey, startsAt: iso(h), endsAt: MIDNIGHT_END, participantIds: [veli.me.id], rewardText: 'Döner' },
  });
  expect(created.statusCode).toBe(201);
  const challengeId = created.json<Challenge>().id;
  const accepted = await authed(h.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
  expect(accepted.statusCode).toBe(200);
  tick(h);
  expect(challengeRow(h, challengeId).status).toBe('active');
  return { ali, veli, challengeId };
}

/** What the background sync posts: the phone's count for each of these days. */
async function phoneSync(h: TestApp, user: RegisteredUser, days: Record<string, number>) {
  const response = await authed(h.app, user.token)({
    method: 'POST',
    url: '/me/steps',
    payload: { days: Object.entries(days).map(([dayKey, steps]) => ({ dayKey, steps, source: 'health_connect' })) },
  });
  expect(response.statusCode).toBe(200);
}

function at(h: TestApp, instant: string, offsetMs = 0): void {
  h.setNow(new Date(Date.parse(instant) + offsetMs));
}

describe('scheduler: the hour the phones get after a step çelınc ends', () => {
  it('waits past midnight, so the last evening synced late still decides the winner', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await endingAtMidnight(harness, 'adim_yarisi');

    // Evening syncs: Ali 22:00, Veli 22:15 — and then Doze holds Veli's phone.
    at(harness, '2026-01-06T19:00:00.000Z');
    await phoneSync(harness, ali, { '2026-01-06': 10_000 });
    at(harness, '2026-01-06T19:15:00.000Z');
    await phoneSync(harness, veli, { '2026-01-06': 9_000 });

    at(harness, MIDNIGHT_END, MINUTE);
    expect(tick(harness)).toMatchObject({ finalized: 0 });
    expect(challengeRow(harness, challengeId).status).toBe('active');

    // 00:20: Veli's 4,000 steps from 22:30-23:50 finally arrive with the new day.
    at(harness, MIDNIGHT_END, 20 * MINUTE);
    await phoneSync(harness, veli, { '2026-01-06': 13_000, '2026-01-07': 150 });
    expect(tick(harness)).toMatchObject({ finalized: 0 }); // Ali's phone has not been heard since

    at(harness, MIDNIGHT_END, LIMITS.DEVICE_SETTLE_MS - MINUTE);
    expect(tick(harness)).toMatchObject({ finalized: 0 });
    at(harness, MIDNIGHT_END, LIMITS.DEVICE_SETTLE_MS);
    expect(tick(harness)).toMatchObject({ finalized: 1 });

    const row = challengeRow(harness, challengeId);
    expect(row.status).toBe('finished');
    expect(row.winner_id).toBe(veli.me.id);
    expect(participant(harness, challengeId, veli.me.id)).toMatchObject({ final_score: 13_000, final_rank: 1 });
    expect(participant(harness, challengeId, ali.me.id)).toMatchObject({ final_score: 10_000, final_rank: 2 });
  });

  it('finishes early once every phone has reported the last day after the end', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await endingAtMidnight(harness, 'adim_yarisi');

    at(harness, '2026-01-06T19:00:00.000Z');
    await phoneSync(harness, ali, { '2026-01-06': 10_000 });
    await phoneSync(harness, veli, { '2026-01-06': 9_000 });

    // Ali's phone reports after midnight, but only the new day: the last one is not in.
    at(harness, MIDNIGHT_END, 5 * MINUTE);
    await phoneSync(harness, ali, { '2026-01-07': 40 });
    await phoneSync(harness, veli, { '2026-01-06': 9_500, '2026-01-07': 10 });
    expect(tick(harness)).toMatchObject({ finalized: 0 });

    at(harness, MIDNIGHT_END, 10 * MINUTE);
    await phoneSync(harness, ali, { '2026-01-06': 10_200, '2026-01-07': 60 });
    expect(tick(harness)).toMatchObject({ finalized: 1 });
    expect(challengeRow(harness, challengeId)).toMatchObject({ status: 'finished', winner_id: ali.me.id });
    expect(participant(harness, challengeId, ali.me.id).final_score).toBe(10_200);
  });

  it('starts the hour again from boot when the server was off at the end', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await endingAtMidnight(harness, 'adim_yarisi');
    at(harness, '2026-01-06T19:00:00.000Z');
    await phoneSync(harness, ali, { '2026-01-06': 10_000 });
    await phoneSync(harness, veli, { '2026-01-06': 9_000 });

    // The PC was off all night and comes back at 07:00.
    const bootAt = new Date('2026-01-07T04:00:00.000Z');
    const pass = () => runSchedulerOnce(harness!.db, harness!.now(), { bootAt });
    at(harness, bootAt.toISOString());
    expect(pass()).toMatchObject({ finalized: 0 });
    at(harness, bootAt.toISOString(), LIMITS.DEVICE_SETTLE_MS - MINUTE);
    expect(pass()).toMatchObject({ finalized: 0 });
    at(harness, bootAt.toISOString(), LIMITS.DEVICE_SETTLE_MS);
    expect(pass()).toMatchObject({ finalized: 1 });
    expect(challengeRow(harness, challengeId).status).toBe('finished');
  });

  it('still finishes a typed çelınc right at the end', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await endingAtMidnight(harness, 'su_bardak');
    for (const [user, value] of [[ali, 6], [veli, 4]] as const) {
      const response = await authed(harness.app, user.token)({
        method: 'POST',
        url: `/challenges/${challengeId}/entries`,
        payload: { dayKey: today(harness), value, source: 'manual', clientTime: iso(harness) },
      });
      expect(response.statusCode).toBe(201);
    }

    at(harness, MIDNIGHT_END, 1);
    expect(tick(harness)).toMatchObject({ finalized: 1 });
    expect(challengeRow(harness, challengeId)).toMatchObject({ status: 'finished', winner_id: ali.me.id });
  });

  it('never counts steps walked after an end that cut the last day in half', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    befriend(harness.app, ali.me.id, veli.me.id);
    // ends at 20:35 in Istanbul, the way a rematch used to
    const endsAt = '2026-01-06T17:35:00.000Z';
    const created = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/challenges',
      payload: { typeKey: 'adim_yarisi', startsAt: iso(harness), endsAt, participantIds: [veli.me.id] },
    });
    const challengeId = created.json<Challenge>().id;
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    tick(harness);

    at(harness, '2026-01-06T17:00:00.000Z');
    await phoneSync(harness, ali, { '2026-01-06': 12_000 });
    await phoneSync(harness, veli, { '2026-01-06': 10_000 });

    // 21:25: Veli's evening walk after the whistle reaches the server
    at(harness, endsAt, 50 * MINUTE);
    await phoneSync(harness, ali, { '2026-01-06': 12_000 });
    await phoneSync(harness, veli, { '2026-01-06': 15_000 });
    const veliDay = harness.db
      .prepare('SELECT value FROM entries WHERE challenge_id = ? AND user_id = ?')
      .get(challengeId, veli.me.id) as { value: number };
    expect(veliDay.value).toBe(10_000);

    // nothing more can move that day, so there is nobody to wait for
    expect(tick(harness)).toMatchObject({ finalized: 1 });
    expect(challengeRow(harness, challengeId)).toMatchObject({ status: 'finished', winner_id: ali.me.id });
  });

  it('sends no "you logged nothing today" reminder for a çelınc that is only waiting for the phones', async () => {
    harness = await makeApp({ now: NOW });
    // a reminder at 00:xx is due for anybody who has nothing on the new day
    const { ali, challengeId } = await endingAtMidnight(harness, 'adim_yarisi', { reminderHour: 0 });

    at(harness, MIDNIGHT_END, MINUTE);
    expect(tick(harness)).toMatchObject({ finalized: 0, reminders: 0 });
    expect(challengeRow(harness, challengeId).status).toBe('active');
    const newDay = listByType(harness.db, ali.me.id, 'reminder').filter(
      (row) => dataOf(row).dayKey === '2026-01-07',
    );
    expect(newDay).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The hours the owner of a disputed entry gets to answer
// ---------------------------------------------------------------------------

async function logWater(h: TestApp, user: RegisteredUser, challengeId: string, value: number): Promise<string> {
  const response = await authed(h.app, user.token)({
    method: 'POST',
    url: `/challenges/${challengeId}/entries`,
    payload: { dayKey: today(h), value, source: 'manual', clientTime: iso(h), sessionId: randomUUID() },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ entry: { id: string } }>().entry.id;
}

async function dispute(h: TestApp, user: RegisteredUser, challengeId: string, entryId: string) {
  const response = await authed(h.app, user.token)({
    method: 'POST',
    url: `/challenges/${challengeId}/entries/${entryId}/dispute`,
    payload: { reason: 'içmedi o kadar' },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ answerBy: string | null }>();
}

function entryStatus(h: TestApp, entryId: string): string {
  return (h.db.prepare('SELECT status FROM entries WHERE id = ?').get(entryId) as { status: string }).status;
}

describe('scheduler: an itiraz nobody answers', () => {
  it('throws the entry out after the answer window, tells the owner and counts the win for the disputer', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await endingAtMidnight(harness, 'su_bardak');
    const day = today(harness);
    const entries = [
      await logWater(harness, ali, challengeId, 3),
      await logWater(harness, ali, challengeId, 4),
      await logWater(harness, ali, challengeId, 2),
    ];
    for (const entryId of entries) await dispute(harness, veli, challengeId, entryId);

    harness.advance(LIMITS.DISPUTE_ANSWER_MS - MINUTE);
    expect(tick(harness)).toMatchObject({ disputes: 0 });
    expect(entries.map((id) => entryStatus(harness!, id))).toEqual(['disputed', 'disputed', 'disputed']);

    harness.advance(MINUTE);
    expect(tick(harness)).toMatchObject({ disputes: 3 });
    expect(entries.map((id) => entryStatus(harness!, id))).toEqual(['rejected', 'rejected', 'rejected']);
    const upheld = harness.db.prepare("SELECT COUNT(*) AS n FROM disputes WHERE status = 'upheld'").get();
    expect(upheld).toEqual({ n: 3 });

    const rejected = listByType(harness.db, ali.me.id, 'entry_rejected');
    expect(rejected).toHaveLength(3);
    expect(dataOf(rejected[0])).toMatchObject({ challengeId, dayKey: day });
    // three upheld itiraz is the first rung of the ladder
    expect(getBadges(harness.db, veli.me.id)).toContain('itiraz_1');

    // done is done: the next pass has nothing left to throw out
    expect(tick(harness)).toMatchObject({ disputes: 0 });
    expect(listByType(harness.db, ali.me.id, 'entry_rejected')).toHaveLength(3);
  });

  it('still needs two of the four rivals in a five-player çelınc', async () => {
    harness = await makeApp({ now: NOW });
    const players: RegisteredUser[] = [];
    for (const name of ['ali', 'veli', 'ayse', 'mert', 'cem']) players.push(await registerUser(harness.app, name));
    const [ali, veli, ayse] = players as [RegisteredUser, RegisteredUser, RegisteredUser];
    for (const friend of players.slice(1)) befriend(harness.app, ali.me.id, friend.me.id);
    const created = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/challenges',
      payload: { typeKey: 'su_bardak', startsAt: iso(harness), endsAt: MIDNIGHT_END, participantIds: players.slice(1).map((u) => u.me.id) },
    });
    const challengeId = created.json<Challenge>().id;
    for (const friend of players.slice(1)) {
      await authed(harness.app, friend.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    }
    tick(harness);
    const entryId = await logWater(harness, ali, challengeId, 5);

    // one of four is not a majority: no clock, however long it sits
    expect((await dispute(harness, veli, challengeId, entryId)).answerBy).toBeNull();
    harness.advance(LIMITS.DISPUTE_ANSWER_MS + HOUR);
    expect(tick(harness)).toMatchObject({ disputes: 0 });
    expect(entryStatus(harness, entryId)).toBe('disputed');

    const second = await dispute(harness, ayse, challengeId, entryId);
    expect(second.answerBy).toBe(iso(harness, LIMITS.DISPUTE_ANSWER_MS));
    harness.advance(LIMITS.DISPUTE_ANSWER_MS);
    expect(tick(harness)).toMatchObject({ disputes: 1 });
    expect(entryStatus(harness, entryId)).toBe('rejected');
  });

  it('holds the result for an itiraz still inside its window, then finishes without the entry', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await endingAtMidnight(harness, 'su_bardak');
    at(harness, MIDNIGHT_END, -2 * HOUR);
    const aliEntry = await logWater(harness, ali, challengeId, 8);
    await logWater(harness, veli, challengeId, 5);
    // an hour before the end Veli calls it: Ali is owed twelve hours to answer
    at(harness, MIDNIGHT_END, -HOUR);
    await dispute(harness, veli, challengeId, aliEntry);

    at(harness, MIDNIGHT_END, MINUTE);
    expect(tick(harness)).toMatchObject({ finalized: 0 });
    expect(challengeRow(harness, challengeId).status).toBe('active');

    at(harness, MIDNIGHT_END, LIMITS.DISPUTE_ANSWER_MS - HOUR - MINUTE);
    expect(tick(harness)).toMatchObject({ disputes: 0, finalized: 0 });

    at(harness, MIDNIGHT_END, LIMITS.DISPUTE_ANSWER_MS - HOUR);
    expect(tick(harness)).toMatchObject({ disputes: 1, finalized: 1 });
    expect(challengeRow(harness, challengeId)).toMatchObject({ status: 'finished', winner_id: veli.me.id });
    expect(participant(harness, challengeId, ali.me.id).final_score).toBe(0);
  });

  it('finishes on the next pass once the owner answers during the wait', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await endingAtMidnight(harness, 'su_bardak');
    at(harness, MIDNIGHT_END, -2 * HOUR);
    const aliEntry = await logWater(harness, ali, challengeId, 8);
    await logWater(harness, veli, challengeId, 5);
    at(harness, MIDNIGHT_END, -HOUR);
    await dispute(harness, veli, challengeId, aliEntry);

    at(harness, MIDNIGHT_END, 3 * HOUR);
    expect(tick(harness)).toMatchObject({ finalized: 0 });
    const answered = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${aliEntry}/proof`,
      payload: { proofUrl: '/uploads/bardaklar.jpg' },
    });
    expect(answered.statusCode).toBe(200);

    expect(tick(harness)).toMatchObject({ finalized: 1 });
    expect(challengeRow(harness, challengeId)).toMatchObject({ status: 'finished', winner_id: ali.me.id });
    expect(participant(harness, challengeId, ali.me.id).final_score).toBe(8);
  });

  it('takes no new itiraz during the wait, so one after another cannot hold the result for days', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await endingAtMidnight(harness, 'su_bardak');
    at(harness, MIDNIGHT_END, -2 * HOUR);
    const first = await logWater(harness, ali, challengeId, 8);
    const second = await logWater(harness, ali, challengeId, 3);
    at(harness, MIDNIGHT_END, -HOUR);
    await dispute(harness, veli, challengeId, first);

    // still `active`, waiting on the first one's photo
    at(harness, MIDNIGHT_END, LIMITS.DISPUTE_ANSWER_MS - 2 * HOUR);
    expect(tick(harness)).toMatchObject({ finalized: 0 });
    const late = await authed(harness.app, veli.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${second}/dispute`,
      payload: { reason: 'bu da yalan' },
    });
    expect(late.statusCode).toBe(400);
    expect(late.json<{ error: { code: string } }>().error.code).toBe('challenge_ended');
    expect(entryStatus(harness, second)).toBe('ok');

    at(harness, MIDNIGHT_END, LIMITS.DISPUTE_ANSWER_MS - HOUR);
    expect(tick(harness)).toMatchObject({ disputes: 1, finalized: 1 });
    expect(participant(harness, challengeId, ali.me.id).final_score).toBe(3);
  });

  it("takes an itiraz in a step çelınc's hour, where the last evening lands, and none after it", async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await endingAtMidnight(harness, 'adim_yarisi');
    at(harness, MIDNIGHT_END, 20 * MINUTE);
    await phoneSync(harness, ali, { '2026-01-06': 30_000 });
    const entryId = (
      harness.db.prepare('SELECT id FROM entries WHERE challenge_id = ? AND user_id = ?').get(challengeId, ali.me.id) as {
        id: string;
      }
    ).id;

    at(harness, MIDNIGHT_END, LIMITS.DEVICE_SETTLE_MS);
    const tooLate = await authed(harness.app, veli.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${entryId}/dispute`,
      payload: { reason: 'telefonu köpeğe bağlamış' },
    });
    expect(tooLate.statusCode).toBe(400);
    expect(tooLate.json<{ error: { code: string } }>().error.code).toBe('challenge_ended');

    at(harness, MIDNIGHT_END, LIMITS.DEVICE_SETTLE_MS - MINUTE);
    const inTime = await dispute(harness, veli, challengeId, entryId);
    expect(inTime.answerBy).not.toBeNull();
  });

  it('lets nobody walk out of a çelınc that is over but still waiting, which would cancel the result', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await endingAtMidnight(harness, 'adim_yarisi');
    at(harness, '2026-01-06T19:00:00.000Z');
    await phoneSync(harness, ali, { '2026-01-06': 9_000 });
    await phoneSync(harness, veli, { '2026-01-06': 10_000 });

    // Ali's late evening arrives in the hour; Veli sees he lost and tries to leave
    at(harness, MIDNIGHT_END, 20 * MINUTE);
    await phoneSync(harness, ali, { '2026-01-06': 12_000 });
    const left = await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/leave` });
    expect(left.statusCode).toBe(400);
    expect(left.json<{ error: { code: string } }>().error.code).toBe('challenge_ended');

    at(harness, MIDNIGHT_END, LIMITS.DEVICE_SETTLE_MS);
    expect(tick(harness)).toMatchObject({ finalized: 1, cancelled: 0 });
    expect(challengeRow(harness, challengeId)).toMatchObject({ status: 'finished', winner_id: ali.me.id });
  });
});

describe('scheduler: nobody pokes into a result that is only waiting', () => {
  it('offers no poke past the end and refuses one, while an itiraz holds the result', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await endingAtMidnight(harness, 'su_bardak');
    at(harness, MIDNIGHT_END, -2 * HOUR);
    const aliEntry = await logWater(harness, ali, challengeId, 8);
    await logWater(harness, veli, challengeId, 5);
    at(harness, MIDNIGHT_END, -HOUR);
    await dispute(harness, veli, challengeId, aliEntry);

    at(harness, MIDNIGHT_END, 2 * HOUR);
    expect(tick(harness)).toMatchObject({ finalized: 0 });
    expect(challengeRow(harness, challengeId).status).toBe('active');

    const detail = (await authed(harness.app, ali.token)({ method: 'GET', url: `/challenges/${challengeId}` })).json<{
      pokeTargets: unknown[];
      canPoke: boolean;
    }>();
    expect(detail.pokeTargets).toEqual([]);
    expect(detail.canPoke).toBe(false);

    const poke = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/poke`,
      payload: { toUserId: veli.me.id },
    });
    expect(poke.statusCode).toBe(400);
    expect(poke.json<{ error: { code: string } }>().error.code).toBe('challenge_ended');
    expect(listByType(harness.db, veli.me.id, 'poke')).toHaveLength(0);
  });

  it('keeps the co-leaders of a tie quiet until the phones have had their hour', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await endingAtMidnight(harness, 'adim_yarisi');
    at(harness, MIDNIGHT_END, -2 * HOUR);
    await phoneSync(harness, ali, { '2026-01-06': 10_000 });
    await phoneSync(harness, veli, { '2026-01-06': 10_000 });
    const tieTaunt = () =>
      authed(harness!.app, ali.token)({
        method: 'POST',
        url: `/challenges/${challengeId}/taunt`,
        payload: { toUserId: veli.me.id, templateId: 'l2_tie_01' },
      });

    at(harness, MIDNIGHT_END, 20 * MINUTE);
    expect(tick(harness)).toMatchObject({ finalized: 0 });
    const early = await tieTaunt();
    expect(early.statusCode).toBe(400);
    expect(early.json<{ error: { code: string } }>().error.code).toBe('challenge_not_finished');

    at(harness, MIDNIGHT_END, LIMITS.DEVICE_SETTLE_MS);
    expect(tick(harness)).toMatchObject({ finalized: 1 });
    expect(challengeRow(harness, challengeId).is_tie).toBe(1);
    expect((await tieTaunt()).statusCode).toBe(201);
  });
});

/** Ali and `names` in a live water çelınc that ends at local midnight, all accepted. */
async function waterGroup(h: TestApp, names: string[]): Promise<{ players: RegisteredUser[]; challengeId: string }> {
  const players: RegisteredUser[] = [];
  for (const name of ['ali', ...names]) players.push(await registerUser(h.app, name, { displayName: name }));
  const [creator, ...friends] = players as [RegisteredUser, ...RegisteredUser[]];
  for (const friend of friends) befriend(h.app, creator.me.id, friend.me.id);
  const created = await authed(h.app, creator.token)({
    method: 'POST',
    url: '/challenges',
    payload: { typeKey: 'su_bardak', startsAt: iso(h), endsAt: MIDNIGHT_END, participantIds: friends.map((u) => u.me.id) },
  });
  const challengeId = created.json<Challenge>().id;
  for (const friend of friends) {
    await authed(h.app, friend.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
  }
  tick(h);
  return { players, challengeId };
}

function answerByOf(h: TestApp, entryId: string): string | null {
  return (h.db.prepare('SELECT answer_by FROM entries WHERE id = ?').get(entryId) as { answer_by: string | null }).answer_by;
}

describe('scheduler: the itiraz majority shrinks when somebody leaves', () => {
  it('gives the owner the full 12 hours from the leave, and says so, instead of throwing the entry out', async () => {
    harness = await makeApp({ now: NOW });
    const { players, challengeId } = await waterGroup(harness, ['veli', 'can', 'mert']);
    const [ali, veli, can] = players as [RegisteredUser, RegisteredUser, RegisteredUser];
    const entryId = await logWater(harness, ali, challengeId, 9);

    // one of three rivals is not a majority of four players
    expect((await dispute(harness, veli, challengeId, entryId)).answerBy).toBeNull();
    const asked = listByType(harness.db, ali.me.id, 'dispute');
    expect(asked).toHaveLength(1);
    expect(asked[0]?.body).not.toContain('12 saat');

    // 13 hours on, Can walks out: three players, and Veli's itiraz alone is a majority now
    harness.advance(13 * HOUR);
    const left = await authed(harness.app, can.token)({ method: 'POST', url: `/challenges/${challengeId}/leave` });
    expect(left.statusCode).toBe(200);
    expect(answerByOf(harness, entryId)).toBe(iso(harness, LIMITS.DISPUTE_ANSWER_MS));
    const warned = listByType(harness.db, ali.me.id, 'dispute');
    expect(warned).toHaveLength(2);
    expect(warned[0]?.body).toContain('artık çoğunlukta');
    expect(warned[0]?.body).toContain('12 saat içinde fotoğraf ekle');
    expect(dataOf(warned[0]!)).toMatchObject({ challengeId, entryId, answerBy: iso(harness, LIMITS.DISPUTE_ANSWER_MS) });

    expect(tick(harness)).toMatchObject({ disputes: 0 });
    expect(entryStatus(harness, entryId)).toBe('disputed');
    harness.advance(LIMITS.DISPUTE_ANSWER_MS - MINUTE);
    expect(tick(harness)).toMatchObject({ disputes: 0 });
    harness.advance(MINUTE);
    expect(tick(harness)).toMatchObject({ disputes: 1 });
    expect(entryStatus(harness, entryId)).toBe('rejected');
  });

  it('starts a full window on the first pass for an old database where nothing stored the clock', async () => {
    harness = await makeApp({ now: NOW });
    const { players, challengeId } = await waterGroup(harness, ['veli']);
    const [ali, veli] = players as [RegisteredUser, RegisteredUser];
    const entryId = await logWater(harness, ali, challengeId, 9);
    await dispute(harness, veli, challengeId, entryId);
    // what migration 009 finds: an entry a majority disputed a day ago, no clock
    harness.db.prepare('UPDATE entries SET answer_by = NULL WHERE id = ?').run(entryId);
    harness.db.prepare('UPDATE disputes SET created_at = ? WHERE entry_id = ?').run(iso(harness, -24 * HOUR), entryId);

    expect(tick(harness)).toMatchObject({ disputes: 0 });
    expect(entryStatus(harness, entryId)).toBe('disputed');
    expect(answerByOf(harness, entryId)).toBe(iso(harness, LIMITS.DISPUTE_ANSWER_MS));
    expect(listByType(harness.db, ali.me.id, 'dispute')[0]?.body).toContain('artık çoğunlukta');
    // armed once, not every pass
    expect(tick(harness)).toMatchObject({ disputes: 0 });
    expect(listByType(harness.db, ali.me.id, 'dispute')).toHaveLength(2);
  });

  it('stops counting the itiraz of somebody who left, and stops the clock with it', async () => {
    harness = await makeApp({ now: NOW });
    const { players, challengeId } = await waterGroup(harness, ['veli', 'ayse', 'mert', 'cem']);
    const [ali, veli, ayse] = players as [RegisteredUser, RegisteredUser, RegisteredUser];
    const entryId = await logWater(harness, ali, challengeId, 9);
    await dispute(harness, veli, challengeId, entryId);
    expect((await dispute(harness, ayse, challengeId, entryId)).answerBy).not.toBeNull();

    // four players left, two of three rivals needed, and only Veli's still counts
    await authed(harness.app, ayse.token)({ method: 'POST', url: `/challenges/${challengeId}/leave` });
    expect(answerByOf(harness, entryId)).toBeNull();
    harness.advance(LIMITS.DISPUTE_ANSWER_MS + HOUR);
    expect(tick(harness)).toMatchObject({ disputes: 0 });
    expect(entryStatus(harness, entryId)).toBe('disputed');
  });

  it('does not let somebody who walked out join again', async () => {
    harness = await makeApp({ now: NOW });
    const { players, challengeId } = await waterGroup(harness, ['veli', 'can']);
    const can = players[2]!;
    await authed(harness.app, can.token)({ method: 'POST', url: `/challenges/${challengeId}/leave` });

    const back = await authed(harness.app, can.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    expect(back.statusCode).toBe(409);
    expect(back.json<{ error: { code: string } }>().error.code).toBe('already_left');
    expect(participant(harness, challengeId, can.me.id).status).toBe('left');
  });
});

describe('scheduler: deleting the account while a result is being decided', () => {
  it('keeps the loser in the result instead of turning a lost 1v1 into "not enough players"', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await endingAtMidnight(harness, 'adim_yarisi');
    at(harness, '2026-01-06T19:00:00.000Z');
    await phoneSync(harness, ali, { '2026-01-06': 12_000 });
    await phoneSync(harness, veli, { '2026-01-06': 9_000 });

    // the hour after the end: Veli sees where this is going and deletes his account
    at(harness, MIDNIGHT_END, 20 * MINUTE);
    expect((await authed(harness.app, veli.token)({ method: 'DELETE', url: '/me' })).statusCode).toBe(200);
    expect(participant(harness, challengeId, veli.me.id)).toMatchObject({ status: 'accepted' });

    at(harness, MIDNIGHT_END, LIMITS.DEVICE_SETTLE_MS);
    expect(tick(harness)).toMatchObject({ finalized: 1, cancelled: 0 });
    expect(challengeRow(harness, challengeId)).toMatchObject({ status: 'finished', winner_id: ali.me.id });
  });

  it('still lets a deletion before the end walk out and cancel a 1v1', async () => {
    harness = await makeApp({ now: NOW });
    const { veli, challengeId } = await endingAtMidnight(harness, 'adim_yarisi');
    at(harness, '2026-01-06T19:00:00.000Z');
    expect((await authed(harness.app, veli.token)({ method: 'DELETE', url: '/me' })).statusCode).toBe(200);
    expect(participant(harness, challengeId, veli.me.id)).toMatchObject({ status: 'left' });
    expect(challengeRow(harness, challengeId).status).toBe('cancelled');
  });
});

// ---------------------------------------------------------------------------
// The winner who never says a word
// ---------------------------------------------------------------------------

const PLAYERS = [
  ['ali', 'Ali'],
  ['veli', 'Veli'],
  ['ayse', 'Ayşe'],
] as const;

/**
 * A water çelınc between Ali and the next `glasses.length - 1` friends, each
 * logging their glasses, that finishes on the dot at `endsAt` (by default two
 * hours from NOW: 14:00 in Istanbul). Returns the moment it was finalized.
 */
async function finishedWater(
  h: TestApp,
  glasses: number[],
  endsAt = iso(h, 2 * HOUR),
): Promise<{ players: RegisteredUser[]; challengeId: string; finishedAt: string }> {
  const players: RegisteredUser[] = [];
  for (const [username, displayName] of PLAYERS.slice(0, glasses.length)) {
    players.push(await registerUser(h.app, username, { displayName }));
  }
  const [creator, ...friends] = players as [RegisteredUser, ...RegisteredUser[]];
  for (const friend of friends) befriend(h.app, creator.me.id, friend.me.id);

  const created = await authed(h.app, creator.token)({
    method: 'POST',
    url: '/challenges',
    payload: { typeKey: 'su_bardak', startsAt: iso(h), endsAt, participantIds: friends.map((f) => f.me.id) },
  });
  expect(created.statusCode).toBe(201);
  const challengeId = created.json<Challenge>().id;
  for (const friend of friends) {
    const accepted = await authed(h.app, friend.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    expect(accepted.statusCode).toBe(200);
  }
  tick(h);
  for (const [index, player] of players.entries()) await logWater(h, player, challengeId, glasses[index] ?? 0);

  at(h, endsAt, 1);
  expect(tick(h)).toMatchObject({ finalized: 1, tauntFollowups: 0 });
  return { players, challengeId, finishedAt: challengeRow(h, challengeId).finalized_at as string };
}

/** The "hâlâ bekliyor" reminders in one person's inbox. */
function followups(h: TestApp, user: RegisteredUser) {
  return listByType(h.db, user.me.id, 'reminder').filter((row) => dataOf(row).kind === 'taunt_followup');
}

async function taunt(h: TestApp, from: RegisteredUser, to: RegisteredUser, challengeId: string) {
  const response = await authed(h.app, from.token)({
    method: 'POST',
    url: `/challenges/${challengeId}/taunt`,
    payload: { toUserId: to.me.id, customBody: 'Koydum mu?' },
  });
  expect(response.statusCode).toBe(201);
}

describe('scheduler: a winner who never says "KOYDUM MU?"', () => {
  it('reminds the winner once, two hours after the finish, and never the loser', async () => {
    harness = await makeApp({ now: NOW });
    const { players, challengeId, finishedAt } = await finishedWater(harness, [6, 4]);
    const [ali, veli] = players as [RegisteredUser, RegisteredUser];

    at(harness, finishedAt, 2 * HOUR - MINUTE);
    expect(tick(harness)).toMatchObject({ tauntFollowups: 0 });

    at(harness, finishedAt, 2 * HOUR); // 16:00 in Istanbul
    expect(tick(harness)).toMatchObject({ tauntFollowups: 1 });
    const sent = followups(harness, ali);
    expect(sent).toHaveLength(1);
    expect(dataOf(sent[0])).toEqual({ challengeId, kind: 'taunt_followup' });
    expect(sent[0]).toMatchObject({ title: 'Koymayacak mısın?', body: 'Veli ağzını açmanı bekliyor.' });
    expect(followups(harness, veli)).toHaveLength(0);

    // one is all it takes: later passes, the next afternoon too, stay quiet
    for (const later of [2 * HOUR + MINUTE, 5 * HOUR, 26 * HOUR]) {
      at(harness, finishedAt, later);
      expect(tick(harness)).toMatchObject({ tauntFollowups: 0 });
    }
    expect(followups(harness, ali)).toHaveLength(1);
  });

  it('stays quiet when the winner already said it', async () => {
    harness = await makeApp({ now: NOW });
    const { players, challengeId, finishedAt } = await finishedWater(harness, [6, 4]);
    const [ali, veli] = players as [RegisteredUser, RegisteredUser];
    await taunt(harness, ali, veli, challengeId);

    at(harness, finishedAt, 2 * HOUR);
    expect(tick(harness)).toMatchObject({ tauntFollowups: 0 });
    expect(followups(harness, ali)).toHaveLength(0);
  });

  it('names only the losers still waiting', async () => {
    harness = await makeApp({ now: NOW });
    const { players, challengeId, finishedAt } = await finishedWater(harness, [8, 5, 3]);
    const [ali, veli] = players as [RegisteredUser, RegisteredUser, RegisteredUser];
    await taunt(harness, ali, veli, challengeId);

    at(harness, finishedAt, 2 * HOUR);
    expect(tick(harness)).toMatchObject({ tauntFollowups: 1 });
    expect(followups(harness, ali)[0]?.body).toBe('Ayşe ağzını açmanı bekliyor.');
  });

  it('talks to the whole queue when several are waiting, at the winner\'s own level', async () => {
    harness = await makeApp({ now: NOW });
    const { players, finishedAt } = await finishedWater(harness, [8, 5, 3]);
    const [ali] = players as [RegisteredUser];
    harness.db.prepare('UPDATE users SET vulgarity_max = 3 WHERE id = ?').run(ali.me.id);

    at(harness, finishedAt, 2 * HOUR);
    expect(tick(harness)).toMatchObject({ tauntFollowups: 1 });
    // runner-up first
    expect(followups(harness, ali)[0]).toMatchObject({
      title: 'KOYMADIN DAHA 🍆',
      body: 'Veli ve Ayşe sırada bekliyor, hadi hepsine koy.',
    });
  });

  it('is not quieted by a loser answering back', async () => {
    harness = await makeApp({ now: NOW });
    const { players, challengeId, finishedAt } = await finishedWater(harness, [8, 5, 3]);
    const [ali, veli, ayse] = players as [RegisteredUser, RegisteredUser, RegisteredUser];
    await taunt(harness, ali, veli, challengeId);
    // Veli's one answer goes to Ali: it is not Ali's laf to Ayşe, nor a second one to Veli
    await taunt(harness, veli, ali, challengeId);

    at(harness, finishedAt, 2 * HOUR);
    expect(tick(harness)).toMatchObject({ tauntFollowups: 1 });
    expect(followups(harness, ali)[0]?.body).toBe('Ayşe ağzını açmanı bekliyor.');
    for (const loser of [veli, ayse]) expect(followups(harness, loser)).toHaveLength(0);
  });

  it('has nobody to remind after a tie', async () => {
    harness = await makeApp({ now: NOW });
    const { players, challengeId, finishedAt } = await finishedWater(harness, [5, 5]);
    expect(challengeRow(harness, challengeId).is_tie).toBe(1);

    at(harness, finishedAt, 2 * HOUR);
    expect(tick(harness)).toMatchObject({ tauntFollowups: 0 });
    for (const player of players) expect(followups(harness, player)).toHaveLength(0);
  });

  it('reminds nobody when the co-leaders of a tie had a go at each other', async () => {
    harness = await makeApp({ now: NOW });
    const { players, challengeId, finishedAt } = await finishedWater(harness, [5, 5, 3]);
    const [ali, veli] = players as [RegisteredUser, RegisteredUser, RegisteredUser];
    await taunt(harness, ali, veli, challengeId);
    await taunt(harness, veli, ali, challengeId);

    at(harness, finishedAt, 2 * HOUR);
    expect(tick(harness)).toMatchObject({ tauntFollowups: 0 });
    for (const player of players) expect(followups(harness, player)).toHaveLength(0);
  });

  it('does not push the winner towards somebody behind a block', async () => {
    harness = await makeApp({ now: NOW });
    const { players, finishedAt } = await finishedWater(harness, [6, 4]);
    const [ali, veli] = players as [RegisteredUser, RegisteredUser];
    const blocked = await authed(harness.app, veli.token)({ method: 'POST', url: `/users/${ali.me.id}/block` });
    expect(blocked.statusCode).toBe(200);

    at(harness, finishedAt, 2 * HOUR);
    expect(tick(harness)).toMatchObject({ tauntFollowups: 0 });
    expect(followups(harness, ali)).toHaveLength(0);
  });

  it('lets a winner who finished at midnight sleep, and reminds them at noon', async () => {
    harness = await makeApp({ now: NOW });
    const { players, finishedAt } = await finishedWater(harness, [6, 4], MIDNIGHT_END);
    const [ali] = players as [RegisteredUser];

    for (const night of [2 * HOUR, 6 * HOUR, 11 * HOUR]) {
      at(harness, finishedAt, night); // 02:00, 06:00, 11:00 in Istanbul
      expect(tick(harness)).toMatchObject({ tauntFollowups: 0 });
    }
    at(harness, '2026-01-07T09:00:00.000Z'); // 12:00 in Istanbul
    expect(tick(harness)).toMatchObject({ tauntFollowups: 1 });
    expect(followups(harness, ali)).toHaveLength(1);
  });

  it('lets it go two days after the finish', async () => {
    harness = await makeApp({ now: NOW });
    const { players, finishedAt } = await finishedWater(harness, [6, 4]);
    const [ali] = players as [RegisteredUser];

    // the server was off the whole time and comes back in the afternoon two days later
    at(harness, finishedAt, 48 * HOUR + MINUTE);
    expect(tick(harness)).toMatchObject({ tauntFollowups: 0 });
    expect(followups(harness, ali)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe('scheduler: cancellation', () => {
  it('cancels a pending challenge that reached its end without a second player', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await pendingChallenge(harness, {
      startsIn: 2 * HOUR,
      runsFor: 2 * HOUR,
      accept: false,
    });

    harness.advance(3 * HOUR); // started, but still alone
    expect(tick(harness)).toMatchObject({ activated: 0, cancelled: 0 });
    expect(challengeRow(harness, challengeId).status).toBe('pending');

    harness.advance(2 * HOUR); // past the end
    expect(tick(harness)).toMatchObject({ activated: 0, finalized: 0, cancelled: 1 });

    const row = challengeRow(harness, challengeId);
    expect(row.status).toBe('cancelled');
    expect(row.finalized_at).toBe(harness.now().toISOString());

    // The creator and the friend who never answered both hear about it.
    for (const user of [ali, veli]) {
      const cancelled = listByType(harness.db, user.me.id, 'challenge_cancelled');
      expect(cancelled, user.me.username).toHaveLength(1);
      expect(dataOf(cancelled[0])).toMatchObject({ challengeId });
    }

    expect(tick(harness)).toMatchObject({ cancelled: 0 });
  });

  it('says the rival walked out, not "kimse kabul etmedi", when a silent invitee kept it open to the end', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    const ayse = await registerUser(harness.app, 'ayse', { displayName: 'Ayşe' });
    befriend(harness.app, ali.me.id, veli.me.id);
    befriend(harness.app, ali.me.id, ayse.me.id);
    const created = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/challenges',
      payload: { typeKey: 'su_bardak', startsAt: iso(harness), endsAt: MIDNIGHT_END, participantIds: [veli.me.id, ayse.me.id] },
    });
    const challengeId = created.json<Challenge>().id;
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    harness.advance(HOUR);
    // Veli quits; Ayşe could still say yes, so it stays open
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/leave` });
    expect(challengeRow(harness, challengeId).status).toBe('active');

    at(harness, MIDNIGHT_END, MINUTE);
    tick(harness);
    expect(challengeRow(harness, challengeId).status).toBe('cancelled');
    const [told] = listByType(harness.db, ali.me.id, 'challenge_cancelled');
    expect(dataOf(told!)).toMatchObject({ challengeId, reason: 'everyone_left' });
    expect(told?.body).toContain('herkes kaçtı');
    expect(told?.body).not.toContain('kimse kabul etmedi');
  });

  it('says the same when the one who accepted left before a pending çelınc could start', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    const ayse = await registerUser(harness.app, 'ayse', { displayName: 'Ayşe' });
    befriend(harness.app, ali.me.id, veli.me.id);
    befriend(harness.app, ali.me.id, ayse.me.id);
    const created = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/challenges',
      payload: {
        typeKey: 'su_bardak',
        startsAt: iso(harness, 2 * HOUR),
        endsAt: iso(harness, 4 * HOUR),
        participantIds: [veli.me.id, ayse.me.id],
      },
    });
    const challengeId = created.json<Challenge>().id;
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/leave` });

    harness.advance(5 * HOUR);
    expect(tick(harness)).toMatchObject({ cancelled: 1 });
    const [told] = listByType(harness.db, ali.me.id, 'challenge_cancelled');
    expect(dataOf(told!)).toMatchObject({ challengeId, reason: 'everyone_left' });
    expect(told?.body).not.toContain('kimse kabul etmedi');
  });
});

// ---------------------------------------------------------------------------
// Stopping
// ---------------------------------------------------------------------------

/** A push sender whose flush stays open until the test lets it go. */
function heldPush(): { push: PushSender; flushing: () => boolean; release: () => void } {
  let started = false;
  let release: () => void = () => {};
  const push: PushSender = {
    flush: () => {
      started = true;
      return new Promise<FlushResult>((resolve) => {
        release = () => resolve({ sent: 1, failed: 0 });
      });
    },
  };
  return { push, flushing: () => started, release: () => release() };
}

describe('scheduler: stop', () => {
  it('waits for the push flush in flight, so the database does not close under it', async () => {
    harness = await makeApp({ now: NOW });
    const held = heldPush();
    const stop = startScheduler(harness.app, harness.db, harness.config, { push: held.push });
    // the first pass runs right at start
    expect(held.flushing()).toBe(true);

    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopped).toBe(false);

    held.release();
    await stopping;
    expect(stopped).toBe(true);
  });

  it('gives up on a flush that never answers instead of hanging the shutdown', async () => {
    harness = await makeApp({ now: NOW });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const stop = startScheduler(harness.app, harness.db, harness.config, { push: heldPush().push });
      let stopped = false;
      const stopping = stop().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(STOP_WAIT_MS - 1);
      expect(stopped).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await stopping;
      expect(stopped).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
