/**
 * Contract test: every response shape the mobile app actually consumes.
 *
 * The app and the server are written separately, so a route that returns
 * `{ items: [...] }` where the client expects a bare array is a bug nobody's
 * type system catches — the app just renders an empty screen. This file walks
 * the endpoints `apps/mobile/src/lib/api.ts` calls and asserts the shape of
 * what comes back, so that class of mismatch fails here instead of on a phone.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_PASSWORD, authed, makeApp, registerUser } from './helpers.js';

function isPublicUser(value: unknown): boolean {
  const user = value as Record<string, unknown> | null;
  return (
    !!user &&
    typeof user.id === 'string' &&
    typeof user.username === 'string' &&
    typeof user.displayName === 'string' &&
    typeof user.avatarEmoji === 'string' &&
    typeof user.createdAt === 'string'
  );
}

function isChallenge(value: unknown): boolean {
  const c = value as Record<string, unknown> | null;
  return (
    !!c &&
    typeof c.id === 'string' &&
    typeof c.typeKey === 'string' &&
    typeof c.metricType === 'string' &&
    typeof c.direction === 'string' &&
    typeof c.unit === 'string' &&
    typeof c.status === 'string' &&
    typeof c.startsAt === 'string' &&
    typeof c.endsAt === 'string'
  );
}

function isNotification(value: unknown): boolean {
  const n = value as Record<string, unknown> | null;
  return (
    !!n &&
    typeof n.id === 'string' &&
    typeof n.type === 'string' &&
    typeof n.title === 'string' &&
    typeof n.body === 'string' &&
    typeof n.data === 'object'
  );
}

describe('API contract as the mobile client consumes it', () => {
  it('returns the shapes apps/mobile/src/lib/api.ts expects', async () => {
    const harness = await makeApp();
    const { app, setNow } = harness;

    /* auth ---------------------------------------------------------------- */
    const winner = await registerUser(app, 'mustafa', { displayName: 'Mustafa', vulgarityMax: 3 });
    const loser = await registerUser(app, 'ali', { displayName: 'Ali', vulgarityMax: 3 });

    expect(typeof winner.token).toBe('string');
    expect(isPublicUser(winner.me)).toBe(true);
    expect(winner.me.vulgarityMax).toBe(3);
    expect(typeof winner.me.inviteCode).toBe('string');
    expect(typeof winner.me.stats.wins).toBe('number');
    expect(Array.isArray(winner.me.badges)).toBe(true);

    const call = async (
      token: string,
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      url: string,
      payload?: Record<string, unknown>
    ) => {
      const response = await authed(app, token)(
        payload === undefined ? { method, url } : { method, url, payload }
      );
      // deliberately untyped: this file asserts the SHAPE the client sees at runtime,
      // so borrowing the compile-time types would defeat the point
      return { status: response.statusCode, body: response.json() as any };
    };

    /* login --------------------------------------------------------------- */
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'ali', password: DEFAULT_PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    expect(typeof login.json().token).toBe('string');

    /* an action POST with no body at all must be accepted ------------------ */
    const noBody = await app.inject({
      method: 'POST',
      url: '/me/inbox/read',
      headers: { authorization: `Bearer ${winner.token}`, 'content-type': 'application/json' },
      payload: '',
    });
    // The parser must hand the route `{}` rather than refusing the request outright;
    // this particular route then rejects `{}` on its own terms, which is fine.
    expect(noBody.json().error?.code).not.toBe('empty_body');

    /* friends -------------------------------------------------------------- */
    await call(winner.token, 'POST', '/friends/request', { username: 'ali' });
    const friendsView = (await call(loser.token, 'GET', '/friends')).body;
    expect(Array.isArray(friendsView.friends)).toBe(true);
    expect(Array.isArray(friendsView.incoming)).toBe(true);
    expect(Array.isArray(friendsView.outgoing)).toBe(true);
    expect(typeof friendsView.incoming[0].id).toBe('string');
    expect(isPublicUser(friendsView.incoming[0].user)).toBe(true);
    await call(loser.token, 'POST', `/friends/${friendsView.incoming[0].id}/accept`);

    /* users ---------------------------------------------------------------- */
    const search = (await call(winner.token, 'GET', '/users/search?q=al')).body;
    expect(Array.isArray(search)).toBe(true);
    expect(isPublicUser(search[0])).toBe(true);

    const profile = (await call(winner.token, 'GET', `/users/${loser.me.id}`)).body;
    expect(isPublicUser(profile)).toBe(true);
    expect(typeof profile.stats.wins).toBe('number');
    expect(Array.isArray(profile.badges)).toBe(true);

    /* catalog -------------------------------------------------------------- */
    const catalog = (await call(winner.token, 'GET', '/catalog')).body;
    expect(Array.isArray(catalog.types)).toBe(true);
    expect(Array.isArray(catalog.taunts)).toBe(true);
    expect(Array.isArray(catalog.badges)).toBe(true);
    expect(typeof catalog.microcopy).toBe('object');
    expect(typeof catalog.version).toBe('string');

    /* create --------------------------------------------------------------- */
    // everything is measured against the INJECTED clock, not wall time
    const start = harness.now();
    const created = (
      await call(winner.token, 'POST', '/challenges', {
        typeKey: 'adim_yarisi',
        title: 'Gece Yürüyüşü',
        startsAt: new Date(start.getTime() - 60_000).toISOString(),
        endsAt: new Date(start.getTime() + 3 * 86_400_000).toISOString(),
        participantIds: [loser.me.id],
        rewardText: 'Kaybeden döner ısmarlar',
      })
    ).body;
    // the wizard navigates with `result.id`
    expect(isChallenge(created)).toBe(true);

    await call(loser.token, 'POST', `/challenges/${created.id}/accept`);

    /* list ----------------------------------------------------------------- */
    const list = (await call(winner.token, 'GET', '/challenges')).body;
    expect(Array.isArray(list)).toBe(true);
    expect(isChallenge(list[0].challenge)).toBe(true);
    expect(Array.isArray(list[0].participants)).toBe(true);
    expect(isPublicUser(list[0].participants[0].user)).toBe(true);
    expect(typeof list[0].participants[0].score).toBe('number');
    expect(typeof list[0].participants[0].rank).toBe('number');

    /* steps ---------------------------------------------------------------- */
    const todayKey = harness.now().toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' });
    const sync = (
      await call(winner.token, 'POST', '/me/steps', {
        days: [{ dayKey: todayKey, steps: 12_430, source: 'pedometer' }],
      })
    ).body;
    expect(typeof sync.updated).toBe('number');
    await call(loser.token, 'POST', '/me/steps', {
      days: [{ dayKey: todayKey, steps: 4201, source: 'pedometer' }],
    });

    /* detail --------------------------------------------------------------- */
    const detail = (await call(winner.token, 'GET', `/challenges/${created.id}`)).body;
    expect(isChallenge(detail.challenge)).toBe(true);
    expect(Array.isArray(detail.myEntries)).toBe(true);
    expect(Array.isArray(detail.feed)).toBe(true);
    expect(Array.isArray(detail.disputes)).toBe(true);
    expect(Array.isArray(detail.taunts)).toBe(true);
    expect(Array.isArray(detail.canTaunt)).toBe(true);
    expect(typeof detail.canPoke).toBe('boolean');

    /* poke ----------------------------------------------------------------- */
    await call(winner.token, 'POST', `/challenges/${created.id}/poke`, { toUserId: loser.me.id });

    /* finish and taunt ------------------------------------------------------ */
    setNow(new Date(start.getTime() + 4 * 86_400_000));
    await call(winner.token, 'POST', '/dev/advance');

    const results = (await call(winner.token, 'GET', `/challenges/${created.id}/results`)).body;
    expect(isChallenge(results.challenge)).toBe(true);
    expect(Array.isArray(results.standings)).toBe(true);
    expect(Array.isArray(results.taunts)).toBe(true);
    expect(results.standings.find((s: { isWinner: boolean }) => s.isWinner).user.id).toBe(winner.me.id);

    // the winner picks one of the templates the results screen offered
    expect(Array.isArray(results.tauntTemplatesForWinner)).toBe(true);
    const template = results.tauntTemplatesForWinner[0];
    expect(template?.id).toBeTruthy();
    const sent = await call(winner.token, 'POST', `/challenges/${created.id}/taunt`, {
      toUserId: loser.me.id,
      templateId: template.id,
    });
    expect(sent.status).toBeLessThan(300);

    /* inbox ---------------------------------------------------------------- */
    const inbox = (await call(loser.token, 'GET', '/me/inbox')).body;
    expect(Array.isArray(inbox)).toBe(true);
    expect(isNotification(inbox[0])).toBe(true);
    expect(inbox.some((n: { type: string }) => n.type === 'taunt')).toBe(true);

    const unread = (await call(loser.token, 'GET', '/me/inbox/unread')).body;
    expect(typeof unread.count).toBe('number');
    expect(unread.count).toBeGreaterThan(0);

    await call(loser.token, 'POST', '/me/inbox/read', { all: true });
    expect((await call(loser.token, 'GET', '/me/inbox/unread')).body.count).toBe(0);

    /* rematch -------------------------------------------------------------- */
    const rematch = (await call(loser.token, 'POST', `/challenges/${created.id}/rematch`)).body;
    expect(isChallenge(rematch)).toBe(true);
    expect(rematch.rematchOfId).toBe(created.id);

    /* leaderboard ----------------------------------------------------------- */
    const leaderboard = (await call(winner.token, 'GET', '/leaderboard')).body;
    expect(Array.isArray(leaderboard)).toBe(true);
    expect(isPublicUser(leaderboard[0].user)).toBe(true);
    expect(typeof leaderboard[0].wins).toBe('number');
    expect(typeof leaderboard[0].rank).toBe('number');

    await harness.close();
  });

  it('lets a challenge of the minimum length still be accepted', async () => {
    const harness = await makeApp();
    const { app } = harness;
    const creator = await registerUser(app, 'kemal');
    const friend = await registerUser(app, 'veli');

    const auth = (token: string) => ({ authorization: `Bearer ${token}` });
    await app.inject({ method: 'POST', url: '/friends/request', headers: auth(creator.token), payload: { username: 'veli' } });
    const incoming = (
      await app.inject({ method: 'GET', url: '/friends', headers: auth(friend.token) })
    ).json().incoming[0];
    await app.inject({ method: 'POST', url: `/friends/${incoming.id}/accept`, headers: auth(friend.token) });

    const now = harness.now().getTime();
    const createResponse = await app.inject({
      method: 'POST',
      url: '/challenges',
      headers: auth(creator.token),
      payload: {
        typeKey: 'adim_yarisi',
        startsAt: new Date(now).toISOString(),
        // just over the minimum duration the schema allows
        endsAt: new Date(now + 61 * 60_000).toISOString(),
        participantIds: [friend.me.id],
      },
    });
    expect(createResponse.statusCode, createResponse.body).toBe(201);
    const created = createResponse.json();

    const accept = await app.inject({
      method: 'POST',
      url: `/challenges/${created.id}/accept`,
      headers: auth(friend.token),
    });
    expect(accept.statusCode).toBe(200);

    await harness.close();
  });
});
