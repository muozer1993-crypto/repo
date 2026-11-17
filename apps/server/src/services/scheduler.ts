/**
 * Background scheduler: runs the challenge lifecycle and flushes the push queue
 * every 30 seconds (SPEC 2.4).
 *
 * The timer is `unref()`ed so it never keeps a test process (or a CLI run) alive,
 * and no exception can escape a tick — a broken pass must not kill the server.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_TIMEZONE, todayKey } from '@koydum/shared';
import { MEMORY, type Config } from '../config.js';
import type { Database } from '../db/index.js';
import { clearDeletedTraces } from './accounts.js';
import { backupIfDue, copyBackupIfDue } from './backup.js';
import { runSchedulerOnce } from './challenges.js';
import { isDiskFull, warnDiskFull } from './disk.js';
import { readLastBeat, recordPause, writeLastBeat } from './pauses.js';
import { sweepOrphanPhotos } from './photos.js';
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
 * or a day's backup that did not fit on the disk, how long until the next try.
 * Every pass would fill the owner's window with the same warning twice a minute.
 */
export const BACKUP_COPY_RETRY_MS = 60 * 60_000;

/**
 * A gap this long between two beats of the 30-second interval means the process
 * was not running: the PC slept (Windows suspends it, the process never restarts)
 * or was frozen. Well above a beat, so a busy event loop never reads as one.
 * The wall clock alone cannot tell a sleep from a clock put forward (w32tm
 * /resync after a Linux boot left it hours behind), and a sleep is written down
 * as a pause in which a parked check-in counts at its tap: the gap is checked
 * against the machine's uptime too, which runs on through a sleep and never
 * jumps with the clock (`SchedulerOptions.uptimeMs`). A clock put forward only
 * moves `bootAt`, which holds a result an hour longer.
 */
export const RESUME_GAP_MS = 5 * 60_000;

/**
 * The `bootAt` for this beat: `now` after a gap of more than `RESUME_GAP_MS`
 * since the last one, `prev` (the same object, so the caller can tell) otherwise.
 * A server that slept through midnight is a server that was off at midnight, and
 * gets the same hour (`stillSettling`, `resolveDisputes`).
 */
export function nextBootAt(prev: Date, lastBeatMs: number, now: Date): Date {
  return now.getTime() - lastBeatMs > RESUME_GAP_MS ? now : prev;
}

export interface SchedulerOptions {
  /** Stand-in for the Expo sender; tests hold a flush open to watch stop() wait for it. */
  push?: PushSender;
  /**
   * Milliseconds the machine has been up: counts on through a sleep (Windows'
   * tick count, Linux's boot time) and is not moved by setting the clock.
   * Tests tie it to their injected clock to stand for a sleep.
   */
  uptimeMs?: () => number;
}

const machineUptimeMs = (): number => os.uptime() * 1000;

/** About how much room a copy of the database takes, in whole MB rounded up; null when the file cannot be read. */
function databaseMb(dbPath: string): number | null {
  try {
    return Math.max(1, Math.ceil(fs.statSync(path.resolve(dbPath)).size / (1024 * 1024)));
  } catch {
    return null;
  }
}

/**
 * Starts the interval and returns the stop function. Await it before closing the
 * database: a flush cut off after Expo's answer would write its failed tickets
 * into a closed one (a row is claimed before it is sent, so it never goes twice).
 */
