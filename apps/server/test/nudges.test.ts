/**
 * The mid-day nudge: "o ne lan, {leader} sana fark koymuş, kalk da iki dolaş".
 *
 * It is the one notification nobody asks for, which is exactly why it has to be
 * disciplined: once a day, in the reader's own afternoon, only when somebody is
 * really ahead.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { newId, nowIso } from '../src/db/index.js';
import { listInbox } from '../src/services/notifications.js';
import { runSchedulerOnce, sendNudges } from '../src/services/challenges.js';
import { authed, befriend, makeApp, registerUser, type RegisteredUser, type TestApp } from './helpers.js';
import type { FastifyInstance } from 'fastify';
import type { Me } from '@koydum/shared';

let harness: TestApp | null = null;
afterEach(async () => {
  await harness?.app.close();
  harness = null;
});

interface SeedOptions {
  creatorId: string;
  accepted: string[];
  startsAt: string;
  endsAt: string;
  typeKey?: string;
  metricType?: string;
  direction?: 'higher' | 'lower';
  unit?: string;
  deadlineTime?: string | null;
}

function seedActive(app: FastifyInstance, options: SeedOptions): string {
  const id = newId();
  const at = nowIso(app.now());
  app.db
    .prepare(
      `INSERT INTO challenges (id, creator_id, type_key, metric_type, direction, unit, title, starts_at, ends_at,
                               status, reward_text, penalty_text, deadline_time, daily_target, proof_required,
                               created_at, finalized_at, winner_id, is_tie, rematch_of_id)
       VALUES (?, ?, ?, ?, ?, ?, 'Adım Yarışı', ?, ?, 'active', NULL, NULL, ?, NULL, 0, ?, NULL, NULL, 0, NULL)`,
    )
    .run(
      id,
      options.creatorId,
      options.typeKey ?? 'adim_yarisi',
      options.metricType ?? 'auto_steps',
      options.direction ?? 'higher',
      options.unit ?? 'adım',
      options.startsAt,
      options.endsAt,
      options.deadlineTime ?? null,
      at,
    );

  const insert = app.db.prepare(
    'INSERT INTO challenge_participants (challenge_id, user_id, status, invited_at, joined_at, timezone) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const userId of options.accepted) insert.run(id, userId, 'accepted', at, at, 'Europe/Istanbul');
  return id;
}

function addSteps(
  app: FastifyInstance,
  challengeId: string,
  userId: string,
  dayKey: string,
  value: number,
  source = 'pedometer',
): void {
  const at = nowIso(app.now());
  app.db
    .prepare(
      `INSERT INTO entries (id, challenge_id, user_id, day_key, value, source, note, proof_url, status, client_time,
                            session_id, late, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'ok', ?, NULL, 0, ?, ?)`,
    )
    .run(newId(), challengeId, userId, dayKey, value, source, at, at, at);
}

function nudgesOf(harnessApp: TestApp, userId: string) {
  return listInbox(harnessApp.db, userId).filter((row) => row.type === 'nudge');
}

/** 15:00 in Istanbul — inside the window. */
const AFTERNOON = '2026-01-05T12:00:00.000Z';
/** 09:00 in Istanbul — too early to be told to go for a walk. */
const MORNING = '2026-01-05T06:00:00.000Z';
const TODAY = '2026-01-05';

async function twoPlayers(now: string) {
  harness = await makeApp({ now });
  const app = harness.app;
  const ali = await registerUser(app, 'ali', { displayName: 'Mahmut', timezone: 'Europe/Istanbul' });
  const veli = await registerUser(app, 'veli', { timezone: 'Europe/Istanbul' });
  return { app, ali, veli };
}

