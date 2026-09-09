/**
 * The whole story, once, through the HTTP surface only.
 *
 * Two strangers sign up, become kanka, open a one-day step çelınc, walk, the clock
 * runs past the end, the scheduler finishes it, the winner says "KOYDUM MU?", the
 * loser finds it in the inbox — clamped down to the level he can stomach — and asks
 * for a rövanş. Every step is a real request; only the clock is fake.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TIMEZONE,
  todayKey,
  type Challenge,
  type ChallengeDetail,
  type ChallengeResults,
  type FriendsView,
  type Me,
  type Notification,
  type UnreadCount,
} from '@koydum/shared';
import { runSchedulerOnce } from '../src/services/challenges.js';
import { authed, makeApp, type TestApp } from './helpers.js';

let harness: TestApp | null = null;

afterEach(async () => {
  if (harness) {
    await harness.close();
    harness = null;
  }
});

const NOW = '2026-01-05T09:00:00.000Z'; // 12:00 in Europe/Istanbul
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('KOYDUM end to end', () => {
  it('takes two friends from sign-up to taunt to rematch', async () => {
    harness = await makeApp({ now: NOW });
    const h = harness;

    // ---------------------------------------------------------------- sign-up
    const aliSignUp = await h.app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { username: 'ali', password: 'sifre123', displayName: 'Ali', timezone: DEFAULT_TIMEZONE },
    });
    expect(aliSignUp.statusCode).toBe(201);
    const ali = aliSignUp.json<{ token: string; me: Me }>();

    const veliSignUp = await h.app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { username: 'veli', password: 'sifre123', displayName: 'Veli', timezone: DEFAULT_TIMEZONE },
    });
    expect(veliSignUp.statusCode).toBe(201);
    const veli = veliSignUp.json<{ token: string; me: Me }>();

    const asAli = authed(h.app, ali.token);
    const asVeli = authed(h.app, veli.token);

    // Veli cannot take the crude stuff: level 1, nazik.
    const settings = await asVeli({ method: 'PATCH', url: '/me', payload: { vulgarityMax: 1 } });
    expect(settings.statusCode).toBe(200);
    expect(settings.json<Me>().vulgarityMax).toBe(1);

    // --------------------------------------------------------------- kankalar
    const request = await asAli({ method: 'POST', url: '/friends/request', payload: { username: 'veli' } });
    expect(request.statusCode).toBe(201);

    const incoming = (await asVeli({ method: 'GET', url: '/friends' })).json<FriendsView>().incoming;
    expect(incoming).toHaveLength(1);
    expect(incoming[0].user.username).toBe('ali');

    const accepted = await asVeli({ method: 'POST', url: `/friends/${incoming[0].id}/accept` });
    expect(accepted.statusCode).toBe(200);
    expect((await asAli({ method: 'GET', url: '/friends' })).json<FriendsView>().friends.map((f) => f.username)).toEqual([
      'veli',
    ]);

    // ----------------------------------------------------------------- çelınc
    h.advance(5 * 60_000); // Ali thinks about it for five minutes
    const created = await asAli({
      method: 'POST',
      url: '/challenges',
      payload: {
        typeKey: 'adim_yarisi',
        title: 'Bir günlük adım',
        startsAt: new Date(h.now().getTime()).toISOString(),
        endsAt: new Date(h.now().getTime() + DAY).toISOString(),
        participantIds: [veli.me.id],
        rewardText: 'Kaybeden döner ısmarlar',
      },
    });
    expect(created.statusCode).toBe(201);
    const challenge = created.json<Challenge>();
    // Starting now means it is live now — no scheduler pass needed.
    expect(challenge.status).toBe('active');

    // Newest first: the invite sits on top of the friend request from a minute ago.
    const invite = (await asVeli({ method: 'GET', url: '/me/inbox' })).json<Notification[]>();
    expect(invite.map((item) => item.type)).toEqual(['challenge_invite', 'friend_request']);

    const join = await asVeli({ method: 'POST', url: `/challenges/${challenge.id}/accept` });
    expect(join.statusCode).toBe(200);
    expect(join.json<ChallengeDetail>().me?.status).toBe('accepted');

    // ------------------------------------------------------------------ adım
    h.advance(3 * HOUR); // an afternoon of walking, same local day
    const dayKey = todayKey(DEFAULT_TIMEZONE, h.now());
    const aliWalk = await asAli({
      method: 'POST',
      url: `/challenges/${challenge.id}/entries`,
      payload: { dayKey, value: 12430, source: 'pedometer', clientTime: h.now().toISOString() },
    });
    expect(aliWalk.statusCode).toBe(201);

    const veliWalk = await asVeli({
      method: 'POST',
      url: `/challenges/${challenge.id}/entries`,
      payload: { dayKey, value: 8000, source: 'pedometer', clientTime: h.now().toISOString() },
    });
    expect(veliWalk.statusCode).toBe(201);
    expect(veliWalk.json<{ standings: { user: { id: string }; rank: number }[] }>().standings[0].user.id).toBe(ali.me.id);

    // --------------------------------------------------------- the clock runs
    h.advance(DAY + HOUR);
    expect(runSchedulerOnce(h.db, h.now())).toMatchObject({ finalized: 1 });

    const results = (await asAli({ method: 'GET', url: `/challenges/${challenge.id}/results` })).json<ChallengeResults>();
    expect(results.challenge.status).toBe('finished');
    expect(results.challenge.winnerId).toBe(ali.me.id);
    expect(results.challenge.isTie).toBe(false);
    expect(results.standings.map((p) => p.user.id)).toEqual([ali.me.id, veli.me.id]);
    expect(results.standings[0].score).toBe(12430);
    // The winner is offered rendered previews; the loser is not.
    expect(results.tauntTemplatesForWinner?.length ?? 0).toBeGreaterThan(0);

    // ------------------------------------------------------------ KOYDUM MU?
    h.advance(2 * 60_000); // Ali opens the results screen and picks his words
    // Ali reaches for the filthiest template he has; Veli's ceiling decides.
    const taunt = await asAli({
      method: 'POST',
      url: `/challenges/${challenge.id}/taunt`,
      payload: { toUserId: veli.me.id, templateId: 'l3_win_01' },
    });
    expect(taunt.statusCode).toBe(201);
    const sent = taunt.json<{ taunt: { id: string; level: number; title: string; body: string } }>().taunt;
    expect(sent.level).toBe(1);
    // Which level-1 template stands in for the level-3 one is a deterministic pick
    // from the challenge/user ids, so assert what every one of them guarantees:
    // the winner's name, no leftover placeholders, tr-TR grouped numbers (12.430),
    // and nothing Veli did not sign up for.
    expect(sent.body).toContain('Ali');
    expect(sent.body).not.toMatch(/\{[a-zA-Z]+\}/);
    expect(sent.body).toMatch(/\d{1,3}\.\d{3}/);
    expect(sent.body).not.toContain('🍆');

    // Only once per loser.
    const again = await asAli({
      method: 'POST',
      url: `/challenges/${challenge.id}/taunt`,
      payload: { toUserId: veli.me.id, templateId: 'l1_win_01' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('already_taunted');

    // ------------------------------------------------------------ gelen kutusu
    const unread = (await asVeli({ method: 'GET', url: '/me/inbox/unread' })).json<UnreadCount>();
    expect(unread.count).toBeGreaterThan(0);

    const inbox = (await asVeli({ method: 'GET', url: '/me/inbox' })).json<Notification[]>();
    const received = inbox.find((item) => item.type === 'taunt');
    expect(received, 'the loser has a taunt in the inbox').toBeDefined();
    expect(received?.title).toBe(sent.title);
    expect(received?.body).toBe(sent.body);
    expect(received?.data).toMatchObject({ challengeId: challenge.id, tauntId: sent.id });
    // Newest first: the taunt landed after the "you lost" notification.
    expect(inbox[0].id).toBe(received?.id);

    const loserResults = (await asVeli({ method: 'GET', url: `/challenges/${challenge.id}/results` })).json<ChallengeResults>();
    expect(loserResults.taunts).toHaveLength(1);
    expect(loserResults.taunts[0]).toMatchObject({ fromUserId: ali.me.id, toUserId: veli.me.id, level: 1 });
    expect(loserResults.tauntTemplatesForWinner).toBeUndefined();

    const read = await asVeli({ method: 'POST', url: '/me/inbox/read', payload: { all: true } });
    expect(read.statusCode).toBe(200);
    expect((await asVeli({ method: 'GET', url: '/me/inbox/unread' })).json<UnreadCount>().count).toBe(0);

    // ----------------------------------------------------------------- rövanş
    const rematch = await asVeli({ method: 'POST', url: `/challenges/${challenge.id}/rematch` });
    expect(rematch.statusCode).toBe(201);
    const revenge = rematch.json<Challenge>();
    expect(revenge.rematchOfId).toBe(challenge.id);
    expect(revenge.status).toBe('pending');
    expect(revenge.typeKey).toBe(challenge.typeKey);
    expect(revenge.rewardText).toBe('Kaybeden döner ısmarlar');
    expect(Date.parse(revenge.endsAt) - Date.parse(revenge.startsAt)).toBe(DAY);

    const rematchDetail = (await asVeli({ method: 'GET', url: `/challenges/${revenge.id}` })).json<ChallengeDetail>();
    expect(rematchDetail.me?.status).toBe('accepted');
    expect(rematchDetail.participants.find((p) => p.user.id === ali.me.id)?.status).toBe('invited');

    const rematchInbox = (await asAli({ method: 'GET', url: '/me/inbox' })).json<Notification[]>();
    expect(rematchInbox[0].type).toBe('rematch');
    expect(rematchInbox[0].data).toMatchObject({ challengeId: revenge.id, rematchOfId: challenge.id });

    // And the scoreboard remembers who koydu.
    const me = (await asAli({ method: 'GET', url: '/me' })).json<Me>();
    expect(me.stats).toMatchObject({ wins: 1, losses: 0, tauntsSent: 1 });
    expect(me.badges).toContain('koyus_1');

    const beaten = (await asVeli({ method: 'GET', url: '/me' })).json<Me>();
    expect(beaten.stats).toMatchObject({ wins: 0, losses: 1, tauntsReceived: 1 });
  });
});
