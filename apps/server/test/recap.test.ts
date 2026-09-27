/**
 * The weekly recap: Sunday evening, once, in the reader's own timezone, with
 * the week's koydun / yedin, the steps and the king of the week.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { RecapData } from '@koydum/shared';

import { newId, nowIso } from '../src/db/index.js';
import { runSchedulerOnce } from '../src/services/challenges.js';
import { listInbox } from '../src/services/notifications.js';
import { recapWeekFor, sendWeeklyRecaps } from '../src/services/recap.js';
import { befriend, makeApp, registerUser, type TestApp } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let harness: TestApp | null = null;
afterEach(async () => {
  await harness?.app.close();
  harness = null;
});

/** Sunday 2026-01-11, 20:30 in Istanbul (UTC+3). */
const SUNDAY_EVENING = '2026-01-11T17:30:00.000Z';
const SUNDAY = '2026-01-11';

interface FinishedOptions {
  players: string[];
  winnerId: string | null;
  tie?: boolean;
  finalizedAt: string;
}

function seedFinished(app: FastifyInstance, options: FinishedOptions): string {
  const id = newId();
  const at = options.finalizedAt;
  app.db
    .prepare(
      `INSERT INTO challenges (id, creator_id, type_key, metric_type, direction, unit, title, starts_at, ends_at,
                               status, reward_text, penalty_text, deadline_time, daily_target, proof_required,
                               created_at, finalized_at, winner_id, is_tie, rematch_of_id)
       VALUES (?, ?, 'adim_yarisi', 'auto_steps', 'higher', 'adım', 'Adım Yarışı', ?, ?, 'finished', NULL, NULL,
               NULL, NULL, 0, ?, ?, ?, ?, NULL)`,
    )
    .run(id, options.players[0], at, at, at, at, options.tie ? null : options.winnerId, options.tie ? 1 : 0);
  const insert = app.db.prepare(
    `INSERT INTO challenge_participants (challenge_id, user_id, status, invited_at, joined_at, timezone)
     VALUES (?, ?, 'accepted', ?, ?, 'Europe/Istanbul')`,
  );
  for (const userId of options.players) insert.run(id, userId, at, at);
  return id;
}

function seedActive(app: FastifyInstance, players: string[]): void {
  const id = newId();
  const at = nowIso(app.now());
  app.db
    .prepare(
      `INSERT INTO challenges (id, creator_id, type_key, metric_type, direction, unit, title, starts_at, ends_at,
                               status, reward_text, penalty_text, deadline_time, daily_target, proof_required,
                               created_at, finalized_at, winner_id, is_tie, rematch_of_id)
       VALUES (?, ?, 'adim_yarisi', 'auto_steps', 'higher', 'adım', 'Adım Yarışı', ?, ?, 'active', NULL, NULL,
               NULL, NULL, 0, ?, NULL, NULL, 0, NULL)`,
    )
    .run(id, players[0], at, '2026-01-20T00:00:00.000Z', at);
  const insert = app.db.prepare(
    `INSERT INTO challenge_participants (challenge_id, user_id, status, invited_at, joined_at, timezone)
     VALUES (?, ?, 'accepted', ?, ?, 'Europe/Istanbul')`,
  );
  for (const userId of players) insert.run(id, userId, at, at);
}

function setSteps(app: FastifyInstance, userId: string, dayKey: string, steps: number): void {
  app.db
    .prepare(
      `INSERT INTO steps_daily (user_id, day_key, steps, source, updated_at) VALUES (?, ?, ?, 'pedometer', ?)
       ON CONFLICT(user_id, day_key) DO UPDATE SET steps = excluded.steps`,
    )
    .run(userId, dayKey, steps, nowIso(app.now()));
}

function recapsOf(userId: string) {
  return listInbox(harness!.db, userId).filter((row) => row.type === 'recap');
}

function dataOf(row: { data: unknown }): RecapData & { weekKey: string } {
  return (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) as RecapData & { weekKey: string };
}

