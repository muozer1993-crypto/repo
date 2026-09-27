/**
 * Boot: .env → config → database → app → listen → scheduler, plus a clean shutdown.
 * `npm run dev -w apps/server` (tsx watch) or `npm start -w apps/server`; under
 * `npm run internet` the script supervises this process and talks to it over IPC.
 */
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { loadDotEnv } from './env.js';
import { listenErrorMessage } from './listenError.js';
import { startScheduler } from './services/scheduler.js';

/**
 * A close that hangs (a request that never ends) must still end the process, or
 * npm run internet would wait on a server that no longer serves. Above the
 * scheduler's own 10 s wait, below the script's 15 s kill.
 */
const SHUTDOWN_DEADLINE_MS = 12_000;

async function main(): Promise<void> {
  // before anything reads process.env: the README's apps/server/.env is where PORT lives
  loadDotEnv();
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const { app } = await buildApp({ config, db });

  let stopScheduler: (() => Promise<void>) | null = null;
  let shuttingDown = false;
  const shutdown = (reason: string, code = 0): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ reason }, 'shutting down');
    setTimeout(() => process.exit(code), SHUTDOWN_DEADLINE_MS).unref();
    void (async () => {
      // an in-flight push flush marks its rows before the database closes, so a
      // restart does not send the same KOYDUM twice
      await stopScheduler?.();
      await app.close().catch((err: unknown) => app.log.error({ err }, 'close failed'));
      try {
        db.close();
      } catch {
        // already closed
      }
      process.exit(code);
    })();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // closing the console window: SIGHUP on Windows as on Linux
  process.on('SIGHUP', () => shutdown('SIGHUP'));
  if (process.platform === 'win32') process.on('SIGBREAK', () => shutdown('SIGBREAK'));
  // npm run internet asks over IPC because on Windows a "signal" to a child is
  // TerminateProcess: no database close, no waiting for the push flush
  process.on('message', (message: unknown) => {
    if ((message as { type?: unknown } | null)?.type === 'shutdown') shutdown('supervisor');
  });
  // the script itself was killed (Task Manager): nobody is left to stop this
  // process, and it would sit on the port the next `npm run internet` needs
  process.on('disconnect', () => shutdown('supervisor gone'));
  // exit non-zero so npm run internet brings up a fresh process behind the same address
  process.on('unhandledRejection', (err: unknown) => {
    app.log.fatal({ err }, 'unhandled rejection');
    shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (err: Error) => {
    app.log.fatal({ err }, 'uncaught exception');
    shutdown('uncaughtException', 1);
  });

  await app.listen({ port: config.port, host: config.host });
  // only once the port is ours: a second window that cannot listen must not run a
  // pass (notifications, pushes, the backup) against the same database first
  if (shuttingDown) return;
  stopScheduler = startScheduler(app, db, config);
  app.log.info(
    { port: config.port, host: config.host, publicUrl: config.publicUrl, db: config.dbPath },
    'KOYDUM sunucusu ayakta',
  );
}

main().catch((err: unknown) => {
  // the common failures get one Turkish line; anything else needs its stack
  const known = listenErrorMessage(err);
  if (known) console.error(known);
  else console.error('KOYDUM sunucusu başlatılamadı:', err);
  process.exit(1);
});
