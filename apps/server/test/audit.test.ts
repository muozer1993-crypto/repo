/**
 * Regression tests for the second review round — one `describe` per rule that
 * turned out to be missing or wrong on a real phone:
 * a proof-required yes/no çelınc nobody could mark, a "yattım" at 02:00 counting
 * as an early night, nudges to people who never joined, reminders telling a
 * player who logged that their score is zero, disputes after the whistle, a
 * blocked pair reaching each other, a rematch winner "avenging" a win (and the
 * picker never hearing of a real rövanş or a third win in a row), a rematch
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
} from '@koydum/shared';
import { loadConfig } from '../src/config.js';
import { runSchedulerOnce, sendNudges, sendReminders } from '../src/services/challenges.js';
import { computeUserStats } from '../src/services/stats.js';
import { sendTaunt } from '../src/services/taunts.js';
import type { ChallengeRow, UserRow } from '../src/db/index.js';
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

  it('a block also closes the dispute and accept doors', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const veli = await registerUser(harness.app, 'veli');
    const can = await registerUser(harness.app, 'can');
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

    const dispute = await authed(harness.app, veli.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${entryId}/dispute`,
      payload: { reason: 'inanmıyorum' },
    });
    expect(dispute.statusCode).toBe(403);
    expect(errorCode(dispute)).toBe('blocked');
    expect(notificationsOf(harness, ali.me.id, 'dispute')).toHaveLength(0);

    const accept = await authed(harness.app, can.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    expect(accept.statusCode).toBe(403);
    expect(errorCode(accept)).toBe('blocked');
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

describe('lower-is-better standings while the çelınc runs', () => {
  it('averages over the days that have started, not the whole week', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await livePair(harness, 'ekran_suresi_beyani', {}, 7);
    const call = authed(harness.app, ali.token);
    await call({ method: 'POST', url: '/me/screen-time', payload: { days: [{ dayKey: today(harness), minutes: 120 }] } });
    harness.advance(DAY_MS);
    await call({ method: 'POST', url: '/me/screen-time', payload: { days: [{ dayKey: today(harness), minutes: 60 }] } });

    const detail = await call({ method: 'GET', url: `/challenges/${challengeId}` });
    const standings = detail.json<ChallengeDetail>().participants;
    const me = standings.find((p) => p.user.id === ali.me.id);
    const rival = standings.find((p) => p.user.id === veli.me.id);
    // two days started: Ali averages (120 + 60) / 2, Veli has two unreported days
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
  const boundary = 'koydumaudit';
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="file"; filename="proof.jpg"',
    'Content-Type: image/jpeg',
    '',
    'x'.repeat(64),
    `--${boundary}--`,
    '',
  ].join('\r\n');

  it('stops the 61st photo in an hour and opens again once the window has passed', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const upload = () =>
      authed(harness!.app, ali.token)({
        method: 'POST',
        url: '/uploads',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });
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
