/**
 * Regression tests for the second review round — one `describe` per rule that
 * turned out to be missing or wrong on a real phone:
 * a proof-required yes/no çelınc nobody could mark, a "yattım" at 02:00 counting
 * as an early night, nudges to people who never joined, reminders telling a
 * player who logged that their score is zero, disputes after the whistle, a
 * blocked pair reaching each other (or a block mid-race putting a typed number
 * past any itiraz), a rematch winner "avenging" a win, a rival
 * they had beaten or a friend who never played the first one (and the picker
 * never hearing of a real rövanş or a third win in a row), a rematch
 * silently dropping a group rival, a partial step count shaving a typed
 * declaration, a step day friends threw out staying at zero after the phone
 * counted it, and a proxy header nobody set.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TIMEZONE,
  LIMITS,
  addDays,
  todayKey,
  type Challenge,
  type ChallengeDetail,
  type ChallengeResults,
  type Me,
} from '@koydum/shared';
import { loadConfig } from '../src/config.js';
import { runSchedulerOnce, sendNudges, sendReminders } from '../src/services/challenges.js';
import { entryReplacedCopy } from '../src/services/challengeViews.js';
import { awardBadges, computeUserStats, getBadges } from '../src/services/stats.js';
import { sendTaunt } from '../src/services/taunts.js';
import type { ChallengeRow, UserRow } from '../src/db/index.js';
import { JPEG_WITH_GPS, authed, befriend, makeApp, multipart, registerUser, type RegisteredUser, type TestApp } from './helpers.js';

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

function notificationsOf(h: TestApp, userId: string, type: string): { body: string }[] {
  return h.db
    .prepare('SELECT body FROM notifications WHERE user_id = ? AND type = ? ORDER BY created_at')
    .all(userId, type) as { body: string }[];
}

interface Pair {
  ali: RegisteredUser;
  veli: RegisteredUser;
  challengeId: string;
}

async function livePair(h: TestApp, typeKey: string, extra: Record<string, unknown> = {}, durationDays = 3): Promise<Pair> {
  const ali = await registerUser(h.app, 'ali', { displayName: 'Ali' });
  const veli = await registerUser(h.app, 'veli', { displayName: 'Veli' });
  befriend(h.app, ali.me.id, veli.me.id);
  const created = await authed(h.app, ali.token)({
    method: 'POST',
    url: '/challenges',
    payload: { typeKey, startsAt: iso(h), endsAt: iso(h, durationDays * DAY_MS), participantIds: [veli.me.id], ...extra },
  });
  expect(created.statusCode).toBe(201);
  const challengeId = created.json<Challenge>().id;
  expect((await authed(h.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` })).statusCode).toBe(200);
  return { ali, veli, challengeId };
}

describe('proof only applies to typed numbers', () => {
  it('a daily yes/no çelınc can be marked even with the proof flag on', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await livePair(harness, 'sosyal_medya_orucu', { proofRequired: true });
    const marked = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: today(harness), value: 1, source: 'manual', clientTime: iso(harness) },
    });
    expect(marked.statusCode).toBe(201);
  });

  it('a check-in çelınc with the proof flag on still takes the button', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await livePair(harness, 'yatak_toplama', { proofRequired: true, deadlineTime: '13:00' });
    const checkin = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: today(harness), value: 1, source: 'checkin', clientTime: iso(harness) },
    });
    expect(checkin.statusCode).toBe(201);
  });

  it('a typed count with the proof flag on still needs its photo', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await livePair(harness, 'su_bardak', { proofRequired: true });
    const bare = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: today(harness), value: 1, source: 'manual', clientTime: iso(harness) },
    });
    expect(errorCode(bare)).toBe('proof_required');
  });
});

describe('check-in window', () => {
  it('refuses "yattım" before the evening opens and takes it once it has', async () => {
    // 09:00Z = 12:00 Istanbul; erken_yat opens at 19:00 local
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await livePair(harness, 'erken_yat', { deadlineTime: '23:00' });
    const call = authed(harness.app, ali.token);

    const early = await call({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: today(harness), value: 1, source: 'checkin', clientTime: iso(harness) },
    });
    expect(early.statusCode).toBe(400);
    expect(errorCode(early)).toBe('checkin_too_early');

    harness.setNow('2026-01-05T18:30:00.000Z'); // 21:30 Istanbul
    const onTime = await call({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: today(harness), value: 1, source: 'checkin', clientTime: iso(harness) },
    });
    expect(onTime.statusCode).toBe(201);
    expect(onTime.json<{ entry: { value: number } }>().entry.value).toBe(1);
  });

  it('the wake-up çelınc still takes a 06:00 check-in', async () => {
    harness = await makeApp({ now: '2026-01-05T03:00:00.000Z' }); // 06:00 Istanbul
    const { ali, challengeId } = await livePair(harness, 'erken_kus', { deadlineTime: '07:00' });
    const checkin = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: today(harness), value: 1, source: 'checkin', clientTime: iso(harness) },
    });
    expect(checkin.statusCode).toBe(201);
  });
});

describe('who gets nudged and reminded', () => {
  it('never nudges somebody who did not accept the çelınc', async () => {
    harness = await makeApp({ now: NOW }); // 12:00 Istanbul, inside the nudge hours
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    const can = await registerUser(harness.app, 'can', { displayName: 'Can' });
    befriend(harness.app, ali.me.id, veli.me.id);
    befriend(harness.app, ali.me.id, can.me.id);
    const created = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/challenges',
      payload: { typeKey: 'su_bardak', startsAt: iso(harness), endsAt: iso(harness, 3 * DAY_MS), participantIds: [veli.me.id, can.me.id] },
    });
    const challengeId = created.json<Challenge>().id;
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    // Can never answers. Ali drinks.
    for (let i = 0; i < 4; i++) {
      harness.advance(25 * 60_000);
      await authed(harness.app, ali.token)({
        method: 'POST',
        url: `/challenges/${challengeId}/entries`,
        payload: { dayKey: today(harness), value: 1, source: 'manual', clientTime: iso(harness) },
      });
    }

    expect(sendNudges(harness.db, harness.now())).toBe(1);
    expect(notificationsOf(harness, veli.me.id, 'nudge')).toHaveLength(1);
    expect(notificationsOf(harness, can.me.id, 'nudge')).toHaveLength(0);
  });

  it('skips the daily reminder for somebody who already logged today', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { reminderHour: 12 });
    const veli = await registerUser(harness.app, 'veli', { reminderHour: 12 });
    befriend(harness.app, ali.me.id, veli.me.id);
    const created = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/challenges',
      payload: { typeKey: 'su_bardak', startsAt: iso(harness), endsAt: iso(harness, 3 * DAY_MS), participantIds: [veli.me.id] },
    });
    const challengeId = created.json<Challenge>().id;
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: today(harness), value: 2, source: 'manual', clientTime: iso(harness) },
    });

    expect(sendReminders(harness.db, harness.now())).toBe(1);
    expect(notificationsOf(harness, ali.me.id, 'reminder')).toHaveLength(0);
    const [veliReminder] = notificationsOf(harness, veli.me.id, 'reminder');
    expect(veliReminder?.body).toContain('sıfırdasın');
  });
});

describe('disputes and blocks', () => {
  it('refuses a dispute once the çelınc is finished', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await livePair(harness, 'su_bardak', {}, 1);
    const logged = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: today(harness), value: 5, source: 'manual', clientTime: iso(harness) },
    });
    const entryId = logged.json<{ entry: { id: string } }>().entry.id;

    harness.advance(DAY_MS + 60_000);
    const advanced = await harness.app.inject({ method: 'POST', url: '/dev/advance' });
    expect(advanced.json<{ finalized: number }>().finalized).toBe(1);

    const late = await authed(harness.app, veli.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${entryId}/dispute`,
      payload: { reason: 'beş bardak mı, valla mı' },
    });
    expect(late.statusCode).toBe(400);
    expect(errorCode(late)).toBe('challenge_not_active');
    const results = await authed(harness.app, ali.token)({ method: 'GET', url: `/challenges/${challengeId}/results` });
    expect(results.json<ChallengeResults>().standings[0]?.user.id).toBe(ali.me.id);
  });

  it('a block mid-race keeps the itiraz open between players still in it, and still closes the accept door', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    const can = await registerUser(harness.app, 'can', { displayName: 'Can' });
    befriend(harness.app, ali.me.id, veli.me.id);
    befriend(harness.app, ali.me.id, can.me.id);
    const created = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/challenges',
      payload: { typeKey: 'su_bardak', startsAt: iso(harness), endsAt: iso(harness, 3 * DAY_MS), participantIds: [veli.me.id, can.me.id] },
    });
    const challengeId = created.json<Challenge>().id;
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    const logged = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: today(harness), value: 3, source: 'manual', clientTime: iso(harness) },
    });
    const entryId = logged.json<{ entry: { id: string } }>().entry.id;

    // Ali blocks both of them after the invites went out
    expect((await authed(harness.app, ali.token)({ method: 'POST', url: `/users/${veli.me.id}/block` })).statusCode).toBeLessThan(300);
    expect((await authed(harness.app, ali.token)({ method: 'POST', url: `/users/${can.me.id}/block` })).statusCode).toBeLessThan(300);

    // Veli is still in, and the itiraz is the only check on a typed number
    const dispute = await authed(harness.app, veli.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${entryId}/dispute`,
      payload: { reason: 'inanmıyorum' },
    });
    expect(dispute.statusCode).toBe(201);
    // Ali hears that it came, not from whom
    const told = notificationsOf(harness, ali.me.id, 'dispute');
    expect(told).toHaveLength(1);
    expect(told[0]?.body).toContain('Bir rakibin');
    expect(told[0]?.body).not.toContain('Veli');
    // and Ali's photo is no news to Veli across the block
    const answered = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${entryId}/proof`,
      payload: { proofUrl: '/uploads/bardak.jpg' },
    });
    expect(answered.statusCode).toBe(200);
    expect(notificationsOf(harness, veli.me.id, 'dispute')).toHaveLength(0);

    const accept = await authed(harness.app, can.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    expect(accept.statusCode).toBe(403);
    expect(errorCode(accept)).toBe('blocked');
  });

  it('a typed number does not win by blocking the only one who could dispute it', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    befriend(harness.app, ali.me.id, veli.me.id);
    const endsAt = harness.now().getTime() + 2 * DAY_MS;
    const created = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/challenges',
      payload: { typeKey: 'adim_yarisi', startsAt: iso(harness), endsAt: new Date(endsAt).toISOString(), participantIds: [veli.me.id] },
    });
    const challengeId = created.json<Challenge>().id;
    expect((await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` })).statusCode).toBe(200);

    // Ali's phone counts 9.000; Veli types 99.000 and blocks Ali
    const synced = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/me/steps',
      payload: { days: [{ dayKey: today(harness), steps: 9000, source: 'health_connect' }] },
    });
    expect(synced.statusCode).toBe(200);
    const typed = await authed(harness.app, veli.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: today(harness), value: 99000, source: 'manual', clientTime: iso(harness) },
    });
    expect(typed.statusCode).toBe(201);
    const entryId = typed.json<{ entry: { id: string } }>().entry.id;
    expect((await authed(harness.app, veli.token)({ method: 'POST', url: `/users/${ali.me.id}/block` })).statusCode).toBe(200);

    const dispute = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${entryId}/dispute`,
      payload: { reason: 'Yalan, bütün gün evdeydi' },
    });
    expect(dispute.statusCode).toBe(201);
    expect(dispute.json<{ answerBy: string | null }>().answerBy).not.toBeNull();

    // no photo in 12 hours: the typed day goes
    harness.advance(LIMITS.DISPUTE_ANSWER_MS + 60_000);
    runSchedulerOnce(harness.db, harness.now());
    const row = harness.db.prepare('SELECT status FROM entries WHERE id = ?').get(entryId) as { status: string };
    expect(row.status).toBe('rejected');

    harness.setNow(new Date(endsAt + LIMITS.DEVICE_SETTLE_MS + 60_000));
    runSchedulerOnce(harness.db, harness.now());
    const finished = harness.db.prepare('SELECT status, winner_id FROM challenges WHERE id = ?').get(challengeId) as {
      status: string;
      winner_id: string | null;
    };
    expect(finished).toEqual({ status: 'finished', winner_id: ali.me.id });
  });

  it('keeps the door shut to an owner who is out of the çelınc', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    const can = await registerUser(harness.app, 'can', { displayName: 'Can' });
    befriend(harness.app, ali.me.id, veli.me.id);
    befriend(harness.app, ali.me.id, can.me.id);
    const created = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/challenges',
      payload: { typeKey: 'su_bardak', startsAt: iso(harness), endsAt: iso(harness, 3 * DAY_MS), participantIds: [veli.me.id, can.me.id] },
    });
    const challengeId = created.json<Challenge>().id;
    for (const friend of [veli, can]) {
      expect((await authed(harness.app, friend.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` })).statusCode).toBe(200);
    }
    const logged = await authed(harness.app, can.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: today(harness), value: 4, source: 'manual', clientTime: iso(harness) },
    });
    const entryId = logged.json<{ entry: { id: string } }>().entry.id;

    // Can walks out, then blocks Ali: an old participant list is no way back to him
    expect((await authed(harness.app, can.token)({ method: 'POST', url: `/challenges/${challengeId}/leave` })).statusCode).toBe(200);
    expect((await authed(harness.app, can.token)({ method: 'POST', url: `/users/${ali.me.id}/block` })).statusCode).toBeLessThan(300);

    const dispute = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${entryId}/dispute`,
      payload: { reason: 'dört bardak mı' },
    });
    expect(dispute.statusCode).toBe(403);
    expect(errorCode(dispute)).toBe('blocked');
    expect(notificationsOf(harness, can.me.id, 'dispute')).toHaveLength(0);
  });

  it('lets a disputer who blocked the owner take the itiraz back', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await livePair(harness, 'su_bardak');
    const logged = await authed(harness.app, veli.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: today(harness), value: 6, source: 'manual', clientTime: iso(harness) },
    });
    const url = `/challenges/${challengeId}/entries/${logged.json<{ entry: { id: string } }>().entry.id}/dispute`;

    expect((await authed(harness.app, ali.token)({ method: 'POST', url: `/users/${veli.me.id}/block` })).statusCode).toBeLessThan(300);
    const dispute = await authed(harness.app, ali.token)({ method: 'POST', url, payload: { reason: 'altı bardak mı' } });
    expect(dispute.statusCode).toBe(201);
    const told = notificationsOf(harness, veli.me.id, 'dispute');
    expect(told).toHaveLength(1);
    expect(told[0]?.body).toContain('Bir rakibin');
    expect(told[0]?.body).not.toContain('Ali');

    const withdrawn = await authed(harness.app, ali.token)({ method: 'DELETE', url });
    expect(withdrawn.statusCode).toBe(200);
    expect(withdrawn.json<{ entry: { status: string } }>().entry.status).toBe('ok');
  });
});

describe('rematch taunts', () => {
  async function finishedWin(h: TestApp, winner: RegisteredUser, loser: RegisteredUser, rematchOf?: string): Promise<string> {
    let challengeId: string;
    if (rematchOf) {
      const rematch = await authed(h.app, winner.token)({ method: 'POST', url: `/challenges/${rematchOf}/rematch` });
      expect(rematch.statusCode).toBe(201);
      challengeId = rematch.json<Challenge>().id;
      // a rematch starts a few minutes out and must be accepted
      expect((await authed(h.app, loser.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` })).statusCode).toBe(200);
      h.advance(10 * 60_000);
      await h.app.inject({ method: 'POST', url: '/dev/advance' });
    } else {
      const created = await authed(h.app, winner.token)({
        method: 'POST',
        url: '/challenges',
        payload: { typeKey: 'su_bardak', startsAt: iso(h), endsAt: iso(h, DAY_MS), participantIds: [loser.me.id] },
      });
      challengeId = created.json<Challenge>().id;
      expect((await authed(h.app, loser.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` })).statusCode).toBe(200);
    }
    const drink = await authed(h.app, winner.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: today(h), value: 4, source: 'manual', clientTime: iso(h) },
    });
    expect(drink.statusCode).toBe(201);
    h.advance(DAY_MS + 2 * 60_000);
    const advanced = await h.app.inject({ method: 'POST', url: '/dev/advance' });
    expect(advanced.json<{ finalized: number }>().finalized).toBeGreaterThanOrEqual(1);
    const detail = await authed(h.app, winner.token)({ method: 'GET', url: `/challenges/${challengeId}` });
    expect(detail.json<ChallengeDetail>().challenge.winnerId).toBe(winner.me.id);
    return challengeId;
  }

  it('offers revenge lines only to the player who lost the original', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali', vulgarityMax: 3 });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli', vulgarityMax: 3 });
    befriend(harness.app, ali.me.id, veli.me.id);

    const first = await finishedWin(harness, ali, veli);
    // Ali wins the rematch too: nothing to avenge
    const second = await finishedWin(harness, ali, veli, first);
    const repeat = await authed(harness.app, ali.token)({ method: 'GET', url: `/challenges/${second}/results` });
    const repeatTemplates = repeat.json<ChallengeResults>().tauntTemplatesForWinner ?? [];
    expect(repeatTemplates.length).toBeGreaterThan(0);
    expect(repeatTemplates.every((tpl) => tpl.context !== 'revenge')).toBe(true);

    // Veli takes the third one: that IS revenge
    const third = await finishedWin(harness, veli, ali, second);
    const avenged = await authed(harness.app, veli.token)({ method: 'GET', url: `/challenges/${third}/results` });
    const avengedTemplates = avenged.json<ChallengeResults>().tauntTemplatesForWinner ?? [];
    expect(avengedTemplates.length).toBeGreaterThan(0);
    expect(avengedTemplates.every((tpl) => tpl.context === 'revenge')).toBe(true);
    // the picker gets the same word per loser, so it can offer the rövanş lines
    expect(repeat.json<ChallengeResults>().tauntContexts).toEqual({ [veli.me.id]: 'win_big' });
    expect(avenged.json<ChallengeResults>().tauntContexts).toEqual({ [ali.me.id]: 'revenge' });
  });

  /** Both drink the same, so it ends level. */
  async function finishedTie(h: TestApp, a: RegisteredUser, b: RegisteredUser): Promise<string> {
    const created = await authed(h.app, a.token)({
      method: 'POST',
      url: '/challenges',
      payload: { typeKey: 'su_bardak', startsAt: iso(h), endsAt: iso(h, DAY_MS), participantIds: [b.me.id] },
    });
    const challengeId = created.json<Challenge>().id;
    expect((await authed(h.app, b.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` })).statusCode).toBe(200);
    for (const player of [a, b]) {
      await authed(h.app, player.token)({
        method: 'POST',
        url: `/challenges/${challengeId}/entries`,
        payload: { dayKey: today(h), value: 2, source: 'manual', clientTime: iso(h) },
      });
    }
    h.advance(DAY_MS + 2 * 60_000);
    await h.app.inject({ method: 'POST', url: '/dev/advance' });
    const detail = await authed(h.app, a.token)({ method: 'GET', url: `/challenges/${challengeId}` });
    expect(detail.json<ChallengeDetail>().challenge.isTie).toBe(true);
    return challengeId;
  }

  async function contextsOf(h: TestApp, winner: RegisteredUser, challengeId: string): Promise<ChallengeResults> {
    const response = await authed(h.app, winner.token)({ method: 'GET', url: `/challenges/${challengeId}/results` });
    expect(response.statusCode).toBe(200);
    return response.json<ChallengeResults>();
  }

  it('calls a third straight win a streak, and two only by their margin', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali', vulgarityMax: 3 });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli', vulgarityMax: 3 });
    befriend(harness.app, ali.me.id, veli.me.id);

    await finishedWin(harness, ali, veli);
    const second = await finishedWin(harness, ali, veli);
    expect((await contextsOf(harness, ali, second)).tauntContexts).toEqual({ [veli.me.id]: 'win_big' });

    const third = await finishedWin(harness, ali, veli);
    const results = await contextsOf(harness, ali, third);
    expect(results.tauntContexts).toEqual({ [veli.me.id]: 'streak' });
    expect(results.tauntTemplatesForWinner?.length).toBeGreaterThan(0);
    expect(results.tauntTemplatesForWinner?.every((tpl) => tpl.context === 'streak')).toBe(true);
    // an older win looked at later does not borrow the ones that came after it
    expect((await contextsOf(harness, ali, second)).tauntContexts).toEqual({ [veli.me.id]: 'win_big' });
  });

  it('lets a tie break the streak', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    befriend(harness.app, ali.me.id, veli.me.id);

    await finishedWin(harness, ali, veli);
    await finishedTie(harness, ali, veli);
    await finishedWin(harness, ali, veli);
    const third = await finishedWin(harness, ali, veli);
    // three wins, but the tie sits between the first and the other two
    expect((await contextsOf(harness, ali, third)).tauntContexts).toEqual({ [veli.me.id]: 'win_big' });

    const fourth = await finishedWin(harness, ali, veli);
    expect((await contextsOf(harness, ali, fourth)).tauntContexts).toEqual({ [veli.me.id]: 'streak' });
  });

  it('picks a streak line on its own when no template is named', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli', vulgarityMax: 1 });
    befriend(harness.app, ali.me.id, veli.me.id);

    await finishedWin(harness, ali, veli);
    await finishedWin(harness, ali, veli);
    const third = await finishedWin(harness, ali, veli);

    const row = (id: string) => harness!.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow;
    const challenge = harness.db.prepare('SELECT * FROM challenges WHERE id = ?').get(third) as ChallengeRow;
    const { template, taunt } = sendTaunt(harness.db, {
      challenge,
      from: row(ali.me.id),
      to: row(veli.me.id),
      now: harness.now(),
    });
    expect(template?.context).toBe('streak');
    // still clamped to what Veli allows
    expect(template?.level).toBe(1);
    expect(taunt.body).toContain('Ali');
  });

  /**
   * A finished su_bardak çelınc opened by `opener` (the rematch of `rematchOf`
   * when given) where each player drinks their `glasses`. `newcomers` are brought
   * into the rematch with "Kanka ekle" before it starts.
   */
  async function finishedGroup(
    h: TestApp,
    opener: RegisteredUser,
    glasses: [RegisteredUser, number][],
    rematchOf?: string,
    newcomers: RegisteredUser[] = [],
  ): Promise<string> {
    const others = glasses.map(([player]) => player).filter((player) => player.me.id !== opener.me.id);
    const created = rematchOf
      ? await authed(h.app, opener.token)({ method: 'POST', url: `/challenges/${rematchOf}/rematch` })
      : await authed(h.app, opener.token)({
          method: 'POST',
          url: '/challenges',
          payload: { typeKey: 'su_bardak', startsAt: iso(h), endsAt: iso(h, DAY_MS), participantIds: others.map((p) => p.me.id) },
        });
    expect(created.statusCode).toBe(201);
    const challengeId = created.json<Challenge>().id;
    if (newcomers.length > 0) {
      const invited = await authed(h.app, opener.token)({
        method: 'POST',
        url: `/challenges/${challengeId}/invite`,
        payload: { userIds: newcomers.map((p) => p.me.id) },
      });
      expect(invited.statusCode).toBe(200);
    }
    for (const player of others) {
      expect((await authed(h.app, player.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` })).statusCode).toBe(200);
    }
    if (rematchOf) {
      h.advance(10 * 60_000);
      await h.app.inject({ method: 'POST', url: '/dev/advance' });
    }
    for (const [player, value] of glasses) {
      if (value === 0) continue;
      const drink = await authed(h.app, player.token)({
        method: 'POST',
        url: `/challenges/${challengeId}/entries`,
        payload: { dayKey: today(h), value, source: 'manual', clientTime: iso(h) },
      });
      expect(drink.statusCode).toBe(201);
    }
    h.advance(DAY_MS + 2 * 60_000);
    await h.app.inject({ method: 'POST', url: '/dev/advance' });
    const detail = await authed(h.app, opener.token)({ method: 'GET', url: `/challenges/${challengeId}` });
    expect(detail.json<ChallengeDetail>().challenge.status).toBe('finished');
    return challengeId;
  }

  it('pays back only the rivals who finished ahead of the winner last time', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali', vulgarityMax: 3 });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli', vulgarityMax: 3 });
    const can = await registerUser(harness.app, 'can', { displayName: 'Can', vulgarityMax: 3 });
    befriend(harness.app, ali.me.id, veli.me.id);
    befriend(harness.app, ali.me.id, can.me.id);
    befriend(harness.app, veli.me.id, can.me.id);

    // Ali 1st, Veli 2nd, Can 3rd; Veli takes the rematch
    const first = await finishedGroup(harness, ali, [[ali, 4], [veli, 2], [can, 0]]);
    const rematch = await finishedGroup(harness, veli, [[veli, 4], [ali, 2], [can, 1]], first);
    const contexts = (await contextsOf(harness, veli, rematch)).tauntContexts ?? {};
    expect(contexts[ali.me.id]).toBe('revenge');
    // Veli finished ahead of Can last time too: nothing to pay back
    expect(contexts[can.me.id]).toBeDefined();
    expect(contexts[can.me.id]).not.toBe('revenge');
  });

  it('gives a friend brought into the rematch nothing to avenge', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali', vulgarityMax: 3 });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli', vulgarityMax: 3 });
    const deniz = await registerUser(harness.app, 'deniz', { displayName: 'Deniz', vulgarityMax: 3 });
    befriend(harness.app, ali.me.id, veli.me.id);
    befriend(harness.app, ali.me.id, deniz.me.id);

    const first = await finishedWin(harness, ali, veli);
    // Deniz never played the first one, and wins the rematch Ali brought him into
    const rematch = await finishedGroup(harness, ali, [[ali, 2], [veli, 1], [deniz, 4]], first, [deniz]);
    const results = await contextsOf(harness, deniz, rematch);
    expect(Object.keys(results.tauntContexts ?? {}).sort()).toEqual([ali.me.id, veli.me.id].sort());
    expect(Object.values(results.tauntContexts ?? {})).not.toContain('revenge');
    expect(results.tauntTemplatesForWinner?.every((tpl) => tpl.context !== 'revenge')).toBe(true);
    expect(computeUserStats(harness.db, deniz.me.id).revengeWins).toBe(0);
  });

  it('counts a rematch toward Faiziyle Aldı only when its winner lost the first one', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    befriend(harness.app, ali.me.id, veli.me.id);

    // Ali wins the first one and three rematches in a row: he paid nothing back
    let last = await finishedWin(harness, ali, veli);
    for (let round = 0; round < 3; round++) last = await finishedWin(harness, ali, veli, last);
    expect(computeUserStats(harness.db, ali.me.id).revengeWins).toBe(0);
    expect(getBadges(harness.db, ali.me.id)).not.toContain('rovans_1');

    // a rung stored on the older count (every rematch won) is never taken back
    harness.db
      .prepare('INSERT INTO badges (user_id, badge_key, earned_at) VALUES (?, ?, ?)')
      .run(ali.me.id, 'rovans_1', iso(harness));
    awardBadges(harness.db, ali.me.id, harness.now());
    expect(getBadges(harness.db, ali.me.id)).toContain('rovans_1');
  });

  it('gives Faiziyle Aldı to the one who took back three he lost', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    befriend(harness.app, ali.me.id, veli.me.id);

    // back and forth, each one the rematch of the last: Ali, Veli, Ali, Veli, Ali, Veli
    let last = await finishedWin(harness, ali, veli);
    for (let round = 0; round < 3; round++) {
      last = await finishedWin(harness, veli, ali, last);
      if (round < 2) last = await finishedWin(harness, ali, veli, last);
    }
    expect(computeUserStats(harness.db, veli.me.id).revengeWins).toBe(3);
    expect(getBadges(harness.db, veli.me.id)).toContain('rovans_1');
    // Ali's two came back after losing too
    expect(computeUserStats(harness.db, ali.me.id).revengeWins).toBe(2);
  });
});

