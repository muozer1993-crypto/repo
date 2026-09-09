/**
 * `buildApp()` — the whole HTTP surface, exported so tests can drive it with
 * `app.inject()` against an in-memory database.
 *
 * The returned object is `{ app, db, config }`, and the same three things are also
 * decorated on the instance so route modules never need to import anything global:
 *
 *   app.db      — better-sqlite3 handle (already migrated)
 *   app.config  — resolved Config
 *   app.now()   — THE clock. Every route, service and test must read the current
 *                 time from here; tests inject a controllable one via `opts.now`.
 *   app.authenticate — preHandler that fills `request.user`
 */
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { LIMITS } from '@koydum/shared';
import { loadConfig, type Config } from './config.js';
import { openDb, type Database } from './db/index.js';
import { errorHandler, notFoundHandler } from './errors.js';
import { registerAuth } from './plugins/auth.js';

import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import meRoutes from './routes/me.js';
import userRoutes from './routes/users.js';
import friendRoutes from './routes/friends.js';
import catalogRoutes from './routes/catalog.js';
import challengeRoutes from './routes/challenges.js';
import entryRoutes from './routes/entries.js';
import socialRoutes from './routes/social.js';
import uploadRoutes from './routes/uploads.js';
import devRoutes from './routes/dev.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    config: Config;
    /** The single source of "now" for every route and service. */
    now: () => Date;
  }
}

export interface BuildAppOptions {
  /** SQLite path; ignored when `db` is given. Defaults to `config.dbPath`. */
  dbPath?: string;
  /** Config overrides (merged on top of the environment). */
  config?: Partial<Config>;
  /** Pre-opened database (tests). When given, `app.close()` will NOT close it. */
  db?: Database;
  /** Injectable clock. */
  now?: () => Date;
}

export interface BuiltApp {
  app: FastifyInstance;
  db: Database;
  config: Config;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<BuiltApp> {
  const config = loadConfig(opts.config ?? {});
  const ownsDb = opts.db === undefined;
  const db = opts.db ?? openDb(opts.dbPath ?? config.dbPath);
  const now = opts.now ?? ((): Date => new Date());

  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel },
    bodyLimit: LIMITS.UPLOAD_MAX_BYTES + 1024 * 1024,
    trustProxy: true,
  });

  app.decorate('db', db);
  app.decorate('config', config);
  app.decorate('now', now);

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  // `methods` is spelled out because the browser preflights PATCH (the whole
  // settings screen) and DELETE (leaving a challenge, deleting an account); the
  // web build of the app is a first-class client, not just a test target.
  await app.register(cors, {
    origin: true,
    credentials: false,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAge: 86_400,
  });

  // Several endpoints take no body at all (accept, decline, leave, rematch...).
  // Fastify's default JSON parser rejects an empty payload with 400, which
  // breaks any client that sets Content-Type unconditionally — curl, most HTTP
  // libraries, and anything generated from an OpenAPI client. Treat an empty
  // body as `{}` and keep strict parsing for everything else.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, payload: string, done) => {
      const text = typeof payload === 'string' ? payload.trim() : '';
      if (text.length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch (error) {
        // The code is what `errorHandler` maps to the Turkish "Geçersiz JSON
        // gönderdin."; without it a broken body falls through to the generic 400.
        const failure = error as Error & { statusCode?: number; code?: string };
        failure.statusCode = 400;
        failure.code = 'FST_ERR_CTP_INVALID_JSON';
        done(failure, undefined);
      }
    },
  );
  await app.register(multipart, {
    limits: { fileSize: LIMITS.UPLOAD_MAX_BYTES, files: 1 },
  });

  // Proof photos are served straight from disk at /uploads/<file>. When the
  // directory cannot be created (read-only filesystem, a file in the way),
  // @fastify/static would throw on the missing root and take the WHOLE API down with
  // a raw ENOTDIR stack — so the mount is skipped instead and the rest of the server
  // still boots; uploads then fail at write time, which is what the operator needs.
  const uploadDir = path.resolve(config.uploadDir);
  let uploadDirReady = true;
  try {
    fs.mkdirSync(uploadDir, { recursive: true });
  } catch (err) {
    uploadDirReady = false;
    app.log.warn({ err, uploadDir }, 'upload directory unavailable, /uploads is not served');
  }
  if (uploadDirReady) {
    await app.register(fastifyStatic, { root: uploadDir, prefix: '/uploads/', decorateReply: false });
  }

  registerAuth(app, { db, config, now });

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(meRoutes);
  await app.register(userRoutes);
  await app.register(friendRoutes);
  await app.register(catalogRoutes);
  await app.register(challengeRoutes);
  await app.register(entryRoutes);
  await app.register(socialRoutes);
  await app.register(uploadRoutes);
  if (config.enableDevRoutes) await app.register(devRoutes);

  if (ownsDb) {
    app.addHook('onClose', async () => {
      try {
        db.close();
      } catch {
        // already closed
      }
    });
  }

  return { app, db, config };
}