async function gang(now: string = SUNDAY_EVENING) {
  harness = await makeApp({ now });
  const app = harness.app;
  const ali = await registerUser(app, 'ali', { displayName: 'Ali', timezone: 'Europe/Istanbul' });
  const veli = await registerUser(app, 'veli', { displayName: 'Veli', timezone: 'Europe/Istanbul' });
  const can = await registerUser(app, 'can', { displayName: 'Can', timezone: 'Europe/Istanbul' });
  befriend(app, ali.me.id, veli.me.id);
  befriend(app, ali.me.id, can.me.id);
  return { app, ali, veli, can };
}

describe('recapWeekFor', () => {
  const tz = 'Europe/Istanbul';
  it('opens at 20:00 on Sunday and closes at noon on Monday', () => {
    expect(recapWeekFor(new Date('2026-01-11T16:59:00.000Z'), tz)).toBeNull(); // Sun 19:59
    expect(recapWeekFor(new Date('2026-01-11T17:00:00.000Z'), tz)).toBe(SUNDAY); // Sun 20:00
    expect(recapWeekFor(new Date('2026-01-11T20:59:00.000Z'), tz)).toBe(SUNDAY); // Sun 23:59
    expect(recapWeekFor(new Date('2026-01-12T08:59:00.000Z'), tz)).toBe(SUNDAY); // Mon 11:59
    expect(recapWeekFor(new Date('2026-01-12T09:00:00.000Z'), tz)).toBeNull(); // Mon 12:00
    expect(recapWeekFor(new Date('2026-01-10T18:00:00.000Z'), tz)).toBeNull(); // Sat 21:00
  });

  it('follows the reader, not the server', () => {
    // 17:30Z is Sunday 20:30 in Istanbul but still Sunday 12:30 in New York
    expect(recapWeekFor(new Date(SUNDAY_EVENING), 'America/New_York')).toBeNull();
    expect(recapWeekFor(new Date('2026-01-12T01:00:00.000Z'), 'America/New_York')).toBe(SUNDAY);
  });
});

