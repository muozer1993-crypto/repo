/**
 * Entry validation per metric type (SPEC 2.3), deletion and the dispute threshold.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_TIMEZONE, addDays, todayKey, type ChallengeDetail, type Entry, type ParticipantView, type Challenge } from '@koydum/shared';
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
  it('rejects the entry as soon as the threshold is reached (head to head: one rival)', async () => {
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
    const outcome = disputed.json<{ upheld: boolean; entry: Entry; standings: ParticipantView[] }>();
    expect(outcome.upheld).toBe(true);
    expect(outcome.entry.status).toBe('rejected');
    expect(outcome.standings.find((p) => p.user.id === ali.me.id)?.score).toBe(0);

    const inbox = listByType(harness.db, ali.me.id, 'entry_rejected');
    expect(inbox).toHaveLength(1);
    expect(computeUserStats(harness.db, veli.me.id, harness.now()).disputesWon).toBe(1);

    const again = await authed(harness.app, veli.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${entryId}/dispute`,
      payload: { reason: 'yine' },
    });
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('already_rejected');
  });

  it('needs a majority of the other players when there are four', async () => {
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
    const afterFirst = first.json<{ upheld: boolean; entry: Entry; standings: ParticipantView[] }>();
    expect(afterFirst.upheld).toBe(false);
    expect(afterFirst.entry.status).toBe('disputed');
    // A pending dispute must not zero the rival out yet (SPEC 1.3).
    expect(afterFirst.standings.find((p) => p.user.id === ali.me.id)?.score).toBe(55000);
    expect(listByType(harness.db, ali.me.id, 'dispute')).toHaveLength(1);

    const duplicate = await authed(harness.app, veli.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${entryId}/dispute`,
      payload: { reason: 'tekrar' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(errorCode(duplicate)).toBe('already_disputed');

    const second = await authed(harness.app, ayse.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${entryId}/dispute`,
      payload: { reason: 'ben de görmedim' },
    });
    expect(second.statusCode).toBe(201);
    const afterSecond = second.json<{ upheld: boolean; entry: Entry; standings: ParticipantView[] }>();
    expect(afterSecond.upheld).toBe(true);
    expect(afterSecond.entry.status).toBe('rejected');
    expect(afterSecond.standings.find((p) => p.user.id === ali.me.id)?.score).toBe(0);

    // Both disputers now have a win on record.
    expect(computeUserStats(harness.db, veli.me.id, harness.now()).disputesWon).toBe(1);
    expect(computeUserStats(harness.db, ayse.me.id, harness.now()).disputesWon).toBe(1);
    expect(listByType(harness.db, ali.me.id, 'entry_rejected')).toHaveLength(1);
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
