/**
 * POST /auth/register, POST /auth/login, POST /auth/refresh (SPEC 2.2).
 *
 * Register and login return the same `{ token, me }` envelope so the app has
 * everything it needs after a single call. Usernames are stored lowercase (the
 * zod schema lowercases them), passwords go through scrypt, and the token is our
 * own HS256 JWT.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  LoginBodySchema,
  ProveBodySchema,
  RegisterBodySchema,
  proveMessage,
  type AuthResponse,
  type ProveResponse,
} from '@koydum/shared';
import { signToken, signatureBytes } from '../auth/jwt.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { getUserByUsername } from '../db/index.js';
import { conflict, parseBody, tooMany, unauthorized } from '../errors.js';
import { requireUser } from '../plugins/auth.js';
import { toMe } from '../serialize.js';
import { createUser, usernameTaken } from '../services/accounts.js';
import { publicOrigin } from '../services/origin.js';
import { AttemptLimiter, clientKey, retryAfterText } from '../services/throttle.js';

/**
 * Budgets for the two unauthenticated endpoints. They are generous enough that a
 * group of friends sharing one NAT never notices, and small enough that neither
 * password guessing nor scrypt flooding is free. "IP" is `clientKey`: an IPv6
 * client's whole /64.
 */
export const LOGIN_FAILURES_PER_ACCOUNT = { max: 8, windowMs: 15 * 60 * 1000 };
const LOGIN_FAILURES_PER_IP = { max: 40, windowMs: 15 * 60 * 1000 };
const REGISTRATIONS_PER_IP = { max: 120, windowMs: 10 * 60 * 1000 };
/**
 * One account's attempts from every address together. The two budgets above are
 * per address, and addresses are cheap (a rented /48 holds 65,536 /64s), so one
 * account took 62 guesses a second with no 429: some five million a day, now 720.
 * The price is that a stranger can keep the account's login shut, so the 429
 * points at the owner's `npm run yonet -- sifre`, whose new password opens it at
 * once (the budget is per password, see `usernameKey`). A phone already signed
 * in never notices: its session renews through /auth/refresh, not here.
 */
