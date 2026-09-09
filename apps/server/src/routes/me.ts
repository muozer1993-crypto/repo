/**
 * The signed-in user's own resources (SPEC 2.2):
 *   GET/PATCH/DELETE /me, POST+DELETE /me/push-token, POST /me/steps,
 *   GET /me/inbox, POST /me/inbox/read, GET /me/inbox/unread.
 *
 * The interesting one is `POST /me/steps`: the phone syncs raw daily step counts and
 * the server fans them out into an entry for every step challenge the user is
 * actually playing — the app never has to know which challenges exist.
 */
import type { FastifyInstance } from 'fastify';
import {
  InboxQuerySchema,
  InboxReadBodySchema,
  PushTokenBodySchema,
  StepsSyncBodySchema,
  UpdateMeBodySchema,
  type Notification,
  type StepsSyncDay,
  type UnreadCount,
} from '@koydum/shared';
import { newId, nowIso, type ChallengeRow, type Database, type UserRow } from '../db/index.js';
import { parseBody, parseQuery } from '../errors.js';
import { requireUser } from '../plugins/auth.js';
import { toMe, toNotification } from '../serialize.js';
import { softDeleteUser } from '../services/accounts.js';
import { challengeWindow, participantTimezone, typeForChallenge } from '../services/challenges.js';
import { dayWindowIssue } from '../services/entries.js';
import { listInbox, markRead, unreadCount } from '../services/notifications.js';

/** A step challenge plus the timezone this user's days in it are measured in. */
type StepChallengeRow = ChallengeRow & { participant_timezone: string | null };

/**
 * Step challenges the user has accepted and that are still open — `active` or
 * `pending` (SPEC 2.2). A pending challenge that has not started yet simply has no
 * day in range yet, so the day rules below keep it out on their own.
 */
function stepChallengesFor(db: Database, userId: string): StepChallengeRow[] {
  return db
    .prepare(
      `SELECT c.*, p.timezone AS participant_timezone FROM challenges c
         JOIN challenge_participants p ON p.challenge_id = c.id AND p.user_id = ? AND p.status = 'accepted'
        WHERE c.metric_type = 'auto_steps'
          AND c.status IN ('active', 'pending')`,
    )
    .all(userId) as StepChallengeRow[];
}

/**
 * Writes the synced days into `steps_daily` and mirrors them into every matching
 * challenge as an upserted entry. Returns how many entries were touched.
 *
 * The fan-out obeys exactly the same day rules as `POST /challenges/:id/entries`
 * (`dayWindowIssue`): a day outside the challenge window, in the future, or older
 * than the steps backfill limit is skipped instead of banked — otherwise a phone
 * could pre-fill a whole 30-day race with the daily maximum on day one. The window
 * is read in the timezone pinned when the user joined that challenge.
 */
function syncSteps(db: Database, user: UserRow, days: StepsSyncDay[], now: Date): number {
  const at = nowIso(now);
  const challenges = stepChallengesFor(db, user.id);

  const windows = new Map<string, { tz: string; window: string[]; maxPerDay: number }>();
  for (const challenge of challenges) {
    const tz = participantTimezone({ timezone: challenge.participant_timezone }, user);
    windows.set(challenge.id, {
      tz,
      window: challengeWindow(challenge, tz),
      maxPerDay: typeForChallenge(challenge).maxPerDay,
    });
  }

  const upsertSteps = db.prepare(
    `INSERT INTO steps_daily (user_id, day_key, steps, source, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, day_key) DO UPDATE SET steps = excluded.steps, source = excluded.source, updated_at = excluded.updated_at`,
  );
  const findEntry = db.prepare('SELECT id FROM entries WHERE challenge_id = ? AND user_id = ? AND day_key = ?');
  const updateEntry = db.prepare('UPDATE entries SET value = ?, source = ?, updated_at = ? WHERE id = ?');
  const insertEntry = db.prepare(
    `INSERT INTO entries (id, challenge_id, user_id, day_key, value, source, note, proof_url, status,
                          client_time, session_id, late, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'ok', ?, NULL, 0, ?, ?)`,
  );

  const run = db.transaction((list: StepsSyncDay[]) => {
    let updated = 0;
    for (const day of list) {
      upsertSteps.run(user.id, day.dayKey, day.steps, day.source, at);

      for (const challenge of challenges) {
        const rules = windows.get(challenge.id);
        if (!rules) continue;
        if (dayWindowIssue(rules.window, 'auto_steps', rules.tz, day.dayKey, now) !== null) continue;
        const value = Math.min(day.steps, rules.maxPerDay);
        const existing = findEntry.get(challenge.id, user.id, day.dayKey) as { id: string } | undefined;
        if (existing) updateEntry.run(value, day.source, at, existing.id);
        else insertEntry.run(newId(), challenge.id, user.id, day.dayKey, value, day.source, at, at, at);
        updated += 1;
      }
    }
    return updated;
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
