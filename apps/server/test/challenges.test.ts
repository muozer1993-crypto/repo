/**
 * Challenge, taunt, poke, rematch, results and leaderboard routes.
 *
 * Everything runs against an in-memory database with an injected clock
 * (`makeApp`), so "now" is exact and no test depends on wall-clock timing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { LIMITS, addDays, todayKey, DEFAULT_TIMEZONE, type ChallengeDetail, type ChallengeResults, type ChallengeSummary, type LeaderboardEntry, type Challenge } from '@koydum/shared';
import { invitableFor, runSchedulerOnce, sendNudges, sendReminders } from '../src/services/challenges.js';
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

function iso(h: TestApp, offsetMs = 0): string {
  return new Date(h.now().getTime() + offsetMs).toISOString();
}

function today(h: TestApp): string {
  return todayKey(DEFAULT_TIMEZONE, h.now());
}

interface CreateOptions {
  typeKey?: string;
  title?: string;
  startsAt?: string;
  endsAt?: string;
  participantIds: string[];
  deadlineTime?: string;
  rewardText?: string;
  penaltyText?: string;
  proofRequired?: boolean;
}

function createPayload(h: TestApp, options: CreateOptions): Record<string, unknown> {
  return {
    typeKey: options.typeKey ?? 'adim_yarisi',
    title: options.title,
    startsAt: options.startsAt ?? iso(h),
    endsAt: options.endsAt ?? iso(h, 3 * 24 * 60 * 60 * 1000),
    participantIds: options.participantIds,
    deadlineTime: options.deadlineTime,
    rewardText: options.rewardText,
    penaltyText: options.penaltyText,
    proofRequired: options.proofRequired,
  };
}

async function createChallenge(h: TestApp, creator: RegisteredUser, options: CreateOptions) {
  return authed(h.app, creator.token)({ method: 'POST', url: '/challenges', payload: createPayload(h, options) });
}

async function postEntry(h: TestApp, user: RegisteredUser, challengeId: string, payload: Record<string, unknown>) {
  return authed(h.app, user.token)({ method: 'POST', url: `/challenges/${challengeId}/entries`, payload });
}

/** Two friends, a live steps challenge, both accepted. */
async function twoPlayerChallenge(h: TestApp) {
  const ali = await registerUser(h.app, 'ali', { displayName: 'Ali' });
  const veli = await registerUser(h.app, 'veli', { displayName: 'Veli' });
  befriend(h.app, ali.me.id, veli.me.id);

  const created = await createChallenge(h, ali, { participantIds: [veli.me.id] });
  const challengeId = created.json<Challenge>().id;
  await authed(h.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
  return { ali, veli, challengeId };
}

/** Same, but Ali is ahead — mid-çelınc talking is only for whoever leads. */
async function leadingChallenge(h: TestApp) {
  const ctx = await twoPlayerChallenge(h);
  const day = today(h);
  await postEntry(h, ctx.ali, ctx.challengeId, { dayKey: day, value: 12430, source: 'pedometer', clientTime: iso(h) });
  await postEntry(h, ctx.veli, ctx.challengeId, { dayKey: day, value: 900, source: 'pedometer', clientTime: iso(h) });
  return ctx;
}

/** Same, but Ali wins by a mile and the challenge is force-finished. */
async function finishedChallenge(h: TestApp) {
  const ctx = await twoPlayerChallenge(h);
  const day = today(h);
  await postEntry(h, ctx.ali, ctx.challengeId, { dayKey: day, value: 12430, source: 'pedometer', clientTime: iso(h) });
  await postEntry(h, ctx.veli, ctx.challengeId, { dayKey: day, value: 900, source: 'pedometer', clientTime: iso(h) });
  const finalize = await h.app.inject({ method: 'POST', url: `/dev/finalize/${ctx.challengeId}` });
  expect(finalize.statusCode).toBe(200);
  return ctx;
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

describe('POST /challenges', () => {
  it('creates an active challenge, auto-accepts the creator and invites the rest', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli', vulgarityMax: 1 });
    befriend(harness.app, ali.me.id, veli.me.id);

    const response = await createChallenge(harness, ali, { participantIds: [veli.me.id], rewardText: 'Döner' });
    expect(response.statusCode).toBe(201);

    // Creation answers with the bare Challenge (mobile `api.createChallenge`).
    const challenge = response.json<Challenge>();
    expect(challenge.status).toBe('active');
    // The metric shape is copied from the catalog, not looked up later.
    expect(challenge.metricType).toBe('auto_steps');
    expect(challenge.direction).toBe('higher');
    expect(challenge.unit).toBe('adım');
    expect(challenge.title).toBe('Adım Yarışı');
    expect(challenge.rewardText).toBe('Döner');

    const detail = (
      await authed(harness.app, ali.token)({ method: 'GET', url: `/challenges/${challenge.id}` })
    ).json<ChallengeDetail>();
    const me = detail.participants.find((p) => p.user.id === ali.me.id);
    const invited = detail.participants.find((p) => p.user.id === veli.me.id);
    expect(me?.status).toBe('accepted');
    expect(invited?.status).toBe('invited');

    // The invite is rendered at the RECIPIENT's level (Veli is level 1 = nazik).
    const inbox = listByType(harness.db, veli.me.id, 'challenge_invite');
    expect(inbox).toHaveLength(1);
    expect(inbox[0].title).toBe('Çelınc daveti');
    expect(inbox[0].body).toContain('Ali');
    expect(JSON.parse(inbox[0].data)).toMatchObject({ challengeId: challenge.id });
  });

  it('stays pending when it starts in the future', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const veli = await registerUser(harness.app, 'veli');
    befriend(harness.app, ali.me.id, veli.me.id);

    const response = await createChallenge(harness, ali, {
      participantIds: [veli.me.id],
      startsAt: iso(harness, 60 * 60 * 1000),
      endsAt: iso(harness, 3 * 24 * 60 * 60 * 1000),
    });
    expect(response.json<Challenge>().status).toBe('pending');
  });

  it('rejects a non-friend', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const stranger = await registerUser(harness.app, 'yabanci');

    const response = await createChallenge(harness, ali, { participantIds: [stranger.me.id] });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('not_friends');
  });

  it('rejects a blocked friend', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const veli = await registerUser(harness.app, 'veli');
    const friendshipId = befriend(harness.app, ali.me.id, veli.me.id);
    harness.db.prepare("UPDATE friendships SET status = 'blocked' WHERE id = ?").run(friendshipId);

    const response = await createChallenge(harness, ali, { participantIds: [veli.me.id] });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('not_friends');
  });

  it('rejects inviting yourself', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const veli = await registerUser(harness.app, 'veli');
    befriend(harness.app, ali.me.id, veli.me.id);

    const response = await createChallenge(harness, ali, { participantIds: [veli.me.id, ali.me.id] });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('self_participant');
  });

  it('rejects an unknown user id', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const response = await createChallenge(harness, ali, { participantIds: ['no-such-user'] });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('user_not_found');
  });

  it('rejects bad dates', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const veli = await registerUser(harness.app, 'veli');
    befriend(harness.app, ali.me.id, veli.me.id);

    const tooShort = await createChallenge(harness, ali, {
      participantIds: [veli.me.id],
      endsAt: iso(harness, 30 * 60 * 1000),
    });
    expect(tooShort.statusCode).toBe(400);
    expect(tooShort.json().error.code).toBe('validation');

    const inThePast = await createChallenge(harness, ali, {
      participantIds: [veli.me.id],
      startsAt: iso(harness, -2 * 60 * 60 * 1000),
      endsAt: iso(harness, 24 * 60 * 60 * 1000),
    });
    expect(inThePast.statusCode).toBe(400);
    expect(inThePast.json().error.code).toBe('start_in_past');

    const tooLong = await createChallenge(harness, ali, {
      participantIds: [veli.me.id],
      endsAt: iso(harness, 90 * 24 * 60 * 60 * 1000),
    });
    expect(tooLong.statusCode).toBe(400);
  });

  it('says a start in the past is by the server\'s clock, and lets one inside the grace through', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const veli = await registerUser(harness.app, 'veli');
    befriend(harness.app, ali.me.id, veli.me.id);

    // a "Hemen" from a phone 10 minutes slow: older wizards show only the message, so it says why
    const slow = await createChallenge(harness, ali, { participantIds: [veli.me.id], startsAt: iso(harness, -10 * 60 * 1000) });
    expect(slow.statusCode).toBe(400);
    expect(slow.json().error).toMatchObject({
      code: 'start_in_past',
      message:
        'Başlangıç sunucunun saatine göre geçmişte kalıyor. Telefonunun ya da sunucu bilgisayarının saati yanlış olabilir; ikisinde de otomatik saat açık olsun.',
    });

    const late = await createChallenge(harness, ali, { participantIds: [veli.me.id], startsAt: iso(harness, -2 * 60 * 1000) });
    expect(late.statusCode).toBe(201);
    expect(late.json<Challenge>().status).toBe('active');
  });

  it('takes a "Hemen" that lands a moment in the server\'s future as now, not as a start that waits for a "Varım"', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const veli = await registerUser(harness.app, 'veli');
    befriend(harness.app, ali.me.id, veli.me.id);

    // the app's guess of this server's clock is right only to half a round trip
    const ahead = await createChallenge(harness, ali, { participantIds: [veli.me.id], startsAt: iso(harness, 1_500) });
    expect(ahead.statusCode).toBe(201);
    expect(ahead.json<Challenge>()).toMatchObject({ status: 'active', startsAt: iso(harness) });
    // its creator plays at once, before any friend says yes
    const entry = await postEntry(harness, ali, ahead.json<Challenge>().id, {
      dayKey: today(harness),
      value: 1200,
      source: 'manual',
      clientTime: iso(harness),
    });
    expect(entry.statusCode).toBe(201);

    // a start that is really later still waits for it
    const later = await createChallenge(harness, ali, { participantIds: [veli.me.id], startsAt: iso(harness, 2 * 60 * 1000) });
    expect(later.json<Challenge>().status).toBe('pending');
  });

  // "Hemen", three days, as computeWindow sends it: the end snapped to the last
  // millisecond of the third local day in Istanbul
  const SEKERSIZ = { typeKey: 'sekersiz_gun', title: 'Şekersiz Günler', endsAt: '2026-01-07T20:59:59.999Z' };

  it('answers a retry after a lost answer with the çelınc the first try made', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    befriend(harness.app, ali.me.id, veli.me.id);

    const first = await createChallenge(harness, ali, { ...SEKERSIZ, participantIds: [veli.me.id] });
    expect(first.statusCode).toBe(201);
    expect(first.json<Challenge>().status).toBe('active');

    // the answer never came: the app gave up after 15 s and Ali tapped "KOY
    // BAKALIM" again, its "Hemen" now 20 s later
    harness.advance(20_000);
    const retry = await createChallenge(harness, ali, { ...SEKERSIZ, participantIds: [veli.me.id] });
    expect(retry.statusCode).toBe(200);
    expect(retry.json<Challenge>()).toEqual(first.json<Challenge>());

    const mine = await authed(harness.app, ali.token)({ method: 'GET', url: '/challenges' });
    expect(mine.json<ChallengeSummary[]>()).toHaveLength(1);
    expect(listByType(harness.db, veli.me.id, 'challenge_invite')).toHaveLength(1);
  });

  it('still makes a new çelınc when anything differs, or two minutes on', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const veli = await registerUser(harness.app, 'veli');
    const ayse = await registerUser(harness.app, 'ayse');
    befriend(harness.app, ali.me.id, veli.me.id);
    befriend(harness.app, ali.me.id, ayse.me.id);
    const create = (options: Partial<CreateOptions>) =>
      createChallenge(harness!, ali, { ...SEKERSIZ, participantIds: [veli.me.id], ...options });

    const first = await create({});
    expect(first.statusCode).toBe(201);
    const others = [
      await create({ title: 'Tatlı Yok' }),
      await create({ endsAt: '2026-01-08T20:59:59.999Z' }),
      await create({ participantIds: [veli.me.id, ayse.me.id] }),
      await create({ rewardText: 'Kaybeden baklava alır' }),
    ];
    harness.advance(3 * 60_000);
    others.push(await create({}));

    expect(others.map((response) => response.statusCode)).toEqual([201, 201, 201, 201, 201]);
    const ids = new Set([first, ...others].map((response) => response.json<Challenge>().id));
    expect(ids.size).toBe(6);
    expect(listByType(harness.db, veli.me.id, 'challenge_invite')).toHaveLength(6);
  });

  it('requires deadlineTime for a check-in challenge', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const veli = await registerUser(harness.app, 'veli');
    befriend(harness.app, ali.me.id, veli.me.id);

    const missing = await createChallenge(harness, ali, { typeKey: 'erken_kus', participantIds: [veli.me.id] });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('validation');

    const ok = await createChallenge(harness, ali, {
      typeKey: 'erken_kus',
      participantIds: [veli.me.id],
      deadlineTime: '07:00',
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json<Challenge>().deadlineTime).toBe('07:00');
  });

  it("refuses a check-in deadline before the type's window opens", async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const veli = await registerUser(harness.app, 'veli');
    befriend(harness.app, ali.me.id, veli.me.id);

    // "gece yarısından önce yat": erken_yat opens at 19:00, so 00:30 would score every night 0
    const midnight = await createChallenge(harness, ali, {
      typeKey: 'erken_yat',
      participantIds: [veli.me.id],
      deadlineTime: '00:30',
    });
    expect(midnight.statusCode).toBe(400);
    // the 1.0 and 1.1 wizards allow any hour and show only the message: it has to say why
    expect(midnight.json().error).toMatchObject({
      code: 'deadline_outside_window',
      message: 'Check-in saati 19:00 sonrası, en geç 23:59 olmalı. Saati değiştirip tekrar dene.',
    });
  });

  it('plays every morning of a "5 gün" Erken Kalkan Koyar opened the evening before', async () => {
    harness = await makeApp({ now: '2026-12-31T19:00:00.000Z' }); // 22:00 on New Year's Eve
    const ali = await registerUser(harness.app, 'ali');
    const veli = await registerUser(harness.app, 'veli');
    befriend(harness.app, ali.me.id, veli.me.id);
    // the wizard's "Yarın" + 5 gün: from 04:00 on 1 January, when the window opens,
    // to the end of the 5th. It started at 09:00 and lost the first morning: 4-4.
    const created = await createChallenge(harness, ali, {
      typeKey: 'erken_kus',
      participantIds: [veli.me.id],
      deadlineTime: '07:00',
      startsAt: '2027-01-01T01:00:00.000Z',
      endsAt: '2027-01-05T20:59:59.999Z',
    });
    const challengeId = created.json<Challenge>().id;
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });

    for (let i = 0; i < 5; i++) {
      const day = addDays('2027-01-01', i);
      harness.setNow(`${day}T03:30:00.000Z`); // both up at 06:30
      runSchedulerOnce(harness.db, harness.now());
      for (const user of [ali, veli]) {
        const response = await postEntry(harness, user, challengeId, { dayKey: day, value: 1, source: 'checkin', clientTime: iso(harness) });
        expect({ day, user: user.me.username, status: response.statusCode }).toEqual({ day, user: user.me.username, status: 201 });
        expect(response.json().entry.value).toBe(1);
      }
    }

    harness.setNow('2027-01-06T00:00:00.000Z');
    runSchedulerOnce(harness.db, harness.now());
    const detail = (await authed(harness.app, ali.token)({ method: 'GET', url: `/challenges/${challengeId}` })).json<ChallengeDetail>();
    expect(detail.challenge.status).toBe('finished');
    expect(detail.participants.map((p) => p.score)).toEqual([5, 5]);
  });

  it('still takes the 09:00 start an older app sends for a check-in çelınc', async () => {
    harness = await makeApp({ now: '2026-12-31T19:00:00.000Z' });
    const ali = await registerUser(harness.app, 'ali');
    const veli = await registerUser(harness.app, 'veli');
    befriend(harness.app, ali.me.id, veli.me.id);
    const created = await createChallenge(harness, ali, {
      typeKey: 'erken_kus',
      participantIds: [veli.me.id],
      deadlineTime: '07:00',
      startsAt: '2027-01-01T06:00:00.000Z',
      endsAt: '2027-01-05T20:59:59.999Z',
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<Challenge>()).toMatchObject({ status: 'pending', startsAt: '2027-01-01T06:00:00.000Z' });
  });

  it('rejects an unknown type key', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const veli = await registerUser(harness.app, 'veli');
    befriend(harness.app, ali.me.id, veli.me.id);

    const response = await createChallenge(harness, ali, { typeKey: 'yok_boyle_bir_sey', participantIds: [veli.me.id] });
    expect(response.statusCode).toBe(400);
  });

  it('needs a token', async () => {
    harness = await makeApp({ now: NOW });
    const response = await harness.app.inject({ method: 'GET', url: '/challenges' });
    expect(response.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Listing and detail
// ---------------------------------------------------------------------------

describe('GET /challenges', () => {
  it('lists mine (accepted or invited), active first then pending', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const veli = await registerUser(harness.app, 'veli');
    befriend(harness.app, ali.me.id, veli.me.id);

    const active = await createChallenge(harness, ali, { participantIds: [veli.me.id], title: 'Aktif' });
    const pending = await createChallenge(harness, ali, {
      participantIds: [veli.me.id],
      title: 'Bekleyen',
      startsAt: iso(harness, 2 * 60 * 60 * 1000),
      endsAt: iso(harness, 48 * 60 * 60 * 1000),
    });
    expect(active.statusCode).toBe(201);
    expect(pending.statusCode).toBe(201);

    const list = await authed(harness.app, ali.token)({ method: 'GET', url: '/challenges' });
    const titles = list.json<{ challenge: { title: string } }[]>().map((s) => s.challenge.title);
    expect(titles).toEqual(['Aktif', 'Bekleyen']);

    // Invited-but-not-accepted still sees it.
    const veliList = await authed(harness.app, veli.token)({ method: 'GET', url: '/challenges' });
    expect(veliList.json<unknown[]>()).toHaveLength(2);
  });

  it('filters on a comma separated status list', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const veli = await registerUser(harness.app, 'veli');
    befriend(harness.app, ali.me.id, veli.me.id);

    await createChallenge(harness, ali, { participantIds: [veli.me.id], title: 'Aktif' });
    await createChallenge(harness, ali, {
      participantIds: [veli.me.id],
      title: 'Bekleyen',
      startsAt: iso(harness, 2 * 60 * 60 * 1000),
      endsAt: iso(harness, 48 * 60 * 60 * 1000),
    });

    const pendingOnly = await authed(harness.app, ali.token)({ method: 'GET', url: '/challenges?status=pending' });
    expect(pendingOnly.json<{ challenge: { title: string } }[]>().map((s) => s.challenge.title)).toEqual(['Bekleyen']);

    const both = await authed(harness.app, ali.token)({ method: 'GET', url: '/challenges?status=active,pending' });
    expect(both.json<unknown[]>()).toHaveLength(2);

    const bogus = await authed(harness.app, ali.token)({ method: 'GET', url: '/challenges?status=uyduruk' });
    expect(bogus.statusCode).toBe(400);
  });
});

describe('GET /challenges/:id', () => {
  it('returns the detail for a participant and 404 for everybody else', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await twoPlayerChallenge(harness);
    const outsider = await registerUser(harness.app, 'yabanci');

    await postEntry(harness, ali, challengeId, {
      dayKey: today(harness),
      value: 5000,
      source: 'pedometer',
      clientTime: iso(harness),
    });

    const mine = await authed(harness.app, ali.token)({ method: 'GET', url: `/challenges/${challengeId}` });
    expect(mine.statusCode).toBe(200);
    const detail = mine.json<ChallengeDetail>();
    expect(detail.myEntries).toHaveLength(1);
    expect(detail.feed[0].displayName).toBe('Ali');
    expect(detail.disputes).toEqual([]);
    expect(detail.taunts).toEqual([]);
    expect(detail.canTaunt).toEqual([]);
    expect(detail.canPoke).toBe(true);
    expect(detail.me?.score).toBe(5000);

    const theirs = await authed(harness.app, veli.token)({ method: 'GET', url: `/challenges/${challengeId}` });
    expect(theirs.json<ChallengeDetail>().myEntries).toEqual([]);

    const denied = await authed(harness.app, outsider.token)({ method: 'GET', url: `/challenges/${challengeId}` });
    expect(denied.statusCode).toBe(404);

    const missing = await authed(harness.app, ali.token)({ method: 'GET', url: '/challenges/yok' });
    expect(missing.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Invite lifecycle
// ---------------------------------------------------------------------------

describe('accept / decline / leave / cancel', () => {
  it('accepts an invite once', async () => {
    harness = await makeApp({ now: NOW });
    const { veli, challengeId } = await twoPlayerChallenge(harness);
    const again = await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('already_accepted');
  });

  it('refuses to accept in the last hour', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const veli = await registerUser(harness.app, 'veli');
    befriend(harness.app, ali.me.id, veli.me.id);
    const created = await createChallenge(harness, ali, { participantIds: [veli.me.id] });
    const id = created.json<Challenge>().id;

    harness.advance(3 * 24 * 60 * 60 * 1000 - 30 * 60 * 1000); // 30 minutes left
    const response = await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${id}/accept` });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('accept_closed');
  });

  it('sends the instant it stops taking players, the one the accept route refuses from', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const veli = await registerUser(harness.app, 'veli');
    befriend(harness.app, ali.me.id, veli.me.id);
    const created = (await createChallenge(harness, ali, { participantIds: [veli.me.id] })).json<Challenge>();
    // three days long: the door closes an hour before the end
    const closesAt = new Date(Date.parse(created.endsAt) - LIMITS.ACCEPT_CUTOFF_MS).toISOString();
    expect(created.acceptClosesAt).toBe(closesAt);

    // the invitee's home list and çelınc screen carry it too
    const list = await authed(harness.app, veli.token)({ method: 'GET', url: '/challenges' });
    expect(list.json<{ challenge: Challenge }[]>()[0]!.challenge.acceptClosesAt).toBe(closesAt);
    const detail = await authed(harness.app, veli.token)({ method: 'GET', url: `/challenges/${created.id}` });
    expect(detail.json<ChallengeDetail>().challenge.acceptClosesAt).toBe(closesAt);

    harness.setNow(closesAt);
    const late = await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${created.id}/accept` });
    expect(late.statusCode).toBe(400);
    expect(late.json().error.code).toBe('accept_closed');
  });

  it('declines an invite', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const veli = await registerUser(harness.app, 'veli');
    befriend(harness.app, ali.me.id, veli.me.id);
    const created = await createChallenge(harness, ali, { participantIds: [veli.me.id] });
    const id = created.json<Challenge>().id;

    const declined = await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${id}/decline` });
    expect(declined.statusCode).toBe(200);
    expect(declined.json<ChallengeDetail>().me?.status).toBe('declined');

    const again = await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${id}/decline` });
    expect(again.statusCode).toBe(409);

    // A declined invite drops off the list.
    const list = await authed(harness.app, veli.token)({ method: 'GET', url: '/challenges' });
    expect(list.json<unknown[]>()).toHaveLength(0);
  });

  // Invites are mostly answered on the home card or the çelınc screen, not from
  // Gelen, and the badge went on counting every one of them.
  it('reads the invite in Gelen once it is answered, and only that çelınc\'s', async () => {
    harness = await makeApp({ now: NOW });
    const h = harness;
    const ali = await registerUser(h.app, 'ali');
    const veli = await registerUser(h.app, 'veli');
    const ayse = await registerUser(h.app, 'ayse');
    befriend(h.app, ali.me.id, veli.me.id);
    befriend(h.app, ali.me.id, ayse.me.id);
    befriend(h.app, veli.me.id, ayse.me.id);
    const veliCall = authed(h.app, veli.token);
    // four çelıncs, not one sent four times (a retry lands on the first)
    const create = async (title: string) =>
      (await createChallenge(h, ali, { title, participantIds: [veli.me.id, ayse.me.id] })).json<Challenge>().id;
    const veliInvite = (challengeId: string) =>
      h.db
        .prepare(
          "SELECT read_at FROM notifications WHERE user_id = ? AND type = 'challenge_invite' AND json_extract(data, '$.challengeId') = ?",
        )
        .get(veli.me.id, challengeId) as { read_at: string | null };

    const first = await create('Bir');
    const second = await create('İki');
    const third = await create('Üç');
    const untouched = await create('Dört');
    expect((await veliCall({ method: 'GET', url: '/me/inbox/unread' })).json<{ count: number }>().count).toBe(4);

    h.advance(60_000);
    expect((await veliCall({ method: 'POST', url: `/challenges/${first}/accept` })).statusCode).toBe(200);
    expect(veliInvite(first).read_at).toBe(h.now().toISOString());
    expect((await veliCall({ method: 'POST', url: `/challenges/${second}/accept` })).statusCode).toBe(200);
    expect((await veliCall({ method: 'POST', url: `/challenges/${third}/decline` })).statusCode).toBe(200);

    // the accepts add their own news, so the rows and not the count say it
    for (const id of [first, second, third]) expect(veliInvite(id).read_at).not.toBeNull();
    expect(veliInvite(untouched).read_at).toBeNull();
    // somebody else's invite to the same çelınc is theirs to answer
    const ayseInvites = listByType(h.db, ayse.me.id, 'challenge_invite');
    expect(ayseInvites).toHaveLength(4);
    expect(ayseInvites.every((row) => row.read_at === null)).toBe(true);

    // an invite brought by "Kanka ekle" after a no, answered with an invitee's "Ayrıl"
    const reInvited = await authed(h.app, ali.token)({
      method: 'POST',
      url: `/challenges/${third}/invite`,
      payload: { userIds: [veli.me.id] },
    });
    expect(reInvited.statusCode).toBe(200);
    const unreadAgain = listByType(h.db, veli.me.id, 'challenge_invite').filter((row) => row.read_at === null);
    expect(unreadAgain).toHaveLength(2);
    expect((await veliCall({ method: 'POST', url: `/challenges/${third}/leave` })).statusCode).toBe(200);
    const stillUnread = listByType(h.db, veli.me.id, 'challenge_invite').filter((row) => row.read_at === null);
    expect(stillUnread.map((row) => JSON.parse(row.data).challengeId)).toEqual([untouched]);
  });

  it('reads a rematch invite in Gelen once it is answered', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await finishedChallenge(harness);
    const rematch = await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` });
    const rematchId = rematch.json<Challenge>().id;
    const [row] = listByType(harness.db, veli.me.id, 'rematch');
    expect(row?.read_at).toBeNull();

    const accepted = await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${rematchId}/accept` });
    expect(accepted.statusCode).toBe(200);
    expect(listByType(harness.db, veli.me.id, 'rematch')[0]?.read_at).not.toBeNull();
  });

  it('leaves an active challenge, which head to head ends it', async () => {
    harness = await makeApp({ now: NOW });
    const { veli, challengeId } = await twoPlayerChallenge(harness);
    const left = await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/leave` });
    expect(left.statusCode).toBe(200);
    expect(left.json<ChallengeDetail>().me?.status).toBe('left');
    // nobody left to race: cancelled now, not at the end date
    expect(left.json<ChallengeDetail>().challenge.status).toBe('cancelled');

    const again = await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/leave` });
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe('challenge_closed');
  });

  it('takes a declined invite back while the çelınc still runs', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const veli = await registerUser(harness.app, 'veli');
    const cem = await registerUser(harness.app, 'cem');
    befriend(harness.app, ali.me.id, veli.me.id);
    befriend(harness.app, ali.me.id, cem.me.id);
    const created = await createChallenge(harness, ali, { participantIds: [veli.me.id, cem.me.id] });
    const id = created.json<Challenge>().id;
    const veliCall = authed(harness.app, veli.token);

    // Cem has not answered yet, so the çelınc is still on
    const declined = await veliCall({ method: 'POST', url: `/challenges/${id}/decline` });
    expect(declined.json<ChallengeDetail>().challenge.status).toBe('active');

    const back = await veliCall({ method: 'POST', url: `/challenges/${id}/accept` });
    expect(back.statusCode).toBe(200);
    expect(back.json<ChallengeDetail>().me?.status).toBe('accepted');
    expect((await veliCall({ method: 'GET', url: '/challenges' })).json<unknown[]>()).toHaveLength(1);
  });

  // Older apps show an invitee "Ayrıl" next to "Varım" and "Yokum". Stored as
  // `left`, it locked the friend out: no "Katıl", and "Kanka ekle" hid them.
  it('stores an invitee\'s "Ayrıl" as a no, which they can take back or be asked again', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    const cem = await registerUser(harness.app, 'cem', { displayName: 'Cem' });
    befriend(harness.app, ali.me.id, veli.me.id);
    befriend(harness.app, ali.me.id, cem.me.id);
    const id = (await createChallenge(harness, ali, { participantIds: [veli.me.id, cem.me.id] })).json<Challenge>().id;
    const leave = (user: RegisteredUser) => authed(harness!.app, user.token)({ method: 'POST', url: `/challenges/${id}/leave` });

    // Cem has not answered, so the çelınc goes on without Veli
    const no = await leave(veli);
    expect(no.statusCode).toBe(200);
    expect(no.json<ChallengeDetail>().me?.status).toBe('declined');
    expect(no.json<ChallengeDetail>().challenge.status).toBe('active');
    // the inviter hears a no, and nobody a walk-out
    expect(listByType(harness.db, ali.me.id, 'challenge_declined').map((row) => JSON.parse(row.data))).toEqual([
      { challengeId: id, fromUserId: veli.me.id },
    ]);
    for (const user of [ali, veli, cem]) expect(listByType(harness.db, user.me.id, 'challenge_left')).toHaveLength(0);

    // the app's "Katıl" takes it back
    const back = await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${id}/accept` });
    expect(back.statusCode).toBe(200);
    expect(back.json<ChallengeDetail>().me?.status).toBe('accepted');

    // and the creator may ask again
    expect((await leave(cem)).json<ChallengeDetail>().me?.status).toBe('declined');
    const asked = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${id}/invite`,
      payload: { userIds: [cem.me.id] },
    });
    expect(asked.statusCode).toBe(200);
    expect(asked.json<ChallengeDetail>().participants.find((p) => p.user.id === cem.me.id)?.status).toBe('invited');
    expect(listByType(harness.db, cem.me.id, 'challenge_invite')).toHaveLength(2);

    // a player who walks out is still gone for good
    const out = await leave(veli);
    expect(out.json<ChallengeDetail>().me?.status).toBe('left');
    expect(listByType(harness.db, ali.me.id, 'challenge_left').map((row) => JSON.parse(row.data))).toEqual([
      { challengeId: id, fromUserId: veli.me.id },
    ]);
  });

  it('cancels a pending challenge as the creator only', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { vulgarityMax: 3 });
    befriend(harness.app, ali.me.id, veli.me.id);
    const created = await createChallenge(harness, ali, {
      participantIds: [veli.me.id],
      startsAt: iso(harness, 2 * 60 * 60 * 1000),
      endsAt: iso(harness, 48 * 60 * 60 * 1000),
    });
    const id = created.json<Challenge>().id;

    const notCreator = await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${id}/cancel` });
    expect(notCreator.statusCode).toBe(403);
    expect(notCreator.json().error.code).toBe('not_creator');

    const cancelled = await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${id}/cancel` });
    expect(cancelled.statusCode).toBe(200);
    // accept / decline / leave / cancel all answer with the full detail so the
    // app can repaint the screen from the response.
    expect(cancelled.json<ChallengeDetail>().challenge.status).toBe('cancelled');

    const inbox = listByType(harness.db, veli.me.id, 'challenge_cancelled');
    expect(inbox).toHaveLength(1);
    expect(inbox[0].title).toBe('Çelınc iptal 🍆'); // Veli is level 3

    const again = await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${id}/cancel` });
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe('challenge_started');
  });

  it('tells an invitee who blocked the creator that it is off, without the creator\'s name', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const invitees = await Promise.all(
      ([1, 2, 3] as const).map((level) =>
        registerUser(harness!.app, `davetli${level}`, { displayName: `Davetli${level}`, vulgarityMax: level }),
      ),
    );
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    for (const friend of [...invitees, veli]) befriend(harness.app, ali.me.id, friend.me.id);
    const created = await createChallenge(harness, ali, {
      title: 'Pazar Yürüyüşü',
      participantIds: [...invitees, veli].map((friend) => friend.me.id),
      startsAt: iso(harness, 2 * 60 * 60 * 1000),
      endsAt: iso(harness, 48 * 60 * 60 * 1000),
    });
    const id = created.json<Challenge>().id;
    for (const invitee of invitees) {
      const blocked = await authed(harness.app, invitee.token)({ method: 'POST', url: `/users/${ali.me.id}/block` });
      expect(blocked.statusCode).toBe(200);
    }

    const cancelled = await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${id}/cancel` });
    expect(cancelled.statusCode).toBe(200);

    const bodies = invitees.map((invitee) => listByType(harness!.db, invitee.me.id, 'challenge_cancelled')[0]?.body);
    expect(bodies).toEqual([
      '"Pazar Yürüyüşü" çelıncı iptal edildi.',
      '"Pazar Yürüyüşü" çelıncı iptal oldu.',
      '"Pazar Yürüyüşü" çelıncı yattı, iptal 🍆',
    ]);
    for (const body of bodies) {
      for (const junk of ['Ali', 'undefined', 'null', 'NaN', '[object', '{']) expect(body).not.toContain(junk);
    }
    // nothing between Veli and Ali: he hears who called it off
    expect(listByType(harness.db, veli.me.id, 'challenge_cancelled')[0]?.body).toBe(
      'Ali "Pazar Yürüyüşü" çelıncını iptal etti.',
    );
  });

  it('refuses to cancel one whose start passed with two yeses, before the scheduler gets to it', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    befriend(harness.app, ali.me.id, veli.me.id);
    const created = await createChallenge(harness, ali, {
      participantIds: [veli.me.id],
      startsAt: iso(harness, 2 * 60 * 60 * 1000),
      endsAt: iso(harness, 48 * 60 * 60 * 1000),
    });
    const id = created.json<Challenge>().id;
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${id}/accept` });
    // past the start, no scheduler pass yet (the owner's PC just woke)
    harness.advance(3 * 60 * 60 * 1000);

    const response = await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${id}/cancel` });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('challenge_started');
  });

  it('reads as started the moment its start passes with two yeses, before the scheduler gets to it', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    befriend(harness.app, ali.me.id, veli.me.id);
    const created = await createChallenge(harness, ali, {
      participantIds: [veli.me.id],
      startsAt: iso(harness, 2 * 60 * 60 * 1000),
      endsAt: iso(harness, 48 * 60 * 60 * 1000),
    });
    const id = created.json<Challenge>().id;
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${id}/accept` });
    // the screen's countdown ran out and it asked at once; the scheduler's beat is up to 30 s off
    harness.advance(2 * 60 * 60 * 1000 + 2_000);

    const detail = await authed(harness.app, veli.token)({ method: 'GET', url: `/challenges/${id}` });
    expect(detail.json<ChallengeDetail>().challenge.status).toBe('active');
    const list = await authed(harness.app, ali.token)({ method: 'GET', url: '/challenges' });
    expect(list.json<{ challenge: Challenge }[]>().find((row) => row.challenge.id === id)?.challenge.status).toBe('active');
  });

  it('refuses to cancel a started challenge', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await twoPlayerChallenge(harness);
    const response = await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${challengeId}/cancel` });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('challenge_started');
  });
});