export function startScheduler(
  app: FastifyInstance,
  db: Database,
  config: Config,
  options: SchedulerOptions = {},
): () => Promise<void> {
  const push = options.push ?? createPushSender(config);
  const uptimeMs = options.uptimeMs ?? machineUptimeMs;
  let inFlight: Promise<void> | null = null;
  let copyInFlight: Promise<void> | null = null;
  let copyRetryAt = 0;
  let backupRetryAt = 0;
  // the Istanbul day the unused proof photos were last swept
  let sweptDay: string | null = null;
  // A phone-counted çelınc that ended while this server was off waits a full
  // hour from now, not from its end, so the phones get to report before anybody
  // wins; an itiraz whose window ran out meanwhile gets the same hour for its
  // photo. Asleep is off too: the PC wakes with this process still running, so
  // the interval moves it on when it comes back (`nextBootAt`).
  let bootAt = app.now();
  let lastBeatMs = bootAt.getTime();
  let lastBeatUptimeMs = uptimeMs();
  // the itiraz route and the çelınc detail read it (`disputesOpenUntil`)
  app.schedulerBootAt.at = bootAt;

  // A full disk fails every write of every pass. The owner hears that once an
  // hour, in the words that say what to do (`warnDiskFull`), not as SQLite's
  // English twice a minute; anything else is logged as it was.
  const report = (err: unknown, log: () => void): void => {
    if (isDiskFull(err)) warnDiskFull(app, app.now().getTime());
    else log();
  };

  // Every pause is written down: a check-in a phone parked while nobody could
  // hear it counts at its tap (`tappedWhileDown`). A failed write costs only
  // that, and must not throw out of the interval and take the server with it.
  const remember = (write: () => void): void => {
    try {
      write();
    } catch (err) {
      report(err, () => app.log.warn({ err }, 'writing down when the server was off failed'));
    }
  };
  // A process that was stopped (Ctrl+C, the window closed, the power cut, `dur`
  // and `y` in the npm run internet window) left its last beat behind: the time
  // since then is a pause like a sleep, however short. Nothing ran meanwhile,
  // and a "Geldim" the tunnel answered with a 502 during a three-minute update
  // must count at its tap like one tapped in the night.
  remember(() => {
    const lastRun = readLastBeat(db);
    if (lastRun && lastRun.getTime() < bootAt.getTime()) recordPause(db, lastRun, bootAt);
  });

  const tick = async (): Promise<void> => {
    try {
      const summary = runSchedulerOnce(db, app.now(), {
        bootAt,
        onError: (stepName, err) => report(err, () => app.log.error({ err, step: stepName }, 'scheduler step failed')),
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
      report(err, () => app.log.error({ err }, 'scheduler pass failed'));
    }

    // A deleted account's notes and photos, once the çelınc that still needed
    // them is decided (the pass above may just have finished it). The first
    // pass after the upgrade also takes those of accounts deleted before.
    try {
      const entries = clearDeletedTraces(db, path.resolve(config.uploadDir));
      if (entries) app.log.info({ entries }, 'deleted accounts cleared');
    } catch (err) {
      report(err, () => app.log.warn({ err }, 'clearing deleted accounts failed'));
    }

    try {
      const result = await push.flush(db, app.now());
      if (result.sent || result.failed) app.log.info(result, 'push flush');
    } catch (err) {
      report(err, () => app.log.error({ err }, 'push flush failed'));
    }

    // a no-op on every tick but the first of the day
    if (app.now().getTime() >= backupRetryAt) {
      try {
        const written = await backupIfDue(db, config, app.now());
        if (written) app.log.info({ file: written }, 'database backup written');
      } catch (err) {
        if (isDiskFull(err)) {
          // a copy of the whole database does not fit: an hour on, not every pass
          // with a stack, and how much room it wants, which is what the owner must free
          backupRetryAt = app.now().getTime() + BACKUP_COPY_RETRY_MS;
          app.log.warn({ neededMb: databaseMb(config.dbPath) }, 'database backup did not fit on the disk, trying again in an hour');
        } else {
          app.log.error({ err }, 'database backup failed');
        }
      }
    }

    // The first pass of each day, the start's included: the proof photos no
    // entry shows. Never for a database in memory, which knows nothing of what
    // an earlier run uploaded: every file in the folder would look unused.
    const today = todayKey(DEFAULT_TIMEZONE, app.now());
    if (today !== sweptDay && config.dbPath !== MEMORY && config.dataDir !== MEMORY) {
      // a failed sweep waits for tomorrow, not for the next pass 30 s on
      sweptDay = today;
      try {
        const { removed, bytes } = await sweepOrphanPhotos(db, path.resolve(config.uploadDir), app.now(), {
          dbPath: path.resolve(config.dbPath),
        });
        if (removed > 0) app.log.info({ removed, mb: Math.round((bytes * 10) / (1024 * 1024)) / 10 }, 'proof photos swept');
      } catch (err) {
        app.log.warn({ err }, 'proof photo sweep failed');
      }
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
    // Measured on every beat, including the ones a slow pass makes us skip: a
    // push flush that holds a pass for minutes is not a sleep.
    const now = app.now();
    const upNow = uptimeMs();
    const next = nextBootAt(bootAt, lastBeatMs, now);
    if (next !== bootAt) {
      const minutes = Math.round((now.getTime() - lastBeatMs) / 60_000);
      if (upNow - lastBeatUptimeMs > RESUME_GAP_MS) {
        app.log.warn({ minutes }, 'scheduler resumed after a pause');
        remember(() => recordPause(db, new Date(lastBeatMs), now));
      } else {
        // the process was here all along: no tap went unheard
        app.log.warn({ minutes }, 'clock moved forward');
      }
    }
    bootAt = next;
    app.schedulerBootAt.at = bootAt;
    lastBeatMs = now.getTime();
    lastBeatUptimeMs = upNow;
    // what the next start reads back
    remember(() => writeLastBeat(db, now));

    if (inFlight) return; // never overlap two passes
    inFlight = tick().finally(() => {
      inFlight = null;
    });
  };

  // The first request after a wake can come before the interval's next beat
  // (the phones' queues send the moment the tunnel answers again), so it runs
  // the beat the wake is owed first (the `onRequest` hook in `app.ts`).
  // Between beats it does nothing. It cannot write a sleep twice or start a
  // second pass: `run` moves the last beat to now, so whichever of the request
  // and the interval comes second finds no gap, and `run` never starts a pass
  // while one is still going.
  app.schedulerBootAt.catchUp = (): void => {
    if (app.now().getTime() - lastBeatMs > RESUME_GAP_MS) run();
  };

  // the first copy right at start, not 30 seconds later
  run();

  const timer = setInterval(run, SCHEDULER_INTERVAL_MS);
  timer.unref();

  return async () => {
    clearInterval(timer);
    // nor does a request during the shutdown start a pass on a closing database
    app.schedulerBootAt.catchUp = undefined;
    // the pause the next start writes down begins now, not at the last beat:
    // up to 30 s in which this server was still here to hear a tap
    remember(() => writeLastBeat(db, app.now()));
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
