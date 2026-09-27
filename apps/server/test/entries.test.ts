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
} from '@koydum/shared';
import { runSchedulerOnce } from '../src/services/challenges.js';
import { challengeFeed } from '../src/services/challengeViews.js';
import { getEntryRow } from '../src/services/entries.js';
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

  it('after the end takes the phone\'s late count but no typed number', async () => {
    harness = await makeApp({ now: NOW });
    // runs to 12:00 tomorrow; the scheduler has not been by yet
    const steps = await liveChallenge(harness, 'adim_yarisi', {}, 1);
    const water = await liveChallenge(harness, 'su_bardak', {}, 1, '2');
    harness.advance(DAY_MS + 60_000);
    const lastDay = today(harness);

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
      dayKey: lastDay,
      value: 9000,
      source: 'pedometer',
      clientTime: iso(harness),
    });
    expect(counted.statusCode).toBe(201);

    const synced = await authed(harness.app, steps.veli.token)({
      method: 'POST',
      url: '/me/steps',
      payload: { days: [{ dayKey: lastDay, steps: 11000, source: 'health_connect' }] },
    });
    expect(synced.statusCode).toBe(200);
    expect(synced.json<{ updated: number }>().updated).toBe(1);

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
    const afterFirst = first.json<{ answerBy: string | null; entry: Entry; standings: ParticipantView[] }>();
    expect(afterFirst.answerBy).toBeNull();
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
    const afterSecond = second.json<{ answerBy: string | null; entry: Entry; standings: ParticipantView[] }>();
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

    for (const disputer of [veli, ayse]) {
      const told = listByType(harness.db, disputer.me.id, 'dispute');
      expect(told, disputer.me.username).toHaveLength(1);
      expect(JSON.parse(told[0]!.data)).toEqual({ challengeId, entryId, kind: 'proof' });
    }
    expect(listByType(harness.db, veli.me.id, 'dispute')[0]?.body).toContain('Ali kanıt ekledi, bir bak.');
    expect(listByType(harness.db, ayse.me.id, 'dispute')[0]?.body).toContain('fotoğraf ekledi');
    expect(listByType(harness.db, mert.me.id, 'dispute')).toHaveLength(0);

    // the same itiraz is not filed twice; the clock never runs out on it
    const again = await authed(harness.app, veli.token)({ method: 'POST', url: disputeUrl, payload: { reason: 'foto da sahte' } });
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('already_disputed');
    harness.advance(LIMITS.DISPUTE_ANSWER_MS);
    expect(runSchedulerOnce(harness.db, harness.now()).disputes).toBe(0);
    expect(getEntryRow(harness.db, entryId)?.status).toBe('ok');
    expect(listByType(harness.db, ali.me.id, 'entry_rejected')).toHaveLength(0);
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
