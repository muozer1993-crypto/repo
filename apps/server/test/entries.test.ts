/**
 * Entry validation per metric type (SPEC 2.3), deletion, the dispute threshold and
 * the owner's answer to it (a photo, or the disputer taking it back).
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TIMEZONE,
  LIMITS,
  addDays,
  todayKey,
  type ChallengeDetail,
  type Dispute,
  type Entry,
  type ParticipantView,
  type Challenge,
  type ChallengeSummary,
  type FeedPage,
} from '@koydum/shared';
import { newId } from '../src/db/index.js';
import { runSchedulerOnce } from '../src/services/challenges.js';
import { challengeFeed } from '../src/services/challengeViews.js';
import { getEntryRow } from '../src/services/entries.js';
import { recordPause } from '../src/services/pauses.js';
import { computeUserStats } from '../src/services/stats.js';
import { listByType } from '../src/services/notifications.js';
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

function today(h: TestApp): string {
  return todayKey(DEFAULT_TIMEZONE, h.now());
}

interface Ctx {
  ali: RegisteredUser;
  veli: RegisteredUser;
  challengeId: string;
}

/** Creator + one friend, both accepted, challenge live right now. */
async function liveChallenge(
  h: TestApp,
  typeKey: string,
  extra: Record<string, unknown> = {},
  durationDays = 3,
  suffix = '',
): Promise<Ctx> {
  const ali = await registerUser(h.app, `ali${suffix}`, { displayName: 'Ali' });
  const veli = await registerUser(h.app, `veli${suffix}`, { displayName: 'Veli' });
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
  const accepted = await authed(h.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
  expect(accepted.statusCode).toBe(200);
  return { ali, veli, challengeId };
}

/** `names[0]` creates a steps çelınc with the rest, all friends of theirs and all in. */
async function group(h: TestApp, names: string[]): Promise<{ players: RegisteredUser[]; challengeId: string }> {
  const players: RegisteredUser[] = [];
  for (const name of names) {
    players.push(await registerUser(h.app, name, { displayName: name.charAt(0).toUpperCase() + name.slice(1) }));
  }
  const [creator, ...friends] = players as [RegisteredUser, ...RegisteredUser[]];
  for (const friend of friends) befriend(h.app, creator.me.id, friend.me.id);
  const created = await authed(h.app, creator.token)({
    method: 'POST',
    url: '/challenges',
    payload: { typeKey: 'adim_yarisi', startsAt: iso(h), endsAt: iso(h, 3 * DAY_MS), participantIds: friends.map((f) => f.me.id) },
  });
  expect(created.statusCode).toBe(201);
  const challengeId = created.json<Challenge>().id;
  for (const friend of friends) {
    expect((await authed(h.app, friend.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` })).statusCode).toBe(200);
  }
  return { players, challengeId };
}

function post(h: TestApp, user: RegisteredUser, challengeId: string, payload: Record<string, unknown>) {
  return authed(h.app, user.token)({ method: 'POST', url: `/challenges/${challengeId}/entries`, payload });
}

function errorCode(response: { json: () => unknown }): string {
  return (response.json() as { error: { code: string } }).error.code;
}

// ---------------------------------------------------------------------------
// Common rules
// ---------------------------------------------------------------------------

describe('entry rules shared by every metric', () => {
  it('refuses non-participants and non-active challenges', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const veli = await registerUser(harness.app, 'veli');
    befriend(harness.app, ali.me.id, veli.me.id);

    const created = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/challenges',
      payload: {
        typeKey: 'adim_yarisi',
        startsAt: iso(harness, 2 * 60 * 60 * 1000),
        endsAt: iso(harness, 3 * DAY_MS),
        participantIds: [veli.me.id],
      },
    });
    const id = created.json<Challenge>().id;
    const body = { dayKey: today(harness), value: 100, source: 'pedometer', clientTime: iso(harness) };

    // Invited but not accepted.
    const invited = await post(harness, veli, id, body);
    expect(invited.statusCode).toBe(403);
    expect(errorCode(invited)).toBe('not_participant');

    // Accepted (the creator) but the challenge has not started.
    const early = await post(harness, ali, id, body);
    expect(early.statusCode).toBe(400);
    expect(errorCode(early)).toBe('challenge_not_active');
  });

  it('refuses days outside the window and in the future', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await liveChallenge(harness, 'adim_yarisi');

    const before = await post(harness, ali, challengeId, {
      dayKey: addDays(today(harness), -1),
      value: 100,
      source: 'pedometer',
      clientTime: iso(harness),
    });
    expect(before.statusCode).toBe(400);
    expect(errorCode(before)).toBe('day_out_of_range');

    const future = await post(harness, ali, challengeId, {
      dayKey: addDays(today(harness), 1),
      value: 100,
      source: 'pedometer',
      clientTime: iso(harness),
    });
    expect(future.statusCode).toBe(400);
    expect(errorCode(future)).toBe('day_in_future');
  });

  it('after the end takes the phone\'s late count of a finished day but no typed number', async () => {
    harness = await makeApp({ now: NOW });
    // runs to 12:00 tomorrow; the scheduler has not been by yet
    const steps = await liveChallenge(harness, 'adim_yarisi', {}, 1);
    const water = await liveChallenge(harness, 'su_bardak', {}, 1, '2');
    harness.advance(DAY_MS + 60_000);
    const lastDay = today(harness);
    const firstDay = addDays(lastDay, -1);

    const typed = await post(harness, steps.ali, steps.challengeId, {
      dayKey: lastDay,
      value: 9000,
      source: 'manual',
      clientTime: iso(harness),
    });
    expect(typed.statusCode).toBe(400);
    expect(errorCode(typed)).toBe('challenge_ended');
    expect((typed.json() as { error: { message: string } }).error.message).toContain('son adımlar');

    const counted = await post(harness, steps.ali, steps.challengeId, {
      dayKey: firstDay,
      value: 9000,
      source: 'pedometer',
      clientTime: iso(harness),
    });
    expect(counted.statusCode).toBe(201);

    // The end cut the last day in half at 12:00: its count now carries steps
    // walked after the whistle, so that day keeps what it had.
    const halfDay = await post(harness, steps.ali, steps.challengeId, {
      dayKey: lastDay,
      value: 9000,
      source: 'pedometer',
      clientTime: iso(harness),
    });
    expect(halfDay.statusCode).toBe(400);
    expect(errorCode(halfDay)).toBe('challenge_ended');

    const synced = await authed(harness.app, steps.veli.token)({
      method: 'POST',
      url: '/me/steps',
      payload: {
        days: [
          { dayKey: firstDay, steps: 8000, source: 'health_connect' },
          { dayKey: lastDay, steps: 11000, source: 'health_connect' },
        ],
      },
    });
    expect(synced.statusCode).toBe(200);
    expect(synced.json<{ updated: number }>().updated).toBe(1);
    const veliDays = harness.db
      .prepare('SELECT day_key, value FROM entries WHERE challenge_id = ? AND user_id = ?')
      .all(steps.challengeId, steps.veli.me.id);
    expect(veliDays).toEqual([{ day_key: firstDay, value: 8000 }]);

    // a typed çelınc has no phone to wait for, and takes nothing either
    const glass = await post(harness, water.ali, water.challengeId, {
      dayKey: lastDay,
      value: 1,
      source: 'manual',
      clientTime: iso(harness),
      sessionId: randomUUID(),
    });
    expect(glass.statusCode).toBe(400);
    expect(errorCode(glass)).toBe('challenge_ended');
  });

  it('allows 7 days of backfill for steps and only 2 for manual entries', async () => {
    harness = await makeApp({ now: NOW });
    const steps = await liveChallenge(harness, 'adim_yarisi', {}, 30, '_adim');
    const water = await liveChallenge(harness, 'su_bardak', {}, 30, '_su');
    harness.advance(10 * DAY_MS);
    const day = today(harness);

    const stepsOk = await post(harness, steps.ali, steps.challengeId, {
      dayKey: addDays(day, -7),
      value: 4000,
      source: 'pedometer',
      clientTime: iso(harness),
    });
    expect(stepsOk.statusCode).toBe(201);

    const stepsTooOld = await post(harness, steps.ali, steps.challengeId, {
      dayKey: addDays(day, -8),
      value: 4000,
      source: 'pedometer',
      clientTime: iso(harness),
    });
    expect(stepsTooOld.statusCode).toBe(400);
    expect(errorCode(stepsTooOld)).toBe('day_too_old');

    const manualOk = await post(harness, water.ali, water.challengeId, {
      dayKey: addDays(day, -2),
      value: 2,
      source: 'manual',
      clientTime: iso(harness),
    });
    expect(manualOk.statusCode).toBe(201);

    const manualTooOld = await post(harness, water.ali, water.challengeId, {
      dayKey: addDays(day, -3),
      value: 2,
      source: 'manual',
      clientTime: iso(harness),
    });
    expect(manualTooOld.statusCode).toBe(400);
    expect(errorCode(manualTooOld)).toBe('day_too_old');
  });
});

// ---------------------------------------------------------------------------
// auto_steps
// ---------------------------------------------------------------------------

describe('auto_steps entries', () => {
  it('upserts the day and returns fresh standings', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await liveChallenge(harness, 'adim_yarisi');
    const day = today(harness);

    const first = await post(harness, ali, challengeId, { dayKey: day, value: 4000, source: 'pedometer', clientTime: iso(harness) });
    expect(first.statusCode).toBe(201);
    const body = first.json<{ entry: Entry; standings: ParticipantView[] }>();
    expect(body.entry.value).toBe(4000);
    expect(body.entry.status).toBe('ok');
    expect(body.standings.find((p) => p.user.id === ali.me.id)?.score).toBe(4000);

    const second = await post(harness, ali, challengeId, { dayKey: day, value: 9000, source: 'health_connect', clientTime: iso(harness) });
    expect(second.statusCode).toBe(200);
    expect(second.json<{ entry: Entry }>().entry.id).toBe(body.entry.id);
    expect(second.json<{ standings: ParticipantView[] }>().standings.find((p) => p.user.id === ali.me.id)?.score).toBe(9000);

    // A manual declaration ("beyan") is allowed for steps.
    const beyan = await post(harness, veli, challengeId, { dayKey: day, value: 1200, source: 'manual', clientTime: iso(harness) });
    expect(beyan.statusCode).toBe(201);

    const rows = harness.db.prepare('SELECT COUNT(*) AS n FROM entries WHERE challenge_id = ?').get(challengeId) as { n: number };
    expect(rows.n).toBe(2);
  });

  it('rejects an impossible value and a wrong source', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await liveChallenge(harness, 'adim_yarisi');
    const day = today(harness);

    const tooBig = await post(harness, ali, challengeId, { dayKey: day, value: 100001, source: 'pedometer', clientTime: iso(harness) });
    expect(tooBig.statusCode).toBe(400);
    expect(errorCode(tooBig)).toBe('value_too_large');

    const wrongSource = await post(harness, ali, challengeId, { dayKey: day, value: 100, source: 'focus', clientTime: iso(harness) });
    expect(wrongSource.statusCode).toBe(400);
    expect(errorCode(wrongSource)).toBe('invalid_source');

    const negative = await post(harness, ali, challengeId, { dayKey: day, value: -1, source: 'pedometer', clientTime: iso(harness) });
    expect(negative.statusCode).toBe(400);
    expect(errorCode(negative)).toBe('validation');
  });
});

// ---------------------------------------------------------------------------
// focus_minutes
// ---------------------------------------------------------------------------

describe('focus_minutes entries', () => {
  it('appends sessions and is idempotent on sessionId', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await liveChallenge(harness, 'odak_seansi');
    const day = today(harness);
    const sessionId = randomUUID();

    const first = await post(harness, ali, challengeId, { dayKey: day, value: 25, source: 'focus', clientTime: iso(harness), sessionId });
    expect(first.statusCode).toBe(201);
    const entryId = first.json<{ entry: Entry }>().entry.id;

    const replay = await post(harness, ali, challengeId, { dayKey: day, value: 25, source: 'focus', clientTime: iso(harness), sessionId });
    expect(replay.statusCode).toBe(200);
    expect(replay.json<{ entry: Entry }>().entry.id).toBe(entryId);

    const another = await post(harness, ali, challengeId, {
      dayKey: day,
      value: 45,
      source: 'focus',
      clientTime: iso(harness),
      sessionId: randomUUID(),
    });
    expect(another.statusCode).toBe(201);
    expect(another.json<{ standings: ParticipantView[] }>().standings.find((p) => p.user.id === ali.me.id)?.score).toBe(70);
  });

  it('needs a session id, the focus source and a sane duration', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await liveChallenge(harness, 'odak_seansi');
    const day = today(harness);

    const noSession = await post(harness, ali, challengeId, { dayKey: day, value: 25, source: 'focus', clientTime: iso(harness) });
    expect(noSession.statusCode).toBe(400);
    expect(errorCode(noSession)).toBe('session_required');

    const wrongSource = await post(harness, ali, challengeId, {
      dayKey: day,
      value: 25,
      source: 'manual',
      clientTime: iso(harness),
      sessionId: randomUUID(),
    });
    expect(errorCode(wrongSource)).toBe('invalid_source');

    const tooLong = await post(harness, ali, challengeId, {
      dayKey: day,
      value: 200,
      source: 'focus',
      clientTime: iso(harness),
      sessionId: randomUUID(),
    });
    expect(errorCode(tooLong)).toBe('value_too_large');

    const empty = await post(harness, ali, challengeId, {
      dayKey: day,
      value: 0,
      source: 'focus',
      clientTime: iso(harness),
      sessionId: randomUUID(),
    });
    expect(errorCode(empty)).toBe('invalid_value');
  });

  /** One finished session of `value` minutes on today, under a fresh or given session id. */
  async function focusSession(h: TestApp, user: RegisteredUser, challengeId: string, value: number, sessionId = randomUUID()) {
    return post(h, user, challengeId, { dayKey: today(h), value, source: 'focus', clientTime: iso(h), sessionId });
  }

  it('stops at the catalog cap of 360 minutes a day', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await liveChallenge(harness, 'odak_seansi');

    expect((await focusSession(harness, ali, challengeId, 180)).statusCode).toBe(201);
    expect((await focusSession(harness, ali, challengeId, 180)).statusCode).toBe(201);
    const third = await focusSession(harness, ali, challengeId, 180);
    expect(third.statusCode).toBe(400);
    expect(errorCode(third)).toBe('daily_cap');
    expect((third.json() as { error: { message: string } }).error.message).toBe('Bugünlük odak tavanı doldu (360 dk). Yarın devam.');
    const total = harness.db
      .prepare('SELECT SUM(value) AS n FROM entries WHERE challenge_id = ? AND user_id = ?')
      .get(challengeId, ali.me.id) as { n: number };
    expect(total.n).toBe(360);

    // tomorrow is a new day
    harness.advance(DAY_MS);
    expect((await focusSession(harness, ali, challengeId, 45)).statusCode).toBe(201);
  });

  it('promises no tomorrow at the cap on the çelınc\'s last day', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await liveChallenge(harness, 'odak_seansi');
    // the morning of the last day; the çelınc ends at noon
    harness.advance(3 * DAY_MS - 2 * 60 * 60 * 1000);

    await focusSession(harness, ali, challengeId, 180);
    await focusSession(harness, ali, challengeId, 180);
    const third = await focusSession(harness, ali, challengeId, 30);
    expect(errorCode(third)).toBe('daily_cap');
    expect((third.json() as { error: { message: string } }).error.message).toBe('Bugünlük odak tavanı doldu (360 dk).');
  });

  it('cuts a session that runs past the cap down to what is left of the day', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await liveChallenge(harness, 'odak_seansi');

    // what an older app posts: two long sessions, the second one only partly fits
    expect((await focusSession(harness, ali, challengeId, 180)).statusCode).toBe(201);
    expect((await focusSession(harness, ali, challengeId, 120)).statusCode).toBe(201);
    const over = await focusSession(harness, ali, challengeId, 180);
    expect(over.statusCode).toBe(201);
    expect(over.json<{ entry: Entry }>().entry.value).toBe(60);
    expect(over.json<{ standings: ParticipantView[] }>().standings.find((p) => p.user.id === ali.me.id)?.score).toBe(360);

    // the older app shows "3 sa skoruna eklendi" whatever was stored: the inbox says what was
    const told = harness.db
      .prepare("SELECT title, body, data FROM notifications WHERE user_id = ? AND type = 'reminder'")
      .all(ali.me.id) as { title: string; body: string; data: string }[];
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({
      title: 'Odak tavanı doldu',
      body: '“Odak Seansı”: 180 dakikalık seansın 60 dakikası yazıldı. Günde en fazla 360 dakika sayılıyor.',
    });
    expect(JSON.parse(told[0]!.data)).toEqual({ challengeId, kind: 'focus_cap' });
  });

  it('still answers a replayed session after the cap with the row it wrote', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await liveChallenge(harness, 'odak_seansi');
    const sessionId = randomUUID();

    const first = await focusSession(harness, ali, challengeId, 180, sessionId);
    expect(first.statusCode).toBe(201);
    expect((await focusSession(harness, ali, challengeId, 180)).statusCode).toBe(201);

    // the offline queue sends the first session again after a lost answer
    const replay = await focusSession(harness, ali, challengeId, 180, sessionId);
    expect(replay.statusCode).toBe(200);
    expect(replay.json<{ entry: Entry }>().entry).toMatchObject({ id: first.json<{ entry: Entry }>().entry.id, value: 180 });
  });

  it('gives back the minutes of a session friends threw out', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await liveChallenge(harness, 'odak_seansi');

    const thrownOut = await focusSession(harness, ali, challengeId, 180);
    expect((await focusSession(harness, ali, challengeId, 180)).statusCode).toBe(201);
    expect((await focusSession(harness, ali, challengeId, 30)).statusCode).toBe(400);

    harness.db.prepare("UPDATE entries SET status = 'rejected' WHERE id = ?").run(thrownOut.json<{ entry: Entry }>().entry.id);
    const again = await focusSession(harness, ali, challengeId, 30);
    expect(again.statusCode).toBe(201);
    expect(again.json<{ entry: Entry }>().entry.value).toBe(30);
  });

  it('says so in the past tense for a session of an earlier day', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await liveChallenge(harness, 'odak_seansi');
    await focusSession(harness, ali, challengeId, 180);
    await focusSession(harness, ali, challengeId, 180);
    const day = today(harness);

    // a session parked on the phone last night, sent this morning
    harness.advance(DAY_MS);
    const late = await post(harness, ali, challengeId, { dayKey: day, value: 25, source: 'focus', clientTime: iso(harness), sessionId: randomUUID() });
    expect(late.statusCode).toBe(400);
    expect(errorCode(late)).toBe('daily_cap');
    expect((late.json() as { error: { message: string } }).error.message).toBe('O günün odak tavanı zaten dolmuştu (360 dk).');
  });
});

// ---------------------------------------------------------------------------
// checkin_deadline
// ---------------------------------------------------------------------------

describe('checkin_deadline entries', () => {
  it('scores 1 before the deadline in the user timezone', async () => {
    harness = await makeApp({ now: '2026-01-05T03:00:00.000Z' }); // 06:00 in Istanbul
    const { ali, challengeId } = await liveChallenge(harness, 'erken_kus', { deadlineTime: '07:00' });

    const response = await post(harness, ali, challengeId, {
      dayKey: today(harness),
      value: 1,
      source: 'checkin',
      clientTime: iso(harness),
    });
    expect(response.statusCode).toBe(201);
    const entry = response.json<{ entry: Entry }>().entry;
    expect(entry.value).toBe(1);
    expect(entry.late).toBeUndefined();
    expect(response.json<{ standings: ParticipantView[] }>().standings.find((p) => p.user.id === ali.me.id)?.score).toBe(1);
  });

  it('scores 0 and flags late after the deadline, once per day', async () => {
    harness = await makeApp({ now: NOW }); // 12:00 in Istanbul
    const { ali, challengeId } = await liveChallenge(harness, 'erken_kus', { deadlineTime: '07:00' });

    const late = await post(harness, ali, challengeId, {
      dayKey: today(harness),
      value: 1,
      source: 'checkin',
      clientTime: iso(harness),
    });
    expect(late.statusCode).toBe(201);
    expect(late.json<{ entry: Entry }>().entry.value).toBe(0);
    expect(late.json<{ entry: Entry }>().entry.late).toBe(true);
    // A late check-in scores nothing.
    expect(late.json<{ standings: ParticipantView[] }>().standings.find((p) => p.user.id === ali.me.id)?.score).toBe(0);

    const again = await post(harness, ali, challengeId, {
      dayKey: today(harness),
      value: 1,
      source: 'checkin',
      clientTime: iso(harness),
    });
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('already_checked_in');
  });

  it("judges a stored deadline outside the type's window by the type default, and reports that one", async () => {
    harness = await makeApp({ now: '2026-01-05T19:30:00.000Z' }); // 22:30 in Istanbul
    const { ali, challengeId } = await liveChallenge(harness, 'erken_yat', { deadlineTime: '23:30' });
    // a row written before the window was checked: with 00:00 every evening check-in was late
    harness.db.prepare("UPDATE challenges SET deadline_time = '00:00' WHERE id = ?").run(challengeId);

    const response = await post(harness, ali, challengeId, {
      dayKey: today(harness),
      value: 1,
      source: 'checkin',
      clientTime: iso(harness),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json<{ entry: Entry }>().entry.value).toBe(1);
    expect(response.json<{ entry: Entry }>().entry.late).toBeUndefined();

    // the detail screen and the phone's reminder read the deadline that is enforced
    const detail = await authed(harness.app, ali.token)({ method: 'GET', url: `/challenges/${challengeId}` });
    expect(detail.json<ChallengeDetail>().challenge.deadlineTime).toBe('23:00');
  });

  it('says when the check-in window opens without a suffix after the time', async () => {
    harness = await makeApp({ now: NOW }); // 12:00 in Istanbul
    const { ali, challengeId } = await liveChallenge(harness, 'erken_yat', { deadlineTime: '23:00' });

    const early = await post(harness, ali, challengeId, {
      dayKey: today(harness),
      value: 1,
      source: 'checkin',
      clientTime: iso(harness),
    });
    expect(early.statusCode).toBe(400);
    // "19:00'den" was wrong: on dokuzdan
    expect((early.json() as { error: { message: string } }).error.message).toBe(
      'Bu check-in saat 19:00 olmadan sayılmıyor. Biraz erken geldin.',
    );
  });

  it('only accepts today and only the checkin source', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await liveChallenge(harness, 'erken_kus', { deadlineTime: '23:00' });
    const startDay = today(harness);

    const wrongSource = await post(harness, ali, challengeId, {
      dayKey: startDay,
      value: 1,
      source: 'manual',
      clientTime: iso(harness),
    });
    expect(errorCode(wrongSource)).toBe('invalid_source');

    harness.advance(DAY_MS);
    const yesterday = await post(harness, ali, challengeId, {
      dayKey: startDay,
      value: 1,
      source: 'checkin',
      clientTime: iso(harness),
    });
    expect(yesterday.statusCode).toBe(400);
    expect(errorCode(yesterday)).toBe('checkin_today_only');
  });

  describe('tapped while the server was off', () => {
    // Erken Yatma Sözü, 23:30. The owner's PC slept from 23:00 to 08:00 Istanbul
    // time; the phone parked "Geldim" and sends it at 08:30 the next morning.
    const SLEPT = '2026-01-05T20:00:00.000Z'; // 23:00
    const WOKE = '2026-01-06T05:00:00.000Z'; // 08:00
    const SENT = '2026-01-06T05:30:00.000Z'; // 08:30
    const NIGHT = '2026-01-05';

    /** The last `parkedCheckin`'s çelınc and players. */
    let parked: Ctx | null = null;

    async function parkedCheckin(clientTime: string, options: { slept?: [string, string] | null; sentAt?: string } = {}) {
      harness = await makeApp({ now: NOW });
      parked = await liveChallenge(harness, 'erken_yat', { deadlineTime: '23:30' });
      const { ali, challengeId } = parked;
      const slept = options.slept === undefined ? [SLEPT, WOKE] : options.slept;
      if (slept) recordPause(harness.db, new Date(slept[0]), new Date(slept[1]));
      harness.setNow(options.sentAt ?? SENT);
      return post(harness, ali, challengeId, { dayKey: NIGHT, value: 1, source: 'checkin', clientTime });
    }

    it('counts a tap before the deadline on time, the morning after', async () => {
      const response = await parkedCheckin('2026-01-05T20:10:00.000Z'); // 23:10
      expect(response.statusCode).toBe(201);
      expect(response.json<{ entry: Entry }>().entry).toMatchObject({ dayKey: NIGHT, value: 1 });
      expect(response.json<{ entry: Entry }>().entry.late).toBeUndefined();
    });

    it('counts a tap inside the pause but past the deadline late', async () => {
      const response = await parkedCheckin('2026-01-05T20:40:00.000Z'); // 23:40
      expect(response.statusCode).toBe(201);
      expect(response.json<{ entry: Entry }>().entry).toMatchObject({ value: 0, late: true });
    });

    it('gives nothing to a time from before the server went away: it was up to hear it', async () => {
      const response = await parkedCheckin('2026-01-05T19:00:00.000Z'); // 22:00
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe('checkin_today_only');
    });

    it('judges by its own clock when it never stopped', async () => {
      const response = await parkedCheckin('2026-01-05T20:10:00.000Z', { slept: null });
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe('checkin_today_only');
    });

    it('stops vouching for the pause twelve hours after it woke', async () => {
      const response = await parkedCheckin('2026-01-05T20:10:00.000Z', { sentAt: '2026-01-06T17:01:00.000Z' });
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe('checkin_today_only');
    });

    it('saves a tap that reached it the same evening past the deadline, whatever offset the phone wrote', async () => {
      // asleep from 23:00 to 23:45, sent at 23:50
      const response = await parkedCheckin('2026-01-05T23:10:00+03:00', {
        slept: [SLEPT, '2026-01-05T20:45:00.000Z'],
        sentAt: '2026-01-05T20:50:00.000Z',
      });
      expect(response.statusCode).toBe(201);
      expect(response.json<{ entry: Entry }>().entry.value).toBe(1);
    });

    it("stamps it with its night, so the phones do not take it for the morning's check-in", async () => {
      const response = await parkedCheckin('2026-01-05T20:10:00.000Z'); // 23:10
      expect(response.json<{ entry: Entry }>().entry.createdAt).toBe('2026-01-05T20:10:00.000Z');
      // "done today" on the phones (and their evening reminder) reads the latest of these
      const [summary] = (
        await authed(harness!.app, parked!.ali.token)({ method: 'GET', url: '/challenges' })
      ).json<ChallengeSummary[]>();
      expect(summary?.me?.lastEntryAt).toBe('2026-01-05T20:10:00.000Z');
    });

    it('counts Friday night after a weekend with the lid shut: the age of the day is judged at the tap too', async () => {
      // asleep from 23:00 until three mornings later, sent half an hour after it woke
      const response = await parkedCheckin('2026-01-05T20:10:00.000Z', {
        slept: [SLEPT, '2026-01-08T05:00:00.000Z'],
        sentAt: '2026-01-08T05:30:00.000Z',
      });
      expect(response.statusCode).toBe(201);
      expect(response.json<{ entry: Entry }>().entry).toMatchObject({ dayKey: NIGHT, value: 1 });
    });

    it('answers a check-in it already counted as counted, the morning after too', async () => {
      // the first send landed at 23:10 and its answer was lost; the queue sends it again at 08:30
      harness = await makeApp({ now: '2026-01-05T20:10:00.000Z' });
      const { ali, challengeId } = await liveChallenge(harness, 'erken_yat', { deadlineTime: '23:30' });
      const body = { dayKey: NIGHT, value: 1, source: 'checkin', clientTime: iso(harness) };
      expect((await post(harness, ali, challengeId, body)).statusCode).toBe(201);
      harness.setNow(SENT);
      const replay = await post(harness, ali, challengeId, body);
      expect(replay.statusCode).toBe(409);
      expect(errorCode(replay)).toBe('already_checked_in');
      expect((replay.json() as { error: { message: string } }).error.message).toBe('O gün zaten check-in yapmıştın.');
    });

    it('takes the arrival when it is in time anyway, never a tap that would put it out', async () => {
      // tapped at 18:30 while asleep, before the window opens; sent at 23:20, in time
      const response = await parkedCheckin('2026-01-05T15:30:00.000Z', {
        slept: ['2026-01-05T15:00:00.000Z', '2026-01-05T20:15:00.000Z'],
        sentAt: '2026-01-05T20:20:00.000Z',
      });
      expect(response.statusCode).toBe(201);
      expect(response.json<{ entry: Entry }>().entry.value).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// daily_boolean / manual_count / manual_lower_is_better
// ---------------------------------------------------------------------------

describe('daily_boolean entries', () => {
  it('accepts 0 or 1 and upserts the day', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await liveChallenge(harness, 'sekersiz_gun');
    const day = today(harness);

    const yes = await post(harness, ali, challengeId, { dayKey: day, value: 1, source: 'manual', clientTime: iso(harness) });
    expect(yes.statusCode).toBe(201);
    expect(yes.json<{ standings: ParticipantView[] }>().standings.find((p) => p.user.id === ali.me.id)?.score).toBe(1);

    const no = await post(harness, ali, challengeId, { dayKey: day, value: 0, source: 'manual', clientTime: iso(harness) });
    expect(no.statusCode).toBe(200);
    expect(no.json<{ standings: ParticipantView[] }>().standings.find((p) => p.user.id === ali.me.id)?.score).toBe(0);

    const half = await post(harness, ali, challengeId, { dayKey: day, value: 0.5, source: 'manual', clientTime: iso(harness) });
    expect(half.statusCode).toBe(400);
    expect(errorCode(half)).toBe('invalid_value');

    const two = await post(harness, ali, challengeId, { dayKey: day, value: 2, source: 'manual', clientTime: iso(harness) });
    expect(errorCode(two)).toBe('value_too_large');
  });
});

describe('manual_count entries', () => {
  it('appends and enforces the daily cap', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await liveChallenge(harness, 'su_bardak'); // max 10 per entry, 30 per day
    const day = today(harness);

    let last = await post(harness, ali, challengeId, { dayKey: day, value: 10, source: 'manual', clientTime: iso(harness) });
    for (let i = 0; i < 2; i++) {
      expect(last.statusCode).toBe(201);
      last = await post(harness, ali, challengeId, { dayKey: day, value: 10, source: 'manual', clientTime: iso(harness) });
    }
    expect(last.statusCode).toBe(201);
    expect(last.json<{ standings: ParticipantView[] }>().standings.find((p) => p.user.id === ali.me.id)?.score).toBe(30);

    const overCap = await post(harness, ali, challengeId, { dayKey: day, value: 1, source: 'manual', clientTime: iso(harness) });
    expect(overCap.statusCode).toBe(400);
    expect(errorCode(overCap)).toBe('daily_cap');

    const perEntry = await post(harness, ali, challengeId, {
      dayKey: addDays(day, 0),
      value: 11,
      source: 'manual',
      clientTime: iso(harness),
    });
    expect(errorCode(perEntry)).toBe('value_too_large');
  });
});

describe('manual_lower_is_better entries', () => {
  it('needs proof, upserts the day and ranks the smallest score first', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await liveChallenge(harness, 'ekran_suresi_beyani'); // proofRequired in the catalog
    const day = today(harness);

    const noProof = await post(harness, ali, challengeId, { dayKey: day, value: 200, source: 'manual', clientTime: iso(harness) });
    expect(noProof.statusCode).toBe(400);
    expect(errorCode(noProof)).toBe('proof_required');

    const withProof = await post(harness, ali, challengeId, {
      dayKey: day,
      value: 200,
      source: 'manual',
      clientTime: iso(harness),
      proofUrl: 'https://test.local/uploads/a.jpg',
    });
    expect(withProof.statusCode).toBe(201);

    const corrected = await post(harness, ali, challengeId, {
      dayKey: day,
      value: 120,
      source: 'manual',
      clientTime: iso(harness),
      proofUrl: 'https://test.local/uploads/b.jpg',
    });
    expect(corrected.statusCode).toBe(200);
    expect(corrected.json<{ entry: Entry }>().entry.value).toBe(120);

    const rival = await post(harness, veli, challengeId, {
      dayKey: day,
      value: 600,
      source: 'manual',
      clientTime: iso(harness),
      proofUrl: 'https://test.local/uploads/c.jpg',
    });
    // Both are missing the same two days, so the ordering is decided by the reported value.
    const standings = rival.json<{ standings: ParticipantView[] }>().standings;
    expect(standings[0].user.id).toBe(ali.me.id);
    expect(standings[0].rank).toBe(1);

    const tooBig = await post(harness, ali, challengeId, {
      dayKey: day,
      value: 2000,
      source: 'manual',
      clientTime: iso(harness),
      proofUrl: 'https://test.local/uploads/d.jpg',
    });
    expect(errorCode(tooBig)).toBe('value_too_large');
  });
});

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

describe('DELETE /challenges/:id/entries/:entryId', () => {
  it('deletes my own manual entry only', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await liveChallenge(harness, 'su_bardak');
    const day = today(harness);

    const created = await post(harness, ali, challengeId, { dayKey: day, value: 5, source: 'manual', clientTime: iso(harness) });
    const entryId = created.json<{ entry: Entry }>().entry.id;

    const notMine = await authed(harness.app, veli.token)({
      method: 'DELETE',
      url: `/challenges/${challengeId}/entries/${entryId}`,
    });
    expect(notMine.statusCode).toBe(403);
    expect(errorCode(notMine)).toBe('not_your_entry');

    const removed = await authed(harness.app, ali.token)({
      method: 'DELETE',
      url: `/challenges/${challengeId}/entries/${entryId}`,
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json<{ standings: ParticipantView[] }>().standings.find((p) => p.user.id === ali.me.id)?.score).toBe(0);

    const gone = await authed(harness.app, ali.token)({
      method: 'DELETE',
      url: `/challenges/${challengeId}/entries/${entryId}`,
    });
    expect(gone.statusCode).toBe(404);
  });

  it('refuses to delete an automatic entry', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await liveChallenge(harness, 'erken_kus', { deadlineTime: '23:00' });
    const created = await post(harness, ali, challengeId, {
      dayKey: today(harness),
      value: 1,
      source: 'checkin',
      clientTime: iso(harness),
    });
    const entryId = created.json<{ entry: Entry }>().entry.id;

    const response = await authed(harness.app, ali.token)({
      method: 'DELETE',
      url: `/challenges/${challengeId}/entries/${entryId}`,
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('not_deletable');
  });
});

// ---------------------------------------------------------------------------
// Disputes
// ---------------------------------------------------------------------------

describe('POST /challenges/:id/entries/:entryId/dispute', () => {
  it('head to head one itiraz puts the entry on the clock, and it keeps counting until then', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await liveChallenge(harness, 'adim_yarisi');
    const day = today(harness);

    const created = await post(harness, ali, challengeId, { dayKey: day, value: 60000, source: 'manual', clientTime: iso(harness) });
    const entryId = created.json<{ entry: Entry }>().entry.id;

    const own = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${entryId}/dispute`,
      payload: { reason: 'kendime itiraz' },
    });
    expect(own.statusCode).toBe(403);
    expect(errorCode(own)).toBe('own_entry');

    const disputed = await authed(harness.app, veli.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${entryId}/dispute`,
      payload: { reason: 'telefonu köpeğe bağlamış' },
    });
    expect(disputed.statusCode).toBe(201);
    const outcome = disputed.json<{ answerBy: string | null; entry: Entry; dispute: Dispute; standings: ParticipantView[] }>();
    // the one rival is the majority, but a tap is not a verdict: the owner gets the hours to answer
    expect(outcome.entry.status).toBe('disputed');
    expect(outcome.dispute.status).toBe('open');
    expect(outcome.answerBy).toBe(iso(harness, LIMITS.DISPUTE_ANSWER_MS));
    expect(outcome.standings.find((p) => p.user.id === ali.me.id)?.score).toBe(60000);

    expect(listByType(harness.db, ali.me.id, 'entry_rejected')).toHaveLength(0);
    const [warning] = listByType(harness.db, ali.me.id, 'dispute');
    expect(warning?.body).toContain('12 saat içinde fotoğraf ekle, yoksa bu giriş yanar');
    expect(computeUserStats(harness.db, veli.me.id, harness.now()).disputesWon).toBe(0);

    // everybody reads the reason and the deadline on the feed
    const detail = (await authed(harness.app, ali.token)({ method: 'GET', url: `/challenges/${challengeId}` })).json<ChallengeDetail>();
    expect(detail.disputes).toEqual([expect.objectContaining({ entryId, byUserId: veli.me.id, reason: 'telefonu köpeğe bağlamış', status: 'open' })]);
    expect(detail.feed.find((item) => item.id === entryId)).toMatchObject({ status: 'disputed', answerBy: outcome.answerBy });

    const again = await authed(harness.app, veli.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${entryId}/dispute`,
      payload: { reason: 'yine' },
    });
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('already_disputed');
  });

  it('needs a majority of the other players when there are four, and the clock starts at the majority', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const veli = await registerUser(harness.app, 'veli');
    const ayse = await registerUser(harness.app, 'ayse');
    const mert = await registerUser(harness.app, 'mert');
    for (const friend of [veli, ayse, mert]) befriend(harness.app, ali.me.id, friend.me.id);

    const created = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/challenges',
      payload: {
        typeKey: 'adim_yarisi',
        startsAt: iso(harness),
        endsAt: iso(harness, 3 * DAY_MS),
        participantIds: [veli.me.id, ayse.me.id, mert.me.id],
      },
    });
    const challengeId = created.json<Challenge>().id;
    for (const friend of [veli, ayse, mert]) {
      await authed(harness.app, friend.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    }

    const entry = await post(harness, ali, challengeId, {
      dayKey: today(harness),
      value: 55000,
      source: 'manual',
      clientTime: iso(harness),
    });
    const entryId = entry.json<{ entry: Entry }>().entry.id;

    // 4 accepted → threshold = ceil(3 / 2) = 2.
    const first = await authed(harness.app, veli.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${entryId}/dispute`,
      payload: { reason: 'olmaz böyle bir şey' },
    });
    expect(first.statusCode).toBe(201);
    const afterFirst = first.json<{ answerBy: string | null; othersCalled: number; entry: Entry; standings: ParticipantView[] }>();
    expect(afterFirst.answerBy).toBeNull();
    // Ayşe and Mert, the players who are neither the owner nor the disputer, are called
    expect(afterFirst.othersCalled).toBe(2);
    expect(afterFirst.entry.status).toBe('disputed');
    // A pending dispute must not zero the rival out yet (SPEC 1.3).
    expect(afterFirst.standings.find((p) => p.user.id === ali.me.id)?.score).toBe(55000);
    expect(listByType(harness.db, ali.me.id, 'dispute')).toHaveLength(1);
    expect(listByType(harness.db, ali.me.id, 'dispute')[0]?.body).not.toContain('12 saat');

    const duplicate = await authed(harness.app, veli.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${entryId}/dispute`,
      payload: { reason: 'tekrar' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(errorCode(duplicate)).toBe('already_disputed');

    harness.advance(3 * 60 * 60 * 1000);
    const second = await authed(harness.app, ayse.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${entryId}/dispute`,
      payload: { reason: 'ben de görmedim' },
    });
    expect(second.statusCode).toBe(201);
    const afterSecond = second.json<{ answerBy: string | null; othersCalled: number; entry: Entry; standings: ParticipantView[] }>();
    // the second itiraz starts the clock and calls nobody
    expect(afterSecond.othersCalled).toBe(0);
    // the full window runs from the second itiraz, not from the first one three hours ago
    expect(afterSecond.answerBy).toBe(iso(harness, LIMITS.DISPUTE_ANSWER_MS));
    expect(afterSecond.entry.status).toBe('disputed');
    expect(afterSecond.standings.find((p) => p.user.id === ali.me.id)?.score).toBe(55000);

    const warnings = listByType(harness.db, ali.me.id, 'dispute');
    expect(warnings).toHaveLength(2);
    expect(warnings.some((row) => row.body.includes('12 saat içinde'))).toBe(true);
    expect(computeUserStats(harness.db, veli.me.id, harness.now()).disputesWon).toBe(0);
    expect(listByType(harness.db, ali.me.id, 'entry_rejected')).toHaveLength(0);
  });

  it('keeps a running clock when the disputed player brings in a friend who had no say', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const veli = await registerUser(harness.app, 'veli');
    const cem = await registerUser(harness.app, 'cem');
    const eda = await registerUser(harness.app, 'eda');
    for (const friend of [veli, cem, eda]) befriend(harness.app, ali.me.id, friend.me.id);

    const created = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/challenges',
      payload: { typeKey: 'adim_yarisi', startsAt: iso(harness), endsAt: iso(harness, 3 * DAY_MS), participantIds: [veli.me.id, cem.me.id] },
    });
    const challengeId = created.json<Challenge>().id;
    for (const friend of [veli, cem]) {
      await authed(harness.app, friend.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    }
    const entry = await post(harness, ali, challengeId, { dayKey: today(harness), value: 50000, source: 'manual', clientTime: iso(harness) });
    const entryId = entry.json<{ entry: Entry }>().entry.id;

    // 3 accepted: Veli alone is the majority and the 12 hours start
    const disputed = await authed(harness.app, veli.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${entryId}/dispute`,
      payload: { reason: 'elli bin mi' },
    });
    const answerBy = disputed.json<{ answerBy: string | null }>().answerBy;
    expect(answerBy).toBe(iso(harness, LIMITS.DISPUTE_ANSWER_MS));
    // one vote is the majority here, so nobody else is called to it
    expect(listByType(harness.db, cem.me.id, 'dispute')).toHaveLength(0);

    // Ali adds Eda; with 4 in, a new itiraz would need 2, but this one already started
    harness.advance(60_000);
    const invited = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/invite`,
      payload: { userIds: [eda.me.id] },
    });
    expect(invited.statusCode).toBe(200);
    expect((await authed(harness.app, eda.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` })).statusCode).toBe(200);
    runSchedulerOnce(harness.db, harness.now());
    expect(getEntryRow(harness.db, entryId)?.answer_by).toBe(answerBy);

    harness.advance(LIMITS.DISPUTE_ANSWER_MS);
    expect(runSchedulerOnce(harness.db, harness.now()).disputes).toBe(1);
    expect(getEntryRow(harness.db, entryId)?.status).toBe('rejected');
  });

  it('keeps a disputed entry in the feed however many came after it', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await liveChallenge(harness, 'su_bardak');
    const older = await post(harness, ali, challengeId, { dayKey: today(harness), value: 3, source: 'manual', clientTime: iso(harness) });
    const olderId = older.json<{ entry: Entry }>().entry.id;
    harness.advance(60_000);
    await post(harness, veli, challengeId, { dayKey: today(harness), value: 2, source: 'manual', clientTime: iso(harness) });
    await authed(harness.app, veli.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${olderId}/dispute`,
      payload: { reason: 'üç bardak mı, hadi oradan' },
    });

    // a feed of one still carries the row that has to be answered
    const feed = challengeFeed(harness.db, challengeId, 1);
    expect(feed.map((item) => item.id)).toContain(olderId);
    expect(feed).toHaveLength(2);
  });

  it('calls the other players of a big çelınc to the first itiraz, once, and the feed counts the votes', async () => {
    harness = await makeApp({ now: NOW });
    const { players, challengeId } = await group(harness, ['ali', 'veli', 'ayse', 'mert', 'cem', 'eda', 'can', 'naz', 'ece', 'efe']);
    const [ali, veli, ayse, mert, ...rest] = players as [RegisteredUser, RegisteredUser, RegisteredUser, RegisteredUser, ...RegisteredUser[]];
    harness.db.prepare('UPDATE users SET vulgarity_max = 1 WHERE id = ?').run(ayse.me.id);
    harness.db.prepare('UPDATE users SET vulgarity_max = 3 WHERE id = ?').run(mert.me.id);
    const created = await post(harness, ali, challengeId, { dayKey: today(harness), value: 60000, source: 'manual', clientTime: iso(harness) });
    const entryId = created.json<{ entry: Entry }>().entry.id;
    const url = `/challenges/${challengeId}/entries/${entryId}/dispute`;
    const calls = (user: RegisteredUser) =>
      listByType(harness!.db, user.me.id, 'dispute').filter((row) => (JSON.parse(row.data) as { kind?: string }).kind === 'call');

    // 10 in: a majority of the other nine is 5, and one itiraz starts nothing
    const first = await authed(harness.app, veli.token)({ method: 'POST', url, payload: { reason: 'altmış bin mi' } });
    expect(first.statusCode).toBe(201);
    expect(first.json<{ answerBy: string | null }>().answerBy).toBeNull();

    // the eight others hear of it; the owner and the disputer have their own copy or none
    for (const other of [ayse, mert, ...rest]) expect(calls(other)).toHaveLength(1);
    expect(calls(ali)).toHaveLength(0);
    expect(listByType(harness.db, ali.me.id, 'dispute')).toHaveLength(1);
    expect(listByType(harness.db, veli.me.id, 'dispute')).toHaveLength(0);
    const [call] = calls(rest[0]!);
    expect(JSON.parse(call!.data)).toEqual({ challengeId, entryId, kind: 'call' });
    expect(call?.title).toBe('İtiraz var, sen de bak');
    expect(call?.body).toContain('Veli, "');
    expect(call?.body).toContain('Ali · ');
    expect(call?.body).toContain(' · 60.000 adım. Yalan diyenler 5 kişiyi bulursa 12 saat içinde kanıt lazım');
    expect(calls(ayse)[0]?.title).toBe('Bir girişe itiraz var');
    expect(calls(ayse)[0]?.body).toContain('İtiraz edenler 5 kişiyi bulursa sahibinin 12 saat içinde kanıt eklemesi gerekir');
    expect(calls(mert)[0]?.title).toBe('Biri sallıyor olabilir 🍆');

    const feedRow = async () =>
      (await authed(harness!.app, mert.token)({ method: 'GET', url: `/challenges/${challengeId}` }))
        .json<ChallengeDetail>()
        .feed.find((item) => item.id === entryId);
    expect(await feedRow()).toMatchObject({ status: 'disputed', answerBy: null, disputeVotes: { open: 1, needed: 5 } });

    // a second itiraz rings nobody again
    await authed(harness.app, ayse.token)({ method: 'POST', url, payload: { reason: 'bence de' } });
    expect(await feedRow()).toMatchObject({ disputeVotes: { open: 2, needed: 5 } });
    // both taken back and the entry is clean, but a third friend's itiraz is not a first one
    await authed(harness.app, veli.token)({ method: 'DELETE', url });
    await authed(harness.app, ayse.token)({ method: 'DELETE', url });
    expect(await feedRow()).toMatchObject({ status: 'ok', disputeVotes: null });
    const refiled = await authed(harness.app, veli.token)({ method: 'POST', url, payload: { reason: 'yine de' } });
    expect(refiled.statusCode).toBe(409);
    expect((await authed(harness.app, mert.token)({ method: 'POST', url, payload: { reason: 'ben de' } })).statusCode).toBe(201);
    for (const other of [ayse, ...rest]) expect(calls(other)).toHaveLength(1);
    expect(calls(veli)).toHaveLength(0);
    expect(calls(mert)).toHaveLength(1);

    // five make the majority: the clock starts and the count gives way to it
    for (const friend of rest.slice(0, 4)) {
      await authed(harness.app, friend.token)({ method: 'POST', url, payload: { reason: 'olmaz' } });
    }
    expect(await feedRow()).toMatchObject({ answerBy: iso(harness, LIMITS.DISPUTE_ANSWER_MS), disputeVotes: null });
  });

  it('calls nobody across a block, and nobody to an entry of somebody who left', async () => {
    harness = await makeApp({ now: NOW });
    const { players, challengeId } = await group(harness, ['ali', 'veli', 'ayse', 'mert', 'cem']);
    const [ali, veli, ayse, mert, cem] = players as [RegisteredUser, RegisteredUser, RegisteredUser, RegisteredUser, RegisteredUser];
    const day = today(harness);
    const alis = (await post(harness, ali, challengeId, { dayKey: day, value: 40000, source: 'manual', clientTime: iso(harness) })).json<{ entry: Entry }>().entry.id;
    const cems = (await post(harness, cem, challengeId, { dayKey: day, value: 45000, source: 'manual', clientTime: iso(harness) })).json<{ entry: Entry }>().entry.id;

    // Ayşe blocked the disputer, the owner blocked Mert; only Cem is called
    expect((await authed(harness.app, ayse.token)({ method: 'POST', url: `/users/${veli.me.id}/block` })).statusCode).toBeLessThan(300);
    expect((await authed(harness.app, ali.token)({ method: 'POST', url: `/users/${mert.me.id}/block` })).statusCode).toBeLessThan(300);
    const disputed = await authed(harness.app, veli.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${alis}/dispute`,
      payload: { reason: 'kırk bin mi' },
    });
    expect(disputed.statusCode).toBe(201);
    expect(listByType(harness.db, ayse.me.id, 'dispute')).toHaveLength(0);
    expect(listByType(harness.db, mert.me.id, 'dispute')).toHaveLength(0);
    expect(listByType(harness.db, cem.me.id, 'dispute')).toHaveLength(1);

    // Cem walks out: his rows count for nothing, so nobody is called to them
    expect((await authed(harness.app, cem.token)({ method: 'POST', url: `/challenges/${challengeId}/leave` })).statusCode).toBe(200);
    const left = await authed(harness.app, veli.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${cems}/dispute`,
      payload: { reason: 'o da yalan' },
    });
    expect(left.statusCode).toBe(201);
    expect(listByType(harness.db, ali.me.id, 'dispute').filter((row) => row.data.includes('"call"'))).toHaveLength(0);
  });

  it('needs an existing entry, a reason and membership', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await liveChallenge(harness, 'adim_yarisi');
    const created = await post(harness, ali, challengeId, {
      dayKey: today(harness),
      value: 1000,
      source: 'manual',
      clientTime: iso(harness),
    });
    const entryId = created.json<{ entry: Entry }>().entry.id;

    const missing = await authed(harness.app, veli.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/yok/dispute`,
      payload: { reason: 'yok' },
    });
    expect(missing.statusCode).toBe(404);

    const noReason = await authed(harness.app, veli.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${entryId}/dispute`,
      payload: { reason: '' },
    });
    expect(noReason.statusCode).toBe(400);
    expect(errorCode(noReason)).toBe('validation');

    const outsider = await registerUser(harness.app, 'yabanci');
    const denied = await authed(harness.app, outsider.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${entryId}/dispute`,
      payload: { reason: 'ben de varım' },
    });
    expect(denied.statusCode).toBe(404);
  });
});