describe('rematch line-up', () => {
  it('names the rivals a rematch would leave out for not being friends, and leaves them out', async () => {
    harness = await makeApp({ now: NOW });
    const can = await registerUser(harness.app, 'can', { displayName: 'Can' });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    // Can knows both; Ali and Veli only met in Can's group
    befriend(harness.app, can.me.id, ali.me.id);
    befriend(harness.app, can.me.id, veli.me.id);

    const created = await authed(harness.app, can.token)({
      method: 'POST',
      url: '/challenges',
      payload: { typeKey: 'su_bardak', startsAt: iso(harness), endsAt: iso(harness, DAY_MS), participantIds: [ali.me.id, veli.me.id] },
    });
    const challengeId = created.json<Challenge>().id;
    for (const player of [ali, veli]) {
      expect((await authed(harness.app, player.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` })).statusCode).toBe(200);
    }
    await authed(harness.app, can.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: today(harness), value: 4, source: 'manual', clientTime: iso(harness) },
    });
    harness.advance(DAY_MS + 2 * 60_000);
    await harness.app.inject({ method: 'POST', url: '/dev/advance' });

    const resultsFor = async (user: RegisteredUser) =>
      (await authed(harness!.app, user.token)({ method: 'GET', url: `/challenges/${challengeId}/results` })).json<ChallengeResults>();
    expect((await resultsFor(ali)).rematchLeftOut).toEqual([veli.me.id]);
    expect((await resultsFor(can)).rematchLeftOut).toEqual([]);

    const rematch = await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` });
    expect(rematch.statusCode).toBe(201);
    const invited = harness.db
      .prepare("SELECT user_id FROM challenge_participants WHERE challenge_id = ? AND status = 'invited'")
      .all(rematch.json<Challenge>().id) as { user_id: string }[];
    expect(invited.map((row) => row.user_id)).toEqual([can.me.id]);

    // a block is not something "add them" fixes, and one placed on me must not show
    expect((await authed(harness.app, ali.token)({ method: 'POST', url: `/users/${veli.me.id}/block` })).statusCode).toBeLessThan(300);
    expect((await resultsFor(ali)).rematchLeftOut).toEqual([]);
    expect((await resultsFor(veli)).rematchLeftOut).toEqual([]);
  });
});

describe('device readings versus typed declarations', () => {
  it('hands out the step badge with the sync that crossed the line, not days later', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const call = authed(harness.app, ali.token);
    const day = today(harness);
    const badges = () =>
      (harness!.db.prepare('SELECT badge_key FROM badges WHERE user_id = ?').all(ali.me.id) as { badge_key: string }[]).map(
        (row) => row.badge_key,
      );

    await call({ method: 'POST', url: '/me/steps', payload: { days: [{ dayKey: day, steps: 7000, source: 'pedometer' }] } });
    expect(badges()).not.toContain('adim_1');

    const synced = await call({ method: 'POST', url: '/me/steps', payload: { days: [{ dayKey: day, steps: 8200, source: 'pedometer' }] } });
    expect(synced.statusCode).toBe(200);
    expect(badges()).toContain('adim_1');
    const told = harness.db
      .prepare("SELECT title FROM notifications WHERE user_id = ? AND type = 'badge'")
      .all(ali.me.id) as { title: string }[];
    expect(told.map((row) => row.title)).toContain('🥾 Yeni rozet: Yola Çıktın');
  });

  it('a partial step count never lowers a step declaration, a higher one replaces it', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await livePair(harness, 'adim_yarisi');
    const call = authed(harness.app, ali.token);
    const day = today(harness);

    const declared = await call({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: day, value: 8000, source: 'manual', clientTime: iso(harness) },
    });
    expect(declared.statusCode).toBe(201);

    await call({ method: 'POST', url: '/me/steps', payload: { days: [{ dayKey: day, steps: 1200, source: 'pedometer' }] } });
    let row = harness.db.prepare('SELECT value, source FROM entries WHERE challenge_id = ? AND user_id = ?').get(challengeId, ali.me.id) as { value: number; source: string };
    expect(row).toEqual({ value: 8000, source: 'manual' });

    await call({ method: 'POST', url: '/me/steps', payload: { days: [{ dayKey: day, steps: 9100, source: 'pedometer' }] } });
    row = harness.db.prepare('SELECT value, source FROM entries WHERE challenge_id = ? AND user_id = ?').get(challengeId, ali.me.id) as { value: number; source: string };
    expect(row).toEqual({ value: 9100, source: 'pedometer' });
  });

  it('a lower or zero step reading never lowers a day a device already reported (reinstall, second phone)', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await livePair(harness, 'adim_yarisi');
    const call = authed(harness.app, ali.token);
    const day = today(harness);
    await call({ method: 'POST', url: '/me/steps', payload: { days: [{ dayKey: day, steps: 9000, source: 'health_connect' }] } });
    // a freshly installed phone that started recording this afternoon
    await call({ method: 'POST', url: '/me/steps', payload: { days: [{ dayKey: day, steps: 0, source: 'pedometer' }] } });
    await call({ method: 'POST', url: '/me/steps', payload: { days: [{ dayKey: day, steps: 1200, source: 'pedometer' }] } });
    const row = harness.db.prepare('SELECT value, source FROM entries WHERE challenge_id = ? AND user_id = ?').get(challengeId, ali.me.id) as { value: number; source: string };
    expect(row).toEqual({ value: 9000, source: 'health_connect' });
    const raw = harness.db.prepare('SELECT steps, source FROM steps_daily WHERE user_id = ? AND day_key = ?').get(ali.me.id, day);
    expect(raw).toEqual({ steps: 9000, source: 'health_connect' });
  });

  /** Ali's day, its status and the itirazlar on it, straight from the table. */
  function stepRow(h: TestApp, challengeId: string, userId: string) {
    return h.db
      .prepare('SELECT id, value, source, status, proof_url, answer_by FROM entries WHERE challenge_id = ? AND user_id = ?')
      .get(challengeId, userId) as { id: string; value: number; source: string; status: string; proof_url: string | null; answer_by: string | null };
  }

  /** Files an itiraz and lets the answer window run out unanswered. */
  async function throwOut(h: TestApp, by: RegisteredUser, challengeId: string, entryId: string): Promise<void> {
    const disputed = await authed(h.app, by.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${entryId}/dispute`,
      payload: { reason: 'otuz bin adım mı, yürü git' },
    });
    expect(disputed.statusCode).toBe(201);
    h.advance(LIMITS.DISPUTE_ANSWER_MS);
    expect(runSchedulerOnce(h.db, h.now()).disputes).toBe(1);
  }

  it('the phone brings back a typed step day friends threw out, and only the phone writes it after that', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await livePair(harness, 'adim_yarisi');
    const call = authed(harness.app, ali.token);
    const day = today(harness);

    const typed = await call({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: day, value: 30000, source: 'manual', clientTime: iso(harness) },
    });
    expect(typed.statusCode).toBe(201);
    await throwOut(harness, veli, challengeId, stepRow(harness, challengeId, ali.me.id).id);
    expect(stepRow(harness, challengeId, ali.me.id).status).toBe('rejected');

    // "pedometer" typed into a hand-made request is not the phone: it brings
    // nothing back, and must not leave a thrown-out "phone" row no sync restores
    const claimed = await call({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: day, value: 31000, source: 'pedometer', clientTime: iso(harness) },
    });
    expect(claimed.statusCode).toBe(200);
    expect(stepRow(harness, challengeId, ali.me.id)).toMatchObject({ value: 30000, source: 'manual', status: 'rejected' });

    // a lower honest number is still a number: the rejected row counted 0
    const synced = await call({ method: 'POST', url: '/me/steps', payload: { days: [{ dayKey: day, steps: 11800, source: 'pedometer' }] } });
    expect(synced.json<{ updated: number }>().updated).toBe(1);
    expect(stepRow(harness, challengeId, ali.me.id)).toMatchObject({
      value: 11800,
      source: 'pedometer',
      status: 'ok',
      proof_url: null,
      answer_by: null,
    });
    const detail = (await call({ method: 'GET', url: `/challenges/${challengeId}` })).json<ChallengeDetail>();
    expect(detail.participants.find((p) => p.user.id === ali.me.id)?.score).toBe(11800);
    // what Veli won stays won
    expect(computeUserStats(harness.db, veli.me.id, harness.now()).disputesWon).toBe(1);

    // typing the old number again would count now, and Veli could not object twice
    const again = await call({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: day, value: 30000, source: 'manual', clientTime: iso(harness) },
    });
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('day_rejected');
    expect(again.json<{ error: { message: string } }>().error.message).toContain('sadece telefonun saydığı adım');

    // the phone keeps raising it like any other day
    await call({ method: 'POST', url: '/me/steps', payload: { days: [{ dayKey: day, steps: 12500, source: 'pedometer' }] } });
    expect(stepRow(harness, challengeId, ali.me.id)).toMatchObject({ value: 12500, status: 'ok' });
  });

  it('a step reading friends threw out stays out, whatever the phone says next', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await livePair(harness, 'adim_yarisi');
    const call = authed(harness.app, ali.token);
    const day = today(harness);

    await call({ method: 'POST', url: '/me/steps', payload: { days: [{ dayKey: day, steps: 30000, source: 'pedometer' }] } });
    await throwOut(harness, veli, challengeId, stepRow(harness, challengeId, ali.me.id).id);

    const synced = await call({ method: 'POST', url: '/me/steps', payload: { days: [{ dayKey: day, steps: 31000, source: 'health_connect' }] } });
    expect(synced.json<{ updated: number }>().updated).toBe(0);
    expect(stepRow(harness, challengeId, ali.me.id)).toMatchObject({ value: 30000, source: 'pedometer', status: 'rejected' });

    // nor by hand, and the refusal does not promise a phone that never comes back
    const typed = await call({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: day, value: 12000, source: 'manual', clientTime: iso(harness) },
    });
    expect(typed.statusCode).toBe(409);
    expect(errorCode(typed)).toBe('day_rejected');
    const message = typed.json<{ error: { message: string } }>().error.message;
    expect(message).toContain('artık bir şey yazılmaz');
    expect(message).not.toContain('sadece telefonun');
  });

  it('a restored day drops the itirazlar closed on the old number and keeps the upheld one', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const veli = await registerUser(harness.app, 'veli');
    const can = await registerUser(harness.app, 'can');
    befriend(harness.app, ali.me.id, veli.me.id);
    befriend(harness.app, ali.me.id, can.me.id);
    const created = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/challenges',
      payload: { typeKey: 'adim_yarisi', startsAt: iso(harness), endsAt: iso(harness, 3 * DAY_MS), participantIds: [veli.me.id, can.me.id] },
    });
    const challengeId = created.json<Challenge>().id;
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    await authed(harness.app, can.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    const call = authed(harness.app, ali.token);
    const day = today(harness);

    await call({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: day, value: 30000, source: 'manual', clientTime: iso(harness) },
    });
    const entryId = stepRow(harness, challengeId, ali.me.id).id;
    // Can objects and takes it back; Veli's itiraz is the one that sticks
    const canCall = authed(harness.app, can.token);
    await canCall({ method: 'POST', url: `/challenges/${challengeId}/entries/${entryId}/dispute`, payload: { reason: 'emin değilim' } });
    expect((await canCall({ method: 'DELETE', url: `/challenges/${challengeId}/entries/${entryId}/dispute` })).statusCode).toBe(200);
    await throwOut(harness, veli, challengeId, entryId);

    await call({ method: 'POST', url: '/me/steps', payload: { days: [{ dayKey: day, steps: 11800, source: 'pedometer' }] } });
    const left = harness.db.prepare('SELECT by_user_id, status FROM disputes WHERE entry_id = ?').all(entryId);
    expect(left).toEqual([{ by_user_id: veli.me.id, status: 'upheld' }]);
    // the new number is Can's to question
    const fresh = await canCall({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${entryId}/dispute`,
      payload: { reason: 'bu da fazla' },
    });
    expect(fresh.statusCode).toBe(201);
  });

  it('a phone reading during the itiraz leaves the typed number to it, and takes its place once it is upheld', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await livePair(harness, 'adim_yarisi');
    const call = authed(harness.app, ali.token);
    const day = today(harness);

    await call({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: day, value: 8000, source: 'manual', clientTime: iso(harness) },
    });
    const entryId = stepRow(harness, challengeId, ali.me.id).id;
    const disputed = await authed(harness.app, veli.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${entryId}/dispute`,
      payload: { reason: 'sekiz bin mi' },
    });
    expect(disputed.statusCode).toBe(201);

    // the phone catches up an hour later: the typed row is the itiraz's, not the phone's
    harness.advance(60 * 60_000);
    await call({ method: 'POST', url: '/me/steps', payload: { days: [{ dayKey: day, steps: 9100, source: 'pedometer' }] } });
    expect(stepRow(harness, challengeId, ali.me.id)).toMatchObject({ value: 8000, source: 'manual', status: 'disputed' });

    // upheld: the typed number goes, the phone's reading already on the server counts
    harness.advance(LIMITS.DISPUTE_ANSWER_MS);
    expect(runSchedulerOnce(harness.db, harness.now()).disputes).toBe(1);
    expect(stepRow(harness, challengeId, ali.me.id)).toMatchObject({ value: 9100, source: 'pedometer', status: 'ok' });
    await call({ method: 'POST', url: '/me/steps', payload: { days: [{ dayKey: day, steps: 12000, source: 'pedometer' }] } });
    expect(stepRow(harness, challengeId, ali.me.id)).toMatchObject({ value: 12000, status: 'ok' });

    const typed = await call({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: day, value: 15000, source: 'manual', clientTime: iso(harness) },
    });
    expect(errorCode(typed)).toBe('day_rejected');
    expect(typed.json<{ error: { message: string } }>().error.message).toContain('sadece telefonun saydığı adım');
  });

  it('the friend who won the itiraz can question the phone reading that took the day back', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await livePair(harness, 'adim_yarisi');
    const call = authed(harness.app, ali.token);
    const day = today(harness);

    await call({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: day, value: 30000, source: 'manual', clientTime: iso(harness) },
    });
    const entryId = stepRow(harness, challengeId, ali.me.id).id;
    await throwOut(harness, veli, challengeId, entryId);
    expect(computeUserStats(harness.db, veli.me.id, harness.now()).disputesWon).toBe(1);

    // the "phone" says the same 30000
    await call({ method: 'POST', url: '/me/steps', payload: { days: [{ dayKey: day, steps: 30000, source: 'health_connect' }] } });
    expect(stepRow(harness, challengeId, ali.me.id)).toMatchObject({ value: 30000, status: 'ok' });

    const again = await authed(harness.app, veli.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${entryId}/dispute`,
      payload: { reason: 'telefon da yalan söylüyor' },
    });
    expect(again.statusCode).toBe(201);
    expect(stepRow(harness, challengeId, ali.me.id)).toMatchObject({ status: 'disputed' });
    // the first win still counts, and the day stays closed to typing meanwhile
    expect(computeUserStats(harness.db, veli.me.id, harness.now()).disputesWon).toBe(1);
    const typed = await call({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: day, value: 30000, source: 'manual', clientTime: iso(harness) },
    });
    expect(errorCode(typed)).toBe('day_rejected');

    // unanswered, the phone reading goes too, for good
    harness.advance(LIMITS.DISPUTE_ANSWER_MS);
    expect(runSchedulerOnce(harness.db, harness.now()).disputes).toBe(1);
    expect(stepRow(harness, challengeId, ali.me.id)).toMatchObject({ status: 'rejected', source: 'health_connect' });
    await call({ method: 'POST', url: '/me/steps', payload: { days: [{ dayKey: day, steps: 31000, source: 'health_connect' }] } });
    expect(stepRow(harness, challengeId, ali.me.id)).toMatchObject({ status: 'rejected' });
    expect(computeUserStats(harness.db, veli.me.id, harness.now()).disputesWon).toBe(1);
  });

  it('a step day thrown out after the end still gets the phone reading before the result', async () => {
    // 12:00 on 5 Jan to midnight on 8 Jan, Istanbul: the last day is over by the end
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await livePair(harness, 'adim_yarisi', { endsAt: '2026-01-07T21:00:00.000Z' });
    harness.advance(Date.parse('2026-01-07T19:00:00.000Z') - harness.now().getTime()); // 22:00 on the last day
    const day = today(harness);

    await authed(harness.app, ali.token)({ method: 'POST', url: '/me/steps', payload: { days: [{ dayKey: day, steps: 5000, source: 'pedometer' }] } });
    const veliCall = authed(harness.app, veli.token);
    await veliCall({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: day, value: 30000, source: 'manual', clientTime: iso(harness) },
    });
    await veliCall({ method: 'POST', url: '/me/steps', payload: { days: [{ dayKey: day, steps: 11800, source: 'pedometer' }] } });
    harness.advance(30 * 60_000);
    const veliRow = stepRow(harness, challengeId, veli.me.id);
    const disputed = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${veliRow.id}/dispute`,
      payload: { reason: 'otuz bin mi' },
    });
    expect(disputed.statusCode).toBe(201);

    // past the end and the phones' hour, the result waits for the answer window
    harness.advance(3 * 60 * 60_000);
    expect(runSchedulerOnce(harness.db, harness.now()).finalized).toBe(0);

    harness.advance(LIMITS.DISPUTE_ANSWER_MS);
    const pass = runSchedulerOnce(harness.db, harness.now());
    expect(pass).toMatchObject({ disputes: 1, finalized: 1 });
    const challenge = harness.db.prepare('SELECT status, winner_id FROM challenges WHERE id = ?').get(challengeId);
    expect(challenge).toEqual({ status: 'finished', winner_id: veli.me.id });
    expect(stepRow(harness, challengeId, veli.me.id)).toMatchObject({ value: 11800, source: 'pedometer', status: 'ok' });
  });

  it('a step day thrown out more than a week later still gets the phone reading, not a 0', async () => {
    // a 14-day race: Veli only gets round to day one's 30.000 on day ten
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await livePair(harness, 'adim_yarisi', {}, 14);
    const call = authed(harness.app, ali.token);
    const day = today(harness);

    await call({ method: 'POST', url: '/me/steps', payload: { days: [{ dayKey: day, steps: 9000, source: 'pedometer' }] } });
    await call({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: day, value: 30000, source: 'manual', clientTime: iso(harness) },
    });
    expect(stepRow(harness, challengeId, ali.me.id)).toMatchObject({ value: 30000, source: 'manual' });

    harness.advance(9 * DAY_MS);
    await throwOut(harness, veli, challengeId, stepRow(harness, challengeId, ali.me.id).id);
    expect(stepRow(harness, challengeId, ali.me.id)).toMatchObject({ value: 9000, source: 'pedometer', status: 'ok' });
    const detail = (await call({ method: 'GET', url: `/challenges/${challengeId}` })).json<ChallengeDetail>();
    expect(detail.participants.find((p) => p.user.id === ali.me.id)?.score).toBe(9000);

    // the day did not drop off: Ali hears both numbers
    const told = harness.db
      .prepare("SELECT title, body FROM notifications WHERE user_id = ? AND type = 'entry_rejected'")
      .all(ali.me.id);
    expect(told).toEqual([entryReplacedCopy(ali.me.vulgarityMax, detail.challenge.title, day, '30.000 adım', '9.000 adım')]);
  });

  it('a typed screen time thrown out after a week asleep comes back as the phone reading, not the missing-day penalty', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await livePair(harness, 'ekran_suresi_beyani', {}, 14);
    const call = authed(harness.app, ali.token);
    const day = today(harness);
    await call({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: day, value: 30, source: 'manual', proofUrl: '/uploads/x.jpg', clientTime: iso(harness) },
    });
    const entryId = stepRow(harness, challengeId, ali.me.id).id;
    const disputed = await authed(harness.app, veli.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${entryId}/dispute`,
      payload: { reason: 'yarım saat mi, hiç sanmam' },
    });
    expect(disputed.statusCode).toBe(201);
    // the phone reports the day meanwhile; the typed row stays the itiraz's
    await call({ method: 'POST', url: '/me/screen-time', payload: { days: [{ dayKey: day, minutes: 240 }] } });
    expect(stepRow(harness, challengeId, ali.me.id)).toMatchObject({ value: 30, source: 'manual', status: 'disputed' });

    // the owner's PC sleeps for eight days; Ali gets his hour after it wakes, then the itiraz holds
    const bootAt = new Date(harness.now().getTime() + 8 * DAY_MS);
    harness.setNow(bootAt);
    expect(runSchedulerOnce(harness.db, harness.now(), { bootAt })).toMatchObject({ disputes: 0 });
    harness.advance(LIMITS.DEVICE_SETTLE_MS + 60_000);
    expect(runSchedulerOnce(harness.db, harness.now(), { bootAt })).toMatchObject({ disputes: 1 });
    expect(stepRow(harness, challengeId, ali.me.id)).toMatchObject({ value: 240, source: 'usage_stats', status: 'ok' });
  });

  it('a typed screen time is always replaced by the phone reading (lower is better, the phone is honest)', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await livePair(harness, 'ekran_suresi_beyani');
    const call = authed(harness.app, ali.token);
    await call({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: today(harness), value: 30, source: 'manual', proofUrl: '/uploads/x.jpg', clientTime: iso(harness) },
    });
    await call({ method: 'POST', url: '/me/screen-time', payload: { days: [{ dayKey: today(harness), minutes: 240 }] } });
    const row = harness.db.prepare('SELECT value, source FROM entries WHERE challenge_id = ? AND user_id = ?').get(challengeId, ali.me.id) as { value: number; source: string };
    expect(row).toEqual({ value: 240, source: 'usage_stats' });
  });
});

