/**
 * POST /auth/register, POST /auth/login (SPEC 2.2).
 *
 * Both return the same `{ token, me }` envelope so the app has everything it needs
 * after a single call. Usernames are stored lowercase (the zod schema lowercases
 * them), passwords go through scrypt, and the token is our own HS256 JWT.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { LoginBodySchema, RegisterBodySchema, type AuthResponse } from '@koydum/shared';
import { signToken } from '../auth/jwt.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { getUserByUsername } from '../db/index.js';
import { conflict, parseBody, tooMany, unauthorized } from '../errors.js';
import { toMe } from '../serialize.js';
import { createUser, usernameTaken } from '../services/accounts.js';
import { AttemptLimiter, retryAfterText } from '../services/throttle.js';

/**
 * Budgets for the two unauthenticated endpoints. They are generous enough that a
 * group of friends sharing one NAT never notices, and small enough that neither
 * password guessing nor scrypt flooding is free.
 */
const LOGIN_FAILURES_PER_ACCOUNT = { max: 8, windowMs: 15 * 60 * 1000 };
const LOGIN_FAILURES_PER_IP = { max: 40, windowMs: 15 * 60 * 1000 };
const REGISTRATIONS_PER_IP = { max: 120, windowMs: 10 * 60 * 1000 };

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app;

  const loginByAccount = new AttemptLimiter(LOGIN_FAILURES_PER_ACCOUNT.max, LOGIN_FAILURES_PER_ACCOUNT.windowMs);
  const loginByIp = new AttemptLimiter(LOGIN_FAILURES_PER_IP.max, LOGIN_FAILURES_PER_IP.windowMs);
  const registerByIp = new AttemptLimiter(REGISTRATIONS_PER_IP.max, REGISTRATIONS_PER_IP.windowMs);

  /**
   * A REAL hash of a throwaway password, verified for users that do not exist.
   *
   * The old decoy (`scrypt$00$00`) was rejected by `verifyPassword`'s length check
   * before scrypt ever ran, which made an unknown username answer ~88x faster than a
   * known one — a plain username-enumeration oracle. Derived once at boot, awaited
   * per unknown user, so both branches pay for exactly one scrypt.
   */
  const decoyHash = hashPassword(randomBytes(24).toString('hex'));
  // Nothing awaits this before the first login; make sure a failure is not an
  // unhandled rejection.
  decoyHash.catch(() => undefined);

  app.post('/auth/register', async (request, reply) => {
    const now = app.now();
    const ip = request.ip;
    const waitMs = registerByIp.retryAfterMs(ip, now);
    if (waitMs > 0) {
      throw tooMany('too_many_attempts', `Çok fazla hesap açtın. ${retryAfterText(waitMs)}`);
    }
    registerByIp.record(ip, now);

    const body = parseBody(RegisterBodySchema, request.body);

    if (usernameTaken(db, body.username)) {
      throw conflict('username_taken', 'Bu kullanıcı adı kapılmış. Başka bir tane dene.');
    }

    const row = createUser(
      db,
      {
        username: body.username,
        displayName: body.displayName,
        passwordHash: await hashPassword(body.password),
        timezone: body.timezone,
        vulgarityMax: body.vulgarityMax,
      },
      now,
    );

    const payload: AuthResponse = {
      token: signToken({ sub: row.id }, config.jwtSecret, undefined, now),
      me: toMe(db, row, now),
    };
    return reply.code(201).send(payload);
  });

  app.post('/auth/login', async (request) => {
    const now = app.now();
    const ip = request.ip;
    const body = parseBody(LoginBodySchema, request.body);
    const accountKey = `${ip}|${body.username}`;

    // Only FAILURES are counted, so somebody who knows their password is never
    // locked out by a neighbour on the same IP guessing theirs.
    const waitMs = Math.max(loginByIp.retryAfterMs(ip, now), loginByAccount.retryAfterMs(accountKey, now));
    if (waitMs > 0) {
      throw tooMany('too_many_attempts', `Çok fazla deneme yaptın. ${retryAfterText(waitMs)}`);
    }

    const badCredentials = unauthorized('bad_credentials', 'Kullanıcı adı ya da şifre yanlış.');
    const fail = (): never => {
      loginByIp.record(ip, now);
      loginByAccount.record(accountKey, now);
      throw badCredentials;
    };

    const row = getUserByUsername(db, body.username);
    // Verify against a real hash for unknown users so the answer takes the same
    // time and timing does not leak who exists.
    if (!row) {
      await verifyPassword(body.password, await decoyHash);
      return fail();
    }
    if (!(await verifyPassword(body.password, row.password_hash))) return fail();

    loginByIp.reset(ip);
    loginByAccount.reset(accountKey);

    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now.toISOString(), row.id);
    row.last_seen_at = now.toISOString();

    const payload: AuthResponse = {
      token: signToken({ sub: row.id }, config.jwtSecret, undefined, now),
      me: toMe(db, row, now),
    };
    return payload;
  });
}
