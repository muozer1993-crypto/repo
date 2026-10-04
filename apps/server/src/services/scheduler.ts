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
import { backupIfDue, copyBackupIfDue } from './backup.js';
import { runSchedulerOnce } from './challenges.js';
import { createPushSender, type PushSender } from './push.js';

export const SCHEDULER_INTERVAL_MS = 30_000;

/**
 * How long stop() waits for a pass that is still running. Long enough for a push
 * flush to hear back from Expo; short enough that a flush hanging on a dead
 * connection cannot hold the shutdown (npm run internet kills at 15 s).
 */
export const STOP_WAIT_MS = 10_000;

/**
 * After a failed copy to BACKUP_DIR (OneDrive signed out, a USB disk unplugged),
 * how long until the next try. Every pass would fill the owner's window with the
 * same warning twice a minute.
 */
export const BACKUP_COPY_RETRY_MS = 60 * 60_000;

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
  let copyInFlight: Promise<void> | null = null;
  let copyRetryAt = 0;
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

    // The second copy runs on its own: a cloud or network folder that hangs must
    // not hold up the next pass, and when it fails the day still has its backup.
    if (config.backupCopyDir && !copyInFlight && app.now().getTime() >= copyRetryAt) {
      copyInFlight = copyBackupIfDue(config, app.now())
        .then((copied) => {
          if (copied) app.log.info({ file: copied }, 'database backup copied to BACKUP_DIR');
        })
        .catch((err: unknown) => {
          copyRetryAt = app.now().getTime() + BACKUP_COPY_RETRY_MS;
          app.log.warn({ err, dir: config.backupCopyDir }, 'database backup copy to BACKUP_DIR failed, trying again in an hour');
        })
        .finally(() => {
          copyInFlight = null;
        });
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
    if (!inFlight && !copyInFlight) return;
    let waited: NodeJS.Timeout | undefined;
    const gaveUp = await Promise.race([
      (async () => {
        await inFlight;
        // read only now: the pass that was running may just have started a copy
        await copyInFlight;
        return false;
      })(),
      new Promise<boolean>((resolve) => {
        waited = setTimeout(() => resolve(true), STOP_WAIT_MS);
      }),
    ]);
    clearTimeout(waited);
    if (gaveUp) app.log.warn('scheduler pass still running at shutdown, closing anyway');
  };
}
