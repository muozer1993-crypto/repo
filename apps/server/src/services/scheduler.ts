/**
 * Background scheduler: runs the challenge lifecycle and flushes the push queue
 * every 30 seconds (SPEC 2.4).
 *
 * The timer is `unref()`ed so it never keeps a test process (or a CLI run) alive,
 * and no exception can escape a tick — a broken pass must not kill the server.
 */
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import { backupIfDue } from './backup.js';
import { runSchedulerOnce } from './challenges.js';
import { createPushSender, type PushSender } from './push.js';

export const SCHEDULER_INTERVAL_MS = 30_000;

/**
 * How long stop() waits for a pass that is still running. Long enough for a push
 * flush to hear back from Expo; short enough that a flush hanging on a dead
 * connection cannot hold the shutdown (npm run internet kills at 15 s).
 */
export const STOP_WAIT_MS = 10_000;

export interface SchedulerOptions {
  /** Stand-in for the Expo sender; tests hold a flush open to watch stop() wait for it. */
  push?: PushSender;
}

/**
 * Starts the interval and returns the stop function. Await it before closing the
 * database: a flush cut off between Expo's answer and `pushed_at` leaves rows that
 * the next start sends again.
 */
export function startScheduler(
  app: FastifyInstance,
  db: Database,
  config: Config,
  options: SchedulerOptions = {},
): () => Promise<void> {
  const push = options.push ?? createPushSender(config);
  let inFlight: Promise<void> | null = null;
  // A phone-counted çelınc that ended while this server was off waits a full
  // hour from now, not from its end, so the phones get to report before anybody wins.
  const bootAt = app.now();

  const tick = async (): Promise<void> => {
    try {
      const summary = runSchedulerOnce(db, app.now(), {
        bootAt,
        onError: (stepName, err) => app.log.error({ err, step: stepName }, 'scheduler step failed'),
      });
      if (
        summary.activated ||
        summary.disputes ||
        summary.finalized ||
        summary.cancelled ||
        summary.reminders ||
        summary.nudges ||
        summary.recaps ||
        summary.tauntFollowups
      ) {
        app.log.info(summary, 'scheduler pass');
      }
    } catch (err) {
      app.log.error({ err }, 'scheduler pass failed');
    }

    try {
      const result = await push.flush(db);
      if (result.sent || result.failed) app.log.info(result, 'push flush');
    } catch (err) {
      app.log.error({ err }, 'push flush failed');
    }

    // a no-op on every tick but the first of the day
    try {
      const written = await backupIfDue(db, config, app.now());
      if (written) app.log.info({ file: written }, 'database backup written');
    } catch (err) {
      app.log.error({ err }, 'database backup failed');
    }
  };

  const run = (): void => {
    if (inFlight) return; // never overlap two passes
    inFlight = tick().finally(() => {
      inFlight = null;
    });
  };

  // the first copy right at start, not 30 seconds later
  run();

  const timer = setInterval(run, SCHEDULER_INTERVAL_MS);
  timer.unref();

  return async () => {
    clearInterval(timer);
    if (!inFlight) return;
    let waited: NodeJS.Timeout | undefined;
    const gaveUp = await Promise.race([
      inFlight.then(() => false),
      new Promise<boolean>((resolve) => {
        waited = setTimeout(() => resolve(true), STOP_WAIT_MS);
      }),
    ]);
    clearTimeout(waited);
    if (gaveUp) app.log.warn('scheduler pass still running at shutdown, closing anyway');
  };
}
