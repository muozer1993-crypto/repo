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
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { LIMITS } from '@koydum/shared';
import { loadConfig, type Config } from './config.js';
import { openDb, type Database } from './db/index.js';
import { errorHandler, notFoundHandler } from './errors.js';
import { registerAuth } from './plugins/auth.js';

import healthRoutes from './routes/health.js';
import inviteRoutes from './routes/invites.js';
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
    /**
     * When the scheduler started, or last woke from sleep (`startScheduler`
     * keeps `at` up to date): the phones' hour after an end runs from here
     * too, and an itiraz may be filed in it (`disputesOpenUntil`). `catchUp`
     * runs the beat a wake is still owed before a request is handled (the
     * `onRequest` hook below). Both unset while no scheduler runs (tests,
     * `/dev/advance`).
     */
    schedulerBootAt: { at?: Date; catchUp?: () => void };
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
  /** Where log lines go instead of stdout (tests read them). */
  logStream?: { write: (line: string) => void };
}

/** A response slower than this is logged even when it succeeded. */
const SLOW_REQUEST_MS = 2_000;

/**
 * The most a JSON body may weigh. The biggest one a schema lets through,
 * `/me/inbox/read` with 500 ids of 64 characters, is about 33 KB, and what the apps
 * send (a 14-day step sync, a çelınc with 15 friends) is a few KB; anything bigger
 * only holds the one event loop every friend shares. A 3 MB list of `{}` kept it
 * busy for 14 s and pushed the process to 3 GB. Proof photos are not under this:
 * @fastify/multipart reads its own stream with its own `MULTIPART_LIMITS`.
 */
export const JSON_BODY_LIMIT = 64 * 1024;

/**
 * POST /uploads takes one part, the photo (`file`), and the app sends nothing
 * else. busboy's defaults let a body carry 1,000 parts of 1 MB text fields
 * besides, every one kept in memory until the request ends: one account sent
 * 99 such fields per request, stalled each just under Cloudflare's 100 MB cap,
 * and a few dozen of them ran the process out of heap. A few small fields are
 * still read (a client that adds a name is no attacker), cut at 1 KB; more fields
 * than that are a 400 `too_many_parts`.
 */
export const MULTIPART_LIMITS = {
  fileSize: LIMITS.UPLOAD_MAX_BYTES,
  files: 1,
  fields: 4,
  fieldSize: 1024,
  fieldNameSize: 100,
  parts: 5,
  headerPairs: 20,
} as const;

/**
 * How long a request may take to arrive. Fastify's default is no limit, so a
 * body stalled halfway held its memory for as long as the sender kept the
 * connection open. The app gives a photo two minutes (`UPLOAD_TIMEOUT_MS`), a
 * JSON call 15 s; this leaves a slow connection a margin past both.
 */
export const REQUEST_TIMEOUT_MS = 150_000;

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
    logger:
      config.logLevel === 'silent'
        ? false
        : { level: config.logLevel, ...(opts.logStream ? { stream: opts.logStream } : {}) },
    // Two JSON lines per request buried the tunnel address and every real error in
    // the owner's window; the hook below keeps only the requests worth a look.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: JSON_BODY_LIMIT,
    requestTimeout: REQUEST_TIMEOUT_MS,
    trustProxy: config.trustProxy,
  });

  app.decorate('db', db);
  app.decorate('config', config);
  app.decorate('now', now);
  app.decorate('schedulerBootAt', {} as { at?: Date; catchUp?: () => void });

  // A PC that wakes keeps this process, and the phones send what they parked
  // the moment the tunnel answers again, which can be before the scheduler's
  // next beat: a "Geldim" from the night would find no sleep written down, a
  // çelınc that started meanwhile still pending, an itiraz the hour already
  // gone. The beat the wake is owed runs first; between beats this is one
  // subtraction. Nothing it does may cost the friend their request.
  app.addHook('onRequest', async () => {
    try {
      app.schedulerBootAt.catchUp?.();
    } catch (err) {
      app.log.error({ err }, 'scheduler catch-up failed');
    }
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  // A failed or slow request, one line. The query string stays out: an invite
  // code or a search for a friend's name has no business in the owner's window.
  app.addHook('onResponse', async (request, reply) => {
    // 507 is POST /uploads turning a photo away on a nearly full disk on purpose;
    // it tells the owner itself, once an hour rather than once a photo.
    const failed = reply.statusCode >= 500 && reply.statusCode !== 507;
    if (!failed && reply.elapsedTime < SLOW_REQUEST_MS) return;
    request.log.warn(
      {
        method: request.method,
        url: request.url.split('?')[0],
        statusCode: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
      },
      failed ? 'request failed' : 'slow request',
    );
  });

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
  await app.register(multipart, { limits: MULTIPART_LIMITS });

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
    await app.register(fastifyStatic, {
      root: uploadDir,
      prefix: '/uploads/',
      decorateReply: false,
      // A name is a fresh UUID and never reused, so a photo never changes under its
      // URL: phones, and any cache on the way, keep it instead of downloading every
      // feed thumb again.
      maxAge: '365d',
      immutable: true,
      // Served as an image and nothing else: no sniffing a "photo" into HTML, and
      // opened on its own in a browser it can run nothing.
      setHeaders: (reply) => {
        reply.header('x-content-type-options', 'nosniff');
        reply.header('content-security-policy', "default-src 'none'; img-src 'self'; sandbox");
      },
    });
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
  await app.register(inviteRoutes);
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
