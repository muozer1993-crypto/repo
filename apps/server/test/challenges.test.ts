/**
 * Challenge, taunt, poke, rematch, results and leaderboard routes.
 *
 * Everything runs against an in-memory database with an injected clock
 * (`makeApp`), so "now" is exact and no test depends on wall-clock timing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { addDays, todayKey, DEFAULT_TIMEZONE, type ChallengeDetail, type ChallengeResults, type LeaderboardEntry } from '@koydum/shared';
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
  const detail = created.json<ChallengeDetail>();
  await authed(h.app, veli.token)({ method: 'POST', url: `/challenges/${detail.challenge.id}/accept` });
  return { ali, veli, challengeId: detail.challenge.id };
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

    const detail = response.json<ChallengeDetail>();
    expect(detail.challenge.status).toBe('active');
    // The metric shape is copied from the catalog, not looked up later.
    expect(detail.challenge.metricType).toBe('auto_steps');
    expect(detail.challenge.direction).toBe('higher');
    expect(detail.challenge.unit).toBe('adım');
    expect(detail.challenge.title).toBe('Adım Yarışı');
    expect(detail.challenge.rewardText).toBe('Döner');

    const me = detail.participants.find((p) => p.user.id === ali.me.id);
    const invited = detail.participants.find((p) => p.user.id === veli.me.id);
    expect(me?.status).toBe('accepted');
    expect(invited?.status).toBe('invited');

    // The invite is rendered at the RECIPIENT's level (Veli is level 1 = nazik).
    const inbox = listByType(harness.db, veli.me.id, 'challenge_invite');
    expect(inbox).toHaveLength(1);
    expect(inbox[0].title).toBe('📩 Çelinç daveti');
    expect(inbox[0].body).toContain('Ali');
    expect(JSON.parse(inbox[0].data)).toMatchObject({ challengeId: detail.challenge.id });
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
    expect(response.json<ChallengeDetail>().challenge.status).toBe('pending');
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
    expect(ok.json<ChallengeDetail>().challenge.deadlineTime).toBe('07:00');
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
    const id = created.json<ChallengeDetail>().challenge.id;

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
    const id = created.json<ChallengeDetail>().challenge.id;

    const declined = await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${id}/decline` });
    expect(declined.statusCode).toBe(200);
    expect(declined.json<ChallengeDetail>().me?.status).toBe('declined');

    const again = await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${id}/decline` });
    expect(again.statusCode).toBe(409);

    // A declined invite drops off the list.
    const list = await authed(harness.app, veli.token)({ method: 'GET', url: '/challenges' });
    expect(list.json<unknown[]>()).toHaveLength(0);
  });

  it('leaves an active challenge', async () => {
    harness = await makeApp({ now: NOW });
    const { veli, challengeId } = await twoPlayerChallenge(harness);
    const left = await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/leave` });
    expect(left.statusCode).toBe(200);
    expect(left.json<ChallengeDetail>().me?.status).toBe('left');

    const again = await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/leave` });
    expect(again.statusCode).toBe(409);
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
    const id = created.json<ChallengeDetail>().challenge.id;

    const notCreator = await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${id}/cancel` });
    expect(notCreator.statusCode).toBe(403);
    expect(notCreator.json().error.code).toBe('not_creator');

    const cancelled = await authed(harness.app, ali.token)({ method: 'POST', url: `/challenges/${id}/cancel` });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json<ChallengeDetail>().challenge.status).toBe('cancelled');

    const inbox = listByType(harness.db, veli.me.id, 'challenge_cancelled');
    expect(inbox).toHaveLength(1);
    expect(inbox[0].title).toBe('Çelinç iptal 🍆'); // Veli is level 3

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
    const id = created.json<ChallengeDetail>().challenge.id;
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
});

// ---------------------------------------------------------------------------
// Pokes
// ---------------------------------------------------------------------------

describe('POST /challenges/:id/poke', () => {
  it('pokes once every two hours', async () => {
    harness = await makeApp({ now: NOW });
    const { ali, veli, challengeId } = await twoPlayerChallenge(harness);

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
    const detail = response.json<ChallengeDetail>();

    expect(detail.challenge.rematchOfId).toBe(challengeId);
    expect(detail.challenge.status).toBe('pending');
    expect(detail.challenge.typeKey).toBe('adim_yarisi');
    expect(Date.parse(detail.challenge.startsAt)).toBe(harness.now().getTime() + 5 * 60 * 1000);
    expect(Date.parse(detail.challenge.endsAt) - Date.parse(detail.challenge.startsAt)).toBe(3 * 24 * 60 * 60 * 1000);
    expect(detail.me?.status).toBe('accepted');
    expect(detail.participants.find((p) => p.user.id === ali.me.id)?.status).toBe('invited');

    expect(listByType(harness.db, ali.me.id, 'rematch')).toHaveLength(1);

    const twice = await authed(harness.app, veli.token)({ method: 'POST', url: `/challenges/${challengeId}/rematch` });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.code).toBe('already_rematched');
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
  it('ranks me and my friends by wins, then taunts sent', async () => {
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
    expect(board[0]).toMatchObject({ wins: 1, losses: 0, tauntsSent: 1, rank: 1 });
    expect(board[1]).toMatchObject({ wins: 0, losses: 1, tauntsSent: 0, rank: 2 });
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
