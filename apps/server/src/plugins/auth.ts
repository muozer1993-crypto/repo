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
import { isDiskFull, warnDiskFull } from '../services/disk.js';

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
    // SPEC 2.2 documents ONE auth failure code (`unauthorized`), so an expired or
    // invalid session must not answer with a code the client has never heard of —
    // that is exactly the case that needs a re-login. The Turkish message is what
    // tells the two apart for a human.
    const claims = verifyToken(token, config.jwtSecret, now);
    if (!claims) throw unauthorized('unauthorized', 'Oturumun geçersiz ya da süresi dolmuş. Tekrar giriş yap.');

    const row = selectUser.get(claims.sub) as UserRow | undefined;
    if (!row) throw unauthorized('unauthorized', 'Oturumun geçersiz ya da süresi dolmuş. Tekrar giriş yap.');
    // Closed with "Hesabı sil" or the owner's `yonet sil`: there is no signing
    // back in (the name is anonymised, the password gone), so the phone must
    // not be told to try.
    if (row.deleted_at !== null) {
      throw unauthorized('unauthorized', 'Bu hesap kapatıldı, bununla bir daha giriş yapılamaz. Bir yanlışlık varsa sunucuyu kuran kişiye sor.');
    }
    // Signed before the last password change or owner reset: whoever still holds
    // it (a friend's phone the account was once opened on) is out. Same single
    // code; the message is what the signed-out phone shows on its login screen.
    if (claims.ver !== row.token_version) {
      throw unauthorized('unauthorized', 'Şifren değişti, bu telefondaki oturum kapandı. Yeni şifreyle gir.');
    }

    const last = row.last_seen_at ? Date.parse(row.last_seen_at) : 0;
    if (!Number.isFinite(last) || now.getTime() - last > LAST_SEEN_THROTTLE_MS) {
      const iso = now.toISOString();
      // Only the last visit `yonet kullanicilar` shows. On a full disk this write
      // failed every request a minute after the one before, reads included: the
      // whole group locked out of screens that save nothing. A real write still
      // gets the 507 that says why.
      try {
        touchUser.run(iso, row.id);
        row.last_seen_at = iso;
      } catch (err) {
        if (!isDiskFull(err)) throw err;
        warnDiskFull(app, now.getTime());
      }
    }

    request.user = { id: row.id, row };
  };

  app.decorate('authenticate', authenticate);
}