// ---------------------------------------------------------------------------
// Saying yes
// ---------------------------------------------------------------------------

describe('saying yes: who hears it', () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  function accept(h: TestApp, user: RegisteredUser, challengeId: string) {
    return authed(h.app, user.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
  }

  function titles(h: TestApp, user: RegisteredUser, type: 'challenge_accepted' | 'challenge_started') {
    return listByType(h.db, user.me.id, type).map((row) => row.title);
  }

  /** Ali (polite) with two friends: Veli (crude) and Cem (casual). */
  async function trio(h: TestApp) {
    const ali = await registerUser(h.app, 'ali', { displayName: 'Ali', vulgarityMax: 1 });
    const veli = await registerUser(h.app, 'veli', { displayName: 'Veli', vulgarityMax: 3 });
    const cem = await registerUser(h.app, 'cem', { displayName: 'Cem', vulgarityMax: 2 });
    befriend(h.app, ali.me.id, veli.me.id);
    befriend(h.app, ali.me.id, cem.me.id);
    return { ali, veli, cem };
  }

  it('starts a "Hemen" çelınc for both players on the first yes, and tells the players about the next one', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, cem } = await trio(harness);
    const created = await createChallenge(harness, ali, { participantIds: [veli.me.id, cem.me.id] });
    const id = created.json<Challenge>().id;
    expect(created.json<Challenge>().status).toBe('active');

    expect((await accept(harness, veli, id)).statusCode).toBe(200);
    // the scheduler only starts pending ones: this yes is the start
    expect(titles(harness, ali, 'challenge_started')).toEqual(['🔔 Çelınc başladı']);
    expect(titles(harness, veli, 'challenge_started')).toEqual(['🍆 ÇELINC BAŞLADI']);
    expect(JSON.parse(listByType(harness.db, ali.me.id, 'challenge_started')[0]!.data)).toEqual({ challengeId: id });
    expect(titles(harness, ali, 'challenge_accepted')).toEqual([]);

    harness.advance(HOUR);
    await accept(harness, cem, id);
    const [toAli] = listByType(harness.db, ali.me.id, 'challenge_accepted');
    expect(toAli!.title).toBe('Cem kabul etti');
    expect(toAli!.body).toBe('Cem, "Adım Yarışı" çelıncına katıldı. Artık 3 kişisiniz.');
    expect(JSON.parse(toAli!.data)).toEqual({ challengeId: id, fromUserId: cem.me.id });
    expect(listByType(harness.db, veli.me.id, 'challenge_accepted').map((row) => [row.title, row.body])).toEqual([
      ['Cem sahaya indi 🍆', '"Adım Yarışı" çelıncına daldı, kurban sayısı 3 oldu.'],
    ]);
    expect(titles(harness, cem, 'challenge_accepted')).toEqual([]);
    // it started once, before Cem came
    expect(titles(harness, ali, 'challenge_started')).toHaveLength(1);
    expect(titles(harness, cem, 'challenge_started')).toEqual([]);
  });

  it('does not start a running çelınc twice when a yes brings it back to two', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, cem } = await trio(harness);
    const id = (await createChallenge(harness, ali, { participantIds: [veli.me.id, cem.me.id] })).json<Challenge>().id;
    await accept(harness, veli, id);
    // Cem has not answered, so the çelınc goes on without Veli
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${id}/leave` });

    harness.advance(HOUR);
    await accept(harness, cem, id);
    expect(titles(harness, ali, 'challenge_started')).toHaveLength(1);
    expect(titles(harness, ali, 'challenge_accepted')).toEqual(['Cem kabul etti']);
    expect(listByType(harness.db, ali.me.id, 'challenge_accepted')[0]!.body).toContain('Artık 2 kişisiniz.');
  });

  it('tells only the creator about each yes before the start, and the scheduler starts it once', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, cem } = await trio(harness);
    const created = await createChallenge(harness, ali, {
      participantIds: [veli.me.id, cem.me.id],
      startsAt: iso(harness, 2 * HOUR),
      endsAt: iso(harness, 3 * DAY),
    });
    const id = created.json<Challenge>().id;

    await accept(harness, veli, id);
    harness.advance(10 * 60 * 1000);
    await accept(harness, cem, id);
    expect(listByType(harness.db, ali.me.id, 'challenge_accepted').map((row) => row.body)).toEqual([
      'Cem, "Adım Yarışı" çelıncına katıldı. Artık 3 kişisiniz.',
      'Veli, "Adım Yarışı" çelıncına katıldı. Artık 2 kişisiniz.',
    ]);
    // the creator is the one waiting for answers
    expect(titles(harness, veli, 'challenge_accepted')).toEqual([]);
    expect(titles(harness, ali, 'challenge_started')).toEqual([]);

    harness.advance(2 * HOUR);
    expect(runSchedulerOnce(harness.db, harness.now()).activated).toBe(1);
    for (const user of [ali, veli, cem]) expect(titles(harness, user, 'challenge_started')).toHaveLength(1);
  });

  it('leaves a çelınc already past its start time to the scheduler, which says "başladı" once', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli } = await trio(harness);
    const created = await createChallenge(harness, ali, {
      participantIds: [veli.me.id],
      startsAt: iso(harness, HOUR),
      endsAt: iso(harness, 3 * DAY),
    });
    const id = created.json<Challenge>().id;
    harness.advance(2 * HOUR);
    // alone, the creator's çelınc does not start
    expect(runSchedulerOnce(harness.db, harness.now()).activated).toBe(0);

    const accepted = await accept(harness, veli, id);
    expect(accepted.json<ChallengeDetail>().challenge.status).toBe('pending');
    expect(titles(harness, ali, 'challenge_accepted')).toEqual([]);
    expect(titles(harness, ali, 'challenge_started')).toEqual([]);

    harness.advance(30 * 1000);
    expect(runSchedulerOnce(harness.db, harness.now()).activated).toBe(1);
    runSchedulerOnce(harness.db, harness.now());
    expect(titles(harness, ali, 'challenge_started')).toEqual(['🔔 Çelınc başladı']);
    expect(titles(harness, veli, 'challenge_started')).toEqual(['🍆 ÇELINC BAŞLADI']);
  });

  it('starts a morning check-in çelınc at 04:00 without waking anybody up to say so', async () => {
    harness = await makeApp({ now: '2026-12-31T19:00:00.000Z' }); // 22:00 in Istanbul
    const { ali, veli } = await trio(harness);
    const tokyo = await registerUser(harness.app, 'kenji', { displayName: 'Kenji', timezone: 'Asia/Tokyo' });
    befriend(harness.app, ali.me.id, tokyo.me.id);
    // the wizard's "Yarın 04:00" and "Yarın 09:00"
    const morning = (
      await createChallenge(harness, ali, {
        typeKey: 'erken_kus',
        participantIds: [veli.me.id, tokyo.me.id],
        deadlineTime: '07:00',
        startsAt: '2027-01-01T01:00:00.000Z',
        endsAt: '2027-01-05T20:59:59.999Z',
      })
    ).json<Challenge>().id;
    const evening = (
      await createChallenge(harness, ali, {
        typeKey: 'erken_yat',
        participantIds: [veli.me.id],
        deadlineTime: '23:00',
        startsAt: '2027-01-01T06:00:00.000Z',
        endsAt: '2027-01-05T20:59:59.999Z',
      })
    ).json<Challenge>().id;
    for (const user of [veli, tokyo]) await accept(harness, user, morning);
    await accept(harness, veli, evening);

    harness.setNow('2027-01-01T01:00:20.000Z');
    expect(runSchedulerOnce(harness.db, harness.now()).activated).toBe(1);
    const started = (user: RegisteredUser) =>
      listByType(harness!.db, user.me.id, 'challenge_started').map((row) => JSON.parse(row.data).challengeId as string);
    // 04:00 in Istanbul: the 06:30 reminder is the first thing they hear; it is 10:00 in Tokyo
    expect(started(ali)).toEqual([]);
    expect(started(veli)).toEqual([]);
    expect(started(tokyo)).toEqual([morning]);

    harness.setNow('2027-01-01T06:00:20.000Z');
    expect(runSchedulerOnce(harness.db, harness.now()).activated).toBe(1);
    expect(started(ali)).toEqual([evening]);
    expect(started(veli)).toEqual([evening]);
  });

  it('says "başladı" before 07:00 to a morning check-in no phone had a reminder for', async () => {
    harness = await makeApp({ now: '2026-12-31T19:00:00.000Z' }); // 22:00 in Istanbul
    const { ali, veli, cem } = await trio(harness);
    // "Yarın 04:00", and nobody but Ali is in when it opens
    const late = (
      await createChallenge(harness, ali, {
        typeKey: 'erken_kus',
        participantIds: [veli.me.id],
        deadlineTime: '07:00',
        startsAt: '2027-01-01T01:00:00.000Z',
        endsAt: '2027-01-05T20:59:59.999Z',
      })
    ).json<Challenge>().id;
    // both in the evening before, but a 04:20 deadline is 20 minutes after the start:
    // the phone's reminder half an hour before it would ring before the çelınc began
    const tight = (
      await createChallenge(harness, ali, {
        typeKey: 'erken_kus',
        participantIds: [cem.me.id],
        deadlineTime: '04:20',
        startsAt: '2027-01-01T01:00:00.000Z',
        endsAt: '2027-01-05T20:59:59.999Z',
      })
    ).json<Challenge>().id;
    await accept(harness, cem, tight);
    const started = (user: RegisteredUser) =>
      listByType(harness!.db, user.me.id, 'challenge_started').map((row) => JSON.parse(row.data).challengeId as string);

    harness.setNow('2027-01-01T01:00:20.000Z');
    expect(runSchedulerOnce(harness.db, harness.now()).activated).toBe(1);
    expect(started(ali)).toEqual([tight]);
    expect(started(cem)).toEqual([tight]);

    // 05:45: Veli wakes up and says yes; Ali's phone left out a çelınc he was alone in
    harness.setNow('2027-01-01T02:45:00.000Z');
    expect((await accept(harness, veli, late)).statusCode).toBe(200);
    expect(titles(harness, ali, 'challenge_accepted')).toEqual(['Cem kabul etti']);
    harness.advance(20 * 1000);
    expect(runSchedulerOnce(harness.db, harness.now()).activated).toBe(1);
    expect(started(ali)).toEqual([late, tight]);
    expect(started(veli)).toEqual([late]);
  });

  it('lets nobody in past a block with a player, and says nothing to an account that is gone', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, cem } = await trio(harness);
    const can = await registerUser(harness.app, 'can', { displayName: 'Can' });
    befriend(harness.app, ali.me.id, can.me.id);
    const id = (
      await createChallenge(harness, ali, { participantIds: [veli.me.id, cem.me.id, can.me.id] })
    ).json<Challenge>().id;
    await accept(harness, veli, id);
    harness.advance(60 * 1000);
    await accept(harness, cem, id);
    // Veli wants nothing to do with Can: Can's yes is refused, without saying
    // who blocked whom, and nobody hears one
    await authed(harness.app, veli.token)({ method: 'POST', url: `/users/${can.me.id}/block` });
    harness.advance(60 * 1000);
    const refused = await accept(harness, can, id);
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ error: { code: string; message: string } }>().error).toEqual({
      code: 'blocked_in_challenge',
      message: 'Bu çelınca katılamazsın.',
    });
    expect(titles(harness, ali, 'challenge_accepted')).toEqual(['Cem kabul etti']);

    // the block lifted; Cem's account is gone while still on the line-up (the
    // route keeps that from happening, the guard holds anyway)
    await authed(harness.app, veli.token)({ method: 'POST', url: `/users/${can.me.id}/unblock` });
    harness.db.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').run(iso(harness), cem.me.id);
    harness.advance(60 * 1000);
    expect((await accept(harness, can, id)).statusCode).toBe(200);
    expect(titles(harness, ali, 'challenge_accepted')).toEqual(['Can kabul etti', 'Cem kabul etti']);
    expect(titles(harness, veli, 'challenge_accepted')).toEqual(['Can sahaya indi 🍆', 'Cem sahaya indi 🍆']);
    expect(titles(harness, cem, 'challenge_accepted')).toEqual([]);
  });
});

describe('saying yes: the days the phone already sent', () => {
  const DAY = 24 * 60 * 60 * 1000;

  function entryRows(h: TestApp, challengeId: string, userId: string) {
    return h.db
      .prepare('SELECT day_key, value, source FROM entries WHERE challenge_id = ? AND user_id = ? ORDER BY day_key ASC')
      .all(challengeId, userId) as { day_key: string; value: number; source: string }[];
  }

  async function pair(h: TestApp, typeKey = 'adim_yarisi', days = 5) {
    const ali = await registerUser(h.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(h.app, 'veli', { displayName: 'Veli' });
    befriend(h.app, ali.me.id, veli.me.id);
    const created = await createChallenge(h, ali, { typeKey, participantIds: [veli.me.id], endsAt: iso(h, days * DAY) });
    return { ali, veli, challengeId: created.json<Challenge>().id };
  }

  it('fills in the step days a friend\'s phone reported before they said yes', async () => {
    harness = await makeApp({ now: NOW });
    const { veli, challengeId } = await pair(harness);
    harness.advance(2 * DAY);
    const start = addDays(today(harness), -2);
    const days = [
      // the day before the çelınc is not one of its days
      { dayKey: addDays(start, -1), steps: 20000, source: 'pedometer' },
      { dayKey: start, steps: 8000, source: 'pedometer' },
      { dayKey: addDays(start, 1), steps: 9000, source: 'health_connect' },
      { dayKey: addDays(start, 2), steps: 4000, source: 'pedometer' },
    ];
    const synced = await authed(harness.app, veli.token)({ method: 'POST', url: '/me/steps', payload: { days } });
    // not in it yet: nothing to fan out to
    expect(synced.json<{ updated: number }>().updated).toBe(0);

    const accepted = await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    expect(entryRows(harness, challengeId, veli.me.id)).toEqual([
      { day_key: start, value: 8000, source: 'pedometer' },
      { day_key: addDays(start, 1), value: 9000, source: 'health_connect' },
      { day_key: addDays(start, 2), value: 4000, source: 'pedometer' },
    ]);
    // the answer already shows them, no second sync needed
    const detail = accepted.json<ChallengeDetail>();
    expect(detail.participants.find((p) => p.user.id === veli.me.id)?.score).toBe(21000);
  });

  it('leaves out a day older than the phone may fill in', async () => {
    harness = await makeApp({ now: NOW });
    const { veli, challengeId } = await pair(harness, 'adim_yarisi', 14);
    const call = authed(harness.app, veli.token);
    const start = today(harness);
    await call({ method: 'POST', url: '/me/steps', payload: { days: [{ dayKey: start, steps: 15000, source: 'pedometer' }] } });

    harness.advance((LIMITS.STEPS_BACKFILL_DAYS + 2) * DAY);
    const oldest = addDays(today(harness), -LIMITS.STEPS_BACKFILL_DAYS);
    await call({
      method: 'POST',
      url: '/me/steps',
      payload: {
        days: [
          { dayKey: oldest, steps: 7000, source: 'pedometer' },
          { dayKey: today(harness), steps: 3000, source: 'pedometer' },
        ],
      },
    });

    await call({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    // a typed entry could not go that far back either
    expect(entryRows(harness, challengeId, veli.me.id)).toEqual([
      { day_key: oldest, value: 7000, source: 'pedometer' },
      { day_key: today(harness), value: 3000, source: 'pedometer' },
    ]);
  });

  it('fills an Ekran Süresi çelınc from the minutes the phone already sent', async () => {
    harness = await makeApp({ now: NOW });
    const { veli, challengeId } = await pair(harness, 'ekran_suresi_beyani');
    harness.advance(DAY);
    const call = authed(harness.app, veli.token);
    const days = [
      { dayKey: addDays(today(harness), -1), minutes: 240 },
      { dayKey: today(harness), minutes: 90 },
    ];
    await call({ method: 'POST', url: '/me/screen-time', payload: { days } });

    await call({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    expect(entryRows(harness, challengeId, veli.me.id)).toEqual([
      { day_key: addDays(today(harness), -1), value: 240, source: 'usage_stats' },
      { day_key: today(harness), value: 90, source: 'usage_stats' },
    ]);
  });

  it('writes nothing for a çelınc the phone does not count', async () => {
    harness = await makeApp({ now: NOW });
    const { veli, challengeId } = await pair(harness, 'kitap_sayfa');
    const call = authed(harness.app, veli.token);
    await call({ method: 'POST', url: '/me/steps', payload: { days: [{ dayKey: today(harness), steps: 15000, source: 'pedometer' }] } });
    await call({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    expect(entryRows(harness, challengeId, veli.me.id)).toEqual([]);
  });
});

describe('how fresh a phone\'s count is', () => {
  const HOUR = 60 * 60 * 1000;

  async function syncSteps(h: TestApp, user: RegisteredUser, steps: number) {
    const response = await authed(h.app, user.token)({
      method: 'POST',
      url: '/me/steps',
      payload: { days: [{ dayKey: today(h), steps, source: 'pedometer' }] },
    });
    expect(response.statusCode).toBe(200);
  }

  async function detailFor(h: TestApp, user: RegisteredUser, challengeId: string) {
    return (await authed(h.app, user.token)({ method: 'GET', url: `/challenges/${challengeId}` })).json<ChallengeDetail>();
  }

  it('stamps every sync on the standings, and the feed row with the last time its number moved', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await twoPlayerChallenge(harness);
    const first = iso(harness);
    await syncSteps(harness, veli, 4201);

    // the same count two hours later: the phone spoke, the number did not move
    harness.advance(2 * HOUR);
    await syncSteps(harness, veli, 4201);
    let detail = await detailFor(harness, ali, challengeId);
    expect(detail.participants.find((p) => p.user.id === veli.me.id)?.lastSyncAt).toBe(iso(harness));
    // Ali's phone never reported
    expect(detail.participants.find((p) => p.user.id === ali.me.id)?.lastSyncAt).toBeNull();
    let row = detail.feed.find((item) => item.userId === veli.me.id);
    expect(row?.createdAt).toBe(first);
    expect(row?.updatedAt).toBe(first);

    harness.advance(HOUR);
    await syncSteps(harness, veli, 11000);
    detail = await detailFor(harness, ali, challengeId);
    row = detail.feed.find((item) => item.userId === veli.me.id);
    expect(row?.createdAt).toBe(first);
    expect(row?.updatedAt).toBe(iso(harness));
    expect(detail.participants.find((p) => p.user.id === veli.me.id)?.lastSyncAt).toBe(iso(harness));

    // a result is not a race any more: nothing to be stale against
    await harness.app.inject({ method: 'POST', url: `/dev/finalize/${challengeId}` });
    detail = await detailFor(harness, ali, challengeId);
    expect(detail.participants.every((p) => p.lastSyncAt === null)).toBe(true);
  });

  it('says nothing about a phone gone quiet under a player who types now', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await twoPlayerChallenge(harness);
    // both had a phone that synced a month ago, and neither has since
    const monthAgo = new Date(harness.now().getTime() - 30 * 24 * HOUR).toISOString();
    const oldDay = monthAgo.slice(0, 10);
    for (const user of [ali, veli]) {
      harness.db
        .prepare("INSERT INTO steps_daily (user_id, day_key, steps, source, updated_at) VALUES (?, ?, 8000, 'pedometer', ?)")
        .run(user.me.id, oldDay, monthAgo);
    }
    // Veli is on an iPhone now and types his steps
    harness.advance(HOUR);
    await postEntry(harness, veli, challengeId, { dayKey: today(harness), value: 6000, source: 'manual', clientTime: iso(harness) });

    let detail = await detailFor(harness, ali, challengeId);
    expect(detail.participants.find((p) => p.user.id === veli.me.id)?.lastSyncAt).toBeNull();
    // Ali's phone is simply dead: that one is news
    expect(detail.participants.find((p) => p.user.id === ali.me.id)?.lastSyncAt).toBe(monthAgo);

    // and once Veli's phone speaks after what he typed, it is his phone's line again
    harness.advance(HOUR);
    await syncSteps(harness, veli, 7000);
    detail = await detailFor(harness, ali, challengeId);
    expect(detail.participants.find((p) => p.user.id === veli.me.id)?.lastSyncAt).toBe(iso(harness));
  });

  it('keeps a phone row at the time its number came through an itiraz and its withdrawal', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await twoPlayerChallenge(harness);
    const synced = iso(harness);
    await syncSteps(harness, veli, 4201);
    const entryId = (await detailFor(harness, ali, challengeId)).feed.find((item) => item.userId === veli.me.id)!.id;

    // Veli's phone went quiet; six hours on Ali questions the 4.201
    harness.advance(6 * HOUR);
    const disputed = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/${entryId}/dispute`,
      payload: { reason: 'bu sayı nereden çıktı' },
    });
    expect(disputed.statusCode).toBe(201);
    let row = (await detailFor(harness, ali, challengeId)).feed.find((item) => item.id === entryId);
    expect(row?.status).toBe('disputed');
    expect(row?.updatedAt).toBe(synced);

    harness.advance(HOUR);
    const withdrawn = await authed(harness.app, ali.token)({
      method: 'DELETE',
      url: `/challenges/${challengeId}/entries/${entryId}/dispute`,
    });
    expect(withdrawn.statusCode).toBe(200);
    row = (await detailFor(harness, ali, challengeId)).feed.find((item) => item.id === entryId);
    expect(row?.status).toBe('ok');
    expect(row?.updatedAt).toBe(synced);
  });

  it('says nothing about phones on a çelınc the phone does not count', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    befriend(harness.app, ali.me.id, veli.me.id);
    const created = await createChallenge(harness, ali, { typeKey: 'kitap_sayfa', participantIds: [veli.me.id] });
    const challengeId = created.json<Challenge>().id;
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    await syncSteps(harness, veli, 9000);

    const detail = await detailFor(harness, ali, challengeId);
    expect(detail.participants).toHaveLength(2);
    expect(detail.participants.every((p) => p.lastSyncAt === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bringing a friend in later
// ---------------------------------------------------------------------------

describe('POST /challenges/:id/invite', () => {
  const DAY = 24 * 60 * 60 * 1000;

  async function invite(h: TestApp, user: RegisteredUser, challengeId: string, userIds: string[]) {
    return authed(h.app, user.token)({ method: 'POST', url: `/challenges/${challengeId}/invite`, payload: { userIds } });
  }

  it('brings a friend into a running çelınc on day two: invited, told, and ranked once they accept', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await twoPlayerChallenge(harness);
    const cem = await registerUser(harness.app, 'cem', { displayName: 'Cem', vulgarityMax: 1 });
    befriend(harness.app, ali.me.id, cem.me.id);
    harness.advance(DAY);

    const invited = await invite(harness, ali, challengeId, [cem.me.id]);
    expect(invited.statusCode).toBe(200);
    const detail = invited.json<ChallengeDetail>();
    expect(detail.participants.find((p) => p.user.id === cem.me.id)?.status).toBe('invited');

    const inbox = listByType(harness.db, cem.me.id, 'challenge_invite');
    expect(inbox).toHaveLength(1);
    expect(inbox[0].title).toBe('Çelınc daveti'); // Cem is level 1
    expect(inbox[0].body).toContain('Ali');
    expect(JSON.parse(inbox[0].data)).toEqual({ challengeId, fromUserId: ali.me.id });

    const cemCall = authed(harness.app, cem.token);
    expect((await cemCall({ method: 'GET', url: '/challenges' })).json<unknown[]>()).toHaveLength(1);
    const accepted = await cemCall({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    expect(accepted.statusCode).toBe(200);
    await postEntry(harness, cem, challengeId, { dayKey: today(harness), value: 20000, source: 'pedometer', clientTime: iso(harness) });

    const after = await cemCall({ method: 'GET', url: `/challenges/${challengeId}` });
    const me = after.json<ChallengeDetail>().me;
    expect(me?.status).toBe('accepted');
    expect(me?.rank).toBe(1);
    expect(me?.score).toBe(20000);
  });

  it('is only for friends nobody blocked', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await twoPlayerChallenge(harness);
    const cem = await registerUser(harness.app, 'cem');
    const eda = await registerUser(harness.app, 'eda');
    const stranger = await registerUser(harness.app, 'yabanci');
    befriend(harness.app, ali.me.id, cem.me.id);
    befriend(harness.app, ali.me.id, eda.me.id);

    const outsider = await invite(harness, stranger, challengeId, [cem.me.id]);
    expect(outsider.statusCode).toBe(404);

    const notFriend = await invite(harness, ali, challengeId, [stranger.me.id]);
    expect(notFriend.statusCode).toBe(400);
    expect(notFriend.json().error.code).toBe('not_friends');

    // the block is Eda's, placed on Ali: it still keeps her out
    await authed(harness.app, eda.token)({ method: 'POST', url: `/users/${ali.me.id}/block` });
    const blocked = await invite(harness, ali, challengeId, [eda.me.id]);
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error.code).toBe('not_friends');

    const self = await invite(harness, ali, challengeId, [ali.me.id]);
    expect(self.statusCode).toBe(400);
    expect(self.json().error.code).toBe('self_participant');

    const twice = await invite(harness, ali, challengeId, [cem.me.id, cem.me.id]);
    expect(twice.statusCode).toBe(400);
    expect(twice.json().error.code).toBe('validation');

    // one bad name stops the whole list: nobody is half invited
    const mixed = await invite(harness, ali, challengeId, [cem.me.id, veli.me.id]);
    expect(mixed.statusCode).toBe(409);
    expect(mixed.json().error.code).toBe('already_in');
    expect(listByType(harness.db, cem.me.id, 'challenge_invite')).toHaveLength(0);

    expect((await invite(harness, ali, challengeId, [cem.me.id])).statusCode).toBe(200);
    const again = await invite(harness, ali, challengeId, [cem.me.id]);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('already_in');
    expect(listByType(harness.db, cem.me.id, 'challenge_invite')).toHaveLength(1);
  });

  it('lets any player call their own kanka in, and a no goes back to whoever called', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await twoPlayerChallenge(harness);
    // Cem came through Veli's link: he is Veli's kanka, not the creator's
    const cem = await registerUser(harness.app, 'cem', { displayName: 'Cem' });
    const eda = await registerUser(harness.app, 'eda', { displayName: 'Eda' });
    befriend(harness.app, veli.me.id, cem.me.id);
    befriend(harness.app, ali.me.id, eda.me.id);
    expect((await invite(harness, ali, challengeId, [eda.me.id])).statusCode).toBe(200);

    // somebody still deciding cannot call anybody yet
    const byEda = await invite(harness, eda, challengeId, [ali.me.id]);
    expect(byEda.statusCode).toBe(403);
    expect(byEda.json().error).toMatchObject({ code: 'not_participant', message: 'Önce çelınca katıl, sonra kanka çağırırsın.' });

    // only one's own kanka
    const notVelis = await invite(harness, veli, challengeId, [eda.me.id]);
    expect(notVelis.statusCode).toBe(400);
    expect(notVelis.json().error.code).toBe('not_friends');

    // the creator's block keeps Veli's kanka out as well
    await authed(harness.app, ali.token)({ method: 'POST', url: `/users/${cem.me.id}/block` });
    const blocked = await invite(harness, veli, challengeId, [cem.me.id]);
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error.code).toBe('blocked_in_challenge');
    await authed(harness.app, ali.token)({ method: 'POST', url: `/users/${cem.me.id}/unblock` });

    const byVeli = await invite(harness, veli, challengeId, [cem.me.id]);
    expect(byVeli.statusCode).toBe(200);
    const inbox = listByType(harness.db, cem.me.id, 'challenge_invite');
    expect(inbox).toHaveLength(1);
    expect(inbox[0].body).toContain('Veli');
    expect(JSON.parse(inbox[0].data)).toEqual({ challengeId, fromUserId: veli.me.id });

    // the home card names who called
    const cemCall = authed(harness.app, cem.token);
    const [summary] = (await cemCall({ method: 'GET', url: '/challenges' })).json<ChallengeSummary[]>();
    expect(summary.me?.invitedBy).toBe(veli.me.id);
    const invitedBy = Object.fromEntries(summary.participants.map((p) => [p.user.id, p.invitedBy]));
    expect(invitedBy).toEqual({ [ali.me.id]: null, [veli.me.id]: ali.me.id, [eda.me.id]: ali.me.id, [cem.me.id]: veli.me.id });

    // Cem's no is Veli's news; the creator never asked him
    expect((await cemCall({ method: 'POST', url: `/challenges/${challengeId}/decline` })).statusCode).toBe(200);
    expect(listByType(harness.db, veli.me.id, 'challenge_declined').map((n) => JSON.parse(n.data))).toEqual([
      { challengeId, fromUserId: cem.me.id },
    ]);
    expect(listByType(harness.db, ali.me.id, 'challenge_declined')).toHaveLength(0);
  });

  it('tells both the creator and whoever called when a çelınc not started yet gets a yes', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    const can = await registerUser(harness.app, 'can', { displayName: 'Can' });
    const cem = await registerUser(harness.app, 'cem', { displayName: 'Cem' });
    befriend(harness.app, ali.me.id, veli.me.id);
    befriend(harness.app, ali.me.id, can.me.id);
    befriend(harness.app, veli.me.id, cem.me.id);
    const created = await createChallenge(harness, ali, {
      participantIds: [veli.me.id, can.me.id],
      startsAt: iso(harness, DAY),
      endsAt: iso(harness, 4 * DAY),
    });
    const id = created.json<Challenge>().id;
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${id}/accept` });
    await authed(harness.app, can.token)({ method: 'POST', url: `/challenges/${id}/accept` });
    expect((await invite(harness, veli, id, [cem.me.id])).statusCode).toBe(200);

    await authed(harness.app, cem.token)({ method: 'POST', url: `/challenges/${id}/accept` });
    const heard = (userId: string) =>
      listByType(harness!.db, userId, 'challenge_accepted').filter((n) => JSON.parse(n.data).fromUserId === cem.me.id);
    expect(heard(ali.me.id)).toHaveLength(1);
    expect(heard(veli.me.id)).toHaveLength(1);
    // Can is in it too, but nobody waits on his answer before the start
    expect(heard(can.me.id)).toHaveLength(0);
  });

  it('keeps somebody out whom the player who called them blocked since', async () => {
    harness = await makeApp({ now: NOW });
    const { veli, challengeId } = await twoPlayerChallenge(harness);
    const cem = await registerUser(harness.app, 'cem');
    befriend(harness.app, veli.me.id, cem.me.id);
    expect((await invite(harness, veli, challengeId, [cem.me.id])).statusCode).toBe(200);

    // as with a creator's own invite: the block came after it, and the block wins
    await authed(harness.app, veli.token)({ method: 'POST', url: `/users/${cem.me.id}/block` });
    const accepted = await authed(harness.app, cem.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    expect(accepted.statusCode).toBe(403);
    expect(accepted.json().error.code).toBe('blocked');
    const row = harness.db
      .prepare('SELECT status FROM challenge_participants WHERE challenge_id = ? AND user_id = ?')
      .get(challengeId, cem.me.id) as { status: string };
    expect(row.status).toBe('invited');
  });

  it('keeps a late invitee out whom a player who was never asked blocked after the invite', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    const deniz = await registerUser(harness.app, 'deniz', { displayName: 'Deniz' });
    const cem = await registerUser(harness.app, 'cem', { displayName: 'Cem' });
    befriend(harness.app, ali.me.id, veli.me.id);
    befriend(harness.app, ali.me.id, deniz.me.id);
    befriend(harness.app, veli.me.id, cem.me.id);
    const id = (await createChallenge(harness, ali, { participantIds: [veli.me.id, deniz.me.id] })).json<Challenge>().id;
    for (const player of [veli, deniz]) {
      await authed(harness.app, player.token)({ method: 'POST', url: `/challenges/${id}/accept` });
    }
    // Veli brings his own kanka, a stranger to Deniz, who has only the block to say no with
    expect((await invite(harness, veli, id, [cem.me.id])).statusCode).toBe(200);
    expect((await authed(harness.app, deniz.token)({ method: 'POST', url: `/users/${cem.me.id}/block` })).statusCode).toBe(200);

    const accepted = await authed(harness.app, cem.token)({ method: 'POST', url: `/challenges/${id}/accept` });
    expect(accepted.statusCode).toBe(400);
    // nobody is named
    expect(accepted.json().error).toEqual({ code: 'blocked_in_challenge', message: 'Bu çelınca katılamazsın.' });
    const status = (userId: string) =>
      (
        harness!.db
          .prepare('SELECT status FROM challenge_participants WHERE challenge_id = ? AND user_id = ?')
          .get(id, userId) as { status: string }
      ).status;
    expect(status(cem.me.id)).toBe('invited');
  });

  it('does not let a no taken back put two blocked people in the same çelınc', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    const deniz = await registerUser(harness.app, 'deniz', { displayName: 'Deniz' });
    const cem = await registerUser(harness.app, 'cem', { displayName: 'Cem' });
    befriend(harness.app, ali.me.id, veli.me.id);
    befriend(harness.app, ali.me.id, deniz.me.id);
    befriend(harness.app, veli.me.id, cem.me.id);
    const id = (await createChallenge(harness, ali, { participantIds: [veli.me.id, deniz.me.id] })).json<Challenge>().id;
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${id}/accept` });
    // Deniz says no and has Cem blocked; a no holds no seat, so Cem may come in
    await authed(harness.app, deniz.token)({ method: 'POST', url: `/challenges/${id}/decline` });
    await authed(harness.app, deniz.token)({ method: 'POST', url: `/users/${cem.me.id}/block` });
    expect((await invite(harness, veli, id, [cem.me.id])).statusCode).toBe(200);
    expect((await authed(harness.app, cem.token)({ method: 'POST', url: `/challenges/${id}/accept` })).statusCode).toBe(200);

    // Deniz changes her mind: Cem is in now, and the two never are together
    const back = await authed(harness.app, deniz.token)({ method: 'POST', url: `/challenges/${id}/accept` });
    expect(back.statusCode).toBe(400);
    expect(back.json().error.code).toBe('blocked_in_challenge');
  });

  it('does not offer or invite a kanka whom the creator blocked and then left', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    const deniz = await registerUser(harness.app, 'deniz', { displayName: 'Deniz' });
    const fatma = await registerUser(harness.app, 'fatma', { displayName: 'Fatma' });
    befriend(harness.app, ali.me.id, veli.me.id);
    befriend(harness.app, ali.me.id, deniz.me.id);
    const id = (await createChallenge(harness, ali, { participantIds: [veli.me.id, deniz.me.id] })).json<Challenge>().id;
    for (const player of [veli, deniz]) {
      await authed(harness.app, player.token)({ method: 'POST', url: `/challenges/${id}/accept` });
    }
    await authed(harness.app, ali.token)({ method: 'POST', url: `/users/${fatma.me.id}/block` });
    expect((await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${id}/leave` })).statusCode).toBe(200);
    befriend(harness.app, veli.me.id, fatma.me.id);

    // accept would refuse her over the creator's block: neither the pointer nor the invite holds out a seat
    expect(invitableFor(harness.db, veli.me.id, fatma.me.id, harness.now())).toEqual([]);
    const blocked = await invite(harness, veli, id, [fatma.me.id]);
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error).toEqual({ code: 'blocked_in_challenge', message: 'Fatma bu çelınca eklenemez.' });
    expect(listByType(harness.db, fatma.me.id, 'challenge_invite')).toHaveLength(0);
  });

  it('does not put somebody a player blocked into that player\'s running çelınc', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await twoPlayerChallenge(harness);
    const can = await registerUser(harness.app, 'can', { displayName: 'Can' });
    befriend(harness.app, ali.me.id, can.me.id);
    expect((await authed(harness.app, veli.token)({ method: 'POST', url: `/users/${can.me.id}/block` })).statusCode).toBeLessThan(300);

    const blocked = await invite(harness, ali, challengeId, [can.me.id]);
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error.code).toBe('blocked_in_challenge');
    // the creator is not told who blocked whom
    expect(blocked.json().error.message).toBe('Can bu çelınca eklenemez.');
    expect(listByType(harness.db, can.me.id, 'challenge_invite')).toHaveLength(0);
    expect((await authed(harness.app, can.token)({ method: 'GET', url: `/challenges/${challengeId}` })).statusCode).toBe(404);
  });

  it('closes when accepting does, and stays shut once the time is up', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await twoPlayerChallenge(harness);
    const cem = await registerUser(harness.app, 'cem');
    befriend(harness.app, ali.me.id, cem.me.id);

    harness.advance(3 * DAY - 30 * 60 * 1000); // 30 minutes left
    const late = await invite(harness, ali, challengeId, [cem.me.id]);
    expect(late.statusCode).toBe(400);
    expect(late.json().error.code).toBe('accept_closed');

    // a step çelınc stays `active` for the phones' hour past its end: still no invites
    harness.advance(45 * 60 * 1000);
    const settling = await invite(harness, ali, challengeId, [cem.me.id]);
    expect(settling.statusCode).toBe(400);
    expect(settling.json().error.code).toBe('challenge_closed');
    expect(listByType(harness.db, cem.me.id, 'challenge_invite')).toHaveLength(0);
  });

  it('refuses a finished or cancelled çelınc', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await finishedChallenge(harness);
    const cem = await registerUser(harness.app, 'cem');
    befriend(harness.app, ali.me.id, cem.me.id);

    const finished = await invite(harness, ali, challengeId, [cem.me.id]);
    expect(finished.statusCode).toBe(400);
    expect(finished.json().error.code).toBe('challenge_closed');

    const later = await createChallenge(harness, ali, {
      participantIds: [cem.me.id],
      startsAt: iso(harness, 2 * 60 * 60 * 1000),
      endsAt: iso(harness, 2 * DAY),
    });
    const laterId = later.json<Challenge>().id;
    await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${laterId}/cancel` });
    const cancelled = await invite(harness, ali, laterId, [cem.me.id]);
    expect(cancelled.statusCode).toBe(400);
    expect(cancelled.json().error.code).toBe('challenge_closed');
  });

  it('asks a "Reddet" again with a fresh invite, but never brings back somebody who played and left', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli');
    const cem = await registerUser(harness.app, 'cem');
    const dan = await registerUser(harness.app, 'dan');
    const eda = await registerUser(harness.app, 'eda');
    for (const friend of [veli, cem, dan, eda]) befriend(harness.app, ali.me.id, friend.me.id);
    const created = await createChallenge(harness, ali, {
      participantIds: [veli.me.id, cem.me.id, dan.me.id, eda.me.id],
    });
    const id = created.json<Challenge>().id;
    // Eda plays, so the no's and the walk-out leave a race behind
    await authed(harness.app, eda.token)({ method: 'POST', url: `/challenges/${id}/accept` });

    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${id}/decline` });
    await authed(harness.app, cem.token)({ method: 'POST', url: `/challenges/${id}/accept` });
    await authed(harness.app, cem.token)({ method: 'POST', url: `/challenges/${id}/leave` });
    // Dan never joined: his "Ayrıl" on the invite was only a no
    await authed(harness.app, dan.token)({ method: 'POST', url: `/challenges/${id}/leave` });

    const left = await invite(harness, ali, id, [cem.me.id]);
    expect(left.statusCode).toBe(409);
    expect(left.json().error.code).toBe('already_left');

    const back = await invite(harness, ali, id, [veli.me.id, dan.me.id]);
    expect(back.statusCode).toBe(200);
    const statuses = Object.fromEntries(back.json<ChallengeDetail>().participants.map((p) => [p.user.id, p.status]));
    expect(statuses[veli.me.id]).toBe('invited');
    expect(statuses[dan.me.id]).toBe('invited');
    expect(listByType(harness.db, veli.me.id, 'challenge_invite')).toHaveLength(2);
    expect(listByType(harness.db, dan.me.id, 'challenge_invite')).toHaveLength(2);

    // the invite is the real thing again: it shows on the list, and a no is still a no
    const veliCall = authed(harness.app, veli.token);
    expect((await veliCall({ method: 'GET', url: '/challenges' })).json<unknown[]>()).toHaveLength(1);
    expect((await veliCall({ method: 'POST', url: `/challenges/${id}/decline` })).statusCode).toBe(200);
  });

  it('fills up to the wizard\'s cap and no further', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali');
    const friends: RegisteredUser[] = [];
    for (let i = 0; i < LIMITS.PARTICIPANTS_MAX + 2; i += 1) {
      const friend = await registerUser(harness.app, `kanka${i}`);
      befriend(harness.app, ali.me.id, friend.me.id);
      friends.push(friend);
    }
    const [first, second, ...rest] = friends;
    const created = await createChallenge(harness, ali, { participantIds: [first.me.id, second.me.id] });
    const id = created.json<Challenge>().id;
    // a no gives its seat back
    await authed(harness.app, second.token)({ method: 'POST', url: `/challenges/${id}/decline` });

    const tooMany = await invite(harness, ali, id, rest.map((friend) => friend.me.id));
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().error.code).toBe('too_many_participants');

    const full = await invite(harness, ali, id, rest.slice(0, LIMITS.PARTICIPANTS_MAX - 1).map((friend) => friend.me.id));
    expect(full.statusCode).toBe(200);
    const last = await invite(harness, ali, id, [second.me.id]);
    expect(last.statusCode).toBe(400);
    expect(last.json().error.code).toBe('too_many_participants');
  });
});

// ---------------------------------------------------------------------------
// Taunts
// ---------------------------------------------------------------------------

describe('POST /challenges/:id/taunt', () => {
  it('lets only the winner taunt, once per loser', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await finishedChallenge(harness);

    const detail = await authed(harness.app, ali.token)({ method: 'GET', url: `/challenges/${challengeId}` });
    expect(detail.json<ChallengeDetail>().canTaunt).toEqual([{ toUserId: veli.me.id, done: false }]);

    const loserTries = await authed(harness.app, veli.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/taunt`,
      payload: { toUserId: ali.me.id, templateId: 'l2_win_01' },
    });
    expect(loserTries.statusCode).toBe(403);
    expect(loserTries.json().error.code).toBe('not_winner');

    const sent = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/taunt`,
      payload: { toUserId: veli.me.id, templateId: 'l2_win_01' },
    });
    expect(sent.statusCode).toBe(201);
    const taunt = sent.json<{ taunt: { level: number; body: string; toUserId: string } }>().taunt;
    expect(taunt.level).toBe(2);
    expect(taunt.toUserId).toBe(veli.me.id);
    // Rendered with real names and scores, no placeholders left behind.
    expect(taunt.body).toContain('Ali');
    expect(taunt.body).toContain('12.430');
    expect(taunt.body).not.toContain('{winner}');

    const inbox = listByType(harness.db, veli.me.id, 'taunt');
    expect(inbox).toHaveLength(1);
    expect(JSON.parse(inbox[0].data)).toMatchObject({ challengeId });

    const again = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/taunt`,
      payload: { toUserId: veli.me.id, templateId: 'l2_win_02' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('already_taunted');

    const after = await authed(harness.app, ali.token)({ method: 'GET', url: `/challenges/${challengeId}` });
    expect(after.json<ChallengeDetail>().canTaunt).toEqual([{ toUserId: veli.me.id, done: true }]);
  });

  it('clamps the level down to the target ceiling', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali', vulgarityMax: 3 });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli', vulgarityMax: 1 });
    befriend(harness.app, ali.me.id, veli.me.id);
    const created = await createChallenge(harness, ali, { participantIds: [veli.me.id] });
    const id = created.json<Challenge>().id;
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${id}/accept` });
    await postEntry(harness, ali, id, { dayKey: today(harness), value: 9000, source: 'pedometer', clientTime: iso(harness) });
    await harness.app.inject({ method: 'POST', url: `/dev/finalize/${id}` });

    const sent = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${id}/taunt`,
      payload: { toUserId: veli.me.id, templateId: 'l3_win_01' },
    });
    expect(sent.statusCode).toBe(201);
    const taunt = sent.json<{ taunt: { level: number; body: string } }>().taunt;
    expect(taunt.level).toBe(1);
    expect(taunt.body).not.toContain('🍆');
  });

  it('rejects banned custom text but accepts plain banter', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await finishedChallenge(harness);

    const banned = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/taunt`,
      payload: { toUserId: veli.me.id, customBody: 'anana selam söyle' },
    });
    expect(banned.statusCode).toBe(400);
    expect(banned.json().error.code).toBe('banned_content');

    const ok = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/taunt`,
      payload: { toUserId: veli.me.id, customBody: 'yedin lan kanka, {diff} adım fark' },
    });
    expect(ok.statusCode).toBe(201);
    const taunt = ok.json<{ taunt: { body: string; level: number } }>().taunt;
    expect(taunt.body).toContain('11.530'); // placeholders in custom text are filled too
    expect(taunt.level).toBe(2);
  });

  it('takes a laf to a friend whose surname shares a stem with a slur, and still checks the rest', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await finishedChallenge(harness);
    // Veli's real surname is Topal: his name goes into the finished sentence
    const renamed = await authed(harness.app, veli.token)({ method: 'PATCH', url: '/me', payload: { displayName: 'Veli Topal' } });
    expect(renamed.statusCode).toBe(200);

    const ok = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/taunt`,
      payload: { toUserId: veli.me.id, customBody: "{loser}'a koydum, {diff} adım fark" },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json<{ taunt: { body: string } }>().taunt.body).toContain("Veli Topal'a koydum");

    const banned = await authed(harness.app, veli.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/taunt`,
      payload: { toUserId: ali.me.id, customBody: 'topallar gibi yürüdün', mode: 'reply' },
    });
    expect(banned.statusCode).toBe(400);
    expect(banned.json().error.code).toBe('banned_content');
  });

  it("reads the sender's own name with the laf around it, so a threat cannot be split between them", async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await finishedChallenge(harness);
    const send = (customBody: string) =>
      authed(harness!.app, ali.token)({
        method: 'POST',
        url: `/challenges/${challengeId}/taunt`,
        payload: { toUserId: veli.me.id, customBody },
      });
    const rename = (displayName: string) =>
      authed(harness!.app, ali.token)({ method: 'PATCH', url: '/me', payload: { displayName } });

    // each name passes as a name, each laf passes on its own; together they do not
    const cases: [string, string][] = [
      ['Karını', '{winner} sikerim'],
      ['Kafanı', '{winner} kırarım'],
      ['Boğazını', '{winner} sıkarım'],
      ['Canını', '{winner} alırım {loser}'],
      ['İb', '{winner}ne {loser}'],
      ['Topal', '{winner}lar gibi yürüdün'],
      ['Ali Topal', '{winner}.lar gibi yürüdün'],
    ];
    for (const [displayName, customBody] of cases) {
      expect((await rename(displayName)).statusCode, displayName).toBe(200);
      const refused = await send(customBody);
      expect(refused.statusCode, `${displayName} + ${customBody}`).toBe(400);
      expect(refused.json().error.code).toBe('banned_content');
    }
    expect(harness.db.prepare('SELECT COUNT(*) AS n FROM taunts').get()).toEqual({ n: 0 });

    // a real surname apart from the laf still goes, from the sender's side too,
    // even with the laf glued onto the other end of the name
    expect((await rename('Ali Topal')).statusCode).toBe(200);
    const ok = await send("Bitti,{winner}'dan {loser}'a geçmiş olsun");
    expect(ok.statusCode).toBe(201);
    expect(ok.json<{ taunt: { title: string; body: string } }>().taunt).toMatchObject({
      title: 'Ali Topal laf soktu',
      body: "Bitti,Ali Topal'dan Veli'a geçmiş olsun",
    });
  });

  it('prints a screen-time average with the digits the app previewed', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    befriend(harness.app, ali.me.id, veli.me.id);
    // three whole days in Istanbul: 5, 6 and 7 January
    const created = await createChallenge(harness, ali, {
      typeKey: 'ekran_suresi_beyani',
      endsAt: '2026-01-07T20:59:59.999Z',
      participantIds: [veli.me.id],
    });
    const id = created.json<Challenge>().id;
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${id}/accept` });
    const days: [number, number][] = [
      [60, 80],
      [70, 80],
      [70, 81],
    ];
    for (const [i, minutes] of days.entries()) {
      harness.setNow(new Date(Date.parse(NOW) + i * 24 * 60 * 60 * 1000));
      for (const [user, value] of [[ali, minutes[0]], [veli, minutes[1]]] as const) {
        const payload = { dayKey: today(harness), value, source: 'manual', proofUrl: '/uploads/ekran.jpg', clientTime: iso(harness) };
        expect((await postEntry(harness, user, id, payload)).statusCode).toBe(201);
      }
    }
    harness.setNow('2026-01-08T09:00:00.000Z');
    expect((await harness.app.inject({ method: 'POST', url: `/dev/finalize/${id}` })).statusCode).toBe(200);

    // 200/3 and 241/3: the results screen and the preview say 66,67 and 80,33
    const sent = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${id}/taunt`,
      payload: { toUserId: veli.me.id, templateId: 'l1_win_01' },
    });
    expect(sent.statusCode).toBe(201);
    const body = sent.json<{ taunt: { body: string } }>().taunt.body;
    expect(body).toContain('66,67');
    expect(body).toContain('80,33');
    expect(body).not.toContain('66,7 ');
  });

  it('refuses before the challenge is finished and for non-participants', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await twoPlayerChallenge(harness);

    const early = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/taunt`,
      payload: { toUserId: veli.me.id, templateId: 'l2_win_01' },
    });
    expect(early.statusCode).toBe(400);
    expect(early.json().error.code).toBe('challenge_not_finished');

    const outsider = await registerUser(harness.app, 'yabanci');
    const denied = await authed(harness.app, outsider.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/taunt`,
      payload: { toUserId: veli.me.id, templateId: 'l2_win_01' },
    });
    expect(denied.statusCode).toBe(404);
  });

  it('refuses a target who is not an accepted loser', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await finishedChallenge(harness);

    const self = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/taunt`,
      payload: { toUserId: ali.me.id, templateId: 'l2_win_01' },
    });
    expect(self.statusCode).toBe(400);
    expect(self.json().error.code).toBe('self_taunt');

    const stranger = await registerUser(harness.app, 'yabanci');
    const missing = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/taunt`,
      payload: { toUserId: stranger.me.id, templateId: 'l2_win_01' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('participant_not_found');
  });

  it('rejects a body with both a template and custom text', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await finishedChallenge(harness);
    const response = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/taunt`,
      payload: { toUserId: veli.me.id, templateId: 'l2_win_01', customBody: 'hem hem' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('validation');
  });

  /** Ali, Veli and Cem, finished: Ali first, Cem last; with `tie` Veli ends level with Ali. */
  async function threeWay(h: TestApp, tie: boolean) {
    const ali = await registerUser(h.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(h.app, 'veli', { displayName: 'Veli' });
    const cem = await registerUser(h.app, 'cem', { displayName: 'Cem' });
    befriend(h.app, ali.me.id, veli.me.id);
    befriend(h.app, ali.me.id, cem.me.id);
    const created = await createChallenge(h, ali, { participantIds: [veli.me.id, cem.me.id] });
    const challengeId = created.json<Challenge>().id;
    for (const user of [veli, cem]) {
      await authed(h.app, user.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    }
    const day = today(h);
    const scores: [RegisteredUser, number][] = [[ali, 12430], [veli, tie ? 12430 : 8000], [cem, 900]];
    for (const [user, value] of scores) {
      await postEntry(h, user, challengeId, { dayKey: day, value, source: 'pedometer', clientTime: iso(h) });
    }
    expect((await h.app.inject({ method: 'POST', url: `/dev/finalize/${challengeId}` })).statusCode).toBe(200);
    return { ali, veli, cem, challengeId };
  }

  const tauntAs = (user: RegisteredUser, challengeId: string, payload: Record<string, unknown>) =>
    authed(harness!.app, user.token)({ method: 'POST', url: `/challenges/${challengeId}/taunt`, payload });

  it('lets the loser answer the winner once, after the winner spoke', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await finishedChallenge(harness);

    const early = await tauntAs(veli, challengeId, { toUserId: ali.me.id, templateId: 'l2_reply_01' });
    expect(early.statusCode).toBe(403);
    expect(early.json().error.message).toBe('Önce o konuşsun, sonra cevap verirsin.');

    expect((await tauntAs(ali, challengeId, { toUserId: veli.me.id, templateId: 'l2_win_01' })).statusCode).toBe(201);

    // a winner's line sent back is swapped for an answer: "Ali koydu" from Veli would be a lie
    const reply = await tauntAs(veli, challengeId, { toUserId: ali.me.id, templateId: 'l2_win_01' });
    expect(reply.statusCode).toBe(201);
    const taunt = reply.json<{ taunt: { fromUserId: string; toUserId: string; title: string; body: string } }>().taunt;
    expect(taunt).toMatchObject({ fromUserId: veli.me.id, toUserId: ali.me.id });
    // {winner} stays the real winner, {loser} the one answering
    expect(taunt.body).toContain('Ali');
    expect(taunt.title).toContain('Veli');
    expect(taunt.body).not.toMatch(/\{\w+\}/);

    const inbox = listByType(harness.db, ali.me.id, 'taunt');
    expect(inbox).toHaveLength(1);
    expect(JSON.parse(inbox[0].data)).toMatchObject({ challengeId, fromUserId: veli.me.id });
    // the winner's own laf says who sent it too
    expect(JSON.parse(listByType(harness.db, veli.me.id, 'taunt')[0].data)).toMatchObject({ fromUserId: ali.me.id });

    const again = await tauntAs(veli, challengeId, { toUserId: ali.me.id, customBody: 'bir daha' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('already_replied');

    // the winner already said theirs: no second round
    const winnerAgain = await tauntAs(ali, challengeId, { toUserId: veli.me.id, templateId: 'l2_win_02' });
    expect(winnerAgain.statusCode).toBe(409);
    expect(winnerAgain.json().error.code).toBe('already_taunted');

    // both directions show on both result screens
    const results = await authed(harness.app, veli.token)({ method: 'GET', url: `/challenges/${challengeId}/results` });
    // (the injected clock stands still, so both rows share one instant: order is not the point)
    expect(results.json<ChallengeResults>().taunts.map((t) => t.fromUserId).sort()).toEqual(
      [ali.me.id, veli.me.id].sort(),
    );
  });

  it('titles a typed answer as an answer, not as a win', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await finishedChallenge(harness);
    await tauntAs(ali, challengeId, { toUserId: veli.me.id, templateId: 'l2_win_01' });

    const reply = await tauntAs(veli, challengeId, { toUserId: ali.me.id, customBody: 'haftaya bak sen {winner}' });
    expect(reply.statusCode).toBe(201);
    expect(reply.json<{ taunt: { title: string; body: string } }>().taunt).toMatchObject({
      title: 'Veli boş durmadı',
      body: 'haftaya bak sen Ali',
    });
  });

  it('gives a loser nobody to answer but the winner, and nothing across a block', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, cem, challengeId } = await threeWay(harness, false);
    await tauntAs(ali, challengeId, { toUserId: veli.me.id, templateId: 'l2_win_01' });
    await tauntAs(ali, challengeId, { toUserId: cem.me.id, templateId: 'l2_win_01' });

    const sideways = await tauntAs(veli, challengeId, { toUserId: cem.me.id, templateId: 'l2_reply_01' });
    expect(sideways.statusCode).toBe(403);
    expect(sideways.json().error.code).toBe('not_winner');

    await authed(harness.app, cem.token)({ method: 'POST', url: `/users/${ali.me.id}/block` });
    const blocked = await tauntAs(cem, challengeId, { toUserId: ali.me.id, templateId: 'l2_reply_01' });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('blocked');
    expect(listByType(harness.db, ali.me.id, 'taunt')).toHaveLength(0);
  });

  it('lets the co-leaders of a tie have a go at each other, and nobody behind them', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, cem, challengeId } = await threeWay(harness, true);

    // the picker only offers tie lines; a win line asked for is swapped for one
    const fromAli = await tauntAs(ali, challengeId, { toUserId: veli.me.id, templateId: 'l2_win_01' });
    expect(fromAli.statusCode).toBe(201);
    expect(fromAli.json<{ taunt: { body: string } }>().taunt.body).not.toContain('koydu');
    const fromVeli = await tauntAs(veli, challengeId, { toUserId: ali.me.id, templateId: 'l2_tie_02' });
    expect(fromVeli.statusCode).toBe(201);
    // Veli talking to Ali, and the title (all a lock screen shows) says it is Veli
    expect(fromVeli.json<{ taunt: { title: string; body: string } }>().taunt).toMatchObject({
      title: 'Veli bırakmıyor',
      body: 'Eşit bitti ama bu iş bitmedi Ali. Rövanşı aç da kim koyuyor görelim lan.',
    });
    expect(JSON.parse(listByType(harness.db, ali.me.id, 'taunt')[0].data)).toMatchObject({ fromUserId: veli.me.id });

    const twice = await tauntAs(ali, challengeId, { toUserId: veli.me.id, templateId: 'l2_tie_01' });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.code).toBe('already_taunted');

    const fromBehind = await tauntAs(cem, challengeId, { toUserId: ali.me.id, templateId: 'l2_tie_01' });
    expect(fromBehind.statusCode).toBe(403);
    expect(fromBehind.json().error.code).toBe('not_winner');

    const atBehind = await tauntAs(ali, challengeId, { toUserId: cem.me.id, templateId: 'l2_tie_01' });
    expect(atBehind.statusCode).toBe(403);
    expect(atBehind.json().error.code).toBe('not_winner');
    expect(listByType(harness.db, cem.me.id, 'taunt')).toHaveLength(0);

    // nobody won: each co-leader's list is the other one, already done; nobody behind them
    const detail = await authed(harness.app, ali.token)({ method: 'GET', url: `/challenges/${challengeId}` });
    expect(detail.json<ChallengeDetail>().canTaunt).toEqual([{ toUserId: veli.me.id, done: true }]);
    expect(detail.json<ChallengeDetail>().canTauntCoversTie).toBe(true);
    const behind = await authed(harness.app, cem.token)({ method: 'GET', url: `/challenges/${challengeId}` });
    expect(behind.json<ChallengeDetail>().canTaunt).toEqual([]);
  });

  // The app's "Laf at" goes by this list; it offered Veli and the send earned 403 `blocked`.
  it('leaves a co-leader behind a block out of a tie\'s list', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await threeWay(harness, true);
    const listOf = async (user: RegisteredUser) =>
      (await authed(harness!.app, user.token)({ method: 'GET', url: `/challenges/${challengeId}` })).json<ChallengeDetail>()
        .canTaunt;
    expect(await listOf(ali)).toEqual([{ toUserId: veli.me.id, done: false }]);

    await authed(harness.app, veli.token)({ method: 'POST', url: `/users/${ali.me.id}/block` });
    expect(await listOf(ali)).toEqual([]);
    expect(await listOf(veli)).toEqual([]);
    const refused = await tauntAs(ali, challengeId, { toUserId: veli.me.id, templateId: 'l2_tie_01' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('blocked');
  });
});

// ---------------------------------------------------------------------------
// Pokes
// ---------------------------------------------------------------------------

describe('POST /challenges/:id/poke', () => {
  it('only lets whoever is ahead talk', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await leadingChallenge(harness);

    // Veli is behind: the button is not his to press
    const fromBehind = await authed(harness.app, veli.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/poke`,
      payload: { toUserId: ali.me.id },
    });
    expect(fromBehind.statusCode).toBe(403);
    expect(fromBehind.json().error.code).toBe('not_ahead');
    expect(listByType(harness.db, ali.me.id, 'poke')).toHaveLength(0);

    const fromFront = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/poke`,
      payload: { toUserId: veli.me.id },
    });
    expect(fromFront.statusCode).toBe(201);
  });

  it('gives nobody the right to talk while it is level', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await twoPlayerChallenge(harness);
    const day = today(harness);
    await postEntry(harness, ali, challengeId, { dayKey: day, value: 5_000, source: 'pedometer', clientTime: iso(harness) });
    await postEntry(harness, veli, challengeId, { dayKey: day, value: 5_000, source: 'pedometer', clientTime: iso(harness) });

    const level = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/poke`,
      payload: { toUserId: veli.me.id },
    });
    expect(level.statusCode).toBe(403);
  });

  it('tells the client who may be talked to, and who is still cooling down', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await leadingChallenge(harness);
    const detailFor = async (token: string) =>
      (
        await authed(harness!.app, token)({ method: 'GET', url: `/challenges/${challengeId}` })
      ).json<ChallengeDetail>();

    const leader = await detailFor(ali.token);
    expect(leader.pokeTargets).toEqual([{ toUserId: veli.me.id, done: false }]);
    expect(leader.canPoke).toBe(true);

    const behind = await detailFor(veli.token);
    expect(behind.pokeTargets).toEqual([]);
    expect(behind.canPoke).toBe(false);

    await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/poke`,
      payload: { toUserId: veli.me.id },
    });
    const afterSending = await detailFor(ali.token);
    expect(afterSending.pokeTargets).toEqual([{ toUserId: veli.me.id, done: true }]);
    // still ahead, but with nothing to say for two hours
    expect(afterSending.canPoke).toBe(false);

    harness.advance(2 * 60 * 60 * 1000 + 1000);
    expect((await detailFor(ali.token)).canPoke).toBe(true);
  });

  it('pokes once every two hours', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await leadingChallenge(harness);

    const first = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/poke`,
      payload: { toUserId: veli.me.id },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json<{ level: number }>().level).toBe(2);
    expect(listByType(harness.db, veli.me.id, 'poke')).toHaveLength(1);

    const tooSoon = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/poke`,
      payload: { toUserId: veli.me.id },
    });
    expect(tooSoon.statusCode).toBe(429);
    expect(tooSoon.json().error.code).toBe('poke_cooldown');

    harness.advance(2 * 60 * 60 * 1000 + 1000);
    const later = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/poke`,
      payload: { toUserId: veli.me.id },
    });
    expect(later.statusCode).toBe(201);
    expect(listByType(harness.db, veli.me.id, 'poke')).toHaveLength(2);
  });

  it('only works on an active challenge, never on yourself', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await twoPlayerChallenge(harness);

    const self = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/poke`,
      payload: { toUserId: ali.me.id },
    });
    expect(self.statusCode).toBe(400);
    expect(self.json().error.code).toBe('self_poke');

    await harness.app.inject({ method: 'POST', url: `/dev/finalize/${challengeId}` });
    const finished = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/poke`,
      payload: { toUserId: veli.me.id },
    });
    expect(finished.statusCode).toBe(400);
    expect(finished.json().error.code).toBe('challenge_not_active');
  });
});