export const LOGIN_FAILURES_PER_USERNAME = { max: 30, windowMs: 60 * 60 * 1000 };

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app;

  const loginByAccount = new AttemptLimiter(LOGIN_FAILURES_PER_ACCOUNT.max, LOGIN_FAILURES_PER_ACCOUNT.windowMs);
  const loginByIp = new AttemptLimiter(LOGIN_FAILURES_PER_IP.max, LOGIN_FAILURES_PER_IP.windowMs);
  const loginByUsername = new AttemptLimiter(LOGIN_FAILURES_PER_USERNAME.max, LOGIN_FAILURES_PER_USERNAME.windowMs);
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
    const client = clientKey(request.ip);
    const waitMs = registerByIp.retryAfterMs(client, now);
    if (waitMs > 0) {
      throw tooMany('too_many_attempts', `Çok fazla hesap açtın. ${retryAfterText(waitMs)}`);
    }
    registerByIp.record(client, now);

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
      token: signToken({ sub: row.id, ver: row.token_version }, config.jwtSecret, undefined, now),
      me: toMe(db, row, now),
    };
    return reply.code(201).send(payload);
  });

  app.post('/auth/login', async (request) => {
    const now = app.now();
    const client = clientKey(request.ip);
    const body = parseBody(LoginBodySchema, request.body);
    const accountKey = `${client}|${body.username}`;
    const row = getUserByUsername(db, body.username);
    // Keyed on the account's current password (its token version moves with every
    // change), so the owner's reset reopens a login a stranger has kept shut. An
    // unknown name gets the same budget under its own spelling: both lock alike,
    // and the 429 does not say who exists.
    const usernameKey = row ? `${row.id}:${row.token_version}` : body.username;

    // Only FAILURES are counted, so somebody who knows their password is never
    // locked out by a neighbour on the same IP guessing theirs.
    const addressWaitMs = Math.max(loginByIp.retryAfterMs(client, now), loginByAccount.retryAfterMs(accountKey, now));
    const accountWaitMs = loginByUsername.retryAfterMs(usernameKey, now);
    if (accountWaitMs > 0) {
      // not "you tried too often": the guesses may all be somebody else's
      throw tooMany(
        'too_many_attempts',
        `Bu hesaba çok fazla yanlış şifre denendi. ${retryAfterText(Math.max(accountWaitMs, addressWaitMs))}` +
          ` Şifreni unuttuysan sunucuyu açan kankana söyle, npm run yonet -- sifre ${body.username} ile sıfırlasın;` +
          ' yeni şifreyle beklemeden girersin.',
      );
    }
    if (addressWaitMs > 0) {
      throw tooMany('too_many_attempts', `Çok fazla deneme yaptın. ${retryAfterText(addressWaitMs)}`);
    }
    // Every attempt is counted BEFORE the (async) scrypt and a success wipes it
    // again: recording only after a failure let a burst of guesses sent at once
    // all pass the check above before the first one was written down.
    loginByIp.record(client, now);
    loginByAccount.record(accountKey, now);
    loginByUsername.record(usernameKey, now);

    const badCredentials = unauthorized('bad_credentials', 'Kullanıcı adı ya da şifre yanlış.');
    const fail = (): never => {
      throw badCredentials;
    };

    // Verify against a real hash for unknown users so the answer takes the same
    // time and timing does not leak who exists.
    if (!row) {
      await verifyPassword(body.password, await decoyHash);
      return fail();
    }
    if (!(await verifyPassword(body.password, row.password_hash))) return fail();

    loginByIp.reset(client);
    loginByAccount.reset(accountKey);
    loginByUsername.reset(usernameKey);

    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now.toISOString(), row.id);
    row.last_seen_at = now.toISOString();

    const payload: AuthResponse = {
      token: signToken({ sub: row.id, ver: row.token_version }, config.jwtSecret, undefined, now),
      me: toMe(db, row, now),
    };
    return payload;
  });

  /**
   * "I hold the secret that signed your token, and I am THIS address." A tunnel
   * restart moves the server to a new address, and the app carries the session
   * over (services/serverMove.ts) only after the new address answers this: the
   * public `serverId` alone can be copied by anybody who once read /health.
   *
   * The phone sends its token's `header.payload` (not secret) and a fresh
   * nonce. Recomputing the token's signature needs the JWT secret; it keys a MAC
   * over the nonce and the address this server vouches for (`publicOrigin`:
   * PUBLIC_URL when set). A copycat without the secret cannot answer, and one
   * that relays the question here gets an answer for the real address, which
   * the phone refuses. The signature itself never leaves either side.
   */
  app.post('/auth/prove', async (request): Promise<ProveResponse> => {
    const body = parseBody(ProveBodySchema, request.body);
    const origin = publicOrigin(request, config);
    const proof = createHmac('sha256', signatureBytes(body.claims, config.jwtSecret))
      .update(proveMessage(body.nonce, origin))
      .digest('base64url');
    return { origin, proof };
  });

  /**
   * A fresh 90 days for a token that still works. Without it every token died
   * exactly 90 days after login, so friends who joined the same week were all
   * thrown out on the same day, and a phone that only ran the background task
   * stopped sending steps without a word. The app calls this about once a week.
   * An expired token, or one from before a password change, gets the usual 401
   * from `authenticate`: renewal is not a way back in, only a way to stay in. The
   * new token keeps the version, so a stray session cannot renew itself past the
   * next password change either.
   */
  app.post('/auth/refresh', { preHandler: app.authenticate }, async (request) => {
    const { row } = requireUser(request);
    return { token: signToken({ sub: row.id, ver: row.token_version }, config.jwtSecret, undefined, app.now()) };
  });
}
