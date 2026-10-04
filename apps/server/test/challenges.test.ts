/**
 * Challenge, taunt, poke, rematch, results and leaderboard routes.
 *
 * Everything runs against an in-memory database with an injected clock
 * (`makeApp`), so "now" is exact and no test depends on wall-clock timing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { LIMITS, addDays, todayKey, DEFAULT_TIMEZONE, type ChallengeDetail, type ChallengeResults, type LeaderboardEntry, type Challenge } from '@koydum/shared';
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
    expect(inThePast.json().error.code).toBe('validation');

    const tooLong = await createChallenge(harness, ali, {
      participantIds: [veli.me.id],
      endsAt: iso(harness, 90 * 24 * 60 * 60 * 1000),
    });
    expect(tooLong.statusCode).toBe(400);
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

  it('refuses to cancel a started challenge', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, challengeId } = await twoPlayerChallenge(harness);
    const response = await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${challengeId}/cancel` });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('challenge_started');
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

  it('is the creator\'s call, and only for friends nobody blocked', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await twoPlayerChallenge(harness);
    const cem = await registerUser(harness.app, 'cem');
    const eda = await registerUser(harness.app, 'eda');
    const stranger = await registerUser(harness.app, 'yabanci');
    befriend(harness.app, ali.me.id, cem.me.id);
    befriend(harness.app, veli.me.id, cem.me.id);
    befriend(harness.app, ali.me.id, eda.me.id);

    const byVeli = await invite(harness, veli, challengeId, [cem.me.id]);
    expect(byVeli.statusCode).toBe(403);
    expect(byVeli.json().error.code).toBe('not_creator');

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
    expect(fromVeli.json<{ taunt: { body: string } }>().taunt.body).toBe(
      'Veli ve Ali eşit bitirdi. Bu uygulama bunun için yapılmadı lan.',
    );
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

    // nobody won: the winner-only lists stay empty for the co-leaders
    const detail = await authed(harness.app, ali.token)({ method: 'GET', url: `/challenges/${challengeId}` });
    expect(detail.json<ChallengeDetail>().canTaunt).toEqual([]);
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

    // Veli's, at 16:00 on 10 January: three days, the first one today
    harness.setNow('2026-01-10T13:00:00.000Z');
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

  it('refuses while the challenge is still running', async () => {
    harness = await makeApp({ now: NOW });
    const { veli, challengeId } = await twoPlayerChallenge(harness);
    const response = await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('challenge_not_finished');
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