describe('mid-day nudges', () => {
  it('tells the one who is behind who is ahead and by how much', async () => {
    const { app, ali, veli } = await twoPlayers(AFTERNOON);
    const id = seedActive(app, {
      creatorId: ali.me.id,
      accepted: [ali.me.id, veli.me.id],
      startsAt: '2026-01-05T00:00:00.000Z',
      endsAt: '2026-01-08T00:00:00.000Z',
    });
    addSteps(app, id, ali.me.id, TODAY, 12_430);
    addSteps(app, id, veli.me.id, TODAY, 4_201);

    expect(sendNudges(app.db, app.now())).toBe(1);

    const forLoser = nudgesOf(harness!, veli.me.id);
    expect(forLoser).toHaveLength(1);
    expect(forLoser[0].body).toContain('Mahmut');
    expect(forLoser[0].body).toContain('8.229');
    expect(forLoser[0].body).toContain('adım');
    // the leader hears nothing
    expect(nudgesOf(harness!, ali.me.id)).toHaveLength(0);
  });

  it('speaks the way the reader asked to be spoken to', async () => {
    harness = await makeApp({ now: AFTERNOON });
    const app = harness.app;
    const leader = await registerUser(app, 'mahmut', { displayName: 'Mahmut' });
    const polite = await registerUser(app, 'nazik', { vulgarityMax: 1 });
    const loud = await registerUser(app, 'agir', { vulgarityMax: 3 });

    const id = seedActive(app, {
      creatorId: leader.me.id,
      accepted: [leader.me.id, polite.me.id, loud.me.id],
      startsAt: '2026-01-05T00:00:00.000Z',
      endsAt: '2026-01-08T00:00:00.000Z',
    });
    addSteps(app, id, leader.me.id, TODAY, 12_000);
    addSteps(app, id, polite.me.id, TODAY, 2_000);
    addSteps(app, id, loud.me.id, TODAY, 2_000);

    expect(sendNudges(app.db, app.now())).toBe(2);
    expect(nudgesOf(harness, polite.me.id)[0].title).toBe('Fark açılıyor');
    expect(nudgesOf(harness, loud.me.id)[0].title).toContain('O NE LAN');
    expect(nudgesOf(harness, loud.me.id)[0].body).toContain('Kalk da iki dolaş');
  });

  it('sends at most one per çelınc per person per day', async () => {
    const { app, ali, veli } = await twoPlayers(AFTERNOON);
    const id = seedActive(app, {
      creatorId: ali.me.id,
      accepted: [ali.me.id, veli.me.id],
      startsAt: '2026-01-05T00:00:00.000Z',
      endsAt: '2026-01-08T00:00:00.000Z',
    });
    addSteps(app, id, ali.me.id, TODAY, 12_000);
    addSteps(app, id, veli.me.id, TODAY, 2_000);

    expect(sendNudges(app.db, app.now())).toBe(1);
    expect(sendNudges(app.db, app.now())).toBe(0);
    expect(nudgesOf(harness!, veli.me.id)).toHaveLength(1);

    // the next local day is a new nudge
    harness!.setNow('2026-01-06T12:00:00.000Z');
    expect(sendNudges(app.db, app.now())).toBe(1);
  });

  it('sends one a day however many çelınclar they are behind in, about the worst one', async () => {
    const { app, ali, veli } = await twoPlayers(AFTERNOON);
    const can = await registerUser(app, 'can', { displayName: 'Can', timezone: 'Europe/Istanbul' });
    const window = { startsAt: '2026-01-05T00:00:00.000Z', endsAt: '2026-01-08T00:00:00.000Z' };
    const half = seedActive(app, { creatorId: ali.me.id, accepted: [ali.me.id, veli.me.id], ...window });
    const worst = seedActive(app, { creatorId: can.me.id, accepted: [can.me.id, veli.me.id], ...window });
    const alsoHalf = seedActive(app, { creatorId: ali.me.id, accepted: [ali.me.id, veli.me.id], ...window });
    addSteps(app, half, ali.me.id, TODAY, 12_000);
    addSteps(app, half, veli.me.id, TODAY, 6_000);
    addSteps(app, worst, can.me.id, TODAY, 10_000);
    addSteps(app, worst, veli.me.id, TODAY, 1_000);
    addSteps(app, alsoHalf, ali.me.id, TODAY, 8_000);
    addSteps(app, alsoHalf, veli.me.id, TODAY, 4_000);

    expect(sendNudges(app.db, app.now())).toBe(1);

    const nudges = nudgesOf(harness!, veli.me.id);
    expect(nudges).toHaveLength(1);
    expect(nudges[0].body).toBe('Can sana 9.000 adım fark koymuş. Kalk da iki dolaş. 2 çelıncta daha gerideysin.');
    expect(JSON.parse(nudges[0].data!)).toEqual({ challengeId: worst, fromUserId: can.me.id, dayKey: TODAY });
    // all three were covered, so none of them comes back later today
    expect(
      app.db.prepare('SELECT COUNT(*) AS n FROM nudges_sent WHERE user_id = ? AND day_key = ?').get(veli.me.id, TODAY),
    ).toEqual({ n: 3 });
  });

  it('does not buzz again the same day for a çelınc that falls behind later', async () => {
    const { app, ali, veli } = await twoPlayers(AFTERNOON);
    const window = { startsAt: '2026-01-05T00:00:00.000Z', endsAt: '2026-01-08T00:00:00.000Z' };
    const first = seedActive(app, { creatorId: ali.me.id, accepted: [ali.me.id, veli.me.id], ...window });
    addSteps(app, first, ali.me.id, TODAY, 12_000);
    addSteps(app, first, veli.me.id, TODAY, 2_000);
    expect(sendNudges(app.db, app.now())).toBe(1);

    harness!.advance(3 * 60 * 60_000);
    const later = seedActive(app, { creatorId: ali.me.id, accepted: [ali.me.id, veli.me.id], ...window });
    addSteps(app, later, ali.me.id, TODAY, 9_000);
    addSteps(app, later, veli.me.id, TODAY, 1_000);
    expect(sendNudges(app.db, app.now())).toBe(0);
    expect(nudgesOf(harness!, veli.me.id)).toHaveLength(1);

    // the next local day is one nudge again, counting the other
    harness!.setNow('2026-01-06T12:00:00.000Z');
    expect(sendNudges(app.db, app.now())).toBe(1);
    expect(nudgesOf(harness!, veli.me.id)[0].body).toContain('Bir çelıncta daha gerideysin.');
  });

  it('counts only the çelınclar they are behind in', async () => {
    const { app, ali, veli } = await twoPlayers(AFTERNOON);
    const window = { startsAt: '2026-01-05T00:00:00.000Z', endsAt: '2026-01-08T00:00:00.000Z' };
    const behind = seedActive(app, { creatorId: ali.me.id, accepted: [ali.me.id, veli.me.id], ...window });
    const ahead = seedActive(app, { creatorId: ali.me.id, accepted: [ali.me.id, veli.me.id], ...window });
    addSteps(app, behind, ali.me.id, TODAY, 12_000);
    addSteps(app, behind, veli.me.id, TODAY, 2_000);
    addSteps(app, ahead, ali.me.id, TODAY, 3_000);
    addSteps(app, ahead, veli.me.id, TODAY, 9_000);

    // each is behind in one çelınc: one nudge each, and nothing to count
    expect(sendNudges(app.db, app.now())).toBe(2);
    expect(nudgesOf(harness!, veli.me.id)[0].body).toBe('Mahmut sana 10.000 adım fark koymuş. Kalk da iki dolaş.');
    expect(nudgesOf(harness!, ali.me.id)[0].body).not.toContain('çelıncta');
  });

  it('weighs a screen-time gap against the bigger number, not the leader’s small one', async () => {
    // 13:00 in Istanbul on day one, so today's screen time is what the çelınc has
    const { app, ali, veli } = await twoPlayers('2026-01-05T10:00:00.000Z');
    const window = { startsAt: '2026-01-05T00:00:00.000Z', endsAt: '2026-01-08T00:00:00.000Z' };
    const screen = seedActive(app, {
      creatorId: ali.me.id,
      accepted: [ali.me.id, veli.me.id],
      ...window,
      typeKey: 'ekran_suresi_beyani',
      metricType: 'manual_lower_is_better',
      direction: 'lower',
      unit: 'dk',
    });
    const steps = seedActive(app, { creatorId: ali.me.id, accepted: [ali.me.id, veli.me.id], ...window });
    // 340 dk on 400 is most of it; 340 on the leader's 60 would be "5.7 times" and win every time
    addSteps(app, screen, ali.me.id, TODAY, 60, 'usage_stats');
    addSteps(app, screen, veli.me.id, TODAY, 400, 'manual');
    // nothing at all against 10.000 is all of it
    addSteps(app, steps, ali.me.id, TODAY, 10_000);

    expect(sendNudges(app.db, app.now())).toBe(1);
    const nudge = nudgesOf(harness!, veli.me.id)[0];
    expect(JSON.parse(nudge.data!).challengeId).toBe(steps);
    expect(nudge.body).toBe('Mahmut sana 10.000 adım fark koymuş. Kalk da iki dolaş. Bir çelıncta daha gerideysin.');
  });

  it('says how many more at every level', async () => {
    harness = await makeApp({ now: AFTERNOON });
    const app = harness.app;
    const leader = await registerUser(app, 'mahmut', { displayName: 'Mahmut' });
    const polite = await registerUser(app, 'nazik', { vulgarityMax: 1 });
    const loud = await registerUser(app, 'agir', { vulgarityMax: 3 });
    const window = { startsAt: '2026-01-05T00:00:00.000Z', endsAt: '2026-01-08T00:00:00.000Z' };
    for (let i = 0; i < 3; i++) {
      const id = seedActive(app, { creatorId: leader.me.id, accepted: [leader.me.id, polite.me.id, loud.me.id], ...window });
      addSteps(app, id, leader.me.id, TODAY, 12_000 - i * 1_000);
      addSteps(app, id, polite.me.id, TODAY, 2_000);
      addSteps(app, id, loud.me.id, TODAY, 2_000);
    }

    expect(sendNudges(app.db, app.now())).toBe(2);
    expect(nudgesOf(harness, polite.me.id)[0].body).toBe(
      'Mahmut önde, aradaki fark 10.000 adım. Bugün biraz yürüsen kapanır. Başka 2 çelıncta da gerideysin.',
    );
    expect(nudgesOf(harness, loud.me.id)[0].body).toBe(
      'Mahmut sana 10.000 adım fark koymuş 🍆 Kalk da iki dolaş. Başka 2 çelıncta da yiyorsun 🍆',
    );
  });

  it('leaves alone somebody who switched nudges off, without using up their day', async () => {
    const { app, ali, veli } = await twoPlayers(AFTERNOON);
    const id = seedActive(app, {
      creatorId: ali.me.id,
      accepted: [ali.me.id, veli.me.id],
      startsAt: '2026-01-05T00:00:00.000Z',
      endsAt: '2026-01-08T00:00:00.000Z',
    });
    addSteps(app, id, ali.me.id, TODAY, 12_000);
    addSteps(app, id, veli.me.id, TODAY, 2_000);
    const settings = authed(app, veli.token);

    const off = await settings({ method: 'PATCH', url: '/me', payload: { nudgesEnabled: false } });
    expect(off.json<Me>().nudgesEnabled).toBe(false);

    expect(sendNudges(app.db, app.now())).toBe(0);
    expect(nudgesOf(harness!, veli.me.id)).toHaveLength(0);
    expect(app.db.prepare('SELECT COUNT(*) AS n FROM nudges_sent').get()).toEqual({ n: 0 });

    // changed their mind the same afternoon: today's nudge is still theirs
    await settings({ method: 'PATCH', url: '/me', payload: { nudgesEnabled: true } });
    expect(sendNudges(app.db, app.now())).toBe(1);
    expect(nudgesOf(harness!, veli.me.id)).toHaveLength(1);
  });

  it('says nothing before noon where the reader lives', async () => {
    const { app, ali, veli } = await twoPlayers(MORNING);
    const id = seedActive(app, {
      creatorId: ali.me.id,
      accepted: [ali.me.id, veli.me.id],
      startsAt: '2026-01-05T00:00:00.000Z',
      endsAt: '2026-01-08T00:00:00.000Z',
    });
    addSteps(app, id, ali.me.id, TODAY, 12_000);
    addSteps(app, id, veli.me.id, TODAY, 2_000);

    expect(sendNudges(app.db, app.now())).toBe(0);
  });

  it('ignores a gap too small to be a story', async () => {
    const { app, ali, veli } = await twoPlayers(AFTERNOON);
    const id = seedActive(app, {
      creatorId: ali.me.id,
      accepted: [ali.me.id, veli.me.id],
      startsAt: '2026-01-05T00:00:00.000Z',
      endsAt: '2026-01-08T00:00:00.000Z',
    });
    addSteps(app, id, ali.me.id, TODAY, 10_040);
    addSteps(app, id, veli.me.id, TODAY, 10_000);

    expect(sendNudges(app.db, app.now())).toBe(0);
  });

  it('leaves check-in çelınclar alone — they have their own reminder', async () => {
    const { app, ali, veli } = await twoPlayers(AFTERNOON);
    const id = seedActive(app, {
      creatorId: ali.me.id,
      accepted: [ali.me.id, veli.me.id],
      startsAt: '2026-01-05T00:00:00.000Z',
      endsAt: '2026-01-08T00:00:00.000Z',
      typeKey: 'erken_kalkma',
      metricType: 'checkin_deadline',
      unit: 'gün',
      deadlineTime: '07:00',
    });
    addSteps(app, id, ali.me.id, TODAY, 3);

    expect(sendNudges(app.db, app.now())).toBe(0);
  });

  it('does not tell a screen-time player who has reported nothing yet that they are 1.380 dk behind', async () => {
    // 13:00 in Istanbul on day one: the Android phone has synced, the iPhone types tonight
    const { app, ali, veli } = await twoPlayers('2026-01-05T10:00:00.000Z');
    const id = seedActive(app, {
      creatorId: ali.me.id,
      accepted: [ali.me.id, veli.me.id],
      startsAt: '2026-01-05T00:00:00.000Z',
      endsAt: '2026-01-08T00:00:00.000Z',
      typeKey: 'ekran_suresi_beyani',
      metricType: 'manual_lower_is_better',
      direction: 'lower',
      unit: 'dk',
    });
    addSteps(app, id, ali.me.id, TODAY, 60, 'usage_stats');

    expect(sendNudges(app.db, app.now())).toBe(0);
    expect(nudgesOf(harness!, veli.me.id)).toHaveLength(0);

    // a real number that is worse is a real gap, and the day was not used up
    addSteps(app, id, veli.me.id, TODAY, 400, 'manual');
    expect(sendNudges(app.db, app.now())).toBe(1);
    expect(nudgesOf(harness!, veli.me.id)[0].body).toContain('340 dk');
  });

  it('does not tell the iPhone player they are behind because the Android phone sent half of today', async () => {
    // 13:00 in Istanbul on day two
    const { app, ali, veli } = await twoPlayers('2026-01-06T10:00:00.000Z');
    const id = seedActive(app, {
      creatorId: ali.me.id,
      accepted: [ali.me.id, veli.me.id],
      startsAt: '2026-01-04T21:00:00.000Z',
      endsAt: '2026-01-11T21:00:00.000Z',
      typeKey: 'ekran_suresi_beyani',
      metricType: 'manual_lower_is_better',
      direction: 'lower',
      unit: 'dk',
    });
    // day one: Veli typed 250 last night, Ali's phone 300; today so far Ali's phone says 40
    addSteps(app, id, veli.me.id, TODAY, 250, 'manual');
    addSteps(app, id, ali.me.id, TODAY, 300, 'usage_stats');
    addSteps(app, id, ali.me.id, '2026-01-06', 40, 'usage_stats');

    // (300 + 40) / 2 = 170 against 250 was "Mahmut sana 80 dk fark koymuş"
    expect(sendNudges(app.db, app.now())).toBe(1);
    expect(nudgesOf(harness!, veli.me.id)).toHaveLength(0);
    expect(nudgesOf(harness!, ali.me.id)[0].body).toContain('50 dk');
  });

  it('keeps quiet in the final hour, where the device already warns', async () => {
    const { app, ali, veli } = await twoPlayers(AFTERNOON);
    const id = seedActive(app, {
      creatorId: ali.me.id,
      accepted: [ali.me.id, veli.me.id],
      startsAt: '2026-01-05T00:00:00.000Z',
      endsAt: '2026-01-05T12:30:00.000Z',
    });
    addSteps(app, id, ali.me.id, TODAY, 12_000);
    addSteps(app, id, veli.me.id, TODAY, 2_000);

    expect(sendNudges(app.db, app.now())).toBe(0);
  });
});

