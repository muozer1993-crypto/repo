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
import { sendNudges } from '../src/services/challenges.js';
import { makeApp, registerUser, type TestApp } from './helpers.js';
import type { FastifyInstance } from 'fastify';

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
       VALUES (?, ?, ?, ?, 'higher', ?, 'Adım Yarışı', ?, ?, 'active', NULL, NULL, ?, NULL, 0, ?, NULL, NULL, 0, NULL)`,
    )
    .run(
      id,
      options.creatorId,
      options.typeKey ?? 'adim_yarisi',
      options.metricType ?? 'auto_steps',
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

function addSteps(app: FastifyInstance, challengeId: string, userId: string, dayKey: string, value: number): void {
  const at = nowIso(app.now());
  app.db
    .prepare(
      `INSERT INTO entries (id, challenge_id, user_id, day_key, value, source, note, proof_url, status, client_time,
                            session_id, late, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pedometer', NULL, NULL, 'ok', ?, NULL, 0, ?, ?)`,
    )
    .run(newId(), challengeId, userId, dayKey, value, at, at, at);
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
