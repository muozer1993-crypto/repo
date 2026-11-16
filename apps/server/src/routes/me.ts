/**
 * The signed-in user's own resources (SPEC 2.2):
 *   GET/PATCH/DELETE /me, POST /me/password, POST+DELETE /me/push-token,
 *   POST /me/steps, POST /me/screen-time, GET /me/inbox, POST /me/inbox/read,
 *   GET /me/inbox/unread.
 *
 * The interesting ones are the two device syncs: the phone posts raw daily
 * readings (steps, screen minutes) and the server fans them out into an entry
 * for every matching çelınc the user is actually playing — see
 * `services/deviceSync.ts`. The app never has to know which challenges exist.
 */
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  ChangePasswordBodySchema,
  InboxQuerySchema,
  InboxReadBodySchema,
  PushTokenBodySchema,
  ScreenTimeSyncBodySchema,
  StepsSyncBodySchema,
  UpdateMeBodySchema,
  type AuthResponse,
  type Notification,
  type ScreenTimeSyncDay,
  type StepsSyncDay,
  type UnreadCount,
} from '@koydum/shared';
import { signToken } from '../auth/jwt.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { nowIso, type Database, type UserRow } from '../db/index.js';
import { badRequest, parseBody, parseQuery, tooMany } from '../errors.js';
import { requireUser } from '../plugins/auth.js';
import { toMe, toNotification } from '../serialize.js';
import { replacePassword, softDeleteUser } from '../services/accounts.js';
import { fanOutDeviceDays } from '../services/deviceSync.js';
import { BANNED_TEXT_MESSAGES, assertClean } from '../services/moderation.js';
import { listInbox, markRead, unreadCount } from '../services/notifications.js';
import { awardBadges } from '../services/stats.js';
import { AttemptLimiter, retryAfterText } from '../services/throttle.js';
import { LOGIN_FAILURES_PER_ACCOUNT } from './auth.js';

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
 *
 * A day's minutes only grow here too: one phone's reading of a day sums the
 * foreground time up to now, so a lower one is a second phone or a phone whose
 * usage history was purged, never a correction. 5 after 300 would hand the day to
 * the wrong player. The fan-out gets the day's highest reading, so a typed row it
 * replaces gets that one as well. `updated_at` moves on every sync all the same:
 * it says when the phone last spoke.
 */
function syncScreenTime(db: Database, user: UserRow, days: ScreenTimeSyncDay[], now: Date): number {
  const at = nowIso(now);
  const upsert = db.prepare(
    `INSERT INTO screen_time_daily (user_id, day_key, minutes, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, day_key) DO UPDATE SET
       minutes = MAX(screen_time_daily.minutes, excluded.minutes),
       updated_at = excluded.updated_at
     RETURNING minutes`,
  );
  const run = db.transaction((list: ScreenTimeSyncDay[]) => {
    const stored = list.map((day) => {
      const row = upsert.get(user.id, day.dayKey, day.minutes, at) as { minutes: number };
      return { dayKey: day.dayKey, value: Number(row.minutes), source: 'usage_stats' as const };
    });
    return fanOutDeviceDays(db, user, 'screen_time', stored, now);
  });
  return run(days);
}