// ---------------------------------------------------------------------------
// Rematch, results, leaderboard
// ---------------------------------------------------------------------------

describe('POST /challenges/:id/rematch', () => {
  it('clones the settings, invites the old line-up and notifies', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await finishedChallenge(harness);

    const response = await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` });
    expect(response.statusCode).toBe(201);
    // Like creation, the rematch answers with the bare new Challenge.
    const rematch = response.json<Challenge>();

    expect(rematch.rematchOfId).toBe(challengeId);
    expect(rematch.status).toBe('pending');
    expect(rematch.typeKey).toBe('adim_yarisi');
    expect(Date.parse(rematch.startsAt)).toBe(harness.now().getTime() + 5 * 60 * 1000);
    // the original ran 3 × 24 h from noon, i.e. three whole days; the rematch
    // gets three too, ending where the wizard ends one: the last millisecond of
    // 7 January in Istanbul, not at whatever time the button was tapped
    expect(rematch.endsAt).toBe('2026-01-07T20:59:59.999Z');

    const detail = (
      await authed(harness.app, veli.token)({ method: 'GET', url: `/challenges/${rematch.id}` })
    ).json<ChallengeDetail>();
    expect(detail.me?.status).toBe('accepted');
    expect(detail.participants.find((p) => p.user.id === ali.me.id)?.status).toBe('invited');

    expect(listByType(harness.db, ali.me.id, 'rematch')).toHaveLength(1);

    const twice = await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.code).toBe('already_rematched');
  });

  it('keeps the number of days of a snapped çelınc and still ends on a day, even when asked for at night', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    befriend(harness.app, ali.me.id, veli.me.id);
    // what the wizard sends for "3 gün" from noon: to the last millisecond of 7 January
    const created = await createChallenge(harness, ali, {
      participantIds: [veli.me.id],
      endsAt: '2026-01-07T20:59:59.999Z',
    });
    const challengeId = created.json<Challenge>().id;
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    await harness.app.inject({ method: 'POST', url: `/dev/finalize/${challengeId}` });

    // 23:57 on 9 January: it starts at 00:02, so its three days are 10-12 January
    harness.setNow('2026-01-09T20:57:00.000Z');
    const late = (await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` })).json<Challenge>();
    expect(late.startsAt).toBe('2026-01-09T21:02:00.000Z');
    expect(late.endsAt).toBe('2026-01-12T20:59:59.999Z');

    // Veli's, at 16:00 on 10 January: three days, the first one today. He turns
    // Ali's down first, since a rival's open rematch would send him to it.
    harness.setNow('2026-01-10T13:00:00.000Z');
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${late.id}/decline` });
    const afternoon = (
      await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` })
    ).json<Challenge>();
    expect(afternoon.endsAt).toBe('2026-01-12T20:59:59.999Z');
  });

  it('counts the original\'s days where it was made, even when a rival in another zone asks', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli', timezone: 'Europe/London' });
    befriend(harness.app, ali.me.id, veli.me.id);
    // Ali's "3 gün", snapped in Istanbul; in London it ends at 20:59 on its third day
    const created = await createChallenge(harness, ali, { participantIds: [veli.me.id], endsAt: '2026-01-07T20:59:59.999Z' });
    const challengeId = created.json<Challenge>().id;
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    await harness.app.inject({ method: 'POST', url: `/dev/finalize/${challengeId}` });

    harness.setNow('2026-01-10T13:00:00.000Z'); // 13:00 in London
    const rematch = (await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` })).json<Challenge>();
    // three London days, 10-12 January, ending at London midnight
    expect(rematch.endsAt).toBe('2026-01-12T23:59:59.999Z');
  });

  it("does not carry a check-in deadline outside the type's window into the rematch", async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    befriend(harness.app, ali.me.id, veli.me.id);
    const created = await createChallenge(harness, ali, { typeKey: 'erken_yat', participantIds: [veli.me.id], deadlineTime: '23:30' });
    const challengeId = created.json<Challenge>().id;
    // a row written before the wizard and the schema checked the window
    harness.db.prepare("UPDATE challenges SET deadline_time = '00:00' WHERE id = ?").run(challengeId);
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    await harness.app.inject({ method: 'POST', url: `/dev/finalize/${challengeId}` });

    const rematch = (await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` })).json<Challenge>();
    const stored = harness.db.prepare('SELECT deadline_time FROM challenges WHERE id = ?').get(rematch.id) as { deadline_time: string };
    expect(stored.deadline_time).toBe('23:00');
    expect(rematch.deadlineTime).toBe('23:00');
  });

  it('runs a one-day rematch asked for late at night to the end of the next day, not for half an hour', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    befriend(harness.app, ali.me.id, veli.me.id);
    // "1 gün" from noon
    const created = await createChallenge(harness, ali, { participantIds: [veli.me.id], endsAt: '2026-01-05T20:59:59.999Z' });
    const challengeId = created.json<Challenge>().id;
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    await harness.app.inject({ method: 'POST', url: `/dev/finalize/${challengeId}` });

    harness.setNow('2026-01-06T20:20:00.000Z'); // 23:20
    const rematch = (await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` })).json<Challenge>();
    expect(rematch.startsAt).toBe('2026-01-06T20:25:00.000Z');
    expect(rematch.endsAt).toBe('2026-01-07T20:59:59.999Z');
  });

  it('starts a check-in rematch asked for after the deadline on the next morning its window opens', async () => {
    harness = await makeApp({ now: '2026-12-31T19:00:00.000Z' });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    befriend(harness.app, ali.me.id, veli.me.id);
    // "5 gün" Erken Kalkan Koyar, 1-5 January
    const created = await createChallenge(harness, ali, {
      typeKey: 'erken_kus',
      participantIds: [veli.me.id],
      deadlineTime: '07:00',
      startsAt: '2027-01-01T01:00:00.000Z',
      endsAt: '2027-01-05T20:59:59.999Z',
    });
    const challengeId = created.json<Challenge>().id;
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    await harness.app.inject({ method: 'POST', url: `/dev/finalize/${challengeId}` });

    // 22:00 on 6 January: 22:05 would have lost the 7th's morning, yet counted it
    harness.setNow('2027-01-06T19:00:00.000Z');
    const evening = (await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` })).json<Challenge>();
    expect(evening.startsAt).toBe('2027-01-07T01:00:00.000Z'); // 04:00
    expect(evening.endsAt).toBe('2027-01-11T20:59:59.999Z'); // five mornings, 7-11 January

    // 03:00 on the 7th: this morning can still be played, so in five minutes as ever
    harness.setNow('2027-01-07T00:00:00.000Z');
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${evening.id}/decline` });
    const night = (await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` })).json<Challenge>();
    expect(night.startsAt).toBe('2027-01-07T00:05:00.000Z');
    expect(night.endsAt).toBe('2027-01-11T20:59:59.999Z');
  });

  it('starts a check-in rematch on the next day when the deadline passes in its five minutes', async () => {
    harness = await makeApp({ now: '2026-12-31T19:00:00.000Z' });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    befriend(harness.app, ali.me.id, veli.me.id);
    const created = await createChallenge(harness, ali, {
      typeKey: 'yatak_toplama',
      participantIds: [veli.me.id],
      deadlineTime: '09:00',
      startsAt: '2027-01-01T02:00:00.000Z',
      endsAt: '2027-01-03T20:59:59.999Z',
    });
    const challengeId = created.json<Challenge>().id;
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    await harness.app.inject({ method: 'POST', url: `/dev/finalize/${challengeId}` });

    // 08:57: it would start at 09:02, past this morning's 09:00
    harness.setNow('2027-01-04T05:57:00.000Z');
    const rematch = (await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` })).json<Challenge>();
    expect(rematch.startsAt).toBe('2027-01-05T02:00:00.000Z'); // 05:00 on the 5th
    expect(rematch.endsAt).toBe('2027-01-07T20:59:59.999Z');
  });

  it('lets the creator ask again after a rematch was turned down (and so cancelled)', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await finishedChallenge(harness);

    const first = await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` });
    expect(first.statusCode).toBe(201);
    const firstId = first.json<Challenge>().id;
    const declined = await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${firstId}/decline` });
    expect(declined.json<ChallengeDetail>().challenge.status).toBe('cancelled');

    const second = await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` });
    expect(second.statusCode).toBe(201);
    expect(second.json<Challenge>().id).not.toBe(firstId);
    // one that is still open does count
    const third = await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` });
    expect(third.statusCode).toBe(409);
    expect(third.json().error.code).toBe('already_rematched');
  });

  it('sends a rival to the rematch the other side already opened instead of opening a second one', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await finishedChallenge(harness);
    const resultsFor = async (user: RegisteredUser) =>
      (await authed(harness!.app, user.token)({ method: 'GET', url: `/challenges/${challengeId}/results` })).json<ChallengeResults>();
    const rematchBy = (user: RegisteredUser) =>
      authed(harness!.app, user.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` });

    // nothing yet: both see the button, and each would invite the other
    expect((await resultsFor(ali)).rematch).toBeNull();
    expect((await resultsFor(ali)).rematchInvitable).toBe(1);

    const opened = await rematchBy(veli);
    expect(opened.statusCode).toBe(201);
    const rematchId = opened.json<Challenge>().id;

    expect((await resultsFor(ali)).rematch).toEqual({
      id: rematchId,
      status: 'pending',
      creatorId: veli.me.id,
      creatorName: 'Veli',
      myStatus: 'invited',
    });
    const parallel = await rematchBy(ali);
    expect(parallel.statusCode).toBe(409);
    expect(parallel.json().error).toMatchObject({ code: 'rematch_exists', message: 'Veli rövanşı zaten açtı, davet sende.' });
    expect(harness.db.prepare('SELECT COUNT(*) AS n FROM challenges WHERE rematch_of_id = ?').get(challengeId)).toEqual({ n: 1 });

    // the creator's own second tap is still his own conflict
    const again = await rematchBy(veli);
    expect(again.json().error.code).toBe('already_rematched');
    expect((await resultsFor(veli)).rematch).toMatchObject({ id: rematchId, creatorName: 'Veli', myStatus: 'accepted' });

    await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${rematchId}/accept` });
    expect((await resultsFor(ali)).rematch?.myStatus).toBe('accepted');
    expect((await rematchBy(ali)).json().error.message).toBe('Veli rövanşı zaten açtı, sen de içindesin.');

    // called off before it started: nothing to join, so Ali may open his own
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${rematchId}/cancel` });
    expect((await resultsFor(ali)).rematch).toBeNull();
    const own = await rematchBy(ali);
    expect(own.statusCode).toBe(201);
    expect((await resultsFor(ali)).rematch).toMatchObject({ id: own.json<Challenge>().id, myStatus: 'accepted' });
  });

  it('does not hold a friend to a group rematch invite they can no longer take', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    const can = await registerUser(harness.app, 'can', { displayName: 'Can' });
    befriend(harness.app, ali.me.id, veli.me.id);
    befriend(harness.app, ali.me.id, can.me.id);
    befriend(harness.app, veli.me.id, can.me.id);
    const challengeId = (await createChallenge(harness, ali, { participantIds: [veli.me.id, can.me.id] })).json<Challenge>().id;
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    await authed(harness.app, can.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    await harness.app.inject({ method: 'POST', url: `/dev/finalize/${challengeId}` });

    // Veli's rematch runs with Can; Ali never answers it
    const rematch = (
      await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` })
    ).json<Challenge>();
    await authed(harness.app, can.token)({ method: 'POST', url: `/challenges/${rematch.id}/accept` });
    const resultsForAli = async () =>
      (await authed(harness!.app, ali.token)({ method: 'GET', url: `/challenges/${challengeId}/results` })).json<ChallengeResults>();
    expect((await resultsForAli()).rematch).toMatchObject({ id: rematch.id, myStatus: 'invited' });

    // its door closed: "davet sende" would lead to "katılım kapandı"
    harness.setNow(new Date(Date.parse(rematch.endsAt) - 30 * 60 * 1000).toISOString());
    runSchedulerOnce(harness.db, harness.now());
    expect((await resultsForAli()).rematch).toBeNull();

    // over, and he was never in it: no rematch of his own to open from there
    await harness.app.inject({ method: 'POST', url: `/dev/finalize/${rematch.id}` });
    expect((await resultsForAli()).rematch).toBeNull();
    // Can played Veli's to the end, so for him it still counts
    const forCan = await authed(harness.app, can.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` });
    expect(forCan.json().error).toMatchObject({
      code: 'rematch_exists',
      message: 'Bu çelıncın rövanşı zaten oynandı. Yenisini onun sonucundan aç.',
    });
    const own = await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` });
    expect(own.statusCode).toBe(201);
  });

  it('lets a friend who turned a group rematch down open their own', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    const can = await registerUser(harness.app, 'can', { displayName: 'Can' });
    befriend(harness.app, ali.me.id, veli.me.id);
    befriend(harness.app, ali.me.id, can.me.id);
    befriend(harness.app, veli.me.id, can.me.id);
    const created = await createChallenge(harness, ali, { participantIds: [veli.me.id, can.me.id] });
    const challengeId = created.json<Challenge>().id;
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    await authed(harness.app, can.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    await harness.app.inject({ method: 'POST', url: `/dev/finalize/${challengeId}` });

    const veliRematch = (
      await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` })
    ).json<Challenge>();
    // Can is still invited, so Veli's goes on without Ali
    const declined = await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${veliRematch.id}/decline` });
    expect(declined.json<ChallengeDetail>().challenge.status).toBe('pending');

    const results = (
      await authed(harness.app, ali.token)({ method: 'GET', url: `/challenges/${challengeId}/results` })
    ).json<ChallengeResults>();
    expect(results.rematch).toBeNull();
    const own = await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` });
    expect(own.statusCode).toBe(201);
  });

  it('lets the creator who walked out of their own group rematch open a new one', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    const can = await registerUser(harness.app, 'can', { displayName: 'Can' });
    befriend(harness.app, ali.me.id, veli.me.id);
    befriend(harness.app, ali.me.id, can.me.id);
    befriend(harness.app, veli.me.id, can.me.id);
    const challengeId = (await createChallenge(harness, ali, { participantIds: [veli.me.id, can.me.id] })).json<Challenge>().id;
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    await authed(harness.app, can.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    await harness.app.inject({ method: 'POST', url: `/dev/finalize/${challengeId}` });

    const first = (
      await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` })
    ).json<Challenge>();
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${first.id}/accept` });
    await authed(harness.app, can.token)({ method: 'POST', url: `/challenges/${first.id}/accept` });
    // Ali walks out; Veli and Can play it on
    const left = await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${first.id}/leave` });
    expect(left.json<ChallengeDetail>().challenge.status).toBe('pending');

    // the results screen offers him the button, and the button must work
    const results = (
      await authed(harness.app, ali.token)({ method: 'GET', url: `/challenges/${challengeId}/results` })
    ).json<ChallengeResults>();
    expect(results.rematch).toBeNull();
    expect(results.rematchInvitable).toBe(2);
    const own = await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` });
    expect(own.statusCode).toBe(201);
  });

  it('does not hold Ali to an invite a block came between since', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await finishedChallenge(harness);
    const opened = await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` });
    expect(opened.statusCode).toBe(201);
    await authed(harness.app, veli.token)({ method: 'POST', url: `/users/${ali.me.id}/block` });

    // accept would refuse it, so it is no rematch to send him to
    const results = (
      await authed(harness.app, ali.token)({ method: 'GET', url: `/challenges/${challengeId}/results` })
    ).json<ChallengeResults>();
    expect(results.rematch).toBeNull();
    const own = await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` });
    expect(own.json().error.code).toBe('no_participants');
  });

  it('says nobody is left to invite once the rival is no longer a friend', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await finishedChallenge(harness);
    await authed(harness.app, ali.token)({ method: 'DELETE', url: `/friends/${veli.me.id}` });

    const results = (
      await authed(harness.app, ali.token)({ method: 'GET', url: `/challenges/${challengeId}/results` })
    ).json<ChallengeResults>();
    expect(results.rematchInvitable).toBe(0);
    expect(results.rematchLeftOut).toEqual([veli.me.id]);
    expect(results.rematch).toBeNull();
    const refused = await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` });
    expect(refused.json().error.code).toBe('no_participants');
  });

  it('refuses while the challenge is still running', async () => {
    harness = await makeApp({ now: NOW });
    const { veli, challengeId } = await twoPlayerChallenge(harness);
    const response = await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('challenge_not_finished');
  });

  /** Ali and Veli both at `level`, a finished steps çelınc: Ali 12.430, Veli `veliSteps`. */
  async function finishedAt(h: TestApp, level: 1 | 2 | 3, veliSteps: number) {
    const ali = await registerUser(h.app, 'ali', { displayName: 'Ali', vulgarityMax: level });
    const veli = await registerUser(h.app, 'veli', { displayName: 'Veli', vulgarityMax: level });
    befriend(h.app, ali.me.id, veli.me.id);
    const challengeId = (await createChallenge(h, ali, { participantIds: [veli.me.id] })).json<Challenge>().id;
    await authed(h.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    const day = today(h);
    await postEntry(h, ali, challengeId, { dayKey: day, value: 12430, source: 'pedometer', clientTime: iso(h) });
    await postEntry(h, veli, challengeId, { dayKey: day, value: veliSteps, source: 'pedometer', clientTime: iso(h) });
    expect((await h.app.inject({ method: 'POST', url: `/dev/finalize/${challengeId}` })).statusCode).toBe(200);
    return { ali, veli, challengeId };
  }

  const rematchBody = (h: TestApp, userId: string): string => listByType(h.db, userId, 'rematch')[0]?.body ?? '';

  it('asks only the one who lost the original whether they will lose again', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await finishedAt(harness, 3, 900);

    // Veli lost and wants it back: Ali won, so he hears Veli came back for more
    const byVeli = await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` });
    expect(byVeli.statusCode).toBe(201);
    expect(rematchBody(harness, ali.me.id)).toContain('Geçen sefer yedi, doymamış');
    expect(rematchBody(harness, ali.me.id)).not.toContain('Yine mi yiyeceksin');

    // Ali turns it down and opens his own: to Veli the line is true
    await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${byVeli.json<Challenge>().id}/decline` });
    const byAli = await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` });
    expect(byAli.statusCode).toBe(201);
    expect(rematchBody(harness, veli.me.id)).toContain('Yine mi yiyeceksin');
  });

  it('tells a "Normal" winner to come and win it again', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await finishedAt(harness, 2, 900);
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` });
    expect(rematchBody(harness, ali.me.id)).toContain('Kabul et de bir daha koy.');
  });

  it('tells a co-leader of a tie that this time somebody loses', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await finishedAt(harness, 3, 12430);
    const detail = (await authed(harness.app, ali.token)({ method: 'GET', url: `/challenges/${challengeId}` })).json<ChallengeDetail>();
    expect(detail.challenge.isTie).toBe(true);

    await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` });
    expect(rematchBody(harness, veli.me.id)).toContain('Bu sefer biri yiyecek');
    expect(rematchBody(harness, veli.me.id)).not.toContain('Yine mi yiyeceksin');
  });
});

