/**
 * POST /auth/register, POST /auth/login (SPEC 2.2).
 *
 * Both return the same `{ token, me }` envelope so the app has everything it needs
 * after a single call. Usernames are stored lowercase (the zod schema lowercases
 * them), passwords go through scrypt, and the token is our own HS256 JWT.
 */
import type { FastifyInstance } from 'fastify';
import { LoginBodySchema, RegisterBodySchema, type AuthResponse } from '@koydum/shared';
import { signToken } from '../auth/jwt.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { getUserByUsername } from '../db/index.js';
import { conflict, parseBody, unauthorized } from '../errors.js';
import { toMe } from '../serialize.js';
import { createUser, usernameTaken } from '../services/accounts.js';

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app;

  app.post('/auth/register', async (request, reply) => {
    const body = parseBody(RegisterBodySchema, request.body);

    if (usernameTaken(db, body.username)) {
      throw conflict('username_taken', 'Bu kullanıcı adı kapılmış. Başka bir tane dene.');
    }

    const now = app.now();
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
    const body = parseBody(LoginBodySchema, request.body);
    const badCredentials = unauthorized('bad_credentials', 'Kullanıcı adı ya da şifre yanlış.');

    const row = getUserByUsername(db, body.username);
    // Hash a dummy password for unknown users so timing does not leak who exists.
    if (!row) {
      await verifyPassword(body.password, 'scrypt$00$00');
      throw badCredentials;
    }
    if (!(await verifyPassword(body.password, row.password_hash))) throw badCredentials;

    const now = app.now();
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now.toISOString(), row.id);
    row.last_seen_at = now.toISOString();

    const payload: AuthResponse = {
      token: signToken({ sub: row.id }, config.jwtSecret, undefined, now),
      me: toMe(db, row, now),
    };
    return payload;
  });
}