describe('mid-day nudges on a day the reader already logged', () => {
  /** Tuesday 12:00 in Istanbul: the first pass inside the nudge hours. */
  const NOON = '2026-01-06T09:00:30.000Z';
  const MONDAY = TODAY;
  const TUESDAY = '2026-01-06';
  const week = { startsAt: '2026-01-04T21:00:00.000Z', endsAt: '2026-01-11T21:00:00.000Z' };
  const coldShower = { typeKey: 'soguk_dus', metricType: 'daily_boolean', unit: 'gün' };
  const water = { typeKey: 'su_bardak', metricType: 'manual_count', unit: 'bardak' };

  function claimedBy(app: FastifyInstance, userId: string) {
    return app.db.prepare('SELECT challenge_id FROM nudges_sent WHERE user_id = ?').all(userId);
  }

  it('leaves a yes/no player alone once today is marked, either way', async () => {
    harness = await makeApp({ now: NOON });
    const app = harness.app;
    const tz = { timezone: 'Europe/Istanbul' };
    const ilker = await registerUser(app, 'ilker', { displayName: 'İlker', ...tz });
    const gokce = await registerUser(app, 'gokce', { displayName: 'Gökçe', vulgarityMax: 1, ...tz });
    const eda = await registerUser(app, 'eda', { displayName: 'Eda', ...tz });
    const ufuk = await registerUser(app, 'ufuk', { displayName: 'Ufuk', vulgarityMax: 1, ...tz });
    const id = seedActive(app, {
      creatorId: ilker.me.id,
      accepted: [ilker.me.id, gokce.me.id, eda.me.id, ufuk.me.id],
      ...week,
      ...coldShower,
    });
    addSteps(app, id, ilker.me.id, MONDAY, 1, 'manual');
    addSteps(app, id, ilker.me.id, TUESDAY, 1, 'manual');
    // Gökçe forgot Monday and said yes this morning: nothing today moves that gap
    addSteps(app, id, gokce.me.id, TUESDAY, 1, 'manual');
    // Eda said no this morning, which is just as marked
    addSteps(app, id, eda.me.id, MONDAY, 1, 'manual');
    addSteps(app, id, eda.me.id, TUESDAY, 0, 'manual');
    // Ufuk has not marked today yet, and is the one still told to
    addSteps(app, id, ufuk.me.id, MONDAY, 1, 'manual');

    expect(sendNudges(app.db, app.now())).toBe(1);
    expect(nudgesOf(harness, gokce.me.id)).toHaveLength(0);
    expect(nudgesOf(harness, eda.me.id)).toHaveLength(0);
    expect(nudgesOf(harness, ufuk.me.id).map((row) => row.body)).toEqual([
      'İlker önde, aradaki fark 1 gün. Bugünü işaretlemeyi unutma.',
    ]);
    // skipped before the claim, so their day is still free for another çelınc
    expect(claimedBy(app, gokce.me.id)).toEqual([]);
    expect(claimedBy(app, eda.me.id)).toEqual([]);
  });

  it('asks somebody who already typed today’s glasses for more, not for today’s entry', async () => {
    harness = await makeApp({ now: NOON });
    const app = harness.app;
    const tz = { timezone: 'Europe/Istanbul' };
    const ayse = await registerUser(app, 'ayse', { displayName: 'Ayşe', ...tz });
    const mert = await registerUser(app, 'mert', { displayName: 'Mert', vulgarityMax: 1, ...tz });
    const deniz = await registerUser(app, 'deniz', { displayName: 'Deniz', vulgarityMax: 1, ...tz });
    const id = seedActive(app, {
      creatorId: ayse.me.id,
      accepted: [ayse.me.id, mert.me.id, deniz.me.id],
      ...week,
      ...water,
    });
    addSteps(app, id, ayse.me.id, MONDAY, 6, 'manual');
    addSteps(app, id, mert.me.id, MONDAY, 2, 'manual');
    addSteps(app, id, deniz.me.id, MONDAY, 2, 'manual');
    // Mert had three glasses this morning; Deniz typed four that an itiraz threw out
    addSteps(app, id, mert.me.id, TUESDAY, 3, 'manual');
    addSteps(app, id, deniz.me.id, TUESDAY, 4, 'manual');
    app.db.prepare(`UPDATE entries SET status = 'rejected' WHERE user_id = ? AND day_key = ?`).run(deniz.me.id, TUESDAY);

    expect(sendNudges(app.db, app.now())).toBe(2);
    expect(nudgesOf(harness, mert.me.id)[0].body).toBe(
      'Ayşe önde, aradaki fark 1 bardak. Biraz daha eklersen fark kapanır.',
    );
    expect(nudgesOf(harness, deniz.me.id)[0].body).toBe(
      'Ayşe önde, aradaki fark 4 bardak. Bugünkü girişini yapmayı unutma.',
    );
  });

  it('leaves alone somebody whose day is already at the cap, where "biraz daha" would be refused', async () => {
    harness = await makeApp({ now: NOON });
    const app = harness.app;
    const tz = { timezone: 'Europe/Istanbul' };
    const ayse = await registerUser(app, 'ayse', { displayName: 'Ayşe', ...tz });
    const mert = await registerUser(app, 'mert', { displayName: 'Mert', vulgarityMax: 1, ...tz });
    const deniz = await registerUser(app, 'deniz', { displayName: 'Deniz', vulgarityMax: 1, ...tz });
    // sinav_sayisi takes 300 a day
    const id = seedActive(app, {
      creatorId: ayse.me.id,
      accepted: [ayse.me.id, mert.me.id, deniz.me.id],
      ...week,
      typeKey: 'sinav_sayisi',
      metricType: 'manual_count',
      unit: 'tekrar',
    });
    addSteps(app, id, ayse.me.id, MONDAY, 300, 'manual');
    addSteps(app, id, ayse.me.id, TUESDAY, 300, 'manual');
    // Mert did his whole 300 this morning in two sets; Deniz has 150 still to go
    addSteps(app, id, mert.me.id, TUESDAY, 150, 'manual');
    addSteps(app, id, mert.me.id, TUESDAY, 150, 'manual');
    addSteps(app, id, deniz.me.id, TUESDAY, 150, 'manual');

    expect(sendNudges(app.db, app.now())).toBe(1);
    expect(nudgesOf(harness, mert.me.id)).toHaveLength(0);
    expect(claimedBy(app, mert.me.id)).toEqual([]);
    expect(nudgesOf(harness, deniz.me.id)[0].body).toBe(
      'Ayşe önde, aradaki fark 450 tekrar. Biraz daha eklersen fark kapanır.',
    );
  });

  it('leaves alone a focus player whose 360 minutes today are already in', async () => {
    harness = await makeApp({ now: NOON });
    const app = harness.app;
    const tz = { timezone: 'Europe/Istanbul' };
    const ayse = await registerUser(app, 'ayse', { displayName: 'Ayşe', ...tz });
    const mert = await registerUser(app, 'mert', { displayName: 'Mert', vulgarityMax: 1, ...tz });
    const deniz = await registerUser(app, 'deniz', { displayName: 'Deniz', vulgarityMax: 1, ...tz });
    const id = seedActive(app, {
      creatorId: ayse.me.id,
      accepted: [ayse.me.id, mert.me.id, deniz.me.id],
      ...week,
      typeKey: 'odak_seansi',
      metricType: 'focus_minutes',
      unit: 'dk',
    });
    addSteps(app, id, ayse.me.id, MONDAY, 360, 'focus');
    addSteps(app, id, ayse.me.id, TUESDAY, 360, 'focus');
    // Mert sat his whole 360 this morning; Deniz has 180 still to sit
    addSteps(app, id, mert.me.id, TUESDAY, 180, 'focus');
    addSteps(app, id, mert.me.id, TUESDAY, 180, 'focus');
    addSteps(app, id, deniz.me.id, TUESDAY, 180, 'focus');

    sendNudges(app.db, app.now());
    expect(nudgesOf(harness, mert.me.id)).toHaveLength(0);
    expect(claimedBy(app, mert.me.id)).toEqual([]);
    expect(nudgesOf(harness, deniz.me.id)).toHaveLength(1);
  });

  it('names the çelınc the reader can still do something about, and does not count the marked one', async () => {
    harness = await makeApp({ now: NOON });
    const app = harness.app;
    const ali = await registerUser(app, 'ali', { displayName: 'Ali', timezone: 'Europe/Istanbul' });
    const veli = await registerUser(app, 'veli', { displayName: 'Veli', timezone: 'Europe/Istanbul' });
    const shower = seedActive(app, { creatorId: ali.me.id, accepted: [ali.me.id, veli.me.id], ...week, ...coldShower });
    const glasses = seedActive(app, { creatorId: ali.me.id, accepted: [ali.me.id, veli.me.id], ...week, ...water });
    // half of the shower days is the bigger gap, but Veli has marked today
    addSteps(app, shower, ali.me.id, MONDAY, 1, 'manual');
    addSteps(app, shower, ali.me.id, TUESDAY, 1, 'manual');
    addSteps(app, shower, veli.me.id, TUESDAY, 1, 'manual');
    addSteps(app, glasses, ali.me.id, MONDAY, 10, 'manual');
    addSteps(app, glasses, veli.me.id, MONDAY, 7, 'manual');

    expect(sendNudges(app.db, app.now())).toBe(1);
    const [nudge, ...more] = nudgesOf(harness, veli.me.id);
    expect(more).toHaveLength(0);
    expect(nudge!.body).toBe('Ali sana 3 bardak fark koymuş. Bir şeyler yap da gir şuraya.');
    expect(JSON.parse(nudge!.data!)).toEqual({ challengeId: glasses, fromUserId: ali.me.id, dayKey: TUESDAY });
    expect(claimedBy(app, veli.me.id)).toEqual([{ challenge_id: glasses }]);
  });
});

