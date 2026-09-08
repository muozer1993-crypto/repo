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
import { runSchedulerOnce } from './challenges.js';
import { createPushSender } from './push.js';

export const SCHEDULER_INTERVAL_MS = 30_000;

/** Starts the interval and returns the stop function. */
export function startScheduler(app: FastifyInstance, db: Database, config: Config): () => void {
  const push = createPushSender(config);
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return; // never overlap two passes
    running = true;
    try {
      const summary = runSchedulerOnce(db, app.now(), {
        onError: (stepName, err) => app.log.error({ err, step: stepName }, 'scheduler step failed'),
      });
      if (summary.activated || summary.finalized || summary.cancelled || summary.reminders) {
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

    running = false;
  };

  const timer = setInterval(() => {
    void tick();
  }, SCHEDULER_INTERVAL_MS);
  timer.unref();

  return () => {
    clearInterval(timer);
  };
}