describe("friends in other zones play the creator's number of days", () => {
  /** A yes for `dayKey`, typed the way the detail screen's buttons send it. */
  async function mark(h: TestApp, user: RegisteredUser, challengeId: string, dayKey: string) {
    return postEntry(h, user, challengeId, { dayKey, value: 1, source: 'manual', clientTime: iso(h) });
  }

  function finalRows(h: TestApp, challengeId: string): { user_id: string; final_score: number }[] {
    return h.db
      .prepare('SELECT user_id, final_score FROM challenge_participants WHERE challenge_id = ? ORDER BY rowid')
      .all(challengeId) as { user_id: string; final_score: number }[];
  }

  function outcome(h: TestApp, challengeId: string): { status: string; winner_id: string | null; is_tie: number } {
    return h.db.prepare('SELECT status, winner_id, is_tie FROM challenges WHERE id = ?').get(challengeId) as {
      status: string;
      winner_id: string | null;
      is_tie: number;
    };
  }

  async function myDays(h: TestApp, user: RegisteredUser, challengeId: string) {
    const detail = await authed(h.app, user.token)({ method: 'GET', url: `/challenges/${challengeId}` });
    return detail.json<ChallengeDetail>().myDays;
  }

  /**
   * Ali's "3 gün" Sigara Yok made at 08:00 in New York, Deniz in Istanbul:
   * 10-12 November in New York, 16:00 on the 10th to 07:59 on the 13th in Istanbul.
   */
  async function newYorkSigara(h: TestApp) {
    const ali = await registerUser(h.app, 'ali', { displayName: 'Ali', timezone: 'America/New_York' });
    const deniz = await registerUser(h.app, 'deniz', { displayName: 'Deniz' });
    befriend(h.app, ali.me.id, deniz.me.id);
    const created = await createChallenge(h, ali, {
      typeKey: 'sigara_yok',
      participantIds: [deniz.me.id],
      endsAt: '2026-11-13T04:59:59.999Z',
    });
    expect(created.statusCode).toBe(201);
    const challengeId = created.json<Challenge>().id;
    expect((await authed(h.app, deniz.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` })).statusCode).toBe(200);
    return { ali, deniz, challengeId };
  }

  it('refuses the sliver of a fourth day Istanbul gets in a New York "3 gün", so equal play ties', async () => {
    harness = await makeApp({ now: '2026-11-10T13:00:00.000Z' }); // 08:00 in New York, 16:00 in Istanbul
    const { ali, deniz, challengeId } = await newYorkSigara(harness);
    expect(await myDays(harness, deniz, challengeId)).toEqual({ first: '2026-11-10', last: '2026-11-12' });
    expect(await myDays(harness, ali, challengeId)).toEqual({ first: '2026-11-10', last: '2026-11-12' });

    for (const day of ['2026-11-10', '2026-11-11', '2026-11-12']) {
      harness.setNow(`${day}T13:00:00.000Z`);
      expect((await mark(harness, ali, challengeId, day)).statusCode).toBe(201);
      expect((await mark(harness, deniz, challengeId, day)).statusCode).toBe(201);
    }

    harness.setNow('2026-11-13T03:30:00.000Z'); // 06:30 on the 13th in Istanbul, 22:30 on the 12th in New York
    const sliver = await mark(harness, deniz, challengeId, '2026-11-13');
    expect(sliver.statusCode).toBe(400);
    // inside the çelınc's dates, so not "out of its dates": an older app shows it right there
    expect(sliver.json<{ error: { code: string; message: string } }>().error).toEqual({
      code: 'day_out_of_range',
      message: 'Saat farkı yüzünden bu gün sende sayılmıyor: herkes çelıncı açanın gün sayısı kadar gün oynar.',
    });
    // a day outside them still says so
    const outside = await mark(harness, deniz, challengeId, '2026-11-09');
    expect(outside.json<{ error: { code: string; message: string } }>().error).toEqual({
      code: 'day_out_of_range',
      message: 'Bu gün çelıncın tarih aralığında değil.',
    });
    // one an older server took before the trim does not count either
    harness.db
      .prepare(
        `INSERT INTO entries (id, challenge_id, user_id, day_key, value, source, note, proof_url, status, client_time,
                              session_id, late, created_at, updated_at)
         VALUES ('sliver', ?, ?, '2026-11-13', 1, 'manual', NULL, NULL, 'ok', ?, NULL, 0, ?, ?)`,
      )
      .run(challengeId, deniz.me.id, iso(harness), iso(harness), iso(harness));

    harness.setNow('2026-11-13T05:00:30.000Z');
    runSchedulerOnce(harness.db, harness.now());
    expect(outcome(harness, challengeId)).toEqual({ status: 'finished', winner_id: null, is_tie: 1 });
    expect(finalRows(harness, challengeId)).toEqual([
      { user_id: ali.me.id, final_score: 3 },
      { user_id: deniz.me.id, final_score: 3 },
    ]);
  });

  // An older server took Deniz's sliver of a fourth day; the update leaves it
  // out of her days. An itiraz on it held a 3-3 result 12 hours and told her
  // to prove a day that counts for nothing.
  it('takes no itiraz on a day an older server took that no longer counts, and lets one filed before hold nothing', async () => {
    harness = await makeApp({ now: '2026-11-10T13:00:00.000Z' });
    const { ali, deniz, challengeId } = await newYorkSigara(harness);
    for (const day of ['2026-11-10', '2026-11-11', '2026-11-12']) {
      harness.setNow(`${day}T13:00:00.000Z`);
      expect((await mark(harness, ali, challengeId, day)).statusCode).toBe(201);
      expect((await mark(harness, deniz, challengeId, day)).statusCode).toBe(201);
    }
    harness.setNow('2026-11-13T03:30:00.000Z'); // 06:30 on the 13th in Istanbul, 22:30 on the 12th in New York
    harness.db
      .prepare(
        `INSERT INTO entries (id, challenge_id, user_id, day_key, value, source, note, proof_url, status, client_time,
                              session_id, late, created_at, updated_at)
         VALUES ('sliver', ?, ?, '2026-11-13', 1, 'manual', NULL, NULL, 'ok', ?, NULL, 0, ?, ?)`,
      )
      .run(challengeId, deniz.me.id, iso(harness), iso(harness), iso(harness));

    const filed = await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/entries/sliver/dispute`,
      payload: { reason: 'o gün yoktu ki' },
    });
    expect(filed.statusCode).toBe(400);
    expect(filed.json<{ error: { code: string; message: string } }>().error).toEqual({
      code: 'entry_not_scored',
      message: 'Bu gün saat farkı yüzünden zaten sayılmıyor, itiraz gerekmez.',
    });
    expect(harness.db.prepare('SELECT COUNT(*) AS n FROM disputes').get()).toEqual({ n: 0 });
    expect(listByType(harness.db, deniz.me.id, 'dispute')).toEqual([]);

    // one the older server took on it, already on the clock
    harness.db
      .prepare(
        `INSERT INTO disputes (id, entry_id, by_user_id, reason, status, created_at)
         VALUES ('old', 'sliver', ?, 'o gün yoktu ki', 'open', ?)`,
      )
      .run(ali.me.id, iso(harness));
    harness.db
      .prepare("UPDATE entries SET status = 'disputed', answer_by = ?, answer_from = ? WHERE id = 'sliver'")
      .run(iso(harness, LIMITS.DISPUTE_ANSWER_MS), iso(harness));
    const detail = await authed(harness.app, ali.token)({ method: 'GET', url: `/challenges/${challengeId}` });
    const row = detail.json<ChallengeDetail>().feed.find((item) => item.id === 'sliver');
    expect(row).toMatchObject({ answerBy: null, disputeVotes: null });

    // the result comes at the end, not 12 hours on, and burns nothing
    harness.setNow('2026-11-13T05:00:30.000Z');
    expect(runSchedulerOnce(harness.db, harness.now())).toMatchObject({ disputes: 0, finalized: 1 });
    expect(outcome(harness, challengeId)).toEqual({ status: 'finished', winner_id: null, is_tie: 1 });
    expect(harness.db.prepare("SELECT status FROM disputes WHERE id = 'old'").get()).toEqual({ status: 'open' });
    expect(listByType(harness.db, deniz.me.id, 'entry_rejected')).toEqual([]);
    expect(listByType(harness.db, deniz.me.id, 'dispute')).toEqual([]);
  });

  it('drops the end each friend has less of: Dubai the hour of Monday, Los Angeles the two hours of Sunday', async () => {
    harness = await makeApp({ now: '2026-01-05T06:00:00.000Z' }); // Monday 09:00 in Istanbul
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const omar = await registerUser(harness.app, 'omar', { displayName: 'Omar', timezone: 'Asia/Dubai' });
    const lara = await registerUser(harness.app, 'lara', { displayName: 'Lara', timezone: 'America/Los_Angeles' });
    befriend(harness.app, ali.me.id, omar.me.id);
    befriend(harness.app, ali.me.id, lara.me.id);
    // Monday 09:00 to the end of Sunday in Istanbul: seven days
    const created = await createChallenge(harness, ali, {
      typeKey: 'sigara_yok',
      participantIds: [omar.me.id, lara.me.id],
      endsAt: '2026-01-11T20:59:59.999Z',
    });
    const challengeId = created.json<Challenge>().id;
    for (const user of [omar, lara]) {
      expect((await authed(harness.app, user.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` })).statusCode).toBe(200);
    }
    expect(await myDays(harness, omar, challengeId)).toEqual({ first: '2026-01-05', last: '2026-01-11' });
    expect(await myDays(harness, lara, challengeId)).toEqual({ first: '2026-01-05', last: '2026-01-11' });

    harness.setNow('2026-01-05T06:30:00.000Z'); // 22:30 on Sunday the 4th in Los Angeles
    const sunday = await mark(harness, lara, challengeId, '2026-01-04');
    expect(sunday.statusCode).toBe(400);
    expect(sunday.json<{ error: { code: string } }>().error.code).toBe('day_out_of_range');

    for (let n = 0; n < 7; n += 1) {
      const day = addDays('2026-01-05', n);
      harness.setNow(`${day}T12:00:00.000Z`); // the same date in all three zones
      for (const user of [ali, omar, lara]) expect((await mark(harness, user, challengeId, day)).statusCode).toBe(201);
    }
    // Los Angeles keeps its 13 hours of the last Sunday
    harness.setNow('2026-01-11T20:00:00.000Z'); // 12:00 in Los Angeles, 00:00 on Monday in Dubai
    expect((await mark(harness, lara, challengeId, '2026-01-11')).statusCode).toBe(200);
    harness.setNow('2026-01-11T20:30:00.000Z');
    const monday = await mark(harness, omar, challengeId, '2026-01-12');
    expect(monday.statusCode).toBe(400);
    expect(monday.json<{ error: { code: string } }>().error.code).toBe('day_out_of_range');

    // Lara's yes in the last hour keeps the hour after the end open for itirazlar
    harness.setNow('2026-01-11T22:00:30.000Z');
    runSchedulerOnce(harness.db, harness.now());
    expect(outcome(harness, challengeId)).toEqual({ status: 'finished', winner_id: null, is_tie: 1 });
    expect(finalRows(harness, challengeId).map((row) => row.final_score)).toEqual([7, 7, 7]);
  });

  it('changes nothing for friends in one zone, a day the end cuts in half included', async () => {
    harness = await makeApp({ now: NOW });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    befriend(harness.app, ali.me.id, veli.me.id);
    // three times 24 hours from noon: four Istanbul days, the last one until noon
    const created = await createChallenge(harness, ali, { typeKey: 'sigara_yok', participantIds: [veli.me.id] });
    const challengeId = created.json<Challenge>().id;
    await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
    expect(await myDays(harness, veli, challengeId)).toEqual({ first: '2026-01-05', last: '2026-01-08' });

    for (let n = 0; n < 4; n += 1) {
      const day = addDays('2026-01-05', n);
      harness.setNow(`${day}T08:00:00.000Z`); // 11:00, before the noon end on the last day
      expect((await mark(harness, ali, challengeId, day)).statusCode).toBe(201);
      if (n < 3) expect((await mark(harness, veli, challengeId, day)).statusCode).toBe(201);
    }

    // the last yes came at 11:00, in the last hour, which stays open for itirazlar
    harness.setNow('2026-01-08T10:00:30.000Z');
    runSchedulerOnce(harness.db, harness.now());
    expect(outcome(harness, challengeId)).toEqual({ status: 'finished', winner_id: ali.me.id, is_tie: 0 });
    expect(finalRows(harness, challengeId).map((row) => row.final_score)).toEqual([4, 3]);
  });

  /**
   * Ali's Istanbul çelınc from midnight on Monday, Lara in Los Angeles: her
   * Sunday afternoon is the 11-hour sliver `scoringWindow` leaves out.
   */
  async function istanbulMidnight(h: TestApp, typeKey: string) {
    const ali = await registerUser(h.app, 'ali', { displayName: 'Ali' });
    const lara = await registerUser(h.app, 'lara', { displayName: 'Lara', timezone: 'America/Los_Angeles' });
    befriend(h.app, ali.me.id, lara.me.id);
    const created = await createChallenge(h, ali, {
      typeKey,
      participantIds: [lara.me.id],
      endsAt: '2026-01-11T20:59:59.999Z',
      proofRequired: false,
    });
    expect(created.statusCode).toBe(201);
    const challengeId = created.json<Challenge>().id;
    expect((await authed(h.app, lara.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` })).statusCode).toBe(200);
    return { ali, lara, challengeId };
  }

  it('keeps the screen-time Sunday Los Angeles can type all evening and drops the one the end cuts at 12:59', async () => {
    const h = await makeApp({ now: '2026-01-04T21:00:00.000Z' }); // Monday 00:00 in Istanbul, Sunday 13:00 in Los Angeles
    harness = h;
    const { ali, lara, challengeId } = await istanbulMidnight(h, 'ekran_suresi_beyani');
    // the 13 hours of the last Sunday are more, but they can be typed only until 12:59 and then cost 1440
    expect(await myDays(harness, lara, challengeId)).toEqual({ first: '2026-01-04', last: '2026-01-10' });

    harness.setNow('2026-01-05T03:00:00.000Z'); // 19:00 on Sunday in Los Angeles
    expect((await postEntry(harness, ali, challengeId, { dayKey: '2026-01-05', value: 300, source: 'manual', clientTime: iso(harness) })).statusCode).toBe(201);
    const detail = async () =>
      (await authed(h.app, ali.token)({ method: 'GET', url: `/challenges/${challengeId}` }))
        .json<ChallengeDetail>()
        .participants.map((p) => [p.user.id, p.score, p.rank]);
    // her first day, with nothing typed yet: the penalty, not a free 0
    expect(await detail()).toEqual([
      [ali.me.id, 300, 1],
      [lara.me.id, 1440, 2],
    ]);
    expect((await postEntry(harness, lara, challengeId, { dayKey: '2026-01-04', value: 200, source: 'manual', clientTime: iso(harness) })).statusCode).toBe(201);
    expect(await detail()).toEqual([
      [lara.me.id, 200, 1],
      [ali.me.id, 300, 2],
    ]);
  });

  it('charges nobody 1440 on screen time for a last day the end cuts, west or east of the creator', async () => {
    harness = await makeApp({ now: '2026-01-04T21:00:00.000Z' }); // Monday 00:00 in Istanbul
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const kenji = await registerUser(harness.app, 'kenji', { displayName: 'Kenji', timezone: 'Asia/Tokyo' });
    const mert = await registerUser(harness.app, 'mert', { displayName: 'Mert', timezone: 'America/New_York' });
    befriend(harness.app, ali.me.id, kenji.me.id);
    befriend(harness.app, ali.me.id, mert.me.id);
    const created = await createChallenge(harness, ali, {
      typeKey: 'ekran_suresi_beyani',
      participantIds: [kenji.me.id, mert.me.id],
      endsAt: '2026-01-11T20:59:59.999Z',
      proofRequired: false,
    });
    const challengeId = created.json<Challenge>().id;
    for (const user of [kenji, mert]) {
      expect((await authed(harness.app, user.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` })).statusCode).toBe(200);
    }
    // New York runs from 16:00 on Sunday to 15:59 on the next Sunday: the first is his to type all evening
    expect(await myDays(harness, mert, challengeId)).toEqual({ first: '2026-01-04', last: '2026-01-10' });
    expect(await myDays(harness, kenji, challengeId)).toEqual({ first: '2026-01-05', last: '2026-01-11' });

    // each types 100 at 23:30 local on every day of theirs
    const offsets: [RegisteredUser, string, number][] = [
      [ali, '2026-01-05', 3],
      [kenji, '2026-01-05', 9],
      [mert, '2026-01-04', -5],
    ];
    const typing: { at: number; user: RegisteredUser; dayKey: string }[] = [];
    for (const [user, first, offset] of offsets) {
      for (let n = 0; n < 7; n += 1) {
        const dayKey = addDays(first, n);
        typing.push({ at: Date.parse(`${dayKey}T23:30:00.000Z`) - offset * 3_600_000, user, dayKey });
      }
    }
    typing.sort((a, b) => a.at - b.at);
    for (const { at, user, dayKey } of typing) {
      harness.setNow(new Date(at).toISOString());
      const posted = await postEntry(harness, user, challengeId, { dayKey, value: 100, source: 'manual', clientTime: iso(harness) });
      expect(posted.statusCode).toBe(201);
    }

    harness.setNow('2026-01-11T22:00:30.000Z');
    runSchedulerOnce(harness.db, harness.now());
    expect(outcome(harness, challengeId)).toEqual({ status: 'finished', winner_id: null, is_tie: 1 });
    expect(finalRows(harness, challengeId).map((row) => row.final_score)).toEqual([100, 100, 100]);
  });

  it('sends no reminder or nudge for the sliver of a day a friend cannot mark', async () => {
    harness = await makeApp({ now: '2026-01-04T21:00:00.000Z' });
    const { ali, lara, challengeId } = await istanbulMidnight(harness, 'sigara_yok');
    harness.setNow('2026-01-05T03:00:00.000Z'); // 06:00 on Monday in Istanbul, 19:00 on Sunday in Los Angeles
    expect((await postEntry(harness, ali, challengeId, { dayKey: '2026-01-05', value: 1, source: 'manual', clientTime: iso(harness) })).statusCode).toBe(201);
    expect((await postEntry(harness, lara, challengeId, { dayKey: '2026-01-04', value: 1, source: 'manual', clientTime: iso(harness) })).statusCode).toBe(400);

    // 20:30 in Los Angeles: past her reminder hour and inside the nudge hours, one day behind
    harness.setNow('2026-01-05T04:30:00.000Z');
    expect(sendNudges(harness.db, harness.now())).toBe(0);
    expect(sendReminders(harness.db, harness.now())).toBe(0);

    // her Monday is hers: both come, as for anybody behind who has not marked it
    harness.setNow('2026-01-06T04:30:00.000Z');
    expect(sendNudges(harness.db, harness.now())).toBe(1);
    expect(sendReminders(harness.db, harness.now())).toBe(1);
  });

  it('keeps the result of one that finished before the trim, with its four days', async () => {
    harness = await makeApp({ now: '2026-11-10T13:00:00.000Z' });
    const { ali, deniz, challengeId } = await newYorkSigara(harness);
    // what an older server stored: Deniz's fourth day counted and won it
    const insert = harness.db.prepare(
      `INSERT INTO entries (id, challenge_id, user_id, day_key, value, source, note, proof_url, status, client_time,
                            session_id, late, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 'manual', NULL, NULL, 'ok', ?, NULL, 0, ?, ?)`,
    );
    for (const day of ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']) {
      if (day !== '2026-11-13') insert.run(`a-${day}`, challengeId, ali.me.id, day, iso(harness), iso(harness), iso(harness));
      insert.run(`d-${day}`, challengeId, deniz.me.id, day, iso(harness), iso(harness), iso(harness));
    }
    harness.db
      .prepare("UPDATE challenges SET status = 'finished', finalized_at = ?, winner_id = ?, is_tie = 0 WHERE id = ?")
      .run(iso(harness), deniz.me.id, challengeId);
    const store = harness.db.prepare(
      'UPDATE challenge_participants SET final_score = ?, final_rank = ? WHERE challenge_id = ? AND user_id = ?',
    );
    store.run(4, 1, challengeId, deniz.me.id);
    store.run(3, 2, challengeId, ali.me.id);

    harness.setNow('2026-11-14T12:00:00.000Z');
    const results = await authed(harness.app, ali.token)({ method: 'GET', url: `/challenges/${challengeId}/results` });
    const standings = results.json<ChallengeResults>().standings;
    expect(standings.map((p) => [p.user.id, p.score, p.days, p.rank, p.isWinner])).toEqual([
      [deniz.me.id, 4, 4, 1, true],
      [ali.me.id, 3, 3, 2, false],
    ]);
  });
});

describe('check-in çelınclar across zones', () => {
  /** 12:50 on Tuesday in Istanbul, 04:50 in New York, 09:50 in London. */
  const NOON_ISH = '2026-11-10T09:50:00.000Z';

  async function checkIn(h: TestApp, user: RegisteredUser, challengeId: string, dayKey: string) {
    return postEntry(h, user, challengeId, { dayKey, value: 1, source: 'checkin', clientTime: iso(h) });
  }

  function errorOf(response: { json: <T>() => T }): { code: string; message: string } {
    return response.json<{ error: { code: string; message: string } }>().error;
  }

  async function invite(h: TestApp, user: RegisteredUser, challengeId: string, userIds: string[]) {
    return authed(h.app, user.token)({ method: 'POST', url: `/challenges/${challengeId}/invite`, payload: { userIds } });
  }

  async function accept(h: TestApp, user: RegisteredUser, challengeId: string) {
    return authed(h.app, user.token)({ method: 'POST', url: `/challenges/${challengeId}/accept` });
  }

  function rowOf(h: TestApp, challengeId: string, userId: string): { status: string } | undefined {
    return h.db
      .prepare('SELECT status FROM challenge_participants WHERE challenge_id = ? AND user_id = ?')
      .get(challengeId, userId) as { status: string } | undefined;
  }

  async function detailFor(h: TestApp, user: RegisteredUser, challengeId: string) {
    return (await authed(h.app, user.token)({ method: 'GET', url: `/challenges/${challengeId}` })).json<ChallengeDetail>();
  }

  it('keeps a New York friend out of a one-day erken_yat made "Hemen" in Istanbul: it has no evening for him', async () => {
    harness = await makeApp({ now: NOON_ISH });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const mert = await registerUser(harness.app, 'mert', { displayName: 'Mert', timezone: 'America/New_York' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    befriend(harness.app, ali.me.id, mert.me.id);
    befriend(harness.app, ali.me.id, veli.me.id);
    // until 23:59 in Istanbul, 15:59 in New York, four hours before its 19:00
    const oneEvening = { typeKey: 'erken_yat', deadlineTime: '23:00', endsAt: '2026-11-10T20:59:59.999Z' };

    const wizard = await createChallenge(harness, ali, { ...oneEvening, participantIds: [veli.me.id, mert.me.id] });
    expect(wizard.statusCode).toBe(400);
    expect(errorOf(wizard)).toEqual({
      code: 'checkin_days_short',
      message:
        'Saat farkı yüzünden bu çelıncın check-in saati Mert için hiçbir güne denk gelmiyor, sende 1 gün. Eksik günle eklenemez.',
    });
    expect(harness.db.prepare('SELECT COUNT(*) AS n FROM challenges').get()).toEqual({ n: 0 });

    const created = await createChallenge(harness, ali, { ...oneEvening, participantIds: [veli.me.id] });
    expect(created.statusCode).toBe(201);
    const challengeId = created.json<Challenge>().id;
    const later = await invite(harness, ali, challengeId, [mert.me.id]);
    expect(later.statusCode).toBe(400);
    expect(errorOf(later).code).toBe('checkin_days_short');
    expect(rowOf(harness, challengeId, mert.me.id)).toBeUndefined();
    // and "Kanka oldunuz" does not offer it either
    expect(invitableFor(harness.db, ali.me.id, mert.me.id, harness.now())).toEqual([]);

    // Veli was asked while in Istanbul and says yes from New York: his yes pins New York
    const moved = await authed(harness.app, veli.token)({ method: 'PATCH', url: '/me', payload: { timezone: 'America/New_York' } });
    expect(moved.statusCode).toBe(200);
    const refused = await accept(harness, veli, challengeId);
    expect(refused.statusCode).toBe(400);
    expect(errorOf(refused)).toEqual({
      code: 'checkin_days_short',
      message:
        'Saat farkı yüzünden bu çelıncın check-in saati sende hiçbir güne denk gelmiyor, çelıncı açan Ali için 1 gün. Eksik günle bu çelınca katılamazsın.',
    });
    expect(rowOf(harness, challengeId, veli.me.id)?.status).toBe('invited');

    // back home before the evening, he plays it
    await authed(harness.app, veli.token)({ method: 'PATCH', url: '/me', payload: { timezone: 'Europe/Istanbul' } });
    expect((await accept(harness, veli, challengeId)).statusCode).toBe(200);
  });

  // An older server asked Mert into Ali's "Yarın" erken_yat without checking:
  // six evenings in New York to Ali's seven. His yes was refused, the invite
  // sat unread, Ali heard nothing for a week and then read "kimse kabul etmedi".
  it('ends an invite an older server sent short of evenings when it is accepted, and tells whoever called', async () => {
    harness = await makeApp({ now: NOON_ISH });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const mert = await registerUser(harness.app, 'mert', { displayName: 'Mert' });
    befriend(harness.app, ali.me.id, mert.me.id);
    // from 09:00 on Wednesday to the end of the next Tuesday in Istanbul
    const created = await createChallenge(harness, ali, {
      typeKey: 'erken_yat',
      deadlineTime: '23:00',
      participantIds: [mert.me.id],
      startsAt: '2026-11-11T06:00:00.000Z',
      endsAt: '2026-11-17T20:59:59.999Z',
    });
    expect(created.statusCode).toBe(201);
    const challengeId = created.json<Challenge>().id;
    // Mert lives in New York, and the invite came from the older server (migration 019)
    harness.db.prepare("UPDATE users SET timezone = 'America/New_York' WHERE id = ?").run(mert.me.id);
    harness.db
      .prepare('UPDATE challenge_participants SET days_checked = 0 WHERE challenge_id = ? AND user_id = ?')
      .run(challengeId, mert.me.id);

    const refused = await accept(harness, mert, challengeId);
    expect(refused.statusCode).toBe(400);
    expect(errorOf(refused)).toEqual({
      code: 'checkin_days_short',
      message:
        'Saat farkı yüzünden bu çelıncın check-in saati sende 6 güne denk geliyor, çelıncı açan Ali için 7 gün. Eksik günle bu çelınca katılamazsın. Davet kapandı.',
    });
    expect(rowOf(harness, challengeId, mert.me.id)?.status).toBe('declined');
    expect(listByType(harness.db, mert.me.id, 'challenge_invite')[0]?.read_at).not.toBeNull();

    // Ali hears why at once, and a 1v1 with nobody left to ask ends now
    const told = listByType(harness.db, ali.me.id, 'challenge_declined');
    expect(told.map((row) => [row.title, row.body, JSON.parse(row.data)])).toEqual([
      [
        'Mert giremedi',
        `Saat farkı yüzünden "Erken Yatma Sözü" çelıncına giremedi, check-in saati onda daha az güne denk geliyor. Davet kapandı.`,
        { challengeId, fromUserId: mert.me.id, reason: 'checkin_days_short' },
      ],
    ]);
    expect(harness.db.prepare('SELECT status FROM challenges WHERE id = ?').get(challengeId)).toEqual({ status: 'cancelled' });
    const cancelled = listByType(harness.db, ali.me.id, 'challenge_cancelled');
    expect(cancelled.map((row) => JSON.parse(row.data))).toEqual([{ challengeId, reason: 'everyone_left' }]);
    expect(listByType(harness.db, mert.me.id, 'challenge_cancelled')).toEqual([]);
  });

  it('lets London into a seven-day erken_yat made at 12:50 in Istanbul, and not New York with its six evenings', async () => {
    harness = await makeApp({ now: NOON_ISH });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const leyla = await registerUser(harness.app, 'leyla', { displayName: 'Leyla', timezone: 'Europe/London' });
    const mert = await registerUser(harness.app, 'mert', { displayName: 'Mert', timezone: 'America/New_York' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    for (const friend of [leyla, mert, veli]) befriend(harness.app, ali.me.id, friend.me.id);
    befriend(harness.app, veli.me.id, mert.me.id);
    const created = await createChallenge(harness, ali, {
      typeKey: 'erken_yat',
      deadlineTime: '23:00',
      participantIds: [leyla.me.id, veli.me.id],
      endsAt: '2026-11-16T20:59:59.999Z',
    });
    expect(created.statusCode).toBe(201);
    const challengeId = created.json<Challenge>().id;

    expect((await accept(harness, leyla, challengeId)).statusCode).toBe(200);
    // seven evenings: the last ends at 20:59 there, cut before its 23:00 but still from 19:00
    // (the app shows that day's limit as 20:59 and pokes her at 20:30)
    expect((await detailFor(harness, leyla, challengeId)).myDays).toEqual({ first: '2026-11-10', last: '2026-11-16' });
    expect((await accept(harness, veli, challengeId)).statusCode).toBe(200);

    // the seventh evening starts at 19:00 in New York, after the end; Veli is not the one who opened it
    const refused = await invite(harness, veli, challengeId, [mert.me.id]);
    expect(refused.statusCode).toBe(400);
    expect(errorOf(refused)).toEqual({
      code: 'checkin_days_short',
      message:
        'Saat farkı yüzünden bu çelıncın check-in saati Mert için 6 güne denk geliyor, çelıncı açan Ali için 7 gün. Eksik günle eklenemez.',
    });
    expect(rowOf(harness, challengeId, mert.me.id)).toBeUndefined();
  });

  /**
   * Ali's erken_kus made "Hemen" at 23:00 on Monday in Istanbul by an app that
   * still started it there, until the end of Friday: Tuesday to Friday's
   * mornings for him. In Tokyo it runs from 05:00 on Tuesday to 05:59 on
   * Saturday, five mornings: Saturday's two hours are one more than Ali has.
   */
  async function lateNightErkenKus(h: TestApp) {
    const ali = await registerUser(h.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(h.app, 'veli', { displayName: 'Veli', timezone: 'Asia/Tokyo', reminderHour: 4 });
    befriend(h.app, ali.me.id, veli.me.id);
    const created = await createChallenge(h, ali, {
      typeKey: 'erken_kus',
      deadlineTime: '07:00',
      participantIds: [veli.me.id],
      endsAt: '2026-01-09T20:59:59.999Z',
    });
    expect(created.statusCode).toBe(201);
    const challengeId = created.json<Challenge>().id;
    expect((await accept(h, veli, challengeId)).statusCode).toBe(200);
    return { ali, veli, challengeId };
  }

  it("scores Tokyo on the creator's number of mornings and shows everybody the zone they play in", async () => {
    harness = await makeApp({ now: '2026-01-05T20:00:00.000Z' }); // Monday 23:00 in Istanbul, Tuesday 05:00 in Tokyo
    const { ali, veli, challengeId } = await lateNightErkenKus(harness);
    expect((await detailFor(harness, veli, challengeId)).myDays).toEqual({ first: '2026-01-06', last: '2026-01-09' });
    // Ali keeps his Monday: a "Geldim" tapped after its 07:00 still goes in late, as before
    expect((await detailFor(harness, ali, challengeId)).myDays).toEqual({ first: '2026-01-05', last: '2026-01-09' });

    harness.setNow('2026-01-05T20:30:00.000Z'); // 05:30 on Tuesday in Tokyo
    expect((await checkIn(harness, veli, challengeId, '2026-01-06')).statusCode).toBe(201);
    for (const day of ['2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09']) {
      if (day !== '2026-01-06') {
        harness.setNow(`${addDays(day, -1)}T21:00:00.000Z`); // 06:00 in Tokyo
        expect((await checkIn(harness, veli, challengeId, day)).statusCode).toBe(201);
      }
      harness.setNow(`${day}T03:30:00.000Z`); // 06:30 in Istanbul, 12:30 in Tokyo
      expect((await checkIn(harness, ali, challengeId, day)).statusCode).toBe(201);
    }

    // Saturday 04:30 in Tokyo: no reminder for a morning the server refuses
    harness.setNow('2026-01-09T19:30:00.000Z');
    expect(sendReminders(harness.db, harness.now())).toBe(0);
    harness.setNow('2026-01-09T20:00:00.000Z'); // 05:00 on Saturday in Tokyo
    const extra = await checkIn(harness, veli, challengeId, '2026-01-10');
    expect(extra.statusCode).toBe(400);
    expect(errorOf(extra).code).toBe('day_out_of_range');

    const zones = Object.fromEntries((await detailFor(harness, ali, challengeId)).participants.map((p) => [p.user.id, p.timezone]));
    expect(zones).toEqual({ [ali.me.id]: 'Europe/Istanbul', [veli.me.id]: 'Asia/Tokyo' });

    harness.setNow('2026-01-09T21:00:30.000Z');
    runSchedulerOnce(harness.db, harness.now());
    const outcome = harness.db.prepare('SELECT status, winner_id, is_tie FROM challenges WHERE id = ?').get(challengeId);
    expect(outcome).toEqual({ status: 'finished', winner_id: null, is_tie: 1 });
  });

  it('still reminds Tokyo on a morning that counts', async () => {
    harness = await makeApp({ now: '2026-01-05T20:00:00.000Z' });
    await lateNightErkenKus(harness);
    harness.setNow('2026-01-08T19:30:00.000Z'); // 04:30 on Friday in Tokyo
    expect(sendReminders(harness.db, harness.now())).toBe(1);
  });

  it('keeps the Tokyo morning whose 07:00 a "Hemen" from 00:30 reaches over the last one the end cuts at 05:59', async () => {
    harness = await makeApp({ now: '2026-11-09T21:30:00.000Z' }); // 00:30 on Tuesday in Istanbul, 06:30 in Tokyo
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli', timezone: 'Asia/Tokyo' });
    befriend(harness.app, ali.me.id, veli.me.id);
    const created = await createChallenge(harness, ali, {
      typeKey: 'erken_kus',
      deadlineTime: '07:00',
      participantIds: [veli.me.id],
      endsAt: '2026-11-13T20:59:59.999Z',
    });
    expect(created.statusCode).toBe(201);
    const challengeId = created.json<Challenge>().id;
    expect((await accept(harness, veli, challengeId)).statusCode).toBe(200);
    // Tuesday's half hour before 07:00 counts; Saturday's 04:00-05:59 has no 07:00 in it
    expect((await detailFor(harness, veli, challengeId)).myDays).toEqual({ first: '2026-11-10', last: '2026-11-13' });

    // both at 06:45 local every morning
    for (const day of ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']) {
      harness.setNow(`${addDays(day, -1)}T21:45:00.000Z`);
      expect((await checkIn(harness, veli, challengeId, day)).statusCode).toBe(201);
      harness.setNow(`${day}T03:45:00.000Z`);
      expect((await checkIn(harness, ali, challengeId, day)).statusCode).toBe(201);
    }
    harness.setNow('2026-11-13T19:45:00.000Z'); // 04:45 on Saturday in Tokyo
    expect(errorOf(await checkIn(harness, veli, challengeId, '2026-11-14')).code).toBe('day_out_of_range');

    harness.setNow('2026-11-13T22:00:30.000Z');
    runSchedulerOnce(harness.db, harness.now());
    const outcome = harness.db.prepare('SELECT status, winner_id, is_tie FROM challenges WHERE id = ?').get(challengeId);
    expect(outcome).toEqual({ status: 'finished', winner_id: null, is_tie: 1 });
  });

  // A server from before the trim scored Veli on all five Tokyo mornings. The
  // owner updates on the last evening, after the old server took Veli's
  // Saturday: the çelınc moves onto Ali's four, and equal play ties.
  it("moves a check-in çelınc running when the server is updated onto the creator's count, an older server's extra morning with it", async () => {
    harness = await makeApp({ now: '2026-11-09T21:30:00.000Z' }); // 00:30 on Tuesday in Istanbul, 06:30 in Tokyo
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli', timezone: 'Asia/Tokyo' });
    befriend(harness.app, ali.me.id, veli.me.id);
    const created = await createChallenge(harness, ali, {
      typeKey: 'erken_kus',
      deadlineTime: '07:00',
      participantIds: [veli.me.id],
      endsAt: '2026-11-13T20:59:59.999Z',
    });
    const challengeId = created.json<Challenge>().id;
    expect((await accept(harness, veli, challengeId)).statusCode).toBe(200);

    // both at 06:45 local every morning
    for (const day of ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']) {
      harness.setNow(`${addDays(day, -1)}T21:45:00.000Z`);
      expect((await checkIn(harness, veli, challengeId, day)).statusCode).toBe(201);
      harness.setNow(`${day}T03:45:00.000Z`);
      expect((await checkIn(harness, ali, challengeId, day)).statusCode).toBe(201);
    }
    // what the older server took at 04:45 on Saturday in Tokyo, before the end at 05:59
    harness.setNow('2026-11-13T19:45:00.000Z');
    harness.db
      .prepare(
        `INSERT INTO entries (id, challenge_id, user_id, day_key, value, source, note, proof_url, status, client_time,
                              session_id, late, created_at, updated_at)
         VALUES ('saturday', ?, ?, '2026-11-14', 1, 'checkin', NULL, NULL, 'ok', ?, NULL, 0, ?, ?)`,
      )
      .run(challengeId, veli.me.id, iso(harness), iso(harness), iso(harness));

    // his first morning stays, the Saturday is no day of his and its "Geldim" counts for nothing
    expect((await detailFor(harness, veli, challengeId)).myDays).toEqual({ first: '2026-11-10', last: '2026-11-13' });
    const scores = Object.fromEntries((await detailFor(harness, ali, challengeId)).participants.map((p) => [p.user.id, p.score]));
    expect(scores).toEqual({ [ali.me.id]: 4, [veli.me.id]: 4 });

    harness.setNow('2026-11-13T22:00:30.000Z');
    runSchedulerOnce(harness.db, harness.now());
    const outcome = harness.db.prepare('SELECT status, winner_id, is_tie FROM challenges WHERE id = ?').get(challengeId);
    expect(outcome).toEqual({ status: 'finished', winner_id: null, is_tie: 1 });
    const stored = harness.db
      .prepare('SELECT user_id, final_score FROM challenge_participants WHERE challenge_id = ? ORDER BY rowid')
      .all(challengeId);
    expect(stored).toEqual([
      { user_id: ali.me.id, final_score: 4 },
      { user_id: veli.me.id, final_score: 4 },
    ]);
  });

  // An older server let Mert into Ali's seven-day erken_yat from 12:50: six
  // evenings in New York. He tapped on time on every one he had, like
  // everybody, and lost 6-7 with a loser's badge.
  it('scores a check-in çelınc an older server let a friend into short of evenings on his count, so equal play ties', async () => {
    harness = await makeApp({ now: NOON_ISH });
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const leyla = await registerUser(harness.app, 'leyla', { displayName: 'Leyla', timezone: 'Europe/London' });
    const sam = await registerUser(harness.app, 'sam', { displayName: 'Sam', timezone: 'Australia/Sydney' });
    const mert = await registerUser(harness.app, 'mert', { displayName: 'Mert', timezone: 'America/New_York' });
    befriend(harness.app, ali.me.id, leyla.me.id);
    befriend(harness.app, ali.me.id, sam.me.id);
    const created = await createChallenge(harness, ali, {
      typeKey: 'erken_yat',
      deadlineTime: '23:00',
      participantIds: [leyla.me.id, sam.me.id],
      endsAt: '2026-11-16T20:59:59.999Z',
    });
    expect(created.statusCode).toBe(201);
    const challengeId = created.json<Challenge>().id;
    expect((await accept(harness, leyla, challengeId)).statusCode).toBe(200);
    expect((await accept(harness, sam, challengeId)).statusCode).toBe(200);
    harness.db
      .prepare(
        `INSERT INTO challenge_participants (challenge_id, user_id, status, invited_at, joined_at, final_score, final_rank, timezone)
         VALUES (?, ?, 'accepted', ?, ?, NULL, NULL, 'America/New_York')`,
      )
      .run(challengeId, mert.me.id, iso(harness), iso(harness));

    // everybody plays six: Ali's last evening goes on the tie, Leyla's the one
    // the end cuts at 20:59, Sam's the first one from 20:50
    const h = harness;
    const days = async (user: RegisteredUser) => (await detailFor(h, user, challengeId)).myDays;
    expect(await days(ali)).toEqual({ first: '2026-11-10', last: '2026-11-15' });
    expect(await days(leyla)).toEqual({ first: '2026-11-10', last: '2026-11-15' });
    expect(await days(sam)).toEqual({ first: '2026-11-11', last: '2026-11-16' });
    expect(await days(mert)).toEqual({ first: '2026-11-10', last: '2026-11-15' });

    // 21:00 where each lives, on every evening they have
    const taps: [string, RegisteredUser, string][] = [];
    for (let i = 0; i < 6; i += 1) {
      const day = addDays('2026-11-10', i);
      taps.push([`${day}T18:00:00.000Z`, ali, day]);
      taps.push([`${day}T21:00:00.000Z`, leyla, day]);
      taps.push([`${addDays(day, 1)}T10:00:00.000Z`, sam, addDays(day, 1)]);
      taps.push([`${addDays(day, 1)}T02:00:00.000Z`, mert, day]);
    }
    taps.sort((a, b) => a[0].localeCompare(b[0]));
    for (const [at, user, day] of taps) {
      harness.setNow(at);
      expect((await checkIn(harness, user, challengeId, day)).statusCode).toBe(201);
    }
    harness.setNow('2026-11-16T18:00:00.000Z');
    expect(errorOf(await checkIn(harness, ali, challengeId, '2026-11-16')).code).toBe('day_out_of_range');

    harness.setNow('2026-11-16T21:00:30.000Z');
    runSchedulerOnce(harness.db, harness.now());
    const outcome = harness.db.prepare('SELECT status, winner_id, is_tie FROM challenges WHERE id = ?').get(challengeId);
    expect(outcome).toEqual({ status: 'finished', winner_id: null, is_tie: 1 });
    const stored = harness.db
      .prepare('SELECT final_score, final_rank FROM challenge_participants WHERE challenge_id = ? ORDER BY rowid')
      .all(challengeId);
    expect(stored).toEqual(Array.from({ length: 4 }, () => ({ final_score: 6, final_rank: 1 })));
    const told = listByType(harness.db, mert.me.id, 'challenge_finished')[0];
    expect(JSON.parse(told?.data ?? '{}')).toMatchObject({ role: 'tie' });
    // and no "Ağzının Tadını Aldın"
    expect(harness.db.prepare('SELECT badge_key FROM badges WHERE user_id = ?').all(mert.me.id)).not.toContainEqual({
      badge_key: 'yiyis_1',
    });
  });

  it("leaves a zone's days with no slot out of its check-in days, but not a day the creator has without one too", async () => {
    harness = await makeApp({ now: '2026-11-09T09:00:00.000Z' }); // Monday 12:00 in Istanbul
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const mert = await registerUser(harness.app, 'mert', { displayName: 'Mert', timezone: 'America/New_York' });
    const greta = await registerUser(harness.app, 'greta', { displayName: 'Greta', timezone: 'Europe/Berlin' });
    befriend(harness.app, ali.me.id, mert.me.id);
    befriend(harness.app, ali.me.id, greta.me.id);
    // "Yarın" from 04:00 on Tuesday in Istanbul, 22:00 on Monday in New York, to the end of Saturday
    const created = await createChallenge(harness, ali, {
      typeKey: 'erken_kus',
      deadlineTime: '07:00',
      participantIds: [mert.me.id],
      startsAt: '2026-11-10T01:00:00.000Z',
      endsAt: '2026-11-14T20:59:59.999Z',
    });
    const challengeId = created.json<Challenge>().id;
    expect((await accept(harness, mert, challengeId)).statusCode).toBe(200);
    // his Monday evening has no morning in it: five days, as Ali's
    expect((await detailFor(harness, mert, challengeId)).myDays).toEqual({ first: '2026-11-10', last: '2026-11-14' });
    expect((await detailFor(harness, ali, challengeId)).myDays).toEqual({ first: '2026-11-10', last: '2026-11-14' });
    harness.setNow('2026-11-10T01:30:00.000Z'); // 20:30 on Monday in New York
    expect(errorOf(await checkIn(harness, mert, challengeId, '2026-11-09'))).toEqual({
      code: 'day_out_of_range',
      message: 'Saat farkı yüzünden bu check-in sende sayılmıyor: herkes çelıncı açanın sayısı kadar check-in yapar.',
    });

    // "Hemen" at 12:00, past Istanbul's 07:00 and Berlin's: both keep that first day, for its late 0
    harness.setNow('2026-11-10T09:00:00.000Z');
    const hemen = await createChallenge(harness, ali, {
      typeKey: 'erken_kus',
      deadlineTime: '07:00',
      participantIds: [greta.me.id],
      endsAt: '2026-11-12T20:59:59.999Z',
    });
    const hemenId = hemen.json<Challenge>().id;
    expect((await accept(harness, greta, hemenId)).statusCode).toBe(200);
    expect((await detailFor(harness, greta, hemenId)).myDays).toEqual({ first: '2026-11-10', last: '2026-11-12' });
  });

  it('does not remind New York of a last erken_yat evening that ends at 15:59, before its 19:00', async () => {
    harness = await makeApp({ now: '2026-11-08T21:30:00.000Z' }); // Monday 00:30 in Istanbul
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const mert = await registerUser(harness.app, 'mert', { displayName: 'Mert', timezone: 'America/New_York', reminderHour: 10 });
    befriend(harness.app, ali.me.id, mert.me.id);
    const created = await createChallenge(harness, ali, {
      typeKey: 'erken_yat',
      deadlineTime: '23:00',
      participantIds: [mert.me.id],
      endsAt: '2026-11-15T20:59:59.999Z',
    });
    const challengeId = created.json<Challenge>().id;
    expect((await accept(harness, mert, challengeId)).statusCode).toBe(200);
    // seven evenings from Sunday the 8th; Sunday the 15th ends at 15:59
    expect((await detailFor(harness, mert, challengeId)).myDays).toEqual({ first: '2026-11-08', last: '2026-11-14' });

    harness.setNow('2026-11-15T15:00:00.000Z'); // 10:00 on Sunday in New York
    expect(sendReminders(harness.db, harness.now())).toBe(0);
    harness.setNow('2026-11-14T15:00:00.000Z'); // a Saturday that has its evening
    expect(sendReminders(harness.db, harness.now())).toBe(1);
  });

  /**
   * Ali's Istanbul erken_yat from 00:30 on Monday 9 November to the end of
   * Sunday, finished: Mert in New York had seven evenings too (the 8th from
   * 16:30 to the 14th), and so did everybody in `others`.
   */
  async function finishedErkenYat(h: TestApp, others: RegisteredUser[]) {
    const ali = await registerUser(h.app, 'ali', { displayName: 'Ali' });
    const mert = await registerUser(h.app, 'mert', { displayName: 'Mert', timezone: 'America/New_York' });
    const players = [mert, ...others];
    for (const friend of players) befriend(h.app, ali.me.id, friend.me.id);
    const created = await createChallenge(h, ali, {
      typeKey: 'erken_yat',
      deadlineTime: '23:00',
      participantIds: players.map((p) => p.me.id),
      endsAt: '2026-11-15T20:59:59.999Z',
    });
    expect(created.statusCode).toBe(201);
    const challengeId = created.json<Challenge>().id;
    for (const friend of players) expect((await accept(h, friend, challengeId)).statusCode).toBe(200);
    await h.app.inject({ method: 'POST', url: `/dev/finalize/${challengeId}` });
    return { ali, mert, challengeId };
  }

  it('starts a check-in rematch at the next midnight when sooner would shortchange a friend abroad, and asks him in', async () => {
    harness = await makeApp({ now: '2026-11-08T21:30:00.000Z' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    const { ali, mert, challengeId } = await finishedErkenYat(harness, [veli]);
    const resultsFor = async (user: RegisteredUser) =>
      (await authed(harness!.app, user.token)({ method: 'GET', url: `/challenges/${challengeId}/results` })).json<ChallengeResults>();

    // Monday 14:00 in Istanbul: from 14:05 it would end at 15:59 on Sunday in New York, six evenings there
    harness.setNow('2026-11-16T11:00:00.000Z');
    const before = await resultsFor(ali);
    expect([before.rematchInvitable, before.rematchZoneShort]).toEqual([2, []]);
    const opened = await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` });
    expect(opened.statusCode).toBe(201);
    const rematch = opened.json<Challenge>();
    // from Tuesday 00:00 in Istanbul (Monday 16:00 in New York): seven evenings on both sides
    expect([rematch.startsAt, rematch.endsAt]).toEqual(['2026-11-16T21:00:00.000Z', '2026-11-23T20:59:59.999Z']);
    expect(rowOf(harness, rematch.id, veli.me.id)?.status).toBe('invited');
    expect(rowOf(harness, rematch.id, mert.me.id)?.status).toBe('invited');

    // his button leads to Ali's, so the group is not split across two
    expect((await resultsFor(mert)).rematch).toMatchObject({ id: rematch.id, myStatus: 'invited' });
    const second = await authed(harness.app, mert.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` });
    expect(errorOf(second).code).toBe('rematch_exists');
    expect((await accept(harness, mert, rematch.id)).statusCode).toBe(200);
  });

  it('opens a two-player check-in rematch across zones at any hour', async () => {
    harness = await makeApp({ now: '2026-11-08T21:30:00.000Z' });
    const { ali, mert, challengeId } = await finishedErkenYat(harness, []);
    // 23:30 in Istanbul, 15:30 in New York: both taps used to be refused for this hour
    harness.setNow('2026-11-16T20:30:00.000Z');
    const results = (
      await authed(harness.app, ali.token)({ method: 'GET', url: `/challenges/${challengeId}/results` })
    ).json<ChallengeResults>();
    expect(results.rematchInvitable).toBe(1);
    const opened = await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` });
    expect(opened.statusCode).toBe(201);
    const rematchId = opened.json<Challenge>().id;
    expect((await accept(harness, mert, rematchId)).statusCode).toBe(200);
  });

  it('lets a friend an older server asked into a rematch short of deadlines open his own', async () => {
    harness = await makeApp({ now: '2026-11-08T21:30:00.000Z' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    const { ali, mert, challengeId } = await finishedErkenYat(harness, [veli]);
    harness.setNow('2026-11-16T11:00:00.000Z');
    const opened = await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` });
    const rematchId = opened.json<Challenge>().id;
    // the window an older server gave it: from 14:05 on Monday, six evenings in New York
    harness.db
      .prepare('UPDATE challenges SET starts_at = ?, ends_at = ? WHERE id = ?')
      .run('2026-11-16T11:05:00.000Z', '2026-11-22T20:59:59.999Z', rematchId);

    expect(errorOf(await accept(harness, mert, rematchId)).code).toBe('checkin_days_short');
    const results = await authed(harness.app, mert.token)({ method: 'GET', url: `/challenges/${challengeId}/results` });
    expect(results.json<ChallengeResults>().rematch).toBeNull();
    // his own, from 06:00 in New York, has seven evenings for everybody
    const own = await authed(harness.app, mert.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` });
    expect(own.statusCode).toBe(201);
    const ownId = own.json<Challenge>().id;
    expect(rowOf(harness, ownId, ali.me.id)?.status).toBe('invited');
    expect((await accept(harness, ali, ownId)).statusCode).toBe(200);
  });

  it('changes nothing for friends in one zone, a first day past its deadline included', async () => {
    harness = await makeApp({ now: NOW }); // Monday 12:00 in Istanbul
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    befriend(harness.app, ali.me.id, veli.me.id);
    // "Hemen" from an app that started it after the 07:00: three days, two mornings
    const created = await createChallenge(harness, ali, {
      typeKey: 'erken_kus',
      deadlineTime: '07:00',
      participantIds: [veli.me.id],
      endsAt: '2026-01-07T20:59:59.999Z',
    });
    const challengeId = created.json<Challenge>().id;
    expect((await accept(harness, veli, challengeId)).statusCode).toBe(200);
    expect((await detailFor(harness, veli, challengeId)).myDays).toEqual({ first: '2026-01-05', last: '2026-01-07' });

    const late = await checkIn(harness, veli, challengeId, '2026-01-05');
    expect(late.statusCode).toBe(201);
    expect(late.json<{ entry: { value: number; late: boolean } }>().entry).toMatchObject({ value: 0, late: true });
    for (const day of ['2026-01-06', '2026-01-07']) {
      harness.setNow(`${day}T03:30:00.000Z`); // 06:30
      expect((await checkIn(harness, ali, challengeId, day)).statusCode).toBe(201);
      if (day === '2026-01-06') expect((await checkIn(harness, veli, challengeId, day)).statusCode).toBe(201);
    }
    const zones = (await detailFor(harness, ali, challengeId)).participants.map((p) => p.timezone);
    expect(zones).toEqual(['Europe/Istanbul', 'Europe/Istanbul']);

    harness.setNow('2026-01-07T21:00:30.000Z');
    runSchedulerOnce(harness.db, harness.now());
    const outcome = harness.db.prepare('SELECT status, winner_id, is_tie FROM challenges WHERE id = ?').get(challengeId);
    expect(outcome).toEqual({ status: 'finished', winner_id: ali.me.id, is_tie: 0 });
  });
});

describe('GET /challenges/:id/results', () => {
  it('gives standings to everybody and taunt previews to the winner only', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await finishedChallenge(harness);

    const winner = await authed(harness.app, ali.token)({ method: 'GET', url: `/challenges/${challengeId}/results` });
    expect(winner.statusCode).toBe(200);
    const results = winner.json<ChallengeResults>();
    expect(results.challenge.winnerId).toBe(ali.me.id);
    expect(results.challenge.isTie).toBe(false);
    expect(results.standings[0].user.id).toBe(ali.me.id);
    expect(results.standings[0].rank).toBe(1);
    expect(results.standings[0].isWinner).toBe(true);
    expect(results.standings[1].score).toBe(900);
    expect(results.tauntTemplatesForWinner?.length).toBeGreaterThan(0);
    // Previews are rendered: no raw placeholders survive.
    expect(results.tauntTemplatesForWinner?.every((t) => !t.body.includes('{winner}'))).toBe(true);
    expect(results.tauntTemplatesForWinner?.[0].body).toContain('Ali');

    const loser = await authed(harness.app, veli.token)({ method: 'GET', url: `/challenges/${challengeId}/results` });
    expect(loser.json<ChallengeResults>().tauntTemplatesForWinner).toBeUndefined();

    const outsider = await registerUser(harness.app, 'yabanci');
    const denied = await authed(harness.app, outsider.token)({ method: 'GET', url: `/challenges/${challengeId}/results` });
    expect(denied.statusCode).toBe(404);
  });

  it('shows the loser the taunt they received', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await finishedChallenge(harness);
    await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/taunt`,
      payload: { toUserId: veli.me.id, templateId: 'l2_win_01' },
    });

    const loser = await authed(harness.app, veli.token)({ method: 'GET', url: `/challenges/${challengeId}/results` });
    const taunts = loser.json<ChallengeResults>().taunts;
    expect(taunts).toHaveLength(1);
    expect(taunts[0].fromUserId).toBe(ali.me.id);
  });
});

describe('GET /leaderboard', () => {
  it('ranks me and my friends by wins, then by who has eaten fewer', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await finishedChallenge(harness);
    await authed(harness.app, ali.token)({
      method: 'POST',
      url: `/challenges/${challengeId}/taunt`,
      payload: { toUserId: veli.me.id, templateId: 'l2_win_01' },
    });
    const outsider = await registerUser(harness.app, 'yabanci');

    const response = await authed(harness.app, ali.token)({ method: 'GET', url: '/leaderboard' });
    expect(response.statusCode).toBe(200);
    const board = response.json<LeaderboardEntry[]>();
    expect(board.map((e) => e.user.id)).toEqual([ali.me.id, veli.me.id]);
    expect(board[0]).toMatchObject({ wins: 1, losses: 0, rank: 1 });
    expect(board[1]).toMatchObject({ wins: 0, losses: 1, rank: 2 });
    // talking is not scoring: the taunt count is no longer part of the board
    expect(board[0]).not.toHaveProperty('tauntsSent');
    expect(board.some((e) => e.user.id === outsider.me.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dev routes
// ---------------------------------------------------------------------------

describe('dev routes', () => {
  it('force finalizes, advances the scheduler and resets', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await twoPlayerChallenge(harness);

    const finalize = await harness.app.inject({ method: 'POST', url: `/dev/finalize/${challengeId}` });
    expect(finalize.statusCode).toBe(200);
    expect(finalize.json<{ standings: { user: { id: string } }[] }>().standings[0].user.id).toBe(ali.me.id);

    const missing = await harness.app.inject({ method: 'POST', url: '/dev/finalize/yok' });
    expect(missing.statusCode).toBe(404);

    const advance = await harness.app.inject({
      method: 'POST',
      url: '/dev/advance',
      payload: { now: addDays(today(harness), 4) + 'T09:00:00.000Z' },
    });
    expect(advance.statusCode).toBe(200);
    expect(advance.json()).toMatchObject({ activated: 0, finalized: 0 });

    const reset = await harness.app.inject({ method: 'POST', url: '/dev/reset' });
    expect(reset.statusCode).toBe(200);
    expect(harness.db.prepare('SELECT COUNT(*) AS n FROM users').get()).toMatchObject({ n: 0 });
  });

  it('is not mounted when dev routes are off', async () => {
    harness = await makeApp({ now: NOW, config: { enableDevRoutes: false } });
    const response = await harness.app.inject({ method: 'POST', url: '/dev/reset' });
    expect(response.statusCode).toBe(404);
  });
});
