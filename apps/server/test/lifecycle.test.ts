/**
 * Lifecycle smoke tests for the services the route modules build on:
 * standings, activation, finalization, cancellation, reminders and the push queue.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  activateDueChallenges,
  cancelUnderfilled,
  computeStandings,
  finalizeEndedChallenges,
  getChallengeRow,
  runSchedulerOnce,
  sendReminders,
} from '../src/services/challenges.js';
import { createPushSender } from '../src/services/push.js';
import { listByType } from '../src/services/notifications.js';
import { computeUserStats, getBadges } from '../src/services/stats.js';
import { newId, nowIso, type ChallengeRow } from '../src/db/index.js';
import { makeApp, registerUser, type TestApp } from './helpers.js';

let harness: TestApp | null = null;

afterEach(async () => {
  if (harness) {
    await harness.close();
    harness = null;
  }
});

interface SeedOptions {
  creatorId: string;
  accepted?: string[];
  invited?: string[];
  startsAt: string;
  endsAt: string;
  status?: string;
  typeKey?: string;
  title?: string;
}

/** Inserts a challenge + participants directly (the routes do not exist yet). */
function seedChallenge(app: FastifyInstance, options: SeedOptions): string {
  const id = newId();
  const at = nowIso(app.now());
  app.db
    .prepare(
      `INSERT INTO challenges (id, creator_id, type_key, metric_type, direction, unit, title, starts_at, ends_at,
                               status, reward_text, penalty_text, deadline_time, daily_target, proof_required,
                               created_at, finalized_at, winner_id, is_tie, rematch_of_id)
       VALUES (?, ?, ?, 'auto_steps', 'higher', 'adım', ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, ?, NULL, NULL, 0, NULL)`,
    )
    .run(
      id,
      options.creatorId,
      options.typeKey ?? 'adim_yarisi',
      options.title ?? 'Adım Yarışı',
      options.startsAt,
      options.endsAt,
      options.status ?? 'pending',
      at,
    );

  const insert = app.db.prepare(
    'INSERT INTO challenge_participants (challenge_id, user_id, status, invited_at, joined_at) VALUES (?, ?, ?, ?, ?)',
  );
  for (const userId of options.accepted ?? []) insert.run(id, userId, 'accepted', at, at);
  for (const userId of options.invited ?? []) insert.run(id, userId, 'invited', at, null);
  return id;
}

function addSteps(app: FastifyInstance, challengeId: string, userId: string, dayKey: string, value: number): void {
  const at = nowIso(app.now());
  app.db
    .prepare(
      `INSERT INTO entries (id, challenge_id, user_id, day_key, value, source, note, proof_url, status, client_time,
                            session_id, late, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pedometer', NULL, NULL, 'ok', ?, NULL, 0, ?, ?)`,
    )
    .run(newId(), challengeId, userId, dayKey, value, at, at, at);
}

