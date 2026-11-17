/**
 * The scheduler pass (SPEC 2.4) driven end-to-end with an injected clock.
 *
 * Everything here goes through the real HTTP routes to build the state and then
 * calls `runSchedulerOnce(db, now)` — the same function `startScheduler` calls on
 * its 30-second timer — so the test covers exactly what the running server does:
 * a challenge going live at its start time, finishing at its end time (a step
 * çelınc once the phones have had their hour, any çelınc whose numbers were typed
 * or moved at the whistle once friends have had theirs to question them) with the
 * right winner (or no winner at all), telling every participant, handing out
 * badges, throwing out a disputed entry whose owner never answered (and holding
 * the result for one who still may),
 * giving both an hour after the owner's PC wakes from a night asleep (also when
 * a phone's request gets there before the interval's first beat after the wake), and
 * cancelling a pending challenge nobody joined, and sweeping the proof photos no
 * entry shows once a day. The last block is `startScheduler`'s stop, which a
 * clean shutdown awaits before closing the database.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHALLENGE_TYPES, DEFAULT_TIMEZONE, LIMITS, todayKey, type Challenge, type Entry } from '@koydum/shared';
import { runSchedulerOnce, WAKE_GRACE_MS } from '../src/services/challenges.js';
import { challengeFeed, disputeUpheldCopy, entryReplacedCopy } from '../src/services/challengeViews.js';
import { listByType } from '../src/services/notifications.js';
import type { FlushResult, PushSender } from '../src/services/push.js';
import {
  nextBootAt,
  RESUME_GAP_MS,
  SCHEDULER_INTERVAL_MS,
  startScheduler,
  STOP_WAIT_MS,
} from '../src/services/scheduler.js';
import { readLastBeat, writeLastBeat } from '../src/services/pauses.js';
import { getBadges } from '../src/services/stats.js';
import { migrate, newId, nowIso, type ChallengeRow, type ParticipantRow } from '../src/db/index.js';
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
  extras: { reminderHour?: number; proofRequired?: boolean } = {},
): Promise<{ ali: RegisteredUser; veli: RegisteredUser; challengeId: string }> {
  const { proofRequired, ...userExtras } = extras;
  const ali = await registerUser(h.app, 'ali', { displayName: 'Ali', ...userExtras });
  const veli = await registerUser(h.app, 'veli', { displayName: 'Veli', ...userExtras });
  befriend(h.app, ali.me.id, veli.me.id);
  const created = await authed(h.app, ali.token)({
    method: 'POST',
    url: '/challenges',
    payload: {
      typeKey,
      startsAt: iso(h),
      endsAt: MIDNIGHT_END,
      participantIds: [veli.me.id],
      rewardText: 'Döner',
      ...(proofRequired === undefined ? {} : { proofRequired }),
    },
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

  it('finishes early once every phone has reported the last day after the end, with nothing new in it', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await endingAtMidnight(harness, 'adim_yarisi');

    // 23:50: both evenings are already in
    at(harness, MIDNIGHT_END, -10 * MINUTE);
    await phoneSync(harness, ali, { '2026-01-06': 10_000 });
    await phoneSync(harness, veli, { '2026-01-06': 9_000 });

    // Ali's phone reports after midnight, but only the new day: the last one is not in.
    at(harness, MIDNIGHT_END, 5 * MINUTE);
    await phoneSync(harness, ali, { '2026-01-07': 40 });
    await phoneSync(harness, veli, { '2026-01-06': 9_000, '2026-01-07': 10 });
    expect(tick(harness)).toMatchObject({ finalized: 0 });

    // the same number again: nothing moved after the end, nothing to question
    at(harness, MIDNIGHT_END, 10 * MINUTE);
    await phoneSync(harness, ali, { '2026-01-06': 10_000, '2026-01-07': 60 });
    expect(tick(harness)).toMatchObject({ finalized: 1 });
    expect(challengeRow(harness, challengeId)).toMatchObject({ status: 'finished', winner_id: ali.me.id });
    expect(participant(harness, challengeId, ali.me.id).final_score).toBe(10_000);
  });

  it('takes nothing from a phone first opened after the hour, and nothing tells an iPhone player otherwise', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await endingAtMidnight(harness, 'adim_yarisi');

    // Ali's phone syncs in the evening; Veli's iPhone stays shut until the morning after.
    at(harness, '2026-01-06T19:00:00.000Z');
    await phoneSync(harness, ali, { '2026-01-05': 8_000, '2026-01-06': 10_000 });
    at(harness, MIDNIGHT_END, LIMITS.DEVICE_SETTLE_MS);
    expect(tick(harness)).toMatchObject({ finalized: 1 });

    at(harness, MIDNIGHT_END, 9 * HOUR);
    const late = await authed(harness.app, veli.token)({
      method: 'POST',
      url: '/me/steps',
      payload: {
        days: [
          { dayKey: '2026-01-05', steps: 15_000, source: 'pedometer' },
          { dayKey: '2026-01-06', steps: 17_000, source: 'pedometer' },
        ],
      },
    });
    expect(late.json<{ updated: number }>().updated).toBe(0);
    expect(challengeRow(harness, challengeId)).toMatchObject({ status: 'finished', winner_id: ali.me.id });

    // "open it once a day / once a week" was all the rules and the README asked of him
    const rules = CHALLENGE_TYPES.find((type) => type.key === 'adim_yarisi')?.howMeasuredTr ?? '';
    expect(rules).not.toContain('günde bir kere uygulamayı açman yeterli');
    expect(rules).toContain('Çelınc bitince bir saat içinde uygulamayı bir kez aç');
    const readme = fs.readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
    expect(readme).not.toContain('haftada bir açman yeter');
    expect(readme).toContain('çelınc bitince o saat içinde uygulamayı bir kez aç');
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
    // no phone counts water: the day simply drops off the score
    expect(rejected[0]?.body).toContain('5 Ocak Pazartesi günkü girişine');
    expect(rejected[0]?.body).toContain('skorundan düştü');
    expect(rejected[0]?.body).not.toContain('telefon');
    // Veli started it, so Veli hears how it ended
    const told = listByType(harness.db, veli.me.id, 'dispute');
    expect(told).toHaveLength(3);
    expect(told.map((row) => dataOf(row).entryId).sort()).toEqual([...entries].sort());
    expect(dataOf(told[0]!)).toMatchObject({ challengeId, kind: 'upheld' });
    expect(told[0]).toMatchObject({ title: 'İtirazın tuttu' });
    expect(told[0]?.body).toContain('Ali, ');
    expect(told[0]?.body).not.toContain('telefon');
    // days are written the way people say them, never as a database key
    const said = [...listByType(harness.db, ali.me.id, 'dispute'), ...rejected, ...told];
    for (const row of said) {
      expect(row.body).toContain('5 Ocak Pazartesi');
      expect(row.body).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
    // three upheld itiraz is the first rung of the ladder
    expect(getBadges(harness.db, veli.me.id)).toContain('itiraz_1');

    // done is done: the next pass has nothing left to throw out
    expect(tick(harness)).toMatchObject({ disputes: 0 });
    expect(listByType(harness.db, ali.me.id, 'entry_rejected')).toHaveLength(3);
  });

  it("names the phone's number that took a typed step day's place, to the owner and the disputer", async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await endingAtMidnight(harness, 'adim_yarisi');
    const day = today(harness);
    const typed = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: day, value: 15_000, source: 'manual', clientTime: iso(harness) },
    });
    expect(typed.statusCode).toBe(201);
    const entryId = typed.json<{ entry: { id: string } }>().entry.id;
    await dispute(harness, veli, challengeId, entryId);
    // the phone reports the day meanwhile; the typed row stays the itiraz's
    await phoneSync(harness, ali, { [day]: 8_200 });

    harness.advance(LIMITS.DISPUTE_ANSWER_MS);
    expect(tick(harness)).toMatchObject({ disputes: 1 });
    expect(entryStatus(harness, entryId)).toBe('ok');

    // not "skorundan düştü": the day still counts, with the phone's number
    const [owner] = listByType(harness.db, ali.me.id, 'entry_rejected');
    expect(owner?.body).toContain('15.000 adım');
    expect(owner?.body).toContain('8.200 adım');
    expect(owner?.body).not.toContain('skorundan düştü');

    const told = listByType(harness.db, veli.me.id, 'dispute');
    expect(told).toHaveLength(1);
    expect(dataOf(told[0]!)).toEqual({ challengeId, entryId, kind: 'upheld' });
    expect(told[0]?.body).toContain('telefonunun saydığı 8.200 adım');
  });

  it('says both numbers at every level, and the phone only when it took the day', () => {
    for (const level of [1, 2, 3] as const) {
      const replaced = entryReplacedCopy(level, 'Adım', '2026-10-21', '15.000 adım', '8.200 adım');
      expect(replaced.body).toContain('21 Ekim Çarşamba için yazdığın 15.000 adım');
      expect(replaced.body).toContain('Telefonun');
      expect(replaced.body).toContain('8.200 adım');

      const plain = disputeUpheldCopy(level, 'Ali', 'Adım', '2026-10-21', null);
      expect(plain.body).toContain('Ali, "Adım" çelıncında 21 Ekim Çarşamba günkü girişine');
      expect(plain.body).not.toContain('elefon');
      expect(disputeUpheldCopy(level, 'Ali', 'Adım', '2026-10-21', '8.200 adım').body).toContain('elefonu');
    }
  });

  it('tells no disputer who blocked the owner or deleted the account in the meantime', async () => {
    harness = await makeApp({ now: NOW });
    const players: RegisteredUser[] = [];
    for (const name of ['ali', 'veli', 'ayse', 'mert']) players.push(await registerUser(harness.app, name));
    const [ali, veli, ayse, mert] = players as [RegisteredUser, RegisteredUser, RegisteredUser, RegisteredUser];
    for (const friend of [veli, ayse, mert]) befriend(harness.app, ali.me.id, friend.me.id);
    const created = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/challenges',
      payload: { typeKey: 'su_bardak', startsAt: iso(harness), endsAt: MIDNIGHT_END, participantIds: [veli.me.id, ayse.me.id, mert.me.id] },
    });
    const challengeId = created.json<Challenge>().id;
    for (const friend of [veli, ayse, mert]) {
      await authed(harness.app, friend.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    }
    tick(harness);
    const entryId = await logWater(harness, ali, challengeId, 9);
    for (const friend of [veli, ayse, mert]) await dispute(harness, friend, challengeId, entryId);

    const blocked = await authed(harness.app, ayse.token)({ method: 'POST', url: `/users/${ali.me.id}/block` });
    expect(blocked.statusCode).toBe(200);
    expect((await authed(harness.app, mert.token)({ method: 'DELETE', url: '/me' })).statusCode).toBe(200);

    harness.advance(LIMITS.DISPUTE_ANSWER_MS);
    expect(tick(harness)).toMatchObject({ disputes: 1 });
    expect(entryStatus(harness, entryId)).toBe('rejected');
    // Veli's itiraz called the other two to it before; this is about the verdict
    const upheld = (user: RegisteredUser) =>
      listByType(harness!.db, user.me.id, 'dispute').filter((row) => (JSON.parse(row.data) as { kind?: string }).kind === 'upheld');
    expect(upheld(veli)).toHaveLength(1);
    expect(upheld(ayse)).toHaveLength(0);
    expect(upheld(mert)).toHaveLength(0);
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

// ---------------------------------------------------------------------------
// The itiraz hour for numbers that land at the whistle
// ---------------------------------------------------------------------------

/** Pages read today, typed the way the app's form sends them. */
async function logPages(h: TestApp, user: RegisteredUser, challengeId: string, value: number): Promise<string> {
  const response = await authed(h.app, user.token)({
    method: 'POST',
    url: `/challenges/${challengeId}/entries`,
    payload: { dayKey: today(h), value, source: 'manual', clientTime: iso(h), sessionId: randomUUID() },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ entry: { id: string } }>().entry.id;
}

async function disputesCloseAt(h: TestApp, user: RegisteredUser, challengeId: string): Promise<string | null | undefined> {
  const detail = await authed(h.app, user.token)({ method: 'GET', url: `/challenges/${challengeId}` });
  expect(detail.statusCode).toBe(200);
  return detail.json<{ disputesCloseAt?: string | null }>().disputesCloseAt;
}

function stepDay(h: TestApp, challengeId: string, user: RegisteredUser, dayKey: string): string {
  return (
    h.db
      .prepare('SELECT id FROM entries WHERE challenge_id = ? AND user_id = ? AND day_key = ?')
      .get(challengeId, user.me.id, dayKey) as { id: string }
  ).id;
}

const AN_HOUR_AFTER = new Date(Date.parse(MIDNIGHT_END) + LIMITS.DEVICE_SETTLE_MS).toISOString();

describe('scheduler: the itiraz hour for numbers that land at the whistle', () => {
  it('keeps a typed çelınc open an hour for an itiraz on a number typed in its last minute', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await endingAtMidnight(harness, 'kitap_sayfa', { proofRequired: false });
    at(harness, MIDNIGHT_END, -2 * HOUR);
    await logPages(harness, ali, challengeId, 120);
    await logPages(harness, veli, challengeId, 100);
    expect(await disputesCloseAt(harness, ali, challengeId)).toBe(MIDNIGHT_END);

    // 23:59:30: Veli's 300 pages, thirty seconds before anybody could only look
    at(harness, MIDNIGHT_END, -30_000);
    const late = await logPages(harness, veli, challengeId, 300);
    expect(await disputesCloseAt(harness, ali, challengeId)).toBe(AN_HOUR_AFTER);

    at(harness, MIDNIGHT_END, 10_000);
    expect(tick(harness)).toMatchObject({ finalized: 0 });
    expect(challengeRow(harness, challengeId).status).toBe('active');

    // 00:00:20: Ali saw it, and an itiraz still lands with the owner's 12 hours
    at(harness, MIDNIGHT_END, 20_000);
    expect((await dispute(harness, ali, challengeId, late)).answerBy).not.toBeNull();
    at(harness, MIDNIGHT_END, 30_000);
    expect(tick(harness)).toMatchObject({ finalized: 0 });

    // no photo came: the 300 burns, and the result is the one without it
    at(harness, MIDNIGHT_END, 20_000 + LIMITS.DISPUTE_ANSWER_MS);
    expect(tick(harness)).toMatchObject({ disputes: 1, finalized: 1 });
    expect(entryStatus(harness, late)).toBe('rejected');
    expect(challengeRow(harness, challengeId)).toMatchObject({ status: 'finished', winner_id: ali.me.id });
  });

  it('waits no longer than the hour when nobody questions the late number', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await endingAtMidnight(harness, 'kitap_sayfa', { proofRequired: false });
    at(harness, MIDNIGHT_END, -2 * HOUR);
    await logPages(harness, ali, challengeId, 120);
    at(harness, MIDNIGHT_END, -30_000);
    await logPages(harness, veli, challengeId, 300);

    at(harness, MIDNIGHT_END, LIMITS.DEVICE_SETTLE_MS - MINUTE);
    expect(tick(harness)).toMatchObject({ finalized: 0 });
    at(harness, MIDNIGHT_END, LIMITS.DEVICE_SETTLE_MS);
    expect(tick(harness)).toMatchObject({ finalized: 1 });
    expect(challengeRow(harness, challengeId)).toMatchObject({ status: 'finished', winner_id: veli.me.id });
  });

  it('takes an itiraz after the end on focus sessions posted in the last minute', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await endingAtMidnight(harness, 'odak_seansi');
    at(harness, '2026-01-06T15:00:00.000Z');
    const session = (user: RegisteredUser, dayKey: string) =>
      authed(harness!.app, user.token)({
        method: 'POST',
        url: `/challenges/${challengeId}/entries`,
        payload: { dayKey, value: 180, source: 'focus', clientTime: iso(harness!), sessionId: randomUUID() },
      });
    for (const dayKey of ['2026-01-05', '2026-01-06']) {
      expect((await session(ali, dayKey)).statusCode).toBe(201);
      expect((await session(ali, dayKey)).statusCode).toBe(201);
    }
    expect((await session(ali, '2026-01-05')).statusCode).toBe(400); // the day's 360 are in

    // Veli's four 180-minute sessions all arrive thirty seconds before the end
    at(harness, MIDNIGHT_END, -30_000);
    const veliSessions: string[] = [];
    for (const dayKey of ['2026-01-05', '2026-01-05', '2026-01-06', '2026-01-06']) {
      const response = await session(veli, dayKey);
      expect(response.statusCode).toBe(201);
      veliSessions.push(response.json<{ entry: { id: string } }>().entry.id);
    }

    at(harness, MIDNIGHT_END, 20_000);
    expect((await dispute(harness, ali, challengeId, veliSessions[3]!)).answerBy).not.toBeNull();
    at(harness, MIDNIGHT_END, 30_000);
    expect(tick(harness)).toMatchObject({ finalized: 0 });
    expect(challengeRow(harness, challengeId).status).toBe('active');
  });

  it('still finishes a typed çelınc on the dot when its last number came earlier than the last hour', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await endingAtMidnight(harness, 'kitap_sayfa', { proofRequired: false });
    at(harness, MIDNIGHT_END, -2 * HOUR);
    await logPages(harness, ali, challengeId, 120);
    const veliPages = await logPages(harness, veli, challengeId, 300);

    at(harness, MIDNIGHT_END, 1);
    expect(await disputesCloseAt(harness, ali, challengeId)).toBe(MIDNIGHT_END);
    const late = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${veliPages}/dispute`,
      payload: { reason: 'okumadı o kadar' },
    });
    expect(late.statusCode).toBe(400);
    expect(late.json<{ error: { code: string } }>().error.code).toBe('challenge_ended');
    expect(tick(harness)).toMatchObject({ finalized: 1 });
    expect(challengeRow(harness, challengeId)).toMatchObject({ status: 'finished', winner_id: veli.me.id });
  });

  it('opens no hour for a photo that answers an afternoon itiraz after the end', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await endingAtMidnight(harness, 'kitap_sayfa', { proofRequired: false });
    at(harness, MIDNIGHT_END, -5 * HOUR);
    const aliPages = await logPages(harness, ali, challengeId, 300);
    const aliMore = await logPages(harness, ali, challengeId, 50);
    await logPages(harness, veli, challengeId, 100);
    at(harness, MIDNIGHT_END, -4 * HOUR);
    await dispute(harness, veli, challengeId, aliPages);

    // over at midnight, waiting only for Ali's photo
    at(harness, MIDNIGHT_END, 1);
    expect(tick(harness)).toMatchObject({ finalized: 0 });
    at(harness, MIDNIGHT_END, 20 * MINUTE);
    const answered = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${aliPages}/proof`,
      payload: { proofUrl: '/uploads/sayfalar.jpg' },
    });
    expect(answered.statusCode).toBe(200);
    expect(await disputesCloseAt(harness, veli, challengeId)).toBe(MIDNIGHT_END);

    const another = await authed(harness.app, veli.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${aliMore}/dispute`,
      payload: { reason: 'bu da yalan' },
    });
    expect(another.statusCode).toBe(400);
    expect(another.json<{ error: { code: string } }>().error.code).toBe('challenge_ended');
    expect(tick(harness)).toMatchObject({ finalized: 1 });
    expect(challengeRow(harness, challengeId)).toMatchObject({ status: 'finished', winner_id: ali.me.id });
  });

  it('gives a late typed number the hour after a server that was off at the end comes back', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await endingAtMidnight(harness, 'kitap_sayfa', { proofRequired: false });
    at(harness, MIDNIGHT_END, -30_000);
    const late = await logPages(harness, veli, challengeId, 300);

    // the PC was off from midnight to 08:00: nobody could see the 300 before
    const bootAt = new Date(Date.parse(MIDNIGHT_END) + 8 * HOUR);
    harness.app.schedulerBootAt.at = bootAt;
    const pass = () => runSchedulerOnce(harness!.db, harness!.now(), { bootAt });
    at(harness, bootAt.toISOString());
    expect(pass()).toMatchObject({ finalized: 0 });
    at(harness, bootAt.toISOString(), 10 * MINUTE);
    expect(await disputesCloseAt(harness, ali, challengeId)).toBe(
      new Date(bootAt.getTime() + LIMITS.DEVICE_SETTLE_MS).toISOString(),
    );
    await dispute(harness, ali, challengeId, late);
    expect(entryStatus(harness, late)).toBe('disputed');
  });

  it('holds a step çelınc the whole hour when a phone raised its days after the rival had reported', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await endingAtMidnight(harness, 'adim_yarisi');
    at(harness, '2026-01-06T19:00:00.000Z');
    await phoneSync(harness, ali, { '2026-01-05': 9_000, '2026-01-06': 10_000 });
    await phoneSync(harness, veli, { '2026-01-05': 8_000, '2026-01-06': 9_000 });

    // 00:00:05 Ali's phone sends the last evening; 00:00:10 Veli's raises both days
    at(harness, MIDNIGHT_END, 5_000);
    await phoneSync(harness, ali, { '2026-01-06': 10_400, '2026-01-07': 20 });
    at(harness, MIDNIGHT_END, 10_000);
    await phoneSync(harness, veli, { '2026-01-05': 30_000, '2026-01-06': 30_000, '2026-01-07': 0 });

    // every phone has reported, but a number moved: the hour stays for questions
    at(harness, MIDNIGHT_END, 30_000);
    expect(tick(harness)).toMatchObject({ finalized: 0 });
    expect(challengeRow(harness, challengeId).status).toBe('active');
    at(harness, MIDNIGHT_END, 2 * MINUTE);
    expect((await dispute(harness, ali, challengeId, stepDay(harness, challengeId, veli, '2026-01-06'))).answerBy).not.toBeNull();
  });

  it('finishes a step çelınc an hour after its end when the numbers that moved go unquestioned', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await endingAtMidnight(harness, 'adim_yarisi');
    at(harness, '2026-01-06T19:00:00.000Z');
    await phoneSync(harness, ali, { '2026-01-06': 10_000 });
    await phoneSync(harness, veli, { '2026-01-06': 9_000 });

    at(harness, MIDNIGHT_END, 5 * MINUTE);
    await phoneSync(harness, ali, { '2026-01-06': 10_400 });
    await phoneSync(harness, veli, { '2026-01-06': 12_000 });
    at(harness, MIDNIGHT_END, LIMITS.DEVICE_SETTLE_MS - MINUTE);
    expect(tick(harness)).toMatchObject({ finalized: 0 });
    at(harness, MIDNIGHT_END, LIMITS.DEVICE_SETTLE_MS);
    expect(tick(harness)).toMatchObject({ finalized: 1 });
    expect(challengeRow(harness, challengeId)).toMatchObject({ status: 'finished', winner_id: veli.me.id });
  });

  it('holds a step çelınc for a "Beyan et" day typed at the whistle, even with every phone in', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await endingAtMidnight(harness, 'adim_yarisi');
    at(harness, '2026-01-06T19:00:00.000Z');
    await phoneSync(harness, ali, { '2026-01-06': 10_000 });
    await phoneSync(harness, veli, { '2026-01-06': 9_000 });

    at(harness, MIDNIGHT_END, -30_000);
    const typed = await authed(harness.app, veli.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: '2026-01-06', value: 25_000, source: 'manual', clientTime: iso(harness) },
    });
    expect(typed.statusCode).toBe(200);

    // both phones send the last day again after the end, nothing new in it
    at(harness, MIDNIGHT_END, 5 * MINUTE);
    await phoneSync(harness, ali, { '2026-01-06': 10_000 });
    await phoneSync(harness, veli, { '2026-01-06': 9_000 });
    expect(tick(harness)).toMatchObject({ finalized: 0 });
    at(harness, MIDNIGHT_END, 10 * MINUTE);
    expect((await dispute(harness, ali, challengeId, stepDay(harness, challengeId, veli, '2026-01-06'))).answerBy).not.toBeNull();
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

// ---------------------------------------------------------------------------
// The owner's PC sleeps
// ---------------------------------------------------------------------------

/** A push sender with nothing to send, so a pass started by the interval ends at once. */
const quietPush: PushSender = { flush: () => Promise.resolve({ sent: 0, failed: 0 }) };

describe('scheduler: the owner\'s PC slept through the night', () => {
  it('takes a gap of more than five minutes between two beats for a sleep, and nothing shorter', () => {
    const prev = new Date('2026-01-06T18:00:00.000Z');
    const lastBeat = Date.parse('2026-01-06T20:30:00.000Z');
    expect(nextBootAt(prev, lastBeat, new Date(lastBeat + SCHEDULER_INTERVAL_MS))).toBe(prev);
    expect(nextBootAt(prev, lastBeat, new Date(lastBeat + 4 * MINUTE))).toBe(prev);
    expect(nextBootAt(prev, lastBeat, new Date(lastBeat + RESUME_GAP_MS))).toBe(prev);
    const woke = new Date(lastBeat + 6 * MINUTE);
    expect(nextBootAt(prev, lastBeat, woke)).toBe(woke);
  });

  /**
   * The machine's uptime as the test clock: moving that clock is a sleep, the
   * uptime running on through it (a clock merely put forward leaves it alone).
   */
  const asleepWithClock = (h: TestApp) => ({ push: quietPush, uptimeMs: () => h.now().getTime() });

  /** What the scheduler wrote down as time it was not running (a parked check-in counts at its tap inside one). */
  function pauses(h: TestApp): { started_at: string; ended_at: string }[] {
    return h.db.prepare('SELECT started_at, ended_at FROM server_pauses ORDER BY started_at').all() as {
      started_at: string;
      ended_at: string;
    }[];
  }

  it('writes down a sleep between two beats, and not a beat a minute late', async () => {
    harness = await makeApp({ now: NOW });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let stop: (() => Promise<void>) | null = null;
    try {
      stop = startScheduler(harness.app, harness.db, harness.config, asleepWithClock(harness));
      const beat = async (): Promise<void> => {
        await vi.advanceTimersByTimeAsync(SCHEDULER_INTERVAL_MS);
        await new Promise((resolve) => setImmediate(resolve));
      };

      // a busy minute is no sleep
      at(harness, NOW, MINUTE);
      await beat();
      expect(pauses(harness)).toEqual([]);
      expect(readLastBeat(harness.db)?.toISOString()).toBe(iso(harness));

      // two hours without a beat: the laptop's lid was shut
      const lastBeat = iso(harness);
      at(harness, lastBeat, 2 * HOUR);
      await beat();
      expect(pauses(harness)).toEqual([{ started_at: lastBeat, ended_at: iso(harness) }]);
      expect(readLastBeat(harness.db)?.toISOString()).toBe(iso(harness));
    } finally {
      await stop?.();
      vi.useRealTimers();
    }
  });

  it('writes down the time a stopped server was off when it starts again', async () => {
    harness = await makeApp({ now: NOW });
    // Ctrl+C three hours ago: its last beat is all the old process left
    const lastRun = iso(harness, -3 * HOUR);
    writeLastBeat(harness.db, new Date(lastRun));
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let stop: (() => Promise<void>) | null = null;
    try {
      stop = startScheduler(harness.app, harness.db, harness.config, { push: quietPush });
      expect(pauses(harness)).toEqual([{ started_at: lastRun, ended_at: NOW }]);
      expect(readLastBeat(harness.db)?.toISOString()).toBe(NOW);
    } finally {
      await stop?.();
      vi.useRealTimers();
    }

    // `dur` and `y` a minute apart: a "Geldim" the tunnel answered with a 502
    // meanwhile counts at its tap like one in the night, so even that is written
    // down, from the moment the stop wrote its last beat
    at(harness, NOW, MINUTE);
    try {
      stop = startScheduler(harness.app, harness.db, harness.config, { push: quietPush });
      expect(pauses(harness)).toEqual([
        { started_at: lastRun, ended_at: NOW },
        { started_at: NOW, ended_at: iso(harness) },
      ]);
      // stopped 20 s after its last beat
      at(harness, NOW, MINUTE + 20_000);
    } finally {
      await stop?.();
    }
    // the stop leaves its own beat: the next pause begins there, not up to 30 s
    // before, while this server was still up to hear a tap
    expect(readLastBeat(harness.db)?.toISOString()).toBe(iso(harness));
  });

  it('takes a clock put forward while it runs for what it is, not for a sleep', async () => {
    harness = await makeApp({ now: NOW });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const warn = vi.spyOn(harness.app.log, 'warn');
    let uptime = 1_000_000;
    let stop: (() => Promise<void>) | null = null;
    try {
      stop = startScheduler(harness.app, harness.db, harness.config, { push: quietPush, uptimeMs: () => uptime });
      // Windows came up three hours behind after Linux; w32tm /resync puts it
      // right between two beats while the process serves all along
      at(harness, NOW, 3 * HOUR);
      uptime += SCHEDULER_INTERVAL_MS;
      await vi.advanceTimersByTimeAsync(SCHEDULER_INTERVAL_MS);
      await new Promise((resolve) => setImmediate(resolve));

      // no pause: a check-in claiming a minute of those three hours was heard, or not tapped
      expect(pauses(harness)).toEqual([]);
      expect(warn).toHaveBeenCalledWith({ minutes: 180 }, 'clock moved forward');
      expect(warn).not.toHaveBeenCalledWith(expect.anything(), 'scheduler resumed after a pause');
      // the results still wait their hour from now, which costs nobody anything
      expect(harness.app.schedulerBootAt.at?.toISOString()).toBe(iso(harness));

      // a real sleep after that is one
      const lastBeat = iso(harness);
      at(harness, lastBeat, 2 * HOUR);
      uptime += 2 * HOUR;
      await vi.advanceTimersByTimeAsync(SCHEDULER_INTERVAL_MS);
      await new Promise((resolve) => setImmediate(resolve));
      expect(pauses(harness)).toEqual([{ started_at: lastBeat, ended_at: iso(harness) }]);
    } finally {
      await stop?.();
      vi.useRealTimers();
    }
  });

  it('gives the phones their hour from the moment it wakes, not from the end it slept through', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await endingAtMidnight(harness, 'adim_yarisi');
    // the last syncs before bed; the rest of the evening sits on the phones
    at(harness, '2026-01-06T19:00:00.000Z');
    await phoneSync(harness, ali, { '2026-01-06': 10_000 });
    await phoneSync(harness, veli, { '2026-01-06': 9_000 });

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const warn = vi.spyOn(harness.app.log, 'warn');
    let stop: (() => Promise<void>) | null = null;
    try {
      // the server was started at 23:30, and the laptop went to sleep soon after
      at(harness, MIDNIGHT_END, -30 * MINUTE);
      stop = startScheduler(harness.app, harness.db, harness.config, asleepWithClock(harness));
      // it wakes at 09:00 with the same process: Windows does not restart it
      at(harness, MIDNIGHT_END, 9 * HOUR);
      const wokeAt = harness.now().getTime();
      const beat = async (): Promise<void> => {
        await vi.advanceTimersByTimeAsync(SCHEDULER_INTERVAL_MS);
        // let the pass that beat started finish, so the next one is not skipped
        await new Promise((resolve) => setImmediate(resolve));
      };
      await beat();
      expect(challengeRow(harness, challengeId).status).toBe('active');
      expect(warn).toHaveBeenCalledWith({ minutes: 9 * 60 + 30 }, 'scheduler resumed after a pause');

      // an hour of beats four minutes apart: awake all along, the hour is not started again
      for (let minutes = 4; minutes < 60; minutes += 4) {
        at(harness, new Date(wokeAt).toISOString(), minutes * MINUTE);
        await beat();
        expect(challengeRow(harness, challengeId).status, `${minutes} dakika sonra`).toBe('active');
      }
      at(harness, new Date(wokeAt).toISOString(), LIMITS.DEVICE_SETTLE_MS);
      await beat();
      expect(challengeRow(harness, challengeId)).toMatchObject({ status: 'finished', winner_id: ali.me.id });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      await stop?.();
      vi.useRealTimers();
    }
  });

  it('takes an itiraz on the last evening that a phone sent after it woke', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await endingAtMidnight(harness, 'adim_yarisi');
    at(harness, '2026-01-06T19:00:00.000Z');
    await phoneSync(harness, ali, { '2026-01-06': 10_000 });
    await phoneSync(harness, veli, { '2026-01-06': 9_000 });

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let stop: (() => Promise<void>) | null = null;
    try {
      // running at 23:00, then the laptop sleeps until 08:00
      at(harness, MIDNIGHT_END, -HOUR);
      stop = startScheduler(harness.app, harness.db, harness.config, asleepWithClock(harness));
      at(harness, MIDNIGHT_END, 8 * HOUR);
      const wokeAt = new Date(harness.now().getTime()).toISOString();
      await vi.advanceTimersByTimeAsync(SCHEDULER_INTERVAL_MS);
      await new Promise((resolve) => setImmediate(resolve));
      expect(challengeRow(harness, challengeId).status).toBe('active');

      // 08:05: Veli's phone finally sends the last day. Awake now, so the
      // interval beats on: ten minutes without one would be another sleep,
      // which the next request catches up on and the hour starts again
      at(harness, wokeAt, 5 * MINUTE);
      await vi.advanceTimersByTimeAsync(SCHEDULER_INTERVAL_MS);
      await new Promise((resolve) => setImmediate(resolve));
      await phoneSync(harness, veli, { '2026-01-06': 45_000 });
      const veliDay = harness.db
        .prepare('SELECT id FROM entries WHERE challenge_id = ? AND user_id = ? AND day_key = ?')
        .get(challengeId, veli.me.id, '2026-01-06') as { id: string };

      // 08:10: Ali sees it and may still call it out, and the app is told until when
      at(harness, wokeAt, 10 * MINUTE);
      const detail = await authed(harness.app, ali.token)({ method: 'GET', url: `/challenges/${challengeId}` });
      expect(detail.json<{ disputesCloseAt: string }>().disputesCloseAt).toBe(
        new Date(Date.parse(wokeAt) + LIMITS.DEVICE_SETTLE_MS).toISOString(),
      );
      await dispute(harness, ali, challengeId, veliDay.id);
      expect(entryStatus(harness, veliDay.id)).toBe('disputed');
    } finally {
      await stop?.();
      vi.useRealTimers();
    }
  });

  it('does not reopen itirazlar on a çelınc that only waits for a photo', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await endingAtMidnight(harness, 'su_bardak');
    at(harness, MIDNIGHT_END, -2 * HOUR);
    const first = await logWater(harness, ali, challengeId, 8);
    const second = await logWater(harness, ali, challengeId, 9);
    await logWater(harness, veli, challengeId, 5);
    // before the last hour: an itiraz's turn in it opens the hour after the end
    at(harness, MIDNIGHT_END, -90 * MINUTE);
    await dispute(harness, veli, challengeId, first);

    // restarted at 01:00: the çelınc waits for Ali's photo, not for any phone
    harness.app.schedulerBootAt.at = new Date(Date.parse(MIDNIGHT_END) + HOUR);
    at(harness, MIDNIGHT_END, HOUR + 10 * MINUTE);
    expect(runSchedulerOnce(harness.db, harness.now(), { bootAt: harness.app.schedulerBootAt.at })).toMatchObject({
      finalized: 0,
    });
    const late = await authed(harness.app, veli.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${second}/dispute`,
      payload: { reason: 'bu da yalan' },
    });
    expect(late.statusCode).toBe(400);
    expect(late.json<{ error: { code: string } }>().error.code).toBe('challenge_ended');
  });

  it('gives the owner of an itiraz that ran out in the night an hour after it wakes, on the clock the app shows', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await endingAtMidnight(harness, 'su_bardak');
    at(harness, MIDNIGHT_END, -2 * HOUR);
    const aliEntry = await logWater(harness, ali, challengeId, 8);
    await logWater(harness, veli, challengeId, 5);
    at(harness, MIDNIGHT_END, -HOUR);
    const answerBy = (await dispute(harness, veli, challengeId, aliEntry)).answerBy!;

    // asleep from before the end until two hours after Ali's 12 hours ran out
    const bootAt = new Date(Date.parse(answerBy) + 2 * HOUR);
    const pass = () => runSchedulerOnce(harness!.db, harness!.now(), { bootAt });
    at(harness, bootAt.toISOString());
    expect(pass()).toMatchObject({ disputes: 0, finalized: 0 });
    expect(entryStatus(harness, aliEntry)).toBe('disputed');
    const extended = new Date(bootAt.getTime() + LIMITS.DEVICE_SETTLE_MS).toISOString();
    expect(answerByOf(harness, aliEntry)).toBe(extended);
    // the feed counts down the same hour, so the app still offers "Kanıt ekle"
    expect(challengeFeed(harness.db, challengeId).find((item) => item.id === aliEntry)?.answerBy).toBe(extended);

    at(harness, extended, -MINUTE);
    expect(pass()).toMatchObject({ disputes: 0, finalized: 0 });
    at(harness, extended);
    expect(pass()).toMatchObject({ disputes: 1, finalized: 1 });
    expect(entryStatus(harness, aliEntry)).toBe('rejected');
    expect(challengeRow(harness, challengeId)).toMatchObject({ status: 'finished', winner_id: veli.me.id });
  });

  it("gives a typed day thrown out after a long sleep the phone's number, which still wins the race", async () => {
    // Monday 00:30 to Sunday midnight in Istanbul
    harness = await makeApp({ now: '2026-01-04T21:30:00.000Z' });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    befriend(harness.app, ali.me.id, veli.me.id);
    const created = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/challenges',
      payload: { typeKey: 'adim_yarisi', startsAt: iso(harness), endsAt: '2026-01-11T20:59:59.999Z', participantIds: [veli.me.id] },
    });
    const challengeId = created.json<Challenge>().id;
    expect((await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` })).statusCode).toBe(200);

    // Monday night: Ali types 30.000 over his phone's 9.000
    at(harness, '2026-01-05T19:00:00.000Z');
    await phoneSync(harness, ali, { '2026-01-05': 9_000 });
    await phoneSync(harness, veli, { '2026-01-05': 5_000 });
    const typed = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: '2026-01-05', value: 30_000, source: 'manual', clientTime: iso(harness) },
    });
    const entryId = typed.json<{ entry: { id: string } }>().entry.id;

    // Sunday 22:00 Veli calls it out, and the PC sleeps from then until Tuesday 18:00
    at(harness, '2026-01-11T19:00:00.000Z');
    await dispute(harness, veli, challengeId, entryId);
    const bootAt = new Date('2026-01-13T15:00:00.000Z');
    at(harness, bootAt.toISOString());
    expect(runSchedulerOnce(harness.db, harness.now(), { bootAt })).toMatchObject({ disputes: 0, finalized: 0 });

    // Ali's hour after the wake runs out: Monday is eight days old, the phone's 9.000 still counts
    at(harness, bootAt.toISOString(), LIMITS.DEVICE_SETTLE_MS + MINUTE);
    expect(runSchedulerOnce(harness.db, harness.now(), { bootAt })).toMatchObject({ disputes: 1, finalized: 1 });
    expect(entryStatus(harness, entryId)).toBe('ok');
    expect(participant(harness, challengeId, ali.me.id)).toMatchObject({ final_score: 9_000, final_rank: 1 });
    expect(challengeRow(harness, challengeId)).toMatchObject({ status: 'finished', winner_id: ali.me.id });
    expect(listByType(harness.db, ali.me.id, 'entry_rejected')[0]?.body).not.toContain('skorundan düştü');
  });

  it('throws out on time an itiraz that ran out while the server was up', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await endingAtMidnight(harness, 'su_bardak');
    const aliEntry = await logWater(harness, ali, challengeId, 8);
    const answerBy = (await dispute(harness, veli, challengeId, aliEntry)).answerBy!;

    // started half an hour before the window ran out: Ali had the server all along
    const bootAt = new Date(Date.parse(answerBy) - 30 * MINUTE);
    at(harness, answerBy);
    expect(runSchedulerOnce(harness.db, harness.now(), { bootAt })).toMatchObject({ disputes: 1 });
    expect(entryStatus(harness, aliEntry)).toBe('rejected');
  });

  it('keeps an extended clock measured against the players who were in when it started', async () => {
    harness = await makeApp({ now: NOW });
    const { players, challengeId } = await waterGroup(harness, ['veli', 'cem']);
    const [ali, veli] = players as [RegisteredUser, RegisteredUser];
    const eda = await registerUser(harness.app, 'eda');
    befriend(harness.app, ali.me.id, eda.me.id);
    const entryId = await logWater(harness, ali, challengeId, 9);
    // three in: Veli alone is the majority and the 12 hours start
    const answerBy = (await dispute(harness, veli, challengeId, entryId)).answerBy!;

    // Ali adds Eda; with four in a new itiraz would need two, this one already started
    harness.advance(MINUTE);
    const invited = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/invite`,
      payload: { userIds: [eda.me.id] },
    });
    expect(invited.statusCode).toBe(200);
    expect((await authed(harness.app, eda.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` })).statusCode).toBe(200);

    const bootAt = new Date(Date.parse(answerBy) + 2 * HOUR);
    const extended = new Date(bootAt.getTime() + LIMITS.DEVICE_SETTLE_MS).toISOString();
    const pass = () => runSchedulerOnce(harness!.db, harness!.now(), { bootAt });
    at(harness, bootAt.toISOString());
    expect(pass()).toMatchObject({ disputes: 0 });
    expect(answerByOf(harness, entryId)).toBe(extended);
    // Eda joined before the moved end's 12 hours, but not before the clock started
    at(harness, bootAt.toISOString(), MINUTE);
    expect(pass()).toMatchObject({ disputes: 0 });
    expect(answerByOf(harness, entryId)).toBe(extended);

    at(harness, extended);
    expect(pass()).toMatchObject({ disputes: 1 });
    expect(entryStatus(harness, entryId)).toBe('rejected');
  });

  // The phones' queues send what they parked the moment the tunnel answers
  // again, which can be before the interval's first beat after the wake: the
  // first request has to find the sleep written down and the çelınclar moved on.

  /** One beat of the interval, and the pass it starts run to its end. */
  const nextBeat = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(SCHEDULER_INTERVAL_MS);
    await new Promise((resolve) => setImmediate(resolve));
  };

  /** Ali and Veli, both in a check-in çelınc of `typeKey` that runs until Friday night. */
  async function checkinRace(h: TestApp, typeKey: string, deadlineTime: string, startsAt = iso(h)) {
    const ali = await registerUser(h.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(h.app, 'veli', { displayName: 'Veli' });
    befriend(h.app, ali.me.id, veli.me.id);
    const created = await authed(h.app, ali.token)({
      method: 'POST',
      url: '/challenges',
      payload: { typeKey, deadlineTime, startsAt, endsAt: '2026-01-09T20:59:59.999Z', participantIds: [veli.me.id] },
    });
    expect(created.statusCode).toBe(201);
    const challengeId = created.json<Challenge>().id;
    expect((await authed(h.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` })).statusCode).toBe(200);
    return { ali, veli, challengeId };
  }

  /** "Geldim" for `dayKey` as the phone's queue sends it: tapped at `tappedAt`. */
  function geldim(h: TestApp, user: RegisteredUser, challengeId: string, dayKey: string, tappedAt: string) {
    return authed(h.app, user.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey, value: 1, source: 'checkin', clientTime: tappedAt },
    });
  }

  it('counts a "Geldim" from the night at its tap when it is the first thing to reach the server after it wakes', async () => {
    harness = await makeApp({ now: NOW });
    const { veli, challengeId } = await checkinRace(harness, 'erken_yat', '23:30');
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let stop: (() => Promise<void>) | null = null;
    try {
      // up at 23:00, and the lid shut right after that beat
      at(harness, '2026-01-05T20:00:00.000Z');
      const slept = iso(harness);
      stop = startScheduler(harness.app, harness.db, harness.config, asleepWithClock(harness));
      // 08:05: Veli's phone sends the 23:10 tap before the interval beats again
      at(harness, '2026-01-06T05:05:00.000Z');
      const woke = iso(harness);
      const response = await geldim(harness, veli, challengeId, '2026-01-05', '2026-01-05T20:10:00.000Z');
      expect(response.statusCode).toBe(201);
      const { entry } = response.json<{ entry: Entry }>();
      expect(entry).toMatchObject({ dayKey: '2026-01-05', value: 1 });
      expect(entry.late).toBeUndefined();
      expect(pauses(harness)).toEqual([{ started_at: slept, ended_at: woke }]);

      // the beat that comes after has no sleep left to write down
      at(harness, woke, SCHEDULER_INTERVAL_MS);
      await nextBeat();
      expect(pauses(harness)).toEqual([{ started_at: slept, ended_at: woke }]);
    } finally {
      await stop?.();
      vi.useRealTimers();
    }
  });

  it('counts a morning tap from the sleep on time, not as a late 0 for good', async () => {
    harness = await makeApp({ now: NOW });
    const { veli, challengeId } = await checkinRace(harness, 'erken_kus', '07:00');
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let stop: (() => Promise<void>) | null = null;
    try {
      // asleep from 22:00 until 08:05; Veli got up at 06:30
      at(harness, '2026-01-05T19:00:00.000Z');
      stop = startScheduler(harness.app, harness.db, harness.config, asleepWithClock(harness));
      at(harness, '2026-01-06T05:05:00.000Z');
      const response = await geldim(harness, veli, challengeId, '2026-01-06', '2026-01-06T03:30:00.000Z');
      expect(response.statusCode).toBe(201);
      const { entry } = response.json<{ entry: Entry }>();
      expect(entry.value).toBe(1);
      expect(entry.late).toBeUndefined();
    } finally {
      await stop?.();
      vi.useRealTimers();
    }
  });

  // The owner updates from a version older than 014: that server ran its passes
  // but never wrote a beat down, so the new one's first start had nothing to
  // measure the stop from (migration 017 seeds it from the data).

  /**
   * Ali and Veli in a bedtime çelınc (23:30) on that old server: it last
   * answered Ali's inbox poll at 23:20 and comes back updated at 23:40, with
   * `seed` saying whether 017 ran on the way. Returns when it last heard anybody.
   */
  async function stoppedForTheUpdate(h: TestApp, seed: boolean) {
    const { ali, challengeId } = await checkinRace(h, 'erken_yat', '23:30');
    tick(h);
    at(h, '2026-01-05T20:20:00.000Z');
    expect((await authed(h.app, ali.token)({ method: 'GET', url: '/me/inbox/unread' })).statusCode).toBe(200);
    const lastSeen = (h.db.prepare('SELECT last_seen_at FROM users WHERE id = ?').get(ali.me.id) as { last_seen_at: string })
      .last_seen_at;
    // what the old version left: no beat, and no 017
    h.db.exec("DELETE FROM server_state; DELETE FROM _migrations WHERE id = '017_seed_last_beat'");
    at(h, '2026-01-05T20:40:00.000Z');
    if (seed) expect(migrate(h.db)).toEqual(['017_seed_last_beat']);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let stop: (() => Promise<void>) | null = null;
    try {
      stop = startScheduler(h.app, h.db, h.config, { push: quietPush });
    } finally {
      await stop?.();
      vi.useRealTimers();
    }
    return { ali, challengeId, lastSeen };
  }

  it('counts a "Geldim" tapped while the old version was stopped for the update at its tap', async () => {
    harness = await makeApp({ now: '2026-01-05T20:00:00.000Z' }); // 23:00
    const { ali, challengeId, lastSeen } = await stoppedForTheUpdate(harness, true);
    expect(lastSeen).toBe('2026-01-05T20:20:00.000Z');
    expect(pauses(harness)).toEqual([{ started_at: lastSeen, ended_at: '2026-01-05T20:40:00.000Z' }]);

    // 23:25, while nothing answered; the phone's queue sends it at 23:40
    const response = await geldim(harness, ali, challengeId, '2026-01-05', '2026-01-05T20:25:00.000Z');
    expect(response.statusCode).toBe(201);
    const { entry } = response.json<{ entry: Entry }>();
    expect(entry.value).toBe(1);
    expect(entry.late).toBeUndefined();
  });

  it('scores that "Geldim" a late 0 without the beat 017 seeds', async () => {
    harness = await makeApp({ now: '2026-01-05T20:00:00.000Z' });
    const { ali, challengeId } = await stoppedForTheUpdate(harness, false);
    expect(pauses(harness)).toEqual([]);

    const response = await geldim(harness, ali, challengeId, '2026-01-05', '2026-01-05T20:25:00.000Z');
    expect(response.statusCode).toBe(201);
    const { entry } = response.json<{ entry: Entry }>();
    expect(entry.value).toBe(0);
    expect(entry.late).toBe(true);
  });

  it('takes an itiraz sent right after it wakes, in the hour that starts at the wake', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await endingAtMidnight(harness, 'adim_yarisi');
    at(harness, '2026-01-06T19:00:00.000Z');
    await phoneSync(harness, ali, { '2026-01-06': 10_000 });
    await phoneSync(harness, veli, { '2026-01-06': 45_000 });
    const veliDay = harness.db
      .prepare('SELECT id FROM entries WHERE challenge_id = ? AND user_id = ? AND day_key = ?')
      .get(challengeId, veli.me.id, '2026-01-06') as { id: string };

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let stop: (() => Promise<void>) | null = null;
    try {
      // running at 23:00, asleep through the end until 08:00
      at(harness, MIDNIGHT_END, -HOUR);
      stop = startScheduler(harness.app, harness.db, harness.config, asleepWithClock(harness));
      at(harness, MIDNIGHT_END, 8 * HOUR);
      const woke = iso(harness);
      // Ali's itiraz is the first request, ahead of the interval
      await dispute(harness, ali, challengeId, veliDay.id);
      expect(entryStatus(harness, veliDay.id)).toBe('disputed');
      const detail = await authed(harness.app, ali.token)({ method: 'GET', url: `/challenges/${challengeId}` });
      expect(detail.json<{ disputesCloseAt: string }>().disputesCloseAt).toBe(
        new Date(Date.parse(woke) + LIMITS.DEVICE_SETTLE_MS).toISOString(),
      );
    } finally {
      await stop?.();
      vi.useRealTimers();
    }
  });

  it('starts a morning çelınc whose start it slept through before the first "Geldim" lands', async () => {
    harness = await makeApp({ now: NOW });
    // the wizard's "Yarın 04:00", and Veli said yes in the evening
    const { veli, challengeId } = await checkinRace(harness, 'erken_kus', '07:00', '2026-01-06T01:00:00.000Z');
    expect(challengeRow(harness, challengeId).status).toBe('pending');
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let stop: (() => Promise<void>) | null = null;
    try {
      at(harness, '2026-01-05T20:00:00.000Z'); // 23:00
      stop = startScheduler(harness.app, harness.db, harness.config, asleepWithClock(harness));
      // the start's pass is long over by the time the lid comes down
      await new Promise((resolve) => setImmediate(resolve));
      expect(challengeRow(harness, challengeId).status).toBe('pending');
      // 08:00: tapped at 06:30, while the PC slept
      at(harness, '2026-01-06T05:00:00.000Z');
      const response = await geldim(harness, veli, challengeId, '2026-01-06', '2026-01-06T03:30:00.000Z');
      expect(response.statusCode).toBe(201);
      expect(response.json<{ entry: Entry }>().entry.value).toBe(1);
      expect(challengeRow(harness, challengeId).status).toBe('active');
    } finally {
      await stop?.();
      vi.useRealTimers();
    }
  });

  it('starts it for that "Geldim" even while the pass from before the sleep still waits on Expo', async () => {
    harness = await makeApp({ now: NOW });
    const { veli, challengeId } = await checkinRace(harness, 'erken_kus', '07:00', '2026-01-06T01:00:00.000Z');
    const held = heldPush();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let stop: (() => Promise<void>) | null = null;
    try {
      at(harness, '2026-01-05T20:00:00.000Z');
      stop = startScheduler(harness.app, harness.db, harness.config, {
        push: held.push,
        uptimeMs: () => harness!.now().getTime(),
      });
      // the flush went out at 23:00 and the lid came down on it
      expect(held.flushing()).toBe(true);
      at(harness, '2026-01-06T05:00:00.000Z');
      const response = await geldim(harness, veli, challengeId, '2026-01-06', '2026-01-06T03:30:00.000Z');
      expect(response.statusCode).toBe(201);
      expect(response.json<{ entry: Entry }>().entry.value).toBe(1);
      expect(pauses(harness)).toHaveLength(1);
    } finally {
      held.release();
      await stop?.();
      vi.useRealTimers();
    }
  });

  it('takes a clock put forward for what it is on the first request too', async () => {
    harness = await makeApp({ now: NOW });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const warn = vi.spyOn(harness.app.log, 'warn');
    let uptime = 1_000_000;
    let stop: (() => Promise<void>) | null = null;
    try {
      stop = startScheduler(harness.app, harness.db, harness.config, { push: quietPush, uptimeMs: () => uptime });
      // w32tm /resync puts it three hours forward, and a phone asks something ten seconds later
      at(harness, NOW, 3 * HOUR);
      uptime += 10_000;
      expect((await harness.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      expect(pauses(harness)).toEqual([]);
      expect(warn).toHaveBeenCalledWith({ minutes: 180 }, 'clock moved forward');
      expect(harness.app.schedulerBootAt.at?.toISOString()).toBe(iso(harness));

      at(harness, NOW, 3 * HOUR + SCHEDULER_INTERVAL_MS);
      uptime += SCHEDULER_INTERVAL_MS;
      await nextBeat();
      expect(pauses(harness)).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      await stop?.();
      vi.useRealTimers();
    }
  });

  it('runs one pass for a wake, whatever arrives first, and never two at once', async () => {
    harness = await makeApp({ now: NOW });
    let flushes = 0;
    let holdNext = false;
    let release: () => void = () => {};
    const push: PushSender = {
      flush: () => {
        flushes += 1;
        if (!holdNext) return Promise.resolve({ sent: 0, failed: 0 });
        holdNext = false;
        return new Promise<FlushResult>((resolve) => {
          release = () => resolve({ sent: 0, failed: 0 });
        });
      },
    };
    const health = () => harness!.app.inject({ method: 'GET', url: '/health' });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const warn = vi.spyOn(harness.app.log, 'warn');
    let stop: (() => Promise<void>) | null = null;
    try {
      stop = startScheduler(harness.app, harness.db, harness.config, { push, uptimeMs: () => harness!.now().getTime() });
      await new Promise((resolve) => setImmediate(resolve));
      expect(flushes).toBe(1);

      // awake: a request between two beats costs the scheduler nothing
      at(harness, NOW, 4 * MINUTE);
      expect((await health()).statusCode).toBe(200);
      expect(readLastBeat(harness.db)?.toISOString()).toBe(NOW);
      expect(flushes).toBe(1);

      // asleep until the next morning; three phones knock at once, and the
      // pass the first one starts hangs on Expo
      holdNext = true;
      at(harness, NOW, 20 * HOUR);
      const woke = iso(harness);
      const answers = await Promise.all([health(), health(), health()]);
      expect(answers.map((answer) => answer.statusCode)).toEqual([200, 200, 200]);
      expect(flushes).toBe(2);
      // from the last beat, not from the request that came after it
      expect(pauses(harness)).toEqual([{ started_at: NOW, ended_at: woke }]);

      // the interval's beats find that pass still running and leave it alone
      for (let beats = 1; beats <= 3; beats += 1) {
        at(harness, woke, beats * SCHEDULER_INTERVAL_MS);
        await nextBeat();
        expect((await health()).statusCode).toBe(200);
      }
      expect(flushes).toBe(2);

      release();
      at(harness, woke, 4 * SCHEDULER_INTERVAL_MS);
      await new Promise((resolve) => setImmediate(resolve));
      await nextBeat();
      expect(flushes).toBe(3);
      expect(pauses(harness)).toHaveLength(1);
      expect(warn.mock.calls.filter((call) => call[1] === 'scheduler resumed after a pause')).toHaveLength(1);
    } finally {
      release();
      await stop?.();
      vi.useRealTimers();
    }
  });

  it('answers the request when catching up fails', async () => {
    harness = await makeApp({ now: NOW });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const error = vi.spyOn(harness.app.log, 'error');
    let broken = false;
    let stop: (() => Promise<void>) | null = null;
    try {
      stop = startScheduler(harness.app, harness.db, harness.config, {
        push: quietPush,
        uptimeMs: () => {
          if (broken) throw new Error('uptime unreadable');
          return harness!.now().getTime();
        },
      });
      at(harness, NOW, 2 * HOUR);
      broken = true;
      expect((await harness.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      expect(error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'scheduler catch-up failed');
    } finally {
      broken = false;
      await stop?.();
      vi.useRealTimers();
    }
  });
});

describe("scheduler: the evening reminder and the nudge wait for what the phones parked", () => {
  const TUESDAY = '2026-01-06';

  /** "Yemedim" for `dayKey`, sent now: by the app, or by its queue for a tap at `clientTime`. */
  function markDay(h: TestApp, user: RegisteredUser, challengeId: string, dayKey: string, clientTime = iso(h)) {
    return authed(h.app, user.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey, value: 1, source: 'manual', clientTime },
    });
  }

  /** What one person heard of `type` about Tuesday. */
  function onTuesday(h: TestApp, user: RegisteredUser, type: 'reminder' | 'nudge') {
    return listByType(h.db, user.me.id, type).filter((row) => dataOf(row).dayKey === TUESDAY);
  }

  function nudgeClaims(h: TestApp, user: RegisteredUser): number {
    return (
      h.db.prepare('SELECT COUNT(*) AS n FROM nudges_sent WHERE user_id = ? AND day_key = ?').get(user.me.id, TUESDAY) as {
        n: number;
      }
    ).n;
  }

  const beat = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(SCHEDULER_INTERVAL_MS);
    await new Promise((resolve) => setImmediate(resolve));
  };

  /**
   * Ali and Veli in Şekersiz Günler until Tuesday midnight, reminded from noon,
   * both clean on Monday; on Tuesday the server beats from 09:00 to 10:00 (Ali
   * marks the day at 09:30) and the PC sleeps from 10:00 until 13:00. Returns
   * with the clock at 13:00 and nothing run since the lid came down.
   */
  async function asleepUntilOne(h: TestApp) {
    const players = await endingAtMidnight(h, 'sekersiz_gun', { reminderHour: 12 });
    const { ali, veli, challengeId } = players;
    expect((await markDay(h, ali, challengeId, '2026-01-05')).statusCode).toBe(201);
    expect((await markDay(h, veli, challengeId, '2026-01-05')).statusCode).toBe(201);

    // started at 09:00; the machine's uptime is the clock, so moving it is a sleep
    at(h, '2026-01-06T06:00:00.000Z');
    const stop = startScheduler(h.app, h.db, h.config, { push: quietPush, uptimeMs: () => h.now().getTime() });
    for (let minutes = 4; minutes <= 60; minutes += 4) {
      at(h, '2026-01-06T06:00:00.000Z', minutes * MINUTE);
      await beat();
      if (minutes === 28) {
        at(h, '2026-01-06T06:30:00.000Z');
        expect((await markDay(h, ali, challengeId, TUESDAY)).statusCode).toBe(201);
      }
    }
    at(h, '2026-01-06T10:00:00.000Z');
    return { ...players, stop };
  }

  it('tells nobody at the wake that they are at zero, before the tap the phone parked in the morning lands', async () => {
    harness = await makeApp({ now: NOW });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let stop: (() => Promise<void>) | null = null;
    try {
      const race = await asleepUntilOne(harness);
      stop = race.stop;
      const { ali, veli, challengeId } = race;
      const woke = iso(harness);

      // Veli marked it at 10:30, while nothing answered; his queue sends it as
      // the PC wakes, and that request runs the beat the wake is owed first
      const parked = await markDay(harness, veli, challengeId, TUESDAY, '2026-01-06T07:30:00.000Z');
      expect(parked.statusCode).toBe(201);
      expect(harness.app.schedulerBootAt.at?.toISOString()).toBe(woke);
      // the pass at the wake was due to say "hâlâ sıfırdasın" and "Ali sana 1 gün fark koymuş"
      expect(onTuesday(harness, veli, 'reminder')).toEqual([]);
      expect(onTuesday(harness, veli, 'nudge')).toEqual([]);
      expect(nudgeClaims(harness, veli)).toBe(0);

      // 2-2 when the grace is over: nothing to remind him of, nobody ahead
      for (let minutes = 4; minutes <= 24; minutes += 4) {
        at(harness, woke, minutes * MINUTE);
        await beat();
      }
      expect(onTuesday(harness, veli, 'reminder')).toEqual([]);
      expect(onTuesday(harness, veli, 'nudge')).toEqual([]);
      expect(nudgeClaims(harness, veli)).toBe(0);
      expect(onTuesday(harness, ali, 'reminder')).toEqual([]);
    } finally {
      await stop?.();
      vi.useRealTimers();
    }
  });

  it('reminds somebody with nothing parked on the first beat after the grace, once', async () => {
    harness = await makeApp({ now: NOW });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let stop: (() => Promise<void>) | null = null;
    try {
      const race = await asleepUntilOne(harness);
      stop = race.stop;
      const { ali, veli } = race;
      const woke = iso(harness);

      // the interval notices the wake this time
      await beat();
      expect(harness.app.schedulerBootAt.at?.toISOString()).toBe(woke);
      expect(onTuesday(harness, veli, 'reminder')).toEqual([]);
      expect(onTuesday(harness, veli, 'nudge')).toEqual([]);
      for (let minutes = 4; minutes < WAKE_GRACE_MS / MINUTE; minutes += 4) {
        at(harness, woke, minutes * MINUTE);
        await beat();
        expect(onTuesday(harness, veli, 'reminder'), `${minutes} dakika sonra`).toEqual([]);
        expect(onTuesday(harness, veli, 'nudge'), `${minutes} dakika sonra`).toEqual([]);
      }

      at(harness, woke, WAKE_GRACE_MS);
      await beat();
      expect(onTuesday(harness, veli, 'reminder')).toHaveLength(1);
      expect(onTuesday(harness, veli, 'nudge').map((row) => row.body)).toEqual([
        'Ali sana 1 gün fark koymuş. Bugünü kaçırma.',
      ]);

      // the claims hold: no second one on the beats after it
      for (let minutes = 4; minutes <= 12; minutes += 4) {
        at(harness, woke, WAKE_GRACE_MS + minutes * MINUTE);
        await beat();
      }
      expect(onTuesday(harness, veli, 'reminder')).toHaveLength(1);
      expect(onTuesday(harness, veli, 'nudge')).toHaveLength(1);
      expect(onTuesday(harness, ali, 'reminder')).toEqual([]);
    } finally {
      await stop?.();
      vi.useRealTimers();
    }
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
// The finish across a block
// ---------------------------------------------------------------------------

describe('scheduler: the finish news across a block placed mid-race', () => {
  /**
   * A water çelınc that ends in two hours, everybody in from the start and
   * friends with everybody; each one logs `glasses` before the end.
   */
  async function waterRace(
    h: TestApp,
    people: { username: string; displayName: string; vulgarityMax?: 1 | 2 | 3; glasses: number }[],
  ): Promise<{ players: RegisteredUser[]; challengeId: string; endsAt: string }> {
    const players: RegisteredUser[] = [];
    for (const { username, displayName, vulgarityMax } of people) {
      players.push(await registerUser(h.app, username, { displayName, vulgarityMax }));
    }
    for (const [i, a] of players.entries()) for (const b of players.slice(i + 1)) befriend(h.app, a.me.id, b.me.id);
    const [creator, ...friends] = players as [RegisteredUser, ...RegisteredUser[]];
    const endsAt = iso(h, 2 * HOUR);
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
    for (const [index, player] of players.entries()) await logWater(h, player, challengeId, people[index]!.glasses);
    return { players, challengeId, endsAt };
  }

  async function block(h: TestApp, blocker: RegisteredUser, blocked: RegisteredUser) {
    const response = await authed(h.app, blocker.token)({ method: 'POST', url: `/users/${blocked.me.id}/block` });
    expect(response.statusCode).toBe(200);
  }

  /** No leftovers of a template or a missing value in what the reader sees. */
  function expectClean(text: string) {
    for (const junk of ['undefined', 'null', 'NaN', '[object', '{', '  ']) expect(text).not.toContain(junk);
  }

  it('tells the loser who blocked the winner how it ended, without the winner\'s name', async () => {
    harness = await makeApp({ now: NOW });
    const { players, challengeId, endsAt } = await waterRace(harness, [
      { username: 'ali', displayName: 'Ali', glasses: 10 },
      { username: 'veli', displayName: 'Veli', glasses: 4 },
      { username: 'can', displayName: 'Can', glasses: 2 },
    ]);
    const [ali, veli, can] = players as [RegisteredUser, RegisteredUser, RegisteredUser];
    await block(harness, veli, ali);

    at(harness, endsAt, 1);
    expect(tick(harness)).toMatchObject({ finalized: 1 });
    expect(challengeRow(harness, challengeId).winner_id).toBe(ali.me.id);

    const [lost] = listByType(harness.db, veli.me.id, 'challenge_finished');
    expect(lost!.body).toContain('senin skorun 4 bardak');
    expect(lost!.body).not.toContain('Ali');
    // nor the winner's laf: the block refuses it ("Kazanan ağzını açarsa telefonun öter.")
    expect(lost!.body).toBe('Su Bardağı Yarışı bitti, senin skorun 4 bardak.');
    expectClean(lost!.body);
    // nothing between Can and Ali: his still says who won
    expect(listByType(harness.db, can.me.id, 'challenge_finished')[0]!.body).toContain('Kazanan Ali (10 bardak)');
  });

  it('promises no rematch to a 1v1 loser who has a block with the winner', async () => {
    harness = await makeApp({ now: NOW });
    const { players, challengeId, endsAt } = await waterRace(harness, [
      { username: 'ali', displayName: 'Ali', glasses: 5 },
      { username: 'veli', displayName: 'Veli', vulgarityMax: 1, glasses: 3 },
    ]);
    const [ali, veli] = players as [RegisteredUser, RegisteredUser];
    await block(harness, veli, ali);

    at(harness, endsAt, 1);
    expect(tick(harness)).toMatchObject({ finalized: 1 });
    const [lost] = listByType(harness.db, veli.me.id, 'challenge_finished');
    expect(lost!.title).toBe('Bu tur bitti');
    // "Rövanş isteyebilirsin." would be answered "Rövanş için davet edilecek kimse kalmadı."
    expect(lost!.body).toBe('Su Bardağı Yarışı bitti, senin skorun 3 bardak.');
    const rematch = await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` });
    expect(rematch.statusCode).toBe(400);
  });

  it('names neither co-leader to somebody behind a tie who has a block with one of them', async () => {
    harness = await makeApp({ now: NOW });
    const { players, endsAt } = await waterRace(harness, [
      { username: 'ali', displayName: 'Ali', glasses: 8 },
      { username: 'can', displayName: 'Can', glasses: 8 },
      { username: 'veli', displayName: 'Veli', vulgarityMax: 1, glasses: 3 },
      { username: 'deniz', displayName: 'Deniz', vulgarityMax: 2, glasses: 3 },
      { username: 'ece', displayName: 'Ece', vulgarityMax: 3, glasses: 3 },
      { username: 'oya', displayName: 'Oya', glasses: 3 },
    ]);
    const [, can, veli, deniz, ece, oya] = players as RegisteredUser[];
    await block(harness, veli!, can!);
    await block(harness, can!, deniz!);
    await block(harness, ece!, can!);

    at(harness, endsAt, 1);
    expect(tick(harness)).toMatchObject({ finalized: 1 });

    const bodyOf = (user: RegisteredUser) => listByType(harness!.db, user.me.id, 'challenge_finished')[0]!.body;
    expect(bodyOf(veli!)).toBe(
      'Su Bardağı Yarışı bitti. Birincilik paylaşıldı (8 bardak), sen 3. oldun (3 bardak). İstersen rövanş aç.',
    );
    expect(bodyOf(deniz!)).toBe(
      'Su Bardağı Yarışı bitti. Birinciler berabere kaldı (8 bardak), sen 3. oldun (3 bardak). Yine de yedin, rövanş aç.',
    );
    expect(bodyOf(ece!)).toBe(
      'Su Bardağı Yarışı bitti. Birinciler berabere kaldı (8 bardak), sen 3. oldun (3 bardak). Yedin 🍆 Rövanşı aç da görelim.',
    );
    for (const reader of [veli!, deniz!, ece!]) {
      expect(bodyOf(reader)).not.toContain('Ali');
      expect(bodyOf(reader)).not.toContain('Can');
      expectClean(bodyOf(reader));
    }
    // Oya has no block with either of them
    expect(bodyOf(oya!)).toContain('Ali ve Can berabere kaldı');
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

describe('scheduler: what deleted accounts left', () => {
  it('takes the notes and photos of an account deleted before deleting did, on the first pass', async () => {
    harness = await makeApp({ now: NOW });
    const { veli, challengeId } = await pendingChallenge(harness);
    // a çelınc long since decided
    harness.db.prepare("UPDATE challenges SET status = 'finished' WHERE id = ?").run(challengeId);
    const now = nowIso(harness.now());
    harness.db
      .prepare(
        `INSERT INTO entries (id, challenge_id, user_id, day_key, value, source, note, proof_url, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 9000, 'manual', 'Sahilden eve', '/uploads/00000000-0000-0000-0000-000000000000.jpg', 'ok', ?, ?)`,
      )
      .run(newId(), challengeId, veli.me.id, today(harness), now, now);
    // deleted by a server from before this sweep, which left the note and photo
    harness.db.prepare("UPDATE users SET display_name = 'Silinen kanka', deleted_at = ? WHERE id = ?").run(now, veli.me.id);

    const stop = startScheduler(harness.app, harness.db, harness.config, { push: quietPush });
    // the first pass runs right at start; stop waits for it
    await stop();

    const left = harness.db
      .prepare('SELECT note, proof_url, value FROM entries WHERE challenge_id = ? AND user_id = ?')
      .all(challengeId, veli.me.id);
    expect(left).toEqual([{ note: null, proof_url: null, value: 9000 }]);
  });
});

describe('scheduler: proof photos no entry shows', () => {
  /** A photo nothing points at, uploaded `days` before the harness's clock. */
  function unusedPhoto(h: TestApp, days = 8): string {
    const file = path.join(h.config.uploadDir, `${randomUUID()}.jpg`);
    fs.writeFileSync(file, 'x');
    const at = (h.now().getTime() - days * 24 * HOUR) / 1000;
    fs.utimesSync(file, at, at);
    return file;
  }

  it('sweeps them on the first pass of each day, the start\'s included, and not on the passes between', async () => {
    // a database on disk: one in memory knows nothing of earlier uploads
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koydum-sweep-'));
    let flushes = 0;
    const push: PushSender = {
      flush: () => {
        flushes += 1;
        return Promise.resolve({ sent: 0, failed: 0 });
      },
    };
    let stop: (() => Promise<void>) | null = null;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      harness = await makeApp({ now: NOW, config: { dataDir, dbPath: path.join(dataDir, 'koydum.db') } });
      const h = harness;
      const info = vi.spyOn(h.app.log, 'info');
      const sweeps = (): number => info.mock.calls.filter((call) => call[1] === 'proof photos swept').length;
      /** One beat, and the pass it starts run to its end. */
      const beat = async (): Promise<void> => {
        const before = flushes;
        await vi.advanceTimersByTimeAsync(SCHEDULER_INTERVAL_MS);
        await vi.waitFor(() => expect(flushes).toBe(before + 1), { interval: 10, timeout: 5000 });
        // the day's backup and the sweep come after the flush
        await new Promise((resolve) => setTimeout(resolve, 50));
      };

      // one entry shows a photo: with none shown the sweep holds off (a rescued folder before geri-yukle)
      const ali = await registerUser(h.app, 'ali');
      const veli = await registerUser(h.app, 'veli');
      befriend(h.app, ali.me.id, veli.me.id);
      const created = await authed(h.app, ali.token)({
        method: 'POST',
        url: '/challenges',
        payload: { typeKey: 'su_bardak', startsAt: iso(h), endsAt: MIDNIGHT_END, participantIds: [veli.me.id] },
      });
      const challengeId = created.json<Challenge>().id;
      await authed(h.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
      const shown = await authed(h.app, ali.token)({
        method: 'POST',
        url: `/challenges/${challengeId}/entries`,
        payload: {
          dayKey: todayKey(DEFAULT_TIMEZONE, h.now()),
          value: 1,
          source: 'manual',
          proofUrl: `/uploads/${randomUUID()}.jpg`,
          clientTime: iso(h),
        },
      });
      expect(shown.statusCode).toBe(201);

      const first = unusedPhoto(h);
      stop = startScheduler(h.app, h.db, h.config, { push });
      await vi.waitFor(() => expect(sweeps()).toBe(1), { interval: 10, timeout: 5000 });
      expect(info).toHaveBeenCalledWith({ removed: 1, mb: 0 }, 'proof photos swept');
      expect(fs.existsSync(first)).toBe(false);

      // 18:00 the same day in Istanbul: the day's sweep is done
      const second = unusedPhoto(h);
      h.advance(6 * HOUR);
      await beat();
      expect(fs.existsSync(second)).toBe(true);
      expect(sweeps()).toBe(1);

      // 06:00 the next morning
      h.advance(12 * HOUR);
      await beat();
      await vi.waitFor(() => expect(sweeps()).toBe(2), { interval: 10, timeout: 5000 });
      expect(fs.existsSync(second)).toBe(false);
    } finally {
      await stop?.();
      vi.useRealTimers();
      await harness?.close();
      harness = null;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('leaves the folder alone for a database in memory, where every photo would look unused', async () => {
    harness = await makeApp({ now: NOW });
    const photo = unusedPhoto(harness);
    const stop = startScheduler(harness.app, harness.db, harness.config, { push: quietPush });
    // the first pass runs right at start; stop waits for it
    await stop();
    expect(fs.existsSync(photo)).toBe(true);
  });
});

describe('scheduler: a full disk', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('tells the owner once an hour in Turkish, not on every beat that cannot write its time down', async () => {
    harness = await makeApp({ now: NOW });
    // every write fails the way SQLite's do on a full disk: stubbed, never a real disk filled
    type Run = (this: { source: string }, ...args: unknown[]) => unknown;
    const proto = Object.getPrototypeOf(harness.db.prepare('SELECT 1')) as { run: Run };
    const run = proto.run;
    vi.spyOn(proto, 'run').mockImplementation(function (this: { source: string }, ...args: unknown[]) {
      if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(this.source)) {
        throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });
      }
      return run.apply(this, args);
    });
    const warn = vi.spyOn(harness.app.log, 'warn');
    const said = (msg: string) => warn.mock.calls.filter((args) => args[1] === msg).length;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let stop: (() => Promise<void>) | null = null;
    try {
      stop = startScheduler(harness.app, harness.db, harness.config, {
        push: quietPush,
        uptimeMs: () => harness!.now().getTime(),
      });
      const beat = async (): Promise<void> => {
        harness!.advance(SCHEDULER_INTERVAL_MS);
        await vi.advanceTimersByTimeAsync(SCHEDULER_INTERVAL_MS);
      };

      // the start and ten beats, each failing to write its last beat
      for (let i = 0; i < 10; i += 1) await beat();
      expect(said('disk full, nothing can be saved')).toBe(1);
      expect(said('writing down when the server was off failed')).toBe(0);

      // an hour of beats on, once more
      for (let i = 0; i < HOUR / SCHEDULER_INTERVAL_MS; i += 1) await beat();
      expect(said('disk full, nothing can be saved')).toBe(2);
      expect(said('writing down when the server was off failed')).toBe(0);
    } finally {
      await stop?.();
      vi.useRealTimers();
    }
  });
});

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