export default async function meRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app;
  const auth = { preHandler: app.authenticate };

  /**
   * A phone left unlocked on the table already holds a working token, so the
   * current password is the only thing between it and a hijacked account —
   * guessing it here gets the same budget as guessing it at login.
   */
  const passwordFailures = new AttemptLimiter(LOGIN_FAILURES_PER_ACCOUNT.max, LOGIN_FAILURES_PER_ACCOUNT.windowMs);

  app.get('/me', auth, async (request) => toMe(db, requireUser(request).row, app.now()));

  app.patch('/me', auth, async (request) => {
    const { row } = requireUser(request);
    const body = parseBody(UpdateMeBodySchema, request.body);
    // A name stored before the filter ran on names stays: sent back unchanged
    // beside another field, it must not stop that field from saving.
    if (body.displayName !== undefined && body.displayName !== row.display_name) {
      assertClean(body.displayName, BANNED_TEXT_MESSAGES.displayName);
    }

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
    if (body.nudgesEnabled !== undefined) push('nudges_enabled', body.nudgesEnabled ? 1 : 0);
    if (body.recapEnabled !== undefined) push('recap_enabled', body.recapEnabled ? 1 : 0);

    if (sets.length > 0) {
      params.push(row.id);
      db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...(params as never[]));
    }

    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(row.id) as UserRow;
    return toMe(db, fresh, app.now());
  });

  app.delete('/me', auth, async (request) => {
    const { row } = requireUser(request);
    const deleted = softDeleteUser(db, row, app.now(), { uploadDir: path.resolve(config.uploadDir) });
    return { ok: true, username: deleted.username };
  });

  // ---------------------------------------------------------------------------
  // Password
  // ---------------------------------------------------------------------------

  /**
   * Swaps a throwaway "123456" (or the one the owner handed out with
   * `npm run yonet -- sifre`) for a real one. Every other phone signed in to the
   * account is signed out (`replacePassword` moves the token version on): friends
   * open each other's accounts on their own phones, and a session left there
   * used to outlive any new password. Answers with a fresh session like login
   * does, so this phone stays in (SPEC 2.2).
   */
  app.post('/me/password', auth, async (request) => {
    const { row } = requireUser(request);
    const now = app.now();
    const waitMs = passwordFailures.retryAfterMs(row.id, now);
    if (waitMs > 0) {
      throw tooMany('too_many_attempts', `Çok fazla deneme yaptın. ${retryAfterText(waitMs)}`);
    }

    const body = parseBody(ChangePasswordBodySchema, request.body);
    // Counted BEFORE the (async) scrypt: recording only after it let a burst of
    // guesses sent at once all pass the check above. A right one clears it.
    passwordFailures.record(row.id, now);
    // A 400, never a 401: the app logs out on any 401, and a typo in this form
    // must not cost the session it was typed in.
    if (!(await verifyPassword(body.currentPassword, row.password_hash))) {
      throw badRequest('wrong_password', 'Mevcut şifren tutmadı.');
    }
    passwordFailures.reset(row.id);
    // compared the way scrypt sees them, so a look-alike spelling is "the same" too
    if (body.newPassword.normalize('NFKC') === body.currentPassword.normalize('NFKC')) {
      throw badRequest('same_password', 'Yeni şifren eskisiyle aynı. Başka bir şey yaz.');
    }

    // The push token stays only on the phone that made the change. The app says
    // which token it registered (null: none), so one held by a phone this change
    // signs out goes. An app from before that field says nothing, and its token
    // stays as it always did: that app sends a device token once per run, not
    // once per session, so a token cleared here would leave the phone with no
    // push and no notification of its own until it was restarted.
    const keepPush =
      body.pushToken === undefined || (body.pushToken !== null && body.pushToken === row.push_token);
    const fresh = replacePassword(db, row.id, await hashPassword(body.newPassword), { clearPush: !keepPush });

    const payload: AuthResponse = {
      token: signToken({ sub: fresh.id, ver: fresh.token_version }, config.jwtSecret, undefined, now),
      me: toMe(db, fresh, now),
    };
    return payload;
  });

  // ---------------------------------------------------------------------------
  // Push token
  // ---------------------------------------------------------------------------

  app.post('/me/push-token', auth, async (request) => {
    const { row } = requireUser(request);
    const body = parseBody(PushTokenBodySchema, request.body);
    db.transaction(() => {
      const current = db.prepare('SELECT push_token FROM users WHERE id = ?').get(row.id) as Pick<UserRow, 'push_token'>;
      // A token new to the account only takes what is written from now on. The
      // rows waiting now were the phone's own to show while it had no token (the
      // app's inbox check), or are history a fresh sign-in does not replay: pushed
      // now, they would ring twice, or ring a whole history the day Firebase is
      // turned on. They stay in Gelen. The app sends the same token on every
      // start, and that must not touch anything.
      if (current.push_token !== body.token) {
        db.prepare(
          "UPDATE notifications SET push_error = 'before_token' WHERE user_id = ? AND pushed_at IS NULL AND push_error IS NULL",
        ).run(row.id);
      }
      // One phone, one account: the last account to sign in on it owns the token.
      // Logout's DELETE is best effort, and a token left on the previous account
      // rang its invites and lafs on the next person's phone.
      db.prepare('UPDATE users SET push_token = NULL, push_platform = NULL WHERE push_token = ? AND id <> ?').run(
        body.token,
        row.id,
      );
      db.prepare('UPDATE users SET push_token = ?, push_platform = ? WHERE id = ?').run(body.token, body.platform, row.id);
    })();
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
    const now = app.now();
    const updated = syncSteps(db, row, body.days, now);
    // The step ladder ("Yola Çıktın" at 7.500 a day) reads steps_daily, which
    // only this route writes. Without this the badge waited for some unrelated
    // event (a finish, a laf) and arrived days after the walk. A failure here
    // must not fail the sync: the phone would only send the same days again.
    try {
      awardBadges(db, row.id, now);
    } catch (err) {
      request.log.warn({ err }, 'badge check after steps sync failed');
    }
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
