/**
 * Lifecycle smoke tests for the services the route modules build on:
 * standings, activation, finalization, cancellation, reminders and the push queue.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Challenge, ChallengeDetail } from '@koydum/shared';
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
import { listByType, listInbox } from '../src/services/notifications.js';
import { computeUserStats, getBadges } from '../src/services/stats.js';
import { newId, nowIso, type ChallengeRow } from '../src/db/index.js';
import { authed, befriend, makeApp, registerUser, type RegisteredUser, type TestApp } from './helpers.js';

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
  metricType?: string;
  unit?: string;
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
       VALUES (?, ?, ?, ?, 'higher', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, ?, NULL, NULL, 0, NULL)`,
    )
    .run(
      id,
      options.creatorId,
      options.typeKey ?? 'adim_yarisi',
      options.metricType ?? 'auto_steps',
      options.unit ?? 'adım',
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

const DAY_MS = 24 * 60 * 60 * 1000;

/** `creator` opens a çelınc starting now through the API and `invitee` says yes. */
async function playTogether(
  h: TestApp,
  creator: RegisteredUser,
  invitee: RegisteredUser,
  payload: { typeKey: string; deadlineTime?: string },
): Promise<string> {
  const created = await authed(h.app, creator.token)({
    method: 'POST',
    url: '/challenges',
    payload: {
      ...payload,
      startsAt: h.now().toISOString(),
      endsAt: new Date(h.now().getTime() + 3 * DAY_MS).toISOString(),
      participantIds: [invitee.me.id],
    },
  });
  expect(created.statusCode).toBe(201);
  const challengeId = created.json<Challenge>().id;
  const accepted = await authed(h.app, invitee.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
  expect(accepted.statusCode).toBe(200);
  return challengeId;
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
      // the last millisecond of 7 January in Istanbul, where the app snaps an end
      endsAt: '2026-01-07T20:59:59.999Z',
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

    // at endsAt a step çelınc still waits for the phones; an hour later it is final
    harness.setNow('2026-01-07T21:00:00.000Z');
    expect(finalizeEndedChallenges(db, app.now())).toBe(0);
    harness.setNow('2026-01-07T22:00:00.000Z');
    expect(finalizeEndedChallenges(db, app.now())).toBe(1);

    const finished = getChallengeRow(db, challengeId) as ChallengeRow;
    expect(finished.status).toBe('finished');
    expect(finished.winner_id).toBe(ali.me.id);
    expect(finished.is_tie).toBe(0);
    expect(finished.finalized_at).toBe('2026-01-07T22:00:00.000Z');

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

  it('names the penalty to whoever finished behind a shared first place, when there is one', async () => {
    harness = await makeApp({ now: '2026-01-05T09:00:00.000Z' });
    const { app, db } = harness;
    const ali = await registerUser(app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(app, 'veli', { displayName: 'Veli' });
    const can = await registerUser(app, 'can', { displayName: 'Can', vulgarityMax: 3 });
    const challengeId = seedChallenge(app, {
      creatorId: ali.me.id,
      accepted: [ali.me.id, veli.me.id, can.me.id],
      startsAt: '2026-01-05T08:00:00.000Z',
      endsAt: '2026-01-05T20:59:59.999Z',
      status: 'active',
      typeKey: 'sosyal_medya_orucu',
      metricType: 'daily_boolean',
      unit: 'gün',
      title: 'Sosyal Medya Orucu',
    });
    db.prepare('UPDATE challenges SET penalty_text = ? WHERE id = ?').run('Kaybeden bulaşık yıkar.', challengeId);
    addSteps(app, challengeId, ali.me.id, '2026-01-05', 1);
    addSteps(app, challengeId, veli.me.id, '2026-01-05', 1);
    addSteps(app, challengeId, can.me.id, '2026-01-05', 0);

    harness.setNow('2026-01-05T21:00:00.000Z');
    expect(finalizeEndedChallenges(db, app.now())).toBe(1);
    const [behind] = listByType(db, can.me.id, 'challenge_finished');
    expect(behind!.body).toBe(
      'Sosyal Medya Orucu bitti. Ali ve Veli berabere kaldı (1 gün), sen 3. oldun (0 gün). Ceza sende 🍆 Kaybeden bulaşık yıkar. Rövanşı aç da görelim.',
    );
  });

  it('tells whoever finished behind a shared first place that they lost, and counts it so', async () => {
    harness = await makeApp({ now: '2026-01-05T09:00:00.000Z' });
    const { app, db } = harness;
    const ali = await registerUser(app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(app, 'veli', { displayName: 'Veli' });
    const can = await registerUser(app, 'can', { displayName: 'Can' });

    // a perfect score is easy to share in a check-off çelınc: Ali and Veli kept the day, Can did not
    const challengeId = seedChallenge(app, {
      creatorId: ali.me.id,
      accepted: [ali.me.id, veli.me.id, can.me.id],
      startsAt: '2026-01-05T08:00:00.000Z',
      endsAt: '2026-01-05T20:59:59.999Z',
      status: 'active',
      typeKey: 'sosyal_medya_orucu',
      metricType: 'daily_boolean',
      unit: 'gün',
      title: 'Sosyal Medya Orucu',
    });
    addSteps(app, challengeId, ali.me.id, '2026-01-05', 1);
    addSteps(app, challengeId, veli.me.id, '2026-01-05', 1);
    addSteps(app, challengeId, can.me.id, '2026-01-05', 0);

    harness.setNow('2026-01-05T21:00:00.000Z');
    expect(finalizeEndedChallenges(db, app.now())).toBe(1);
    const finished = getChallengeRow(db, challengeId) as ChallengeRow;
    expect(finished.is_tie).toBe(1);
    expect(finished.winner_id).toBeNull();

    for (const leader of [ali, veli]) {
      const [row] = listByType(db, leader.me.id, 'challenge_finished');
      expect(JSON.parse(row!.data)).toEqual({ challengeId, role: 'tie' });
      expect(row!.title).toBe('Berabere kaldınız');
    }

    const [behind] = listByType(db, can.me.id, 'challenge_finished');
    expect(JSON.parse(behind!.data)).toEqual({ challengeId, role: 'loser', winnerId: null });
    expect(behind!.title).toBe('Yedin lan');
    // no penalty was written, and the results screen it opens says so
    expect(behind!.body).toBe(
      'Sosyal Medya Orucu bitti. Ali ve Veli berabere kaldı (1 gün), sen 3. oldun (0 gün). Yine de yedin, rövanş aç.',
    );
    // no co-leader may send him a laf, so nothing may promise one
    expect(behind!.body).not.toContain('Kazanan');
    expect(behind!.body).not.toContain('berabere bitti');

    const statsOf = async (user: RegisteredUser) => {
      const response = await authed(app, user.token)({ method: 'GET', url: '/me' });
      expect(response.statusCode).toBe(200);
      return response.json<{ stats: { wins: number; losses: number; ties: number } }>().stats;
    };
    expect(await statsOf(can)).toMatchObject({ wins: 0, losses: 1, ties: 0 });
    expect(await statsOf(ali)).toMatchObject({ wins: 0, losses: 0, ties: 1 });
    expect(await statsOf(veli)).toMatchObject({ wins: 0, losses: 0, ties: 1 });
    // the yiyiş ladder follows the loss; the co-leaders lost nothing
    expect(getBadges(db, can.me.id)).toContain('yiyis_1');
    expect(getBadges(db, ali.me.id)).not.toContain('yiyis_1');
  });

  it('names the co-leaders in the final table order, not by their random ids', async () => {
    harness = await makeApp({ now: '2026-01-05T09:00:00.000Z' });
    const { app, db } = harness;
    const ali = await registerUser(app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(app, 'veli', { displayName: 'Veli' });
    const can = await registerUser(app, 'can', { displayName: 'Can' });
    // the line-up runs against the id order, whichever way the UUIDs fell
    const [first, second] = ali.me.id > veli.me.id ? [ali, veli] : [veli, ali];

    const challengeId = seedChallenge(app, {
      creatorId: first.me.id,
      accepted: [first.me.id, second.me.id, can.me.id],
      startsAt: '2026-01-05T08:00:00.000Z',
      endsAt: '2026-01-05T20:59:59.999Z',
      status: 'active',
      typeKey: 'sosyal_medya_orucu',
      metricType: 'daily_boolean',
      unit: 'gün',
      title: 'Sosyal Medya Orucu',
    });
    for (const leader of [first, second]) addSteps(app, challengeId, leader.me.id, '2026-01-05', 1);
    addSteps(app, challengeId, can.me.id, '2026-01-05', 0);

    harness.setNow('2026-01-05T21:00:00.000Z');
    expect(finalizeEndedChallenges(db, app.now())).toBe(1);
    const [behind] = listByType(db, can.me.id, 'challenge_finished');
    expect(behind!.body).toContain(`${first.me.displayName} ve ${second.me.displayName} berabere kaldı`);
    // the results screen reads the same order
    const table = computeStandings(db, getChallengeRow(db, challengeId) as ChallengeRow, app.now());
    expect(table.map((p) => p.user.id)).toEqual([first.me.id, second.me.id, can.me.id]);
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

  describe('the daily reminder only points at something that still counts today', () => {
    /** İlker and Ufuk (both reminded at 20:00 in Istanbul) on Monday 12:00. */
    async function pair(): Promise<{ h: TestApp; ilker: RegisteredUser; ufuk: RegisteredUser }> {
      const h = await makeApp({ now: '2026-01-05T09:00:00.000Z' });
      harness = h;
      const ilker = await registerUser(h.app, 'ilker', { reminderHour: 20 });
      const ufuk = await registerUser(h.app, 'ufuk', { reminderHour: 20 });
      befriend(h.app, ilker.me.id, ufuk.me.id);
      return { h, ilker, ufuk };
    }

    it('skips a sleeper whose only çelınc is a morning check-in already past its deadline', async () => {
      const { h, ilker, ufuk } = await pair();
      const challengeId = await playTogether(h, ilker, ufuk, { typeKey: 'erken_kus', deadlineTime: '07:00' });
      runSchedulerOnce(h.db, h.now());

      h.setNow('2026-01-06T03:30:00.000Z'); // Tuesday 06:30: İlker is up, Ufuk sleeps through it
      const checkin = await authed(h.app, ilker.token)({
        method: 'POST',
        url: `/challenges/${challengeId}/entries`,
        payload: { dayKey: '2026-01-06', value: 1, source: 'checkin', clientTime: h.now().toISOString() },
      });
      expect(checkin.statusCode).toBe(201);

      // 20:00: a "Geldim" now is stored late with 0, so "Çelıncı unutma" has nothing to send him to
      h.setNow('2026-01-06T17:00:30.000Z');
      expect(runSchedulerOnce(h.db, h.now()).reminders).toBe(0);
      expect(listByType(h.db, ufuk.me.id, 'reminder')).toHaveLength(0);
      expect(listByType(h.db, ilker.me.id, 'reminder')).toHaveLength(0);

      // nothing was claimed: a çelınc he joins at 20:30 still gets that evening's reminder
      h.setNow('2026-01-06T17:30:00.000Z');
      await playTogether(h, ilker, ufuk, { typeKey: 'kitap_sayfa' });
      expect(runSchedulerOnce(h.db, h.now()).reminders).toBe(1);
      expect(listByType(h.db, ufuk.me.id, 'reminder')).toHaveLength(1);
      expect(listByType(h.db, ilker.me.id, 'reminder')).toHaveLength(0);
    });

    it('still reminds a bedtime check-in whose deadline is ahead', async () => {
      const { h, ilker, ufuk } = await pair();
      await playTogether(h, ilker, ufuk, { typeKey: 'erken_yat', deadlineTime: '23:00' });

      h.setNow('2026-01-05T17:00:30.000Z'); // Monday 20:00, the 23:00 "Geldim" is still ahead
      expect(runSchedulerOnce(h.db, h.now()).reminders).toBe(2);
      expect(listByType(h.db, ufuk.me.id, 'reminder')).toHaveLength(1);
    });

    it('still reminds a player with another çelınc open beside the missed check-in', async () => {
      const { h, ilker, ufuk } = await pair();
      await playTogether(h, ilker, ufuk, { typeKey: 'erken_kus', deadlineTime: '07:00' });
      await playTogether(h, ilker, ufuk, { typeKey: 'kitap_sayfa' });

      h.setNow('2026-01-06T17:00:30.000Z'); // Tuesday 20:00, nothing entered anywhere
      expect(runSchedulerOnce(h.db, h.now()).reminders).toBe(2);
      expect(listByType(h.db, ufuk.me.id, 'reminder')).toHaveLength(1);
    });

    it('reads the deadline in the zone the çelınc was joined in', async () => {
      const { h, ilker, ufuk } = await pair();
      await playTogether(h, ilker, ufuk, { typeKey: 'erken_kus', deadlineTime: '07:00' });
      // Ufuk flies to New York; his mornings in this çelınc stay Istanbul's
      const moved = await authed(h.app, ufuk.token)({ method: 'PATCH', url: '/me', payload: { timezone: 'America/New_York' } });
      expect(moved.statusCode).toBe(200);

      // 20:00 in New York is 04:00 in Istanbul: his 07:00 check-in is still ahead
      h.setNow('2026-01-06T01:00:30.000Z');
      expect(runSchedulerOnce(h.db, h.now()).reminders).toBe(1);
      expect(listByType(h.db, ufuk.me.id, 'reminder')).toHaveLength(1);
    });
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
    expect(summary).toEqual({ activated: 1, disputes: 0, finalized: 0, cancelled: 1, reminders: 0, nudges: 0, recaps: 0, tauntFollowups: 0 });

    // the end plus the hour a step çelınc gives the phones
    harness.setNow('2026-01-06T09:00:00.000Z');
    expect(runSchedulerOnce(db, app.now()).finalized).toBe(1);
  });
});

describe('declining and leaving', () => {
  const HOUR = 60 * 60_000;

  /** A "Şimdi başla" step çelınc of a week, `creator` against `invitees`. */
  async function startNow(h: TestApp, creator: RegisteredUser, invitees: RegisteredUser[]): Promise<string> {
    for (const invitee of invitees) befriend(h.app, creator.me.id, invitee.me.id);
    const response = await authed(h.app, creator.token)({
      method: 'POST',
      url: '/challenges',
      payload: {
        typeKey: 'adim_yarisi',
        title: 'Adım Yarışı',
        startsAt: h.now().toISOString(),
        endsAt: new Date(h.now().getTime() + 7 * 24 * HOUR).toISOString(),
        participantIds: invitees.map((user) => user.me.id),
      },
    });
    return response.json<Challenge>().id;
  }

  function answer(h: TestApp, user: RegisteredUser, challengeId: string, action: 'accept' | 'decline' | 'leave') {
    return authed(h.app, user.token)({ method: 'POST', url: `/challenges/${challengeId}/${action}` });
  }

  function titles(h: TestApp, user: RegisteredUser, type: 'challenge_declined' | 'challenge_left' | 'challenge_cancelled') {
    return listByType(h.db, user.me.id, type).map((row) => row.title);
  }

  it('cancels a head-to-head çelınc the moment the rival declines, and tells the creator both', async () => {
    harness = await makeApp({ now: '2026-01-05T09:00:00.000Z' });
    const { app, db } = harness;
    const mustafa = await registerUser(app, 'mustafa', { displayName: 'Mustafa' });
    const ali = await registerUser(app, 'ali', { displayName: 'Ali' });
    const id = await startNow(harness, mustafa, [ali]);
    expect(getChallengeRow(db, id)?.status).toBe('active');

    const declined = await answer(harness, ali, id, 'decline');
    expect(declined.statusCode).toBe(200);
    expect(declined.json<ChallengeDetail>().challenge.status).toBe('cancelled');
    expect(getChallengeRow(db, id)?.finalized_at).toBe('2026-01-05T09:00:00.000Z');

    // newest first: the "tırstı", then what it did to the çelınc
    expect(listInbox(db, mustafa.me.id).map((row) => row.type)).toEqual(['challenge_cancelled', 'challenge_declined']);
    const [no] = listByType(db, mustafa.me.id, 'challenge_declined');
    expect(no!.title).toBe('Ali tırstı, reddetti');
    expect(JSON.parse(no!.data)).toEqual({ challengeId: id, fromUserId: ali.me.id });
    const [cancelled] = listByType(db, mustafa.me.id, 'challenge_cancelled');
    // not "kimse kabul etmedi": that line is for a çelınc nobody ever answered
    expect(cancelled!.body).toBe('Adım Yarışı iptal oldu, herkes kaçtı.');
    expect(JSON.parse(cancelled!.data)).toEqual({ challengeId: id, reason: 'everyone_left' });
    // Ali knows what he did
    expect(listInbox(db, ali.me.id).map((row) => row.type)).toEqual(['challenge_invite']);
    // and a week later the scheduler has nothing left to cancel
    harness.advance(8 * 24 * HOUR);
    expect(runSchedulerOnce(db, app.now()).cancelled).toBe(0);
  });

  it('tells everybody still in when a player walks out, at their own level, and plays on', async () => {
    harness = await makeApp({ now: '2026-01-05T09:00:00.000Z' });
    const { app, db } = harness;
    const mustafa = await registerUser(app, 'mustafa', { displayName: 'Mustafa' });
    const ali = await registerUser(app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(app, 'veli', { displayName: 'Veli', vulgarityMax: 3 });
    const id = await startNow(harness, mustafa, [ali, veli]);
    await answer(harness, ali, id, 'accept');
    await answer(harness, veli, id, 'accept');

    const left = await answer(harness, ali, id, 'leave');
    expect(left.statusCode).toBe(200);
    expect(left.json<ChallengeDetail>().challenge.status).toBe('active');

    expect(titles(harness, mustafa, 'challenge_left')).toEqual(['Ali bıraktı kaçtı']);
    expect(titles(harness, veli, 'challenge_left')).toEqual(['Ali havlu attı 🐔']);
    expect(titles(harness, ali, 'challenge_left')).toEqual([]);
    expect(JSON.parse(listByType(db, veli.me.id, 'challenge_left')[0]!.data)).toEqual({ challengeId: id, fromUserId: ali.me.id });
    expect(titles(harness, mustafa, 'challenge_cancelled')).toEqual([]);
  });

  it('waits while an invitee could still make it two, and cancels when they say no too', async () => {
    harness = await makeApp({ now: '2026-01-05T09:00:00.000Z' });
    const { app, db } = harness;
    const mustafa = await registerUser(app, 'mustafa', { displayName: 'Mustafa', vulgarityMax: 1 });
    const ali = await registerUser(app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(app, 'veli', { displayName: 'Veli' });
    const id = await startNow(harness, mustafa, [ali, veli]);
    await answer(harness, ali, id, 'accept');

    // Veli has not answered: Mustafa and Veli can still race
    expect((await answer(harness, ali, id, 'leave')).json<ChallengeDetail>().challenge.status).toBe('active');
    expect(titles(harness, mustafa, 'challenge_left')).toEqual(['Ali çelınctan ayrıldı']);
    // the invitee was never in the race, so he hears nothing about it
    expect(titles(harness, veli, 'challenge_left')).toEqual([]);

    harness.advance(HOUR);
    expect((await answer(harness, veli, id, 'decline')).json<ChallengeDetail>().challenge.status).toBe('cancelled');
    expect(titles(harness, mustafa, 'challenge_declined')).toEqual(['Veli daveti reddetti']);
    expect(listByType(db, mustafa.me.id, 'challenge_cancelled').map((row) => row.body)).toEqual([
      'Adım Yarışı iptal edildi, rakibin kalmadı.',
    ]);
    expect(titles(harness, ali, 'challenge_cancelled')).toEqual([]);
    expect(titles(harness, veli, 'challenge_cancelled')).toEqual([]);
  });

  it('says nothing across a block, but still cancels', async () => {
    harness = await makeApp({ now: '2026-01-05T09:00:00.000Z' });
    const { app, db } = harness;
    const mustafa = await registerUser(app, 'mustafa', { displayName: 'Mustafa' });
    const ali = await registerUser(app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(app, 'veli', { displayName: 'Veli' });
    const cem = await registerUser(app, 'cem', { displayName: 'Cem' });
    const group = await startNow(harness, mustafa, [ali, veli]);
    await answer(harness, ali, group, 'accept');
    await answer(harness, veli, group, 'accept');
    const duel = await startNow(harness, mustafa, [cem]);

    await authed(app, mustafa.token)({ method: 'POST', url: `/users/${ali.me.id}/block` });
    await authed(app, cem.token)({ method: 'POST', url: `/users/${mustafa.me.id}/block` });

    await answer(harness, ali, group, 'leave');
    expect(titles(harness, mustafa, 'challenge_left')).toEqual([]);
    expect(titles(harness, veli, 'challenge_left')).toEqual(['Ali bıraktı kaçtı']);

    await answer(harness, cem, duel, 'decline');
    expect(titles(harness, mustafa, 'challenge_declined')).toEqual([]);
    // the çelınc is news about the çelınc, not a word from Cem
    expect(getChallengeRow(db, duel)?.status).toBe('cancelled');
    expect(titles(harness, mustafa, 'challenge_cancelled')).toEqual(['Çelınc iptal oldu']);
  });

  it('cancels a head-to-head çelınc when the rival deletes the account, without a "havlu attı"', async () => {
    harness = await makeApp({ now: '2026-01-05T09:00:00.000Z' });
    const { app, db } = harness;
    const mustafa = await registerUser(app, 'mustafa', { displayName: 'Mustafa' });
    const ali = await registerUser(app, 'ali', { displayName: 'Ali' });
    const id = await startNow(harness, mustafa, [ali]);
    await answer(harness, ali, id, 'accept');

    expect((await authed(app, ali.token)({ method: 'DELETE', url: '/me' })).statusCode).toBe(200);
    expect(getChallengeRow(db, id)?.status).toBe('cancelled');
    expect(JSON.parse(listByType(db, mustafa.me.id, 'challenge_cancelled')[0]!.data)).toEqual({
      challengeId: id,
      reason: 'everyone_left',
    });
    expect(titles(harness, mustafa, 'challenge_left')).toEqual([]);
  });

  it('leaves a çelınc past its end to the scheduler, and a late no tells nobody', async () => {
    harness = await makeApp({ now: '2026-01-05T09:00:00.000Z' });
    const { app, db } = harness;
    const mustafa = await registerUser(app, 'mustafa', { displayName: 'Mustafa' });
    const ali = await registerUser(app, 'ali', { displayName: 'Ali' });
    const id = await startNow(harness, mustafa, [ali]);

    // a step çelınc waits an hour for the phones after its end
    harness.advance(7 * 24 * HOUR + 10 * 60_000);
    expect((await answer(harness, ali, id, 'decline')).json<ChallengeDetail>().challenge.status).toBe('active');
    expect(titles(harness, mustafa, 'challenge_declined')).toEqual([]);

    harness.advance(HOUR);
    runSchedulerOnce(db, app.now());
    expect(getChallengeRow(db, id)?.status).toBe('cancelled');
    expect(JSON.parse(listByType(db, mustafa.me.id, 'challenge_cancelled')[0]!.data)).toMatchObject({
      reason: 'not_enough_players',
    });
  });
});

describe('push queue', () => {
  const MINUTE = 60_000;

  /** A row waiting for the push queue, written `agoMs` before the clock's now. */
  function queue(h: TestApp, userId: string, agoMs = 0, readAt: string | null = null): string {
    const id = newId();
    h.db
      .prepare(
        "INSERT INTO notifications (id, user_id, type, title, body, data, read_at, created_at, pushed_at, push_error) VALUES (?, ?, 'poke', 'Dürt', 'Kalk', '{}', ?, ?, NULL, NULL)",
      )
      .run(id, userId, readAt, nowIso(new Date(h.now().getTime() - agoMs)));
    return id;
  }

  function pushErrorOf(h: TestApp, id: string): string | null {
    return (h.db.prepare('SELECT push_error FROM notifications WHERE id = ?').get(id) as { push_error: string | null })
      .push_error;
  }

  // A token that is not an Expo one fails every row it is handed without going
  // to the network, so `failed` counts exactly the rows a flush picked.
  const registerToken = (h: TestApp, user: RegisteredUser) =>
    authed(h.app, user.token)({
      method: 'POST',
      url: '/me/push-token',
      payload: { token: 'not-an-expo-token', platform: 'android' },
    });

  it('marks unusable tokens instead of throwing', async () => {
    harness = await makeApp();
    const { app, db, config } = harness;
    const ali = await registerUser(app, 'ali', { pushToken: 'not-an-expo-token' });
    const veli = await registerUser(app, 'veli'); // no token at all

    queue(harness, ali.me.id);
    queue(harness, veli.me.id);

    const sender = createPushSender(config);
    await expect(sender.flush(db, app.now())).resolves.toEqual({ sent: 0, failed: 1 });

    const errors = db.prepare('SELECT push_error FROM notifications WHERE push_error IS NOT NULL').all() as {
      push_error: string;
    }[];
    expect(errors).toEqual([{ push_error: 'invalid_token' }]);

    // nothing left to do on the second pass
    await expect(sender.flush(db, app.now())).resolves.toEqual({ sent: 0, failed: 0 });
  });

  it('never pushes what was written before the phone registered its token', async () => {
    harness = await makeApp();
    const { app, db, config } = harness;
    const ali = await registerUser(app, 'ali');

    // a month without Firebase, and a poke from a minute ago the phone showed itself
    const old: string[] = [];
    for (let i = 0; i < 250; i++) old.push(queue(harness, ali.me.id, 30 * 24 * 60 * MINUTE - i * MINUTE));
    const recent = queue(harness, ali.me.id, MINUTE);

    expect((await registerToken(harness, ali)).statusCode).toBe(200);
    const sender = createPushSender(config);
    await expect(sender.flush(db, app.now())).resolves.toEqual({ sent: 0, failed: 0 });
    expect(pushErrorOf(harness, recent)).toBe('before_token');
    expect(pushErrorOf(harness, old[0]!)).toBe('before_token');
    // still in the inbox, still unread
    const unread = db
      .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL')
      .get(ali.me.id) as { n: number };
    expect(unread.n).toBe(251);
  });

  it('pushes an unread row written after the token, and not a read one', async () => {
    harness = await makeApp();
    const { app, db, config } = harness;
    const ali = await registerUser(app, 'ali');
    expect((await registerToken(harness, ali)).statusCode).toBe(200);

    harness.advance(MINUTE);
    const unread = queue(harness, ali.me.id);
    const read = queue(harness, ali.me.id, 0, nowIso(app.now()));

    const sender = createPushSender(config);
    await expect(sender.flush(db, app.now())).resolves.toEqual({ sent: 0, failed: 1 });
    expect(pushErrorOf(harness, unread)).toBe('invalid_token');
    expect(pushErrorOf(harness, read)).toBeNull();

    // within the hour the read row is only passed over, then it expires
    harness.advance(61 * MINUTE);
    await expect(sender.flush(db, app.now())).resolves.toEqual({ sent: 0, failed: 0 });
    expect(pushErrorOf(harness, read)).toBe('expired');
  });

  it("does not hold a fresh row back behind another account's old ones", async () => {
    harness = await makeApp();
    const { app, db, config } = harness;
    const ali = await registerUser(app, 'ali', { pushToken: 'not-an-expo-token' });
    const veli = await registerUser(app, 'veli', { pushToken: 'not-an-expo-token-2' });

    // the server was off with ali's 300 rows still waiting
    for (let i = 0; i < 300; i++) queue(harness, ali.me.id, 2 * 60 * MINUTE);
    const fresh = queue(harness, veli.me.id);

    const sender = createPushSender(config);
    await expect(sender.flush(db, app.now())).resolves.toEqual({ sent: 0, failed: 1 });
    expect(pushErrorOf(harness, fresh)).toBe('invalid_token');
    const expired = db
      .prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND push_error = 'expired'")
      .get(ali.me.id) as { n: number };
    expect(expired.n).toBe(300);
  });

  it('leaves the queue alone when the phone sends the same token again', async () => {
    harness = await makeApp();
    const { app, db, config } = harness;
    const ali = await registerUser(app, 'ali');
    expect((await registerToken(harness, ali)).statusCode).toBe(200);

    harness.advance(MINUTE);
    const waiting = queue(harness, ali.me.id);
    // the app registers again on every start
    expect((await registerToken(harness, ali)).statusCode).toBe(200);
    expect(pushErrorOf(harness, waiting)).toBeNull();

    await expect(createPushSender(config).flush(db, app.now())).resolves.toEqual({ sent: 0, failed: 1 });
  });
});