describe('challenge lifecycle', () => {
  it('activates, scores, finalizes and awards badges', async () => {
    harness = await makeApp({ now: '2026-01-05T09:00:00.000Z' });
    const { app, db } = harness;
    const ali = await registerUser(app, 'ali');
    const veli = await registerUser(app, 'veli', { vulgarityMax: 3 });

    const challengeId = seedChallenge(app, {
      creatorId: ali.me.id,
      accepted: [ali.me.id, veli.me.id],
      startsAt: '2026-01-05T08:00:00.000Z',
      endsAt: '2026-01-07T09:00:00.000Z',
    });

    expect(activateDueChallenges(db, app.now())).toBe(1);
    expect(getChallengeRow(db, challengeId)?.status).toBe('active');
    expect(listByType(db, ali.me.id, 'challenge_started')).toHaveLength(1);
    expect(listByType(db, veli.me.id, 'challenge_started')).toHaveLength(1);

    // running standings
    addSteps(app, challengeId, ali.me.id, '2026-01-05', 12430);
    addSteps(app, challengeId, veli.me.id, '2026-01-05', 4000);
    const running = computeStandings(db, getChallengeRow(db, challengeId)!);
    expect(running.map((p) => [p.user.username, p.score, p.rank])).toEqual([
      ['ali', 12430, 1],
      ['veli', 4000, 2],
    ]);
    expect(running[0]!.isWinner).toBe(true);

    // finalize when the clock passes endsAt
    harness.setNow('2026-01-07T09:00:00.000Z');
    expect(finalizeEndedChallenges(db, app.now())).toBe(1);

    const finished = getChallengeRow(db, challengeId) as ChallengeRow;
    expect(finished.status).toBe('finished');
    expect(finished.winner_id).toBe(ali.me.id);
    expect(finished.is_tie).toBe(0);
    expect(finished.finalized_at).toBe('2026-01-07T09:00:00.000Z');

    const stored = db
      .prepare('SELECT user_id, final_score, final_rank FROM challenge_participants WHERE challenge_id = ? ORDER BY final_rank')
      .all(challengeId) as { user_id: string; final_score: number; final_rank: number }[];
    expect(stored).toEqual([
      { user_id: ali.me.id, final_score: 12430, final_rank: 1 },
      { user_id: veli.me.id, final_score: 4000, final_rank: 2 },
    ]);

    const winnerNotifications = listByType(db, ali.me.id, 'challenge_finished');
    expect(winnerNotifications).toHaveLength(1);
    expect(JSON.parse(winnerNotifications[0]!.data)).toEqual({ challengeId, role: 'winner' });

    const loserNotifications = listByType(db, veli.me.id, 'challenge_finished');
    expect(JSON.parse(loserNotifications[0]!.data)).toEqual({ challengeId, role: 'loser', winnerId: ali.me.id });
    // recipient level 3 copy: a short lock-screen title, the sentence in the body
    expect(loserNotifications[0]!.title).toBe('YEDİN 🍆');
    expect(loserNotifications[0]!.body.toLocaleLowerCase('tr')).toContain('yedin');

    expect(computeUserStats(db, ali.me.id, app.now()).wins).toBe(1);
    expect(computeUserStats(db, veli.me.id, app.now()).losses).toBe(1);
    expect(getBadges(db, ali.me.id)).toContain('koyus_1');
    expect(getBadges(db, veli.me.id)).toContain('yiyis_1');
    expect(listByType(db, ali.me.id, 'badge').length).toBeGreaterThan(0);

    // finished standings come from the stored final scores
    const final = computeStandings(db, finished);
    expect(final[0]!.isWinner).toBe(true);
    expect(final[0]!.rank).toBe(1);
  });

  it('cancels a pending challenge nobody joined', async () => {
    harness = await makeApp({ now: '2026-01-05T09:00:00.000Z' });
    const { app, db } = harness;
    const ali = await registerUser(app, 'ali');
    const veli = await registerUser(app, 'veli');

    const challengeId = seedChallenge(app, {
      creatorId: ali.me.id,
      accepted: [ali.me.id],
      invited: [veli.me.id],
      startsAt: '2026-01-04T08:00:00.000Z',
      endsAt: '2026-01-05T08:00:00.000Z',
    });

    expect(activateDueChallenges(db, app.now())).toBe(0);
    expect(cancelUnderfilled(db, app.now())).toBe(1);
    expect(getChallengeRow(db, challengeId)?.status).toBe('cancelled');
    expect(listByType(db, ali.me.id, 'challenge_cancelled')).toHaveLength(1);
    expect(listByType(db, veli.me.id, 'challenge_cancelled')).toHaveLength(1);
  });

  it('sends at most one reminder per local day', async () => {
    // 09:00Z is 12:00 in Istanbul
    harness = await makeApp({ now: '2026-01-05T09:00:00.000Z' });
    const { app, db } = harness;
    const ali = await registerUser(app, 'ali', { reminderHour: 12 });
    const veli = await registerUser(app, 'veli', { reminderHour: null });

    seedChallenge(app, {
      creatorId: ali.me.id,
      accepted: [ali.me.id, veli.me.id],
      startsAt: '2026-01-05T08:00:00.000Z',
      endsAt: '2026-01-09T08:00:00.000Z',
      status: 'active',
    });

    expect(sendReminders(db, app.now())).toBe(1);
    expect(sendReminders(db, app.now())).toBe(0);
    expect(listByType(db, ali.me.id, 'reminder')).toHaveLength(1);
    expect(listByType(db, veli.me.id, 'reminder')).toHaveLength(0);

    // next local day → one more
    harness.setNow('2026-01-06T09:00:00.000Z');
    expect(sendReminders(db, app.now())).toBe(1);
  });

  it('runSchedulerOnce reports what it did and never throws', async () => {
    harness = await makeApp({ now: '2026-01-05T09:00:00.000Z' });
    const { app, db } = harness;
    const ali = await registerUser(app, 'ali');
    const veli = await registerUser(app, 'veli');

    seedChallenge(app, {
      creatorId: ali.me.id,
      accepted: [ali.me.id, veli.me.id],
      startsAt: '2026-01-05T08:00:00.000Z',
      endsAt: '2026-01-06T08:00:00.000Z',
    });
    seedChallenge(app, {
      creatorId: ali.me.id,
      accepted: [ali.me.id],
      startsAt: '2026-01-04T08:00:00.000Z',
      endsAt: '2026-01-05T08:00:00.000Z',
    });

    const summary = runSchedulerOnce(db, app.now());
    expect(summary).toEqual({ activated: 1, finalized: 0, cancelled: 1, reminders: 0 });

    harness.setNow('2026-01-06T08:00:00.000Z');
    expect(runSchedulerOnce(db, app.now()).finalized).toBe(1);
  });
});

describe('push queue', () => {
  it('marks unusable tokens instead of throwing', async () => {
    harness = await makeApp();
    const { app, db, config } = harness;
    const ali = await registerUser(app, 'ali', { pushToken: 'not-an-expo-token' });
    const veli = await registerUser(app, 'veli'); // no token at all

    db.prepare(
      "INSERT INTO notifications (id, user_id, type, title, body, data, read_at, created_at, pushed_at, push_error) VALUES (?, ?, 'poke', 'Dürt', 'Kalk', '{}', NULL, ?, NULL, NULL)",
    ).run(newId(), ali.me.id, nowIso(app.now()));
    db.prepare(
      "INSERT INTO notifications (id, user_id, type, title, body, data, read_at, created_at, pushed_at, push_error) VALUES (?, ?, 'poke', 'Dürt', 'Kalk', '{}', NULL, ?, NULL, NULL)",
    ).run(newId(), veli.me.id, nowIso(app.now()));

    const sender = createPushSender(config);
    await expect(sender.flush(db)).resolves.toEqual({ sent: 0, failed: 1 });

    const errors = db.prepare('SELECT push_error FROM notifications WHERE push_error IS NOT NULL').all() as {
      push_error: string;
    }[];
    expect(errors).toEqual([{ push_error: 'invalid_token' }]);

    // nothing left to do on the second pass
    await expect(sender.flush(db)).resolves.toEqual({ sent: 0, failed: 0 });
  });
});