describe('DELETE /challenges/:id/entries/:entryId/dispute', () => {
  it('lets the disputer take it back: dismissed, and the entry is clean again', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await liveChallenge(harness, 'adim_yarisi');
    const created = await post(harness, ali, challengeId, { dayKey: today(harness), value: 20000, source: 'manual', clientTime: iso(harness) });
    const entryId = created.json<{ entry: Entry }>().entry.id;
    const url = `/challenges/${challengeId}/entries/${entryId}/dispute`;

    await authed(harness.app, veli.token)({ method: 'POST', url, payload: { reason: 'yok artık' } });

    // only an itiraz of your own can be taken back
    const notMine = await authed(harness.app, ali.token)({ method: 'DELETE', url });
    expect(notMine.statusCode).toBe(404);
    expect(errorCode(notMine)).toBe('dispute_not_found');

    const withdrawn = await authed(harness.app, veli.token)({ method: 'DELETE', url });
    expect(withdrawn.statusCode).toBe(200);
    const body = withdrawn.json<{ dispute: Dispute; entry: Entry }>();
    expect(body.dispute.status).toBe('dismissed');
    expect(body.entry.status).toBe('ok');

    const detail = (await authed(harness.app, ali.token)({ method: 'GET', url: `/challenges/${challengeId}` })).json<ChallengeDetail>();
    expect(detail.feed.find((item) => item.id === entryId)).toMatchObject({ status: 'ok', answerBy: null });

    // nothing is waiting any more: twelve hours later the entry still stands
    harness.advance(LIMITS.DISPUTE_ANSWER_MS);
    expect(runSchedulerOnce(harness.db, harness.now()).disputes).toBe(0);
    expect(getEntryRow(harness.db, entryId)?.status).toBe('ok');

    // taken back is final
    const twice = await authed(harness.app, veli.token)({ method: 'DELETE', url });
    expect(twice.statusCode).toBe(404);
    const refile = await authed(harness.app, veli.token)({ method: 'POST', url, payload: { reason: 'yine de' } });
    expect(refile.statusCode).toBe(409);
    expect(errorCode(refile)).toBe('already_disputed');
  });

  it('keeps the entry disputed while somebody else still disputes it', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const veli = await registerUser(harness.app, 'veli');
    const ayse = await registerUser(harness.app, 'ayse');
    for (const friend of [veli, ayse]) befriend(harness.app, ali.me.id, friend.me.id);
    const created = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/challenges',
      payload: { typeKey: 'su_bardak', startsAt: iso(harness), endsAt: iso(harness, 3 * DAY_MS), participantIds: [veli.me.id, ayse.me.id] },
    });
    const challengeId = created.json<Challenge>().id;
    for (const friend of [veli, ayse]) {
      await authed(harness.app, friend.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    }
    const entry = await post(harness, ali, challengeId, { dayKey: today(harness), value: 8, source: 'manual', clientTime: iso(harness) });
    const url = `/challenges/${challengeId}/entries/${entry.json<{ entry: Entry }>().entry.id}/dispute`;

    await authed(harness.app, veli.token)({ method: 'POST', url, payload: { reason: 'sekiz bardak mı' } });
    await authed(harness.app, ayse.token)({ method: 'POST', url, payload: { reason: 'bence de fazla' } });
    const withdrawn = await authed(harness.app, veli.token)({ method: 'DELETE', url });
    expect(withdrawn.json<{ entry: Entry }>().entry.status).toBe('disputed');
  });
});