describe('mid-day nudges across a block', () => {
  /** A water çelınc through the real routes; `bardaks` is what each one typed today. */
  async function waterRace(players: { user: RegisteredUser; bardaks: number }[]): Promise<string> {
    const h = harness!;
    const [creator, ...rest] = players;
    for (const [i, a] of players.entries()) {
      for (const b of players.slice(i + 1)) befriend(h.app, a.user.me.id, b.user.me.id);
    }
    const created = await authed(h.app, creator!.user.token)({
      method: 'POST',
      url: '/challenges',
      payload: {
        typeKey: 'su_bardak',
        startsAt: h.now().toISOString(),
        endsAt: new Date(h.now().getTime() + 3 * 86_400_000).toISOString(),
        participantIds: rest.map((p) => p.user.me.id),
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;
    for (const p of rest) {
      const accepted = await authed(h.app, p.user.token)({ method: 'POST', url: `/challenges/${id}/accept` });
      expect(accepted.statusCode).toBe(200);
    }
    for (const p of players) {
      const typed = await authed(h.app, p.user.token)({
        method: 'POST',
        url: `/challenges/${id}/entries`,
        payload: { dayKey: TODAY, value: p.bardaks, source: 'manual', clientTime: h.now().toISOString() },
      });
      expect(typed.statusCode).toBe(201);
    }
    return id;
  }

  function block(blocker: RegisteredUser, blocked: RegisteredUser) {
    return authed(harness!.app, blocker.token)({ method: 'POST', url: `/users/${blocked.me.id}/block` });
  }

  /** No leftovers of a template or a missing value in what the reader sees. */
  function expectClean(text: string) {
    for (const junk of ['undefined', 'null', 'NaN', '[object', '{']) expect(text).not.toContain(junk);
  }

  it('still tells the one who blocked the leader, without the name the poke route refuses', async () => {
    harness = await makeApp(); // 12:00 Istanbul
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    const id = await waterRace([
      { user: ali, bardaks: 1 },
      { user: veli, bardaks: 10 },
    ]);

    expect((await block(ali, veli)).statusCode).toBe(200);
    const poke = await authed(harness.app, veli.token)({
      method: 'POST',
      url: `/challenges/${id}/poke`,
      payload: { toUserId: ali.me.id },
    });
    expect(poke.statusCode).toBe(403);
    expect(poke.json().error.code).toBe('blocked');

    harness.advance(60 * 60_000); // 13:00 Istanbul, inside the nudge hours
    runSchedulerOnce(harness.db, harness.now());

    const [nudge, ...more] = nudgesOf(harness, ali.me.id);
    expect(more).toHaveLength(0);
    expect(nudge!.body).toBe('Bir rakibin sana 9 bardak fark koymuş. Biraz daha yap da gir şuraya.');
    expectClean(nudge!.title);
    // no id of the one blocked rides along either
    expect(JSON.parse(nudge!.data)).toEqual({ challengeId: id, dayKey: TODAY });
  });

  it('works the same the other way round, at every level', async () => {
    harness = await makeApp();
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    const behind = await Promise.all(
      ([1, 2, 3] as const).map((level) =>
        registerUser(harness!.app, `geride${level}`, { displayName: `Geride${level}`, vulgarityMax: level }),
      ),
    );
    await waterRace([{ user: veli, bardaks: 10 }, ...behind.map((user) => ({ user, bardaks: 1 }))]);
    // the ones behind block the leader, not the other way round
    for (const user of behind) expect((await block(user, veli)).statusCode).toBe(200);

    harness.advance(60 * 60_000);
    runSchedulerOnce(harness.db, harness.now());

    const bodies = behind.map((user) => nudgesOf(harness!, user.me.id)[0]?.body ?? '');
    // each of them typed a glass this morning, so it asks for more, not for today's entry
    expect(bodies).toEqual([
      'Bir rakibin önde, aradaki fark 9 bardak. Biraz daha eklersen fark kapanır.',
      'Bir rakibin sana 9 bardak fark koymuş. Biraz daha yap da gir şuraya.',
      'Bir rakibin sana 9 bardak fark koymuş 🍆 Bu kadarla olmaz, biraz daha koy.',
    ]);
    for (const body of bodies) {
      expect(body).not.toContain('Veli');
      expectClean(body);
    }
  });

  it('names the best one ahead the reader has no block with, and measures to them', async () => {
    harness = await makeApp();
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const can = await registerUser(harness.app, 'can', { displayName: 'Can' });
    const veli = await registerUser(harness.app, 'veli', { displayName: 'Veli' });
    const id = await waterRace([
      { user: ali, bardaks: 10 },
      { user: can, bardaks: 6 },
      { user: veli, bardaks: 1 },
    ]);
    expect((await block(veli, ali)).statusCode).toBe(200);

    harness.advance(60 * 60_000);
    runSchedulerOnce(harness.db, harness.now());

    const [nudge] = nudgesOf(harness, veli.me.id);
    expect(nudge!.body).toBe('Can sana 5 bardak fark koymuş. Biraz daha yap da gir şuraya.');
    expect(JSON.parse(nudge!.data)).toEqual({ challengeId: id, fromUserId: can.me.id, dayKey: TODAY });
    // Can still hears about Ali, with whom nothing is wrong
    expect(nudgesOf(harness, can.me.id)[0]!.body).toContain('Ali sana 4 bardak');
  });
});
