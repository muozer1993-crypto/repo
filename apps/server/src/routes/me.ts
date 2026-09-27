/**
 * The signed-in user's own resources (SPEC 2.2):
 *   GET/PATCH/DELETE /me, POST+DELETE /me/push-token, POST /me/steps,
 *   POST /me/screen-time, GET /me/inbox, POST /me/inbox/read, GET /me/inbox/unread.
 *
 * The interesting ones are the two device syncs: the phone posts raw daily
 * readings (steps, screen minutes) and the server fans them out into an entry
 * for every matching çelınc the user is actually playing — see
 * `services/deviceSync.ts`. The app never has to know which challenges exist.
 */
import type { FastifyInstance } from 'fastify';
import {
  InboxQuerySchema,
  InboxReadBodySchema,
  PushTokenBodySchema,
  ScreenTimeSyncBodySchema,
  StepsSyncBodySchema,
  UpdateMeBodySchema,
  type Notification,
  type ScreenTimeSyncDay,
  type StepsSyncDay,
  type UnreadCount,
} from '@koydum/shared';
import { nowIso, type Database, type UserRow } from '../db/index.js';
import { parseBody, parseQuery } from '../errors.js';
import { requireUser } from '../plugins/auth.js';
import { toMe, toNotification } from '../serialize.js';
import { softDeleteUser } from '../services/accounts.js';
import { fanOutDeviceDays } from '../services/deviceSync.js';
import { listInbox, markRead, unreadCount } from '../services/notifications.js';

/**
 * Writes the synced days into `steps_daily` and mirrors them into every open
 * step challenge. Returns how many entries were touched. `steps_daily` records
 * everything the phone reported — only the challenge fan-out is gated by the
 * day rules.
 */
function syncSteps(db: Database, user: UserRow, days: StepsSyncDay[], now: Date): number {
  const at = nowIso(now);
  const upsert = db.prepare(
    `INSERT INTO steps_daily (user_id, day_key, steps, source, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, day_key) DO UPDATE SET
       -- a day's steps only grow; a lower reading is a partial source (see deviceSync.ts)
       steps = MAX(steps_daily.steps, excluded.steps),
       source = CASE WHEN excluded.steps >= steps_daily.steps THEN excluded.source ELSE steps_daily.source END,
       updated_at = excluded.updated_at`,
  );
  const run = db.transaction((list: StepsSyncDay[]) => {
    for (const day of list) upsert.run(user.id, day.dayKey, day.steps, day.source, at);
    return fanOutDeviceDays(
      db,
      user,
      'steps',
      list.map((day) => ({ dayKey: day.dayKey, value: day.steps, source: day.source })),
      now,
    );
  });
  return run(days);
}

/**
 * Same shape for screen time: `screen_time_daily` keeps the phone's word, the
 * fan-out writes `usage_stats` entries into every open screen-time çelınc.
 */
function syncScreenTime(db: Database, user: UserRow, days: ScreenTimeSyncDay[], now: Date): number {
  const at = nowIso(now);
  const upsert = db.prepare(
    `INSERT INTO screen_time_daily (user_id, day_key, minutes, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, day_key) DO UPDATE SET minutes = excluded.minutes, updated_at = excluded.updated_at`,
  );
  const run = db.transaction((list: ScreenTimeSyncDay[]) => {
    for (const day of list) upsert.run(user.id, day.dayKey, day.minutes, at);
    return fanOutDeviceDays(
      db,
      user,
      'screen_time',
      list.map((day) => ({ dayKey: day.dayKey, value: day.minutes, source: 'usage_stats' as const })),
      now,
    );
  });
  return run(days);
}

export default async function meRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;
  const auth = { preHandler: app.authenticate };

  app.get('/me', auth, async (request) => toMe(db, requireUser(request).row, app.now()));

  app.patch('/me', auth, async (request) => {
    const { row } = requireUser(request);
    const body = parseBody(UpdateMeBodySchema, request.body);

    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (column: string, value: unknown): void => {
      sets.push(`${column} = ?`);
      params.push(value);
    };

    if (body.displayName !== undefined) push('display_name', body.displayName);
    if (body.avatarEmoji !== undefined) push('avatar_emoji', body.avatarEmoji);
    if (body.vulgarityMax !== undefined) push('vulgarity_max', body.vulgarityMax);
    if (body.timezone !== undefined) push('timezone', body.timezone);
    if (body.reminderHour !== undefined) push('reminder_hour', body.reminderHour);

    if (sets.length > 0) {
      params.push(row.id);
      db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...(params as never[]));
    }

    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(row.id) as UserRow;
    return toMe(db, fresh, app.now());
  });

  app.delete('/me', auth, async (request) => {
    const { row } = requireUser(request);
    const deleted = softDeleteUser(db, row, app.now());
    return { ok: true, username: deleted.username };
  });

  // ---------------------------------------------------------------------------
  // Push token
  // ---------------------------------------------------------------------------

  app.post('/me/push-token', auth, async (request) => {
    const { row } = requireUser(request);
    const body = parseBody(PushTokenBodySchema, request.body);
    db.prepare('UPDATE users SET push_token = ?, push_platform = ? WHERE id = ?').run(body.token, body.platform, row.id);
    return { ok: true, hasPushToken: true };
  });

  app.delete('/me/push-token', auth, async (request) => {
    const { row } = requireUser(request);
    db.prepare('UPDATE users SET push_token = NULL, push_platform = NULL WHERE id = ?').run(row.id);
    return { ok: true, hasPushToken: false };
  });

  // ---------------------------------------------------------------------------
  // Steps
  // ---------------------------------------------------------------------------

  app.post('/me/steps', auth, async (request) => {
    const { row } = requireUser(request);
    const body = parseBody(StepsSyncBodySchema, request.body);
    const updated = syncSteps(db, row, body.days, app.now());
    return { updated };
  });

  // ---------------------------------------------------------------------------
  // Screen time (Android usage access; iPhones cannot report this)
  // ---------------------------------------------------------------------------

  app.post('/me/screen-time', auth, async (request) => {
    const { row } = requireUser(request);
    const body = parseBody(ScreenTimeSyncBodySchema, request.body);
    const updated = syncScreenTime(db, row, body.days, app.now());
    return { updated };
  });

  // ---------------------------------------------------------------------------
  // Inbox
  // ---------------------------------------------------------------------------

  app.get('/me/inbox', auth, async (request) => {
    const { row } = requireUser(request);
    const query = parseQuery(InboxQuerySchema, request.query);
    // SPEC 2.2 and the mobile client both expect a bare array, newest first.
    const items: Notification[] = listInbox(db, row.id, { before: query.before, limit: query.limit }).map(toNotification);
    return items;
  });

  app.post('/me/inbox/read', auth, async (request) => {
    const { row } = requireUser(request);
    const body = parseBody(InboxReadBodySchema, request.body);
    const updated = markRead(db, row.id, { ids: body.ids, all: body.all });
    const unread: UnreadCount = unreadCount(db, row.id);
    return { updated, ...unread };
  });

  app.get('/me/inbox/unread', auth, async (request) => {
    const { row } = requireUser(request);
    return unreadCount(db, row.id);
  });
}