describe('badges and faces a "Nazik" phone shows', () => {
  /** A one-day su_bardak çelınc `winner` wins over `loser`, finished by the scheduler. */
  async function win(h: TestApp, winner: RegisteredUser, loser: RegisteredUser): Promise<void> {
    const created = await authed(h.app, winner.token)({
      method: 'POST',
      url: '/challenges',
      payload: { typeKey: 'su_bardak', startsAt: iso(h), endsAt: iso(h, DAY_MS), participantIds: [loser.me.id] },
    });
    const challengeId = created.json<Challenge>().id;
    expect((await authed(h.app, loser.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` })).statusCode).toBe(200);
    await authed(h.app, winner.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { dayKey: today(h), value: 4, source: 'manual', clientTime: iso(h) },
    });
    h.advance(DAY_MS + 2 * 60_000);
    await h.app.inject({ method: 'POST', url: '/dev/advance' });
    expect(h.db.prepare('SELECT winner_id FROM challenges WHERE id = ?').get(challengeId)).toEqual({ winner_id: winner.me.id });
  }

  function badgeTitles(h: TestApp, userId: string): string[] {
    return (
      h.db.prepare("SELECT title FROM notifications WHERE user_id = ? AND type = 'badge' ORDER BY created_at").all(userId) as {
        title: string;
      }[]
    ).map((row) => row.title);
  }

  /** "Geldim" once a day for `days` days from the clock's current instant, every one on time. */
  async function checkInDaily(h: TestApp, user: RegisteredUser, challengeId: string, days: number): Promise<void> {
    for (let day = 0; day < days; day++) {
      if (day > 0) h.advance(DAY_MS);
      const checkin = await authed(h.app, user.token)({
        method: 'POST',
        url: `/challenges/${challengeId}/entries`,
        payload: { dayKey: today(h), value: 1, source: 'checkin', clientTime: iso(h) },
      });
      expect(checkin.statusCode).toBe(201);
      expect(checkin.json<{ entry: { value: number } }>().entry.value).toBe(1);
    }
  }

  it('names the first win at the winner\'s level: no 🍆 Saplamacı on a "Nazik" lock screen', async () => {
    harness = await makeApp({ now: NOW });
    const ayse = await registerUser(harness.app, 'ayse', { displayName: 'Ayşe', vulgarityMax: 1 });
    const mert = await registerUser(harness.app, 'mert', { displayName: 'Mert', vulgarityMax: 3 });
    befriend(harness.app, ayse.me.id, mert.me.id);

    await win(harness, ayse, mert);
    await win(harness, mert, ayse);

    const forAyse = badgeTitles(harness, ayse.me.id);
    expect(forAyse).toContain('🏆 Yeni rozet: İlk Zafer');
    expect(forAyse.join('\n')).not.toMatch(/🍆|apla/u);
    expect(badgeTitles(harness, mert.me.id)).toContain('🍆 Yeni rozet: Çırak Saplamacı');
    // only the words differ: both own the same stored badge
    for (const user of [ayse, mert]) {
      expect(harness.db.prepare("SELECT 1 FROM badges WHERE user_id = ? AND badge_key = 'koyus_1'").get(user.me.id)).toBeTruthy();
    }
  });

  it('starts only an "Ağır Abi" with the 🍆 face', async () => {
    harness = await makeApp({ now: NOW });
    const avatarOf = async (username: string, vulgarityMax?: 1 | 2 | 3) => {
      const response = await harness!.app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { username, password: 'sifre123', displayName: username, timezone: DEFAULT_TIMEZONE, vulgarityMax },
      });
      expect(response.statusCode).toBe(201);
      return response.json<{ me: Me }>().me.avatarEmoji;
    };

    for (const username of ['nazik_a', 'nazik_b', 'nazik_c']) expect(await avatarOf(username, 1)).not.toBe('🍆');
    expect(await avatarOf('delikanli', 2)).not.toBe('🍆');
    expect(await avatarOf('varsayilan')).not.toBe('🍆');
    expect(await avatarOf('agir_abi', 3)).toBe('🍆');
  });

  it('seven on-time Erken Yatma nights are not seven mornings', async () => {
    harness = await makeApp({ now: '2026-01-05T18:00:00.000Z' }); // 21:00 Istanbul
    const { ali, challengeId } = await livePair(harness, 'erken_yat', { deadlineTime: '23:00' }, 8);
    await checkInDaily(harness, ali, challengeId, 7);

    // every check-in already asks for badges; the seventh is where a Horoz used to land
    expect(computeUserStats(harness.db, ali.me.id, harness.now()).checkinsStreakMax).toBe(0);
    expect(getBadges(harness.db, ali.me.id)).not.toContain('erken_1');
    expect(badgeTitles(harness, ali.me.id).join('\n')).not.toContain('Horoz');
  });

  it('seven on-time Erken Kalkan mornings make a Horoz', async () => {
    harness = await makeApp({ now: '2026-01-05T03:00:00.000Z' }); // 06:00 Istanbul
    const { ali, challengeId } = await livePair(harness, 'erken_kus', { deadlineTime: '07:00' }, 8);
    await checkInDaily(harness, ali, challengeId, 7);

    expect(computeUserStats(harness.db, ali.me.id, harness.now()).checkinsStreakMax).toBe(7);
    expect(getBadges(harness.db, ali.me.id)).toContain('erken_1');
    expect(badgeTitles(harness, ali.me.id)).toContain('🐓 Yeni rozet: Horoz');
  });
});

describe('lower-is-better standings while the çelınc runs', () => {
  it('averages over the days that are over, not the whole week', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await livePair(harness, 'ekran_suresi_beyani', {}, 7);
    const call = authed(harness.app, ali.token);
    await call({ method: 'POST', url: '/me/screen-time', payload: { days: [{ dayKey: today(harness), minutes: 120 }] } });
    harness.advance(DAY_MS);
    await call({ method: 'POST', url: '/me/screen-time', payload: { days: [{ dayKey: today(harness), minutes: 60 }] } });
    const scoreOf = async (userId: string): Promise<number | undefined> => {
      const detail = await call({ method: 'GET', url: `/challenges/${challengeId}` });
      return detail.json<ChallengeDetail>().participants.find((p) => p.user.id === userId)?.score;
    };
    // day two: only day one is over, today's 60 so far waits for tomorrow
    expect(await scoreOf(ali.me.id)).toBe(120);
    harness.advance(DAY_MS);

    const detail = await call({ method: 'GET', url: `/challenges/${challengeId}` });
    const standings = detail.json<ChallengeDetail>().participants;
    const me = standings.find((p) => p.user.id === ali.me.id);
    const rival = standings.find((p) => p.user.id === veli.me.id);
    // two days over: Ali averages (120 + 60) / 2, Veli has two unreported days
    expect(me?.score).toBe(90);
    expect(rival?.score).toBe(1440);
    expect(me?.rank).toBe(1);
    expect(addDays(today(harness), -1)).not.toBe(today(harness));
  });
});

describe('appended entries are replay-safe', () => {
  it('the same manual_count sessionId twice writes one entry', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await livePair(harness, 'su_bardak');
    const call = authed(harness.app, ali.token);
    const payload = {
      dayKey: today(harness),
      value: 1,
      source: 'manual',
      clientTime: iso(harness),
      sessionId: '4b6c5f1e-7a35-4e5f-9a2b-1c3d5e7f9a0b',
    };
    const first = await call({ method: 'POST', url: `/challenges/${challengeId}/entries`, payload });
    expect(first.statusCode).toBe(201);
    const replay = await call({ method: 'POST', url: `/challenges/${challengeId}/entries`, payload });
    expect(replay.statusCode).toBe(200);
    const rows = harness.db.prepare('SELECT COUNT(*) AS n FROM entries WHERE challenge_id = ? AND user_id = ?').get(challengeId, ali.me.id) as { n: number };
    expect(rows.n).toBe(1);

    // a fresh id is a second glass
    const second = await call({
      method: 'POST',
      url: `/challenges/${challengeId}/entries`,
      payload: { ...payload, sessionId: '8f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f' },
    });
    expect(second.statusCode).toBe(201);
  });
});

describe('POST /uploads per-account cap', () => {
  const form = multipart({ filename: 'proof.jpg', contentType: 'image/jpeg', content: JPEG_WITH_GPS });

  it('stops the 61st photo in an hour and opens again once the window has passed', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const upload = () => authed(harness!.app, ali.token)({ method: 'POST', url: '/uploads', ...form });
    for (let i = 0; i < 60; i += 1) expect((await upload()).statusCode).toBe(201);
    const blocked = await upload();
    expect(blocked.statusCode).toBe(429);
    expect(errorCode(blocked)).toBe('upload_limit');

    harness.advance(61 * 60_000);
    expect((await upload()).statusCode).toBe(201);
  });
});

describe('proxy trust', () => {
  it('believes only a proxy on this machine by default, never everyone', () => {
    const previous = process.env.TRUST_PROXY;
    const load = () => loadConfig({ dataDir: ':memory:', jwtSecret: 'x' }).trustProxy;
    delete process.env.TRUST_PROXY;
    expect(load()).toBe('loopback');
    process.env.TRUST_PROXY = '1';
    expect(load()).toBe('loopback');
    process.env.TRUST_PROXY = '0';
    expect(load()).toBe(false);
    process.env.TRUST_PROXY = '10.0.0.0/8';
    expect(load()).toBe('10.0.0.0/8');
    if (previous === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previous;
  });
});
