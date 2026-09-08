/**
 * Authentication decorator.
 *
 * Not a fastify-plugin wrapper: `registerAuth(app, deps)` decorates the root
 * instance directly, so every route module can use it as
 * `app.get('/me', { preHandler: app.authenticate }, handler)` and then read
 * `request.user` (`{ id, row }`).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Database, UserRow } from '../db/index.js';
import { unauthorized } from '../errors.js';
import { bearerToken, verifyToken } from '../auth/jwt.js';

export interface AuthUser {
  id: string;
  row: UserRow;
}

export interface AuthDeps {
  db: Database;
  config: Config;
  /** Injectable clock (defaults to the real one) so tests can expire tokens. */
  now?: () => Date;
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Set by the `authenticate` preHandler. Only present on routes that use it —
     * on public routes it is undefined at runtime despite this type.
     */
    user: AuthUser;
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/** Throws 401 when the preHandler did not run (defensive, for public routes). */
export function requireUser(request: FastifyRequest): AuthUser {
  const user = request.user as AuthUser | undefined;
  if (!user) throw unauthorized('unauthorized', 'Giriş yapman gerekiyor.');
  return user;
}

const LAST_SEEN_THROTTLE_MS = 60_000;

export function registerAuth(app: FastifyInstance, deps: AuthDeps): void {
  const { db, config } = deps;
  const clock = deps.now ?? (() => new Date());

  const selectUser = db.prepare('SELECT * FROM users WHERE id = ?');
  const touchUser = db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?');

  const authenticate = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const token = bearerToken(request.headers.authorization);
    if (!token) throw unauthorized('unauthorized', 'Giriş yapman gerekiyor.');

    const now = clock();
    const claims = verifyToken(token, config.jwtSecret, now);
    if (!claims) throw unauthorized('invalid_token', 'Oturumun geçersiz ya da süresi dolmuş. Tekrar giriş yap.');

    const row = selectUser.get(claims.sub) as UserRow | undefined;
    if (!row || row.deleted_at !== null) {
      throw unauthorized('invalid_token', 'Oturumun geçersiz ya da süresi dolmuş. Tekrar giriş yap.');
    }

    const last = row.last_seen_at ? Date.parse(row.last_seen_at) : 0;
    if (!Number.isFinite(last) || now.getTime() - last > LAST_SEEN_THROTTLE_MS) {
      const iso = now.toISOString();
      touchUser.run(iso, row.id);
      row.last_seen_at = iso;
    }

    request.user = { id: row.id, row };
  };

  app.decorate('authenticate', authenticate);
}