describe('weekly recap', () => {
  it('tells everybody their week, with the king of the week', async () => {
    const { app, ali, veli, can } = await gang();
    seedFinished(app, { players: [ali.me.id, veli.me.id], winnerId: ali.me.id, finalizedAt: '2026-01-06T10:00:00.000Z' });
    seedFinished(app, { players: [ali.me.id, can.me.id], winnerId: ali.me.id, finalizedAt: '2026-01-08T10:00:00.000Z' });
    seedFinished(app, { players: [ali.me.id, veli.me.id], winnerId: veli.me.id, finalizedAt: '2026-01-10T10:00:00.000Z' });
    // last week: not this recap's business
    seedFinished(app, { players: [ali.me.id, veli.me.id], winnerId: veli.me.id, finalizedAt: '2026-01-02T10:00:00.000Z' });
    setSteps(app, ali.me.id, '2026-01-05', 8_000);
    setSteps(app, ali.me.id, '2026-01-07', 14_200);
    setSteps(app, ali.me.id, '2026-01-04', 99_999); // the Sunday before: last week
    setSteps(app, veli.me.id, '2026-01-06', 30_000);

    expect(sendWeeklyRecaps(app.db, app.now())).toBe(3);

    const [forAli] = recapsOf(ali.me.id);
    expect(forAli.title).toBe('📊 Haftanın hesabı');
    expect(forAli.body).toContain('Bu hafta 2 kere koydun, 1 kere yedin.');
    expect(forAli.body).toContain('22.200 adım');
    expect(forAli.body).toContain('Çarşamba (14.200)');
    expect(forAli.body).toContain('👑 Haftanın kralı sensin');
    expect(forAli.body).toContain('🚶 En çok Veli yürüdü: 30.000 adım.');
    expect(forAli.body).toContain('Böyle devam.');
    expect(dataOf(forAli)).toMatchObject({
      weekKey: SUNDAY,
      weekStart: '2026-01-05',
      weekEnd: SUNDAY,
      wins: 2,
      losses: 1,
      ties: 0,
      steps: 22_200,
    });

    const [forVeli] = recapsOf(veli.me.id);
    expect(forVeli.body).toContain('Bu hafta 1 kere koydun, 1 kere yedin.');
    expect(forVeli.body).toContain('👑 Haftanın kralı Ali, 2 kere koydu.');
    expect(forVeli.body).toContain('bacaklara sağlık');

    const [forCan] = recapsOf(can.me.id);
    expect(forCan.body).toContain('Bu hafta 1 kere yedin, bir kere bile koyamadın.');
    expect(forCan.body).toContain('Haftaya rövanş.');
  });

  it('speaks at the reader’s level', async () => {
    harness = await makeApp({ now: SUNDAY_EVENING });
    const app = harness.app;
    const polite = await registerUser(app, 'nazik', { displayName: 'Nazik', vulgarityMax: 1 });
    const loud = await registerUser(app, 'agir', { displayName: 'Ağır', vulgarityMax: 3 });
    befriend(app, polite.me.id, loud.me.id);
    seedFinished(app, { players: [polite.me.id, loud.me.id], winnerId: loud.me.id, finalizedAt: '2026-01-09T10:00:00.000Z' });

    sendWeeklyRecaps(app.db, app.now());

    const [soft] = recapsOf(polite.me.id);
    expect(soft.title).toBe('📊 Haftanın özeti');
    expect(soft.body).toContain('Bu hafta 1 çelınc bitti: 0 galibiyet, 1 mağlubiyet.');
    expect(soft.body).toContain('👑 Haftanın kralı: Ağır (1 galibiyet).');
    expect(soft.body).not.toContain('🍆');

    const [hard] = recapsOf(loud.me.id);
    expect(hard.title).toBe('📊 HAFTANIN HESABI 🍆');
    expect(hard.body).toContain('hepsine koydun 🍆');
  });

  it('is sent once a week, even when the scheduler keeps running', async () => {
    const { app, ali, veli } = await gang();
    seedFinished(app, { players: [ali.me.id, veli.me.id], winnerId: ali.me.id, finalizedAt: '2026-01-09T10:00:00.000Z' });

    // Can played nothing, but hears who the king of his gang is
    expect(sendWeeklyRecaps(app.db, app.now())).toBe(3);
    expect(sendWeeklyRecaps(app.db, new Date('2026-01-11T20:00:00.000Z'))).toBe(0);
    expect(sendWeeklyRecaps(app.db, new Date('2026-01-12T06:00:00.000Z'))).toBe(0); // Monday morning
    expect(recapsOf(ali.me.id)).toHaveLength(1);
  });

  it('makes up a missed Sunday on Monday morning, and not after', async () => {
    const { app, ali, veli } = await gang('2026-01-12T06:00:00.000Z'); // Monday 09:00
    seedFinished(app, { players: [ali.me.id, veli.me.id], winnerId: ali.me.id, finalizedAt: '2026-01-09T10:00:00.000Z' });

    expect(sendWeeklyRecaps(app.db, new Date('2026-01-12T10:00:00.000Z'))).toBe(0); // Monday 13:00: too late
    expect(sendWeeklyRecaps(app.db, app.now())).toBe(3);
    expect(dataOf(recapsOf(ali.me.id)[0]).weekKey).toBe(SUNDAY);
  });

  it('counts a çelınc that ends after the recap in the next one, exactly once', async () => {
    const { app, ali, veli } = await gang();
    seedFinished(app, { players: [ali.me.id, veli.me.id], winnerId: ali.me.id, finalizedAt: '2026-01-09T10:00:00.000Z' });
    sendWeeklyRecaps(app.db, app.now());

    // Sunday 23:59 — after this week's recap went out
    seedFinished(app, { players: [ali.me.id, veli.me.id], winnerId: veli.me.id, finalizedAt: '2026-01-11T20:59:00.000Z' });

    // Can is only Ali's friend, and neither of them won anything this week
    expect(sendWeeklyRecaps(app.db, new Date('2026-01-18T17:30:00.000Z'))).toBe(2);
    const [latest] = recapsOf(ali.me.id);
    expect(dataOf(latest)).toMatchObject({ weekKey: '2026-01-18', wins: 0, losses: 1 });
  });

  it('does not lose a çelınc between an on-time recap and a Monday make-up', async () => {
    const { app, ali, veli } = await gang();
    seedFinished(app, { players: [ali.me.id, veli.me.id], winnerId: ali.me.id, finalizedAt: '2026-01-09T10:00:00.000Z' });
    sendWeeklyRecaps(app.db, app.now()); // Sunday 20:30

    // Sunday 00:00 local — after the recap, before the next week starts
    seedFinished(app, { players: [ali.me.id, veli.me.id], winnerId: veli.me.id, finalizedAt: '2026-01-11T21:00:30.000Z' });

    // the server was off all next Sunday evening: Monday 09:00 makes it up
    expect(sendWeeklyRecaps(app.db, new Date('2026-01-19T06:00:00.000Z'))).toBe(2);
    const [latest] = recapsOf(ali.me.id);
    expect(dataOf(latest)).toMatchObject({ weekKey: '2026-01-18', wins: 0, losses: 1 });
  });

  it('keeps the window whole across the night the clocks go back', async () => {
    harness = await makeApp({ now: '2026-10-18T18:00:10.000Z' }); // Sunday 20:00 in Berlin (CEST)
    const app = harness.app;
    const ali = await registerUser(app, 'ali', { displayName: 'Ali', timezone: 'Europe/Berlin' });
    const veli = await registerUser(app, 'veli', { displayName: 'Veli', timezone: 'Europe/Berlin' });
    befriend(app, ali.me.id, veli.me.id);
    seedFinished(app, { players: [ali.me.id, veli.me.id], winnerId: ali.me.id, finalizedAt: '2026-10-16T10:00:00.000Z' });
    sendWeeklyRecaps(app.db, app.now());

    seedFinished(app, { players: [ali.me.id, veli.me.id], winnerId: veli.me.id, finalizedAt: '2026-10-18T18:30:00.000Z' });

    // one week on, 20:00 CET is 19:00Z: 7 days and 59 minutes after the last one
    expect(sendWeeklyRecaps(app.db, new Date('2026-10-25T19:00:10.000Z'))).toBe(2);
    expect(dataOf(recapsOf(ali.me.id)[0])).toMatchObject({ weekKey: '2026-10-25', losses: 1 });
  });

  it('talks about "geçen hafta" when it arrives on Monday', async () => {
    const { app, ali, veli } = await gang('2026-01-12T06:00:00.000Z'); // Monday 09:00
    seedFinished(app, { players: [ali.me.id, veli.me.id], winnerId: veli.me.id, finalizedAt: '2026-01-09T10:00:00.000Z' });

    sendWeeklyRecaps(app.db, app.now());

    const [forAli] = recapsOf(ali.me.id);
    expect(forAli.body).toContain('Geçen hafta 1 kere yedin, bir kere bile koyamadın.');
    expect(forAli.body).toContain('Bu hafta rövanş.');
    expect(forAli.body).not.toContain('Haftaya');
  });

  it('does not call somebody who walked all week lazy', async () => {
    harness = await makeApp({ now: SUNDAY_EVENING });
    const app = harness.app;
    const walker = await registerUser(app, 'yuruyen', { vulgarityMax: 3 });
    const sleeper = await registerUser(app, 'uyuyan', { vulgarityMax: 3 });
    befriend(app, walker.me.id, sleeper.me.id);
    setSteps(app, walker.me.id, '2026-01-07', 25_000);

    sendWeeklyRecaps(app.db, app.now());

    expect(recapsOf(walker.me.id)[0].body).toContain('ne koydun ne yedin, sadece yürüdün 🍆');
    expect(recapsOf(walker.me.id)[0].body).not.toContain('yattın');
    // the friend who did nothing hears who walked, and that they did not
    expect(recapsOf(sleeper.me.id)[0].body).toContain('yattın 🍆');
  });

  it('stays quiet for somebody with nothing to tell', async () => {
    harness = await makeApp({ now: SUNDAY_EVENING });
    const app = harness.app;
    const loner = await registerUser(app, 'yalniz');
    setSteps(app, loner.me.id, '2026-01-04', 5_000); // last week only

    expect(sendWeeklyRecaps(app.db, app.now())).toBe(0);
    expect(recapsOf(loner.me.id)).toHaveLength(0);
  });

  it('still writes to somebody who only walked, or only has a çelınc running', async () => {
    harness = await makeApp({ now: SUNDAY_EVENING });
    const app = harness.app;
    const walker = await registerUser(app, 'yuruyen');
    const racer = await registerUser(app, 'yarisan');
    const rival = await registerUser(app, 'rakip');
    setSteps(app, walker.me.id, '2026-01-10', 7_500);
    seedActive(app, [racer.me.id, rival.me.id]);

    expect(sendWeeklyRecaps(app.db, app.now())).toBe(3);
    expect(recapsOf(walker.me.id)[0].body).toContain('Bu hafta ne koydun ne yedin.');
    expect(recapsOf(walker.me.id)[0].body).toContain('7.500 adım');
    expect(recapsOf(racer.me.id)[0].body).toContain('1 çelınc hâlâ sürüyor.');
  });

  it('shares the crown on an exact tie and names no walker on a shared first place', async () => {
    const { app, ali, veli } = await gang();
    seedFinished(app, { players: [ali.me.id, veli.me.id], winnerId: ali.me.id, finalizedAt: '2026-01-06T10:00:00.000Z' });
    seedFinished(app, { players: [ali.me.id, veli.me.id], winnerId: veli.me.id, finalizedAt: '2026-01-07T10:00:00.000Z' });
    setSteps(app, ali.me.id, '2026-01-06', 10_000);
    setSteps(app, veli.me.id, '2026-01-06', 10_000);

    sendWeeklyRecaps(app.db, app.now());

    const [forAli] = recapsOf(ali.me.id);
    expect(forAli.body).toContain('👑 Tahtı Veli ile paylaşıyorsun (1 galibiyet).');
    expect(forAli.body).not.toContain('🚶');
  });

  it('breaks a tie on wins with steps', async () => {
    const { app, ali, veli } = await gang();
    seedFinished(app, { players: [ali.me.id, veli.me.id], winnerId: ali.me.id, finalizedAt: '2026-01-06T10:00:00.000Z' });
    seedFinished(app, { players: [ali.me.id, veli.me.id], winnerId: veli.me.id, finalizedAt: '2026-01-07T10:00:00.000Z' });
    setSteps(app, veli.me.id, '2026-01-06', 12_000);

    sendWeeklyRecaps(app.db, app.now());

    expect(recapsOf(ali.me.id)[0].body).toContain('👑 Haftanın kralı Veli, 1 kere koydu.');
  });

  it('skips deleted accounts and a broken timezone without stopping the rest', async () => {
    const { app, ali, veli, can } = await gang();
    seedFinished(app, { players: [ali.me.id, veli.me.id, can.me.id], winnerId: ali.me.id, finalizedAt: '2026-01-09T10:00:00.000Z' });
    app.db.prepare("UPDATE users SET timezone = 'Mars/Olympus' WHERE id = ?").run(veli.me.id);
    app.db.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').run(nowIso(app.now()), can.me.id);

    expect(sendWeeklyRecaps(app.db, app.now())).toBe(1);
    expect(recapsOf(ali.me.id)).toHaveLength(1);
    expect(recapsOf(veli.me.id)).toHaveLength(0);
  });

  it('runs as a scheduler step', async () => {
    const { app, ali, veli, can } = await gang();
    seedFinished(app, { players: [ali.me.id, veli.me.id], winnerId: ali.me.id, finalizedAt: '2026-01-09T10:00:00.000Z' });

    expect(runSchedulerOnce(app.db, app.now()).recaps).toBe(3);
    expect(recapsOf(can.me.id)[0].body).toContain('👑 Haftanın kralı Ali');
  });
});