describe('POST /challenges/:id/entries/:entryId/proof', () => {
  it('lets the owner answer with a photo: the itiraz closes and the disputers are told to look', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli');
    const ayse = await registerUser(harness.app, 'ayse', { vulgarityMax: 1 });
    const mert = await registerUser(harness.app, 'mert');
    for (const friend of [veli, ayse, mert]) befriend(harness.app, ali.me.id, friend.me.id);
    const created = await authed(harness.app, ali.token)({
      method: 'POST',
      url: '/challenges',
      payload: {
        typeKey: 'adim_yarisi',
        startsAt: iso(harness),
        endsAt: iso(harness, 3 * DAY_MS),
        participantIds: [veli.me.id, ayse.me.id, mert.me.id],
      },
    });
    const challengeId = created.json<Challenge>().id;
    for (const friend of [veli, ayse, mert]) {
      await authed(harness.app, friend.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    }
    const entry = await post(harness, ali, challengeId, { dayKey: today(harness), value: 30000, source: 'manual', clientTime: iso(harness) });
    const entryId = entry.json<{ entry: Entry }>().entry.id;
    const disputeUrl = `/challenges/${challengeId}/entries/${entryId}/dispute`;
    const proofUrl = `/challenges/${challengeId}/entries/${entryId}/proof`;

    // an entry nobody disputes needs no answer
    const early = await authed(harness.app, ali.token)({ method: 'POST', url: proofUrl, payload: { proofUrl: '/uploads/adim.jpg' } });
    expect(early.statusCode).toBe(409);
    expect(errorCode(early)).toBe('not_disputed');

    await authed(harness.app, veli.token)({ method: 'POST', url: disputeUrl, payload: { reason: 'otuz bin mi' } });
    await authed(harness.app, ayse.token)({ method: 'POST', url: disputeUrl, payload: { reason: 'bütün gün oturdu' } });

    // only the owner answers
    const stranger = await authed(harness.app, mert.token)({ method: 'POST', url: proofUrl, payload: { proofUrl: '/uploads/sahte.jpg' } });
    expect(stranger.statusCode).toBe(403);
    expect(errorCode(stranger)).toBe('not_your_entry');

    const bad = await authed(harness.app, ali.token)({ method: 'POST', url: proofUrl, payload: { proofUrl: 'javascript:alert(1)' } });
    expect(bad.statusCode).toBe(400);

    const answered = await authed(harness.app, ali.token)({ method: 'POST', url: proofUrl, payload: { proofUrl: '/uploads/adim.jpg' } });
    expect(answered.statusCode).toBe(200);
    const body = answered.json<{ entry: Entry; standings: ParticipantView[] }>();
    expect(body.entry).toMatchObject({ status: 'ok', proofUrl: '/uploads/adim.jpg' });
    expect(body.standings.find((p) => p.user.id === ali.me.id)?.score).toBe(30000);

    const statuses = harness.db.prepare('SELECT status FROM disputes WHERE entry_id = ?').all(entryId) as { status: string }[];
    expect(statuses.map((row) => row.status)).toEqual(['dismissed', 'dismissed']);

    // Veli's itiraz called Ayşe and Mert to it; the photo is news to the disputers only
    const news = (user: RegisteredUser) =>
      listByType(harness!.db, user.me.id, 'dispute').filter((row) => (JSON.parse(row.data) as { kind?: string }).kind !== 'call');
    for (const disputer of [veli, ayse]) {
      const told = news(disputer);
      expect(told, disputer.me.username).toHaveLength(1);
      expect(JSON.parse(told[0]!.data)).toEqual({ challengeId, entryId, kind: 'proof' });
    }
    expect(news(veli)[0]?.body).toContain('Ali kanıt ekledi, bir bak.');
    expect(news(ayse)[0]?.body).toContain('fotoğraf ekledi');
    expect(news(mert)).toHaveLength(0);

    // the same itiraz is not filed twice; the clock never runs out on it
    const again = await authed(harness.app, veli.token)({ method: 'POST', url: disputeUrl, payload: { reason: 'foto da sahte' } });
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('already_disputed');
    harness.advance(LIMITS.DISPUTE_ANSWER_MS);
    expect(runSchedulerOnce(harness.db, harness.now()).disputes).toBe(0);
    expect(getEntryRow(harness.db, entryId)?.status).toBe('ok');
    expect(listByType(harness.db, ali.me.id, 'entry_rejected')).toHaveLength(0);
  });

  it('takes the old app\'s answer: the day sent again with a photo closes the itiraz like "Kanıt ekle"', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await liveChallenge(harness, 'ekran_suresi_beyani');
    const day = today(harness);
    const first = await post(harness, ali, challengeId, { dayKey: day, value: 300, source: 'manual', proofUrl: '/uploads/ekran.jpg', clientTime: iso(harness) });
    const entryId = first.json<{ entry: Entry }>().entry.id;
    const disputeUrl = `/challenges/${challengeId}/entries/${entryId}/dispute`;
    const disputed = await authed(harness.app, veli.token)({ method: 'POST', url: disputeUrl, payload: { reason: 'beş saat mi' } });
    expect(disputed.json<{ answerBy: string | null }>().answerBy).not.toBeNull();
    // the owner is told where the photo goes, and that it needs the new app
    const warning = listByType(harness.db, ali.me.id, 'dispute')[0];
    expect(warning?.body).toContain('"Kanıt ekle" düğmesi yoksa önce uygulamayı güncelle.');

    // what the 1.0 entry modal sends: the same day, a fresh photo
    const again = await post(harness, ali, challengeId, { dayKey: day, value: 300, source: 'manual', proofUrl: '/uploads/ekran-2.jpg', clientTime: iso(harness) });
    expect(again.statusCode).toBe(200);
    expect(again.json<{ entry: Entry }>().entry).toMatchObject({ id: entryId, status: 'ok', proofUrl: '/uploads/ekran-2.jpg' });
    expect(listByType(harness.db, veli.me.id, 'dispute')[0]?.body).toContain('kanıt ekledi');

    harness.advance(LIMITS.DISPUTE_ANSWER_MS + 60_000);
    expect(runSchedulerOnce(harness.db, harness.now()).disputes).toBe(0);
    expect(getEntryRow(harness.db, entryId)?.status).toBe('ok');
    expect(listByType(harness.db, ali.me.id, 'entry_rejected')).toHaveLength(0);
  });

  it('lets the disputer say "yalan" to a new number sent with the photo', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await liveChallenge(harness, 'ekran_suresi_beyani');
    const day = today(harness);
    const first = await post(harness, ali, challengeId, { dayKey: day, value: 300, source: 'manual', proofUrl: '/uploads/ekran.jpg', clientTime: iso(harness) });
    const entryId = first.json<{ entry: Entry }>().entry.id;
    const disputeUrl = `/challenges/${challengeId}/entries/${entryId}/dispute`;
    await authed(harness.app, veli.token)({ method: 'POST', url: disputeUrl, payload: { reason: 'beş saat mi' } });

    const changed = await post(harness, ali, challengeId, { dayKey: day, value: 5, source: 'manual', proofUrl: '/uploads/baska.jpg', clientTime: iso(harness) });
    expect(changed.json<{ entry: Entry }>().entry).toMatchObject({ id: entryId, value: 5, status: 'ok' });
    const second = await authed(harness.app, veli.token)({ method: 'POST', url: disputeUrl, payload: { reason: 'beş dakika hiç değil' } });
    expect(second.statusCode).toBe(201);
    expect(second.json<{ entry: Entry }>().entry.status).toBe('disputed');
  });

  it('opens the door again once an entry closed with a photo changes its number', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await liveChallenge(harness, 'ekran_suresi_beyani');
    const day = today(harness);
    const first = await post(harness, ali, challengeId, { dayKey: day, value: 300, source: 'manual', proofUrl: '/uploads/ekran.jpg', clientTime: iso(harness) });
    const entryId = first.json<{ entry: Entry }>().entry.id;
    const disputeUrl = `/challenges/${challengeId}/entries/${entryId}/dispute`;
    await authed(harness.app, veli.token)({ method: 'POST', url: disputeUrl, payload: { reason: 'beş saat mi' } });
    const answered = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${entryId}/proof`,
      payload: { proofUrl: '/uploads/ekran-2.jpg' },
    });
    expect(answered.statusCode).toBe(200);

    // same number again: the photo already answered it, one itiraz per person stands
    await post(harness, ali, challengeId, { dayKey: day, value: 300, source: 'manual', proofUrl: '/uploads/ekran-2.jpg', clientTime: iso(harness) });
    const same = await authed(harness.app, veli.token)({ method: 'POST', url: disputeUrl, payload: { reason: 'yine de' } });
    expect(same.statusCode).toBe(409);

    // then the day drops to 5 minutes behind the photo that backed 300
    const lowered = await post(harness, ali, challengeId, { dayKey: day, value: 5, source: 'manual', proofUrl: '/uploads/ekran-2.jpg', clientTime: iso(harness) });
    expect(lowered.json<{ entry: Entry }>().entry).toMatchObject({ id: entryId, value: 5, status: 'ok' });
    const fresh = await authed(harness.app, veli.token)({ method: 'POST', url: disputeUrl, payload: { reason: 'beş dakika mı' } });
    expect(fresh.statusCode).toBe(201);
  });

  it('opens the door again after a withdrawn itiraz when the number changes', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await liveChallenge(harness, 'adim_yarisi');
    const day = today(harness);
    const first = await post(harness, ali, challengeId, { dayKey: day, value: 8000, source: 'manual', clientTime: iso(harness) });
    const entryId = first.json<{ entry: Entry }>().entry.id;
    const disputeUrl = `/challenges/${challengeId}/entries/${entryId}/dispute`;
    await authed(harness.app, veli.token)({ method: 'POST', url: disputeUrl, payload: { reason: 'sekiz bin mi' } });
    await authed(harness.app, veli.token)({ method: 'DELETE', url: disputeUrl });

    await post(harness, ali, challengeId, { dayKey: day, value: 30000, source: 'manual', clientTime: iso(harness) });
    const fresh = await authed(harness.app, veli.token)({ method: 'POST', url: disputeUrl, payload: { reason: 'otuz bin hiç değil' } });
    expect(fresh.statusCode).toBe(201);
  });

  it('is closed once the çelınc is over', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await liveChallenge(harness, 'su_bardak', {}, 1);
    const entry = await post(harness, ali, challengeId, { dayKey: today(harness), value: 4, source: 'manual', clientTime: iso(harness) });
    const entryId = entry.json<{ entry: Entry }>().entry.id;
    await authed(harness.app, veli.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${entryId}/dispute`,
      payload: { reason: 'dört bardak mı' },
    });

    harness.advance(DAY_MS + LIMITS.DISPUTE_ANSWER_MS);
    runSchedulerOnce(harness.db, harness.now());
    const late = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${entryId}/proof`,
      payload: { proofUrl: '/uploads/bardak.jpg' },
    });
    expect(late.statusCode).toBe(400);
    expect(errorCode(late)).toBe('challenge_not_active');
    const withdraw = await authed(harness.app, veli.token)({
      method: 'DELETE',
      url: `/challenges/${challengeId}/entries/${entryId}/dispute`,
    });
    expect(withdraw.statusCode).toBe(400);
    expect(errorCode(withdraw)).toBe('challenge_not_active');
  });
});

describe('GET /challenges/:id/feed', () => {
  /** A typed row written at `at`, straight into the table: sixty posts would only slow the suite down. */
  function insertEntry(h: TestApp, challengeId: string, userId: string, at: string, value = 1): string {
    const id = newId();
    h.db
      .prepare(
        `INSERT INTO entries (id, challenge_id, user_id, day_key, value, source, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'manual', 'ok', ?, ?)`,
      )
      .run(id, challengeId, userId, today(h), value, at, at);
    return id;
  }

  function feedPage(h: TestApp, user: RegisteredUser, challengeId: string, query = '') {
    return authed(h.app, user.token)({ method: 'GET', url: `/challenges/${challengeId}/feed${query}` });
  }

  function detailOf(h: TestApp, user: RegisteredUser, challengeId: string) {
    return authed(h.app, user.token)({ method: 'GET', url: `/challenges/${challengeId}` });
  }

  it('pages past the 40 newest from the cursor the detail hands out, an old disputed row aside', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await liveChallenge(harness, 'su_bardak');
    // sixty rows a second apart, oldest first
    const ids = Array.from({ length: 60 }, (_, i) =>
      insertEntry(harness!, challengeId, (i % 2 === 0 ? ali : veli).me.id, iso(harness!, (i - 60) * 1000)),
    );
    const newestFirst = [...ids].reverse();
    // the oldest one is disputed, so the detail carries it however old
    const disputed = await authed(harness.app, veli.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${ids[0]}/dispute`,
      payload: { reason: 'ilk gün bu kadar mı' },
    });
    expect(disputed.statusCode).toBe(201);

    const detail = (await detailOf(harness, ali, challengeId)).json<ChallengeDetail>();
    expect(detail.feed.map((item) => item.id)).toEqual([...newestFirst.slice(0, 40), ids[0]]);
    // the 40th newest, not the disputed row at the bottom of the feed
    expect(detail.feedCursor).toEqual({ before: iso(harness, -40_000), beforeId: newestFirst[39] });

    const { before, beforeId } = detail.feedCursor!;
    const response = await feedPage(harness, ali, challengeId, `?before=${encodeURIComponent(before)}&beforeId=${beforeId}`);
    expect(response.statusCode).toBe(200);
    const page = response.json<FeedPage>();
    expect(page.items.map((item) => item.id)).toEqual(newestFirst.slice(40));
    expect(page.next).toBeNull();
    // the page carries what the detail's rows carry: the disputed one still says how far the itiraz got
    expect(page.items.at(-1)).toMatchObject({ id: ids[0], status: 'disputed', displayName: 'Ali' });
  });

  it('gives a feed that fits in one look no cursor', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await liveChallenge(harness, 'su_bardak');
    for (let i = 0; i < 40; i++) insertEntry(harness, challengeId, ali.me.id, iso(harness, (i - 40) * 1000));

    const detail = (await detailOf(harness, ali, challengeId)).json<ChallengeDetail>();
    expect(detail.feed).toHaveLength(40);
    expect(detail.feedCursor).toBeNull();
  });

  it('pages from the newest without a cursor, and only one player\'s rows with userId', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await liveChallenge(harness, 'su_bardak');
    const aliIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const user = i % 2 === 0 ? ali : veli;
      const id = insertEntry(harness, challengeId, user.me.id, iso(harness, (i - 10) * 1000));
      if (user === ali) aliIds.unshift(id);
    }

    const first = (await feedPage(harness, veli, challengeId, `?userId=${ali.me.id}&limit=3`)).json<FeedPage>();
    expect(first.items.map((item) => item.id)).toEqual(aliIds.slice(0, 3));
    expect(first.items.every((item) => item.userId === ali.me.id)).toBe(true);
    const { before, beforeId } = first.next!;
    const rest = (
      await feedPage(harness, veli, challengeId, `?userId=${ali.me.id}&before=${encodeURIComponent(before)}&beforeId=${beforeId}`)
    ).json<FeedPage>();
    expect(rest.items.map((item) => item.id)).toEqual(aliIds.slice(3));
    expect(rest.next).toBeNull();

    const everybody = (await feedPage(harness, veli, challengeId)).json<FeedPage>();
    expect(everybody.items).toHaveLength(10);
    expect(everybody.next).toBeNull();
  });

  it('neither skips nor repeats rows written in the same millisecond at a page boundary', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await liveChallenge(harness, 'su_bardak');
    // one device sync writes every day it carries at the same instant
    const at = iso(harness, -60_000);
    const ids = [ali, veli, ali, veli, ali, veli, ali].map((user, i) => insertEntry(harness!, challengeId, user.me.id, at, i + 1));
    insertEntry(harness, challengeId, ali.me.id, iso(harness, -120_000));

    const seen: string[] = [];
    let query = '?limit=2';
    for (let pages = 0; pages < 10; pages++) {
      const page = (await feedPage(harness, ali, challengeId, query)).json<FeedPage>();
      seen.push(...page.items.map((item) => item.id));
      if (!page.next) break;
      // an offset form of the same instant pages the same way
      const offset = new Date(Date.parse(page.next.before) + 3 * 3_600_000).toISOString().replace('Z', '+03:00');
      query = `?limit=2&before=${encodeURIComponent(offset)}&beforeId=${page.next.beforeId}`;
    }
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
    expect(seen.slice(0, 7).sort()).toEqual([...ids].sort());
  });

  it('answers 404 to anybody outside the çelınc, and 400 to an id without its instant', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await liveChallenge(harness, 'su_bardak');
    const cem = await registerUser(harness.app, 'cem');
    befriend(harness.app, ali.me.id, cem.me.id);

    const outsider = await feedPage(harness, cem, challengeId);
    expect(outsider.statusCode).toBe(404);
    expect(errorCode(outsider)).toBe('challenge_not_found');
    const madeUp = await feedPage(harness, ali, randomUUID());
    expect(madeUp.statusCode).toBe(404);
    expect(errorCode(madeUp)).toBe('challenge_not_found');

    const loose = await feedPage(harness, ali, challengeId, `?beforeId=${randomUUID()}`);
    expect(loose.statusCode).toBe(400);
    expect(errorCode(loose)).toBe('validation');
    expect((await feedPage(harness, ali, challengeId, `?limit=${LIMITS.FEED_PAGE_MAX + 1}`)).statusCode).toBe(400);
  });
});
