/**
 * The scheduler pass (SPEC 2.4) driven end-to-end with an injected clock.
 *
 * Everything here goes through the real HTTP routes to build the state and then
 * calls `runSchedulerOnce(db, now)` — the same function `startScheduler` calls on
 * its 30-second timer — so the test covers exactly what the running server does:
 * a challenge going live at its start time, finishing at its end time with the
 * right winner (or no winner at all), telling every participant, handing out
 * badges, and cancelling a pending challenge nobody joined.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_TIMEZONE, todayKey, type Challenge } from '@koydum/shared';
import { runSchedulerOnce } from '../src/services/challenges.js';
import { listByType } from '../src/services/notifications.js';
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
  it('finishes at the end time, crowns the winner, tells everyone and hands out badges', async () => {
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

    harness.advance(60_000);
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

    harness.advance(48 * HOUR);
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
});
