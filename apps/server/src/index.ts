/**
 * Boot: config → database → app → scheduler → listen, plus a clean shutdown.
 * `npm run dev -w apps/server` (tsx watch) or `npm start -w apps/server`.
 */
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { startScheduler } from './services/scheduler.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const { app } = await buildApp({ config, db });

  const stopScheduler = startScheduler(app, db, config);

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    stopScheduler();
    void app
      .close()
      .catch((err: unknown) => app.log.error({ err }, 'close failed'))
      .finally(() => {
        try {
          db.close();
        } catch {
          // already closed
        }
        process.exit(0);
      });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    { port: config.port, host: config.host, publicUrl: config.publicUrl, db: config.dbPath },
    'KOYDUM sunucusu ayakta',
  );
}

main().catch((err: unknown) => {
  console.error('KOYDUM sunucusu başlatılamadı:', err);
  process.exit(1);
});
