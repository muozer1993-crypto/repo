/**
 * Staying signed in and changing the password.
 *
 * Tokens used to die exactly 90 days after login with nothing to renew them, and
 * there was no way to replace a throwaway "123456". `/auth/refresh` extends a
 * token that still works; `/me/password` swaps the password without ever
 * answering 401 (the app logs out on any 401), and signs out every other phone:
 * a session left on a friend's phone used to outlive any new password.
 */
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { proveMessage, type AuthResponse } from '@koydum/shared';
import { authed, DEFAULT_PASSWORD, makeApp, registerUser, type TestApp } from './helpers.js';

const DAY_MS = 24 * 60 * 60 * 1000;

let h: TestApp;

beforeEach(async () => {
  h = await makeApp();
});

afterEach(async () => {
  await h.close();
});

/** `exp` claim of one of our own tokens, in seconds. */
function expOf(token: string): number {
  const claims = token.split('.')[1]!;
  return (JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as { exp: number }).exp;
}

function errorCode(response: { json: () => unknown }): string {
  return (response.json() as { error: { code: string } }).error.code;
}

function login(username: string, password: string) {
  return h.app.inject({ method: 'POST', url: '/auth/login', payload: { username, password } });
}

function changePassword(
  token: string,
  currentPassword: string,
  newPassword: string,
  extra: { pushToken?: string | null } = {},
) {
  return authed(h.app, token)({ method: 'POST', url: '/me/password', payload: { currentPassword, newPassword, ...extra } });
}

/** `ver` claim of one of our own tokens. */
function verOf(token: string): unknown {
  const claims = token.split('.')[1]!;
  return (JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as { ver?: unknown }).ver;
}

/** A token the way every one was signed before token versions: `{ sub, iat, exp }`, no `ver`. */
function legacyToken(userId: string): string {
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const iat = Math.floor(h.app.now().getTime() / 1000);
  const claims = Buffer.from(JSON.stringify({ sub: userId, iat, exp: iat + 90 * 24 * 60 * 60 })).toString('base64url');
  const signature = createHmac('sha256', h.app.config.jwtSecret).update(`${head}.${claims}`).digest('base64url');
  return `${head}.${claims}.${signature}`;
}

describe('POST /auth/refresh', () => {
  it('hands out a later expiry that authenticates after the old token has died', async () => {
    const ali = await registerUser(h.app, 'ali');
    h.advance(30 * DAY_MS);

    const response = await authed(h.app, ali.token)({ method: 'POST', url: '/auth/refresh' });
    expect(response.statusCode).toBe(200);
    const { token } = response.json<{ token: string }>();
    expect(expOf(token)).toBe(expOf(ali.token) + 30 * 24 * 60 * 60);

    // day 91: the login token is gone, the renewed one carries on
    h.advance(61 * DAY_MS);
    expect((await authed(h.app, ali.token)({ method: 'GET', url: '/me' })).statusCode).toBe(401);
    const me = await authed(h.app, token)({ method: 'GET', url: '/me' });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ username: string }>().username).toBe('ali');
  });

  it('does not bring an expired token back', async () => {
    const ali = await registerUser(h.app, 'ali');
    h.advance(91 * DAY_MS);

    const response = await authed(h.app, ali.token)({ method: 'POST', url: '/auth/refresh' });
    expect(response.statusCode).toBe(401);
    expect(errorCode(response)).toBe('unauthorized');
  });
});

describe('POST /me/password', () => {
  it('swaps the password: the old one stops working, the new one and the returned session work', async () => {
    const ali = await registerUser(h.app, 'ali');

    const response = await changePassword(ali.token, DEFAULT_PASSWORD, 'yepyeni42');
    expect(response.statusCode).toBe(200);
    const body = response.json<AuthResponse>();
    expect(body.me.username).toBe('ali');
    expect((await authed(h.app, body.token)({ method: 'GET', url: '/me' })).statusCode).toBe(200);

    expect((await login('ali', DEFAULT_PASSWORD)).statusCode).toBe(401);
    expect((await login('ali', 'yepyeni42')).statusCode).toBe(200);
  });

  it('signs out every other session, and the returned one renews at its new version', async () => {
    const ali = await registerUser(h.app, 'ali');
    // the account opened once on a friend's phone, which kept the session
    const onFriendsPhone = (await login('ali', DEFAULT_PASSWORD)).json<AuthResponse>().token;
    await authed(h.app, onFriendsPhone)({ method: 'POST', url: '/me/push-token', payload: { token: 'ExponentPushToken[kanka]', platform: 'android' } });

    // changed on Ali's own phone, which has no push token of its own
    const body = (await changePassword(ali.token, DEFAULT_PASSWORD, 'yepyeni42', { pushToken: null })).json<AuthResponse>();

    for (const old of [ali.token, onFriendsPhone]) {
      const response = await authed(h.app, old)({ method: 'GET', url: '/me' });
      expect(response.statusCode).toBe(401);
      // the one code SPEC 2.2 knows; the message is what the phone shows
      expect(errorCode(response)).toBe('unauthorized');
      expect(response.json<{ error: { message: string } }>().error.message).toContain('Şifren değişti');
      // nor can a stray session renew its way past the change
      expect((await authed(h.app, old)({ method: 'POST', url: '/auth/refresh' })).statusCode).toBe(401);
    }

    // the friend's phone can no longer clear its push token, so the change did
    expect(body.me.hasPushToken).toBe(false);
    const me = await authed(h.app, body.token)({ method: 'GET', url: '/me' });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ hasPushToken: boolean }>().hasPushToken).toBe(false);

    const renewed = await authed(h.app, body.token)({ method: 'POST', url: '/auth/refresh' });
    expect(renewed.statusCode).toBe(200);
    const { token } = renewed.json<{ token: string }>();
    expect(verOf(token)).toBe(verOf(body.token));
    expect(verOf(token)).toBe(1);
    expect((await authed(h.app, token)({ method: 'GET', url: '/me' })).statusCode).toBe(200);

    // and a login with the new password works on every phone
    const back = (await login('ali', 'yepyeni42')).json<AuthResponse>().token;
    expect((await authed(h.app, back)({ method: 'GET', url: '/me' })).statusCode).toBe(200);
  });

  it('drops a push token the changing phone says is not its own, and keeps the one it says is', async () => {
    const ali = await registerUser(h.app, 'ali');
    const onFriendsPhone = (await login('ali', DEFAULT_PASSWORD)).json<AuthResponse>().token;
    await authed(h.app, onFriendsPhone)({ method: 'POST', url: '/me/push-token', payload: { token: 'ExponentPushToken[kanka]', platform: 'android' } });

    // Ali's phone registered another token: the friend's phone's goes with its session
    const first = (
      await changePassword(ali.token, DEFAULT_PASSWORD, 'yepyeni42', { pushToken: 'ExponentPushToken[ali]' })
    ).json<AuthResponse>();
    expect(first.me.hasPushToken).toBe(false);

    // his own token, registered again and named at the next change, stays put
    await authed(h.app, first.token)({ method: 'POST', url: '/me/push-token', payload: { token: 'ExponentPushToken[ali]', platform: 'android' } });
    const second = (
      await changePassword(first.token, 'yepyeni42', 'dahayeni42', { pushToken: 'ExponentPushToken[ali]' })
    ).json<AuthResponse>();
    expect(second.me.hasPushToken).toBe(true);
    const stored = h.db.prepare('SELECT push_token FROM users WHERE id = ?').get(ali.me.id) as { push_token: string };
    expect(stored.push_token).toBe('ExponentPushToken[ali]');
  });

  it('leaves the push token alone for an app that does not say whose it is', async () => {
    // The 1.1.0 app sends its device token once per run: cleared here, its phone
    // went without push or a notification of its own until it was restarted.
    const ali = await registerUser(h.app, 'ali');
    await authed(h.app, ali.token)({ method: 'POST', url: '/me/push-token', payload: { token: 'ExponentPushToken[ali]', platform: 'android' } });

    const body = (await changePassword(ali.token, DEFAULT_PASSWORD, 'yepyeni42')).json<AuthResponse>();
    expect(body.me.hasPushToken).toBe(true);
    // the other sessions are still signed out
    expect((await authed(h.app, ali.token)({ method: 'GET', url: '/me' })).statusCode).toBe(401);
    // and what is written next is pushed as before, not written off as "before the token"
    const stored = h.db.prepare('SELECT push_token FROM users WHERE id = ?').get(ali.me.id) as { push_token: string };
    expect(stored.push_token).toBe('ExponentPushToken[ali]');
  });

  it('keeps a token signed before token versions working, until the password changes', async () => {
    const ali = await registerUser(h.app, 'ali');
    const old = legacyToken(ali.me.id);
    expect(verOf(old)).toBeUndefined();

    // nobody is signed out by the upgrade itself
    const me = await authed(h.app, old)({ method: 'GET', url: '/me' });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ username: string }>().username).toBe('ali');
    const renewed = await authed(h.app, old)({ method: 'POST', url: '/auth/refresh' });
    expect(renewed.statusCode).toBe(200);
    expect(verOf(renewed.json<{ token: string }>().token)).toBe(0);

    expect((await changePassword(ali.token, DEFAULT_PASSWORD, 'yepyeni42')).statusCode).toBe(200);
    expect((await authed(h.app, old)({ method: 'GET', url: '/me' })).statusCode).toBe(401);
  });

  it('answers a wrong current password with a 400, and the session survives it', async () => {
    const ali = await registerUser(h.app, 'ali');

    const response = await changePassword(ali.token, 'yanlis', 'yepyeni42');
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('wrong_password');
    expect((await authed(h.app, ali.token)({ method: 'GET', url: '/me' })).statusCode).toBe(200);
    expect((await login('ali', DEFAULT_PASSWORD)).statusCode).toBe(200);
  });

  it('refuses the same password again', async () => {
    const ali = await registerUser(h.app, 'ali');

    const response = await changePassword(ali.token, DEFAULT_PASSWORD, DEFAULT_PASSWORD);
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('same_password');
  });

  it('holds the new password to the sign-up rule', async () => {
    const ali = await registerUser(h.app, 'ali');

    const response = await changePassword(ali.token, DEFAULT_PASSWORD, '12345');
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('validation');
    expect((await login('ali', DEFAULT_PASSWORD)).statusCode).toBe(200);
  });

  it('locks guessing after eight misses in fifteen minutes, for that account only', async () => {
    const ali = await registerUser(h.app, 'ali');
    const veli = await registerUser(h.app, 'veli');

    for (let i = 0; i < 8; i++) {
      expect((await changePassword(ali.token, `yanlis${i}`, 'yepyeni42')).statusCode).toBe(400);
    }
    const blocked = await changePassword(ali.token, 'yanlis8', 'yepyeni42');
    expect(blocked.statusCode).toBe(429);
    expect(errorCode(blocked)).toBe('too_many_attempts');
    // even the right one waits, and the lockout is still not a logout
    expect((await changePassword(ali.token, DEFAULT_PASSWORD, 'yepyeni42')).statusCode).toBe(429);
    expect((await authed(h.app, ali.token)({ method: 'GET', url: '/me' })).statusCode).toBe(200);

    expect((await changePassword(veli.token, DEFAULT_PASSWORD, 'yepyeni42')).statusCode).toBe(200);

    h.advance(15 * 60 * 1000);
    expect((await changePassword(ali.token, DEFAULT_PASSWORD, 'yepyeni42')).statusCode).toBe(200);
  });

  it('counts a burst of guesses sent at once, so it cannot outrun the limit', async () => {
    const ali = await registerUser(h.app, 'ali');

    // a hijacked token firing 40 guesses in parallel, the right one among them
    const guesses = Array.from({ length: 40 }, (_, i) => (i === 30 ? DEFAULT_PASSWORD : `yanlis${i}`));
    const answers = await Promise.all(guesses.map((guess) => changePassword(ali.token, guess, 'ele-gecirdim1')));
    const codes = answers.map((response) => response.statusCode);

    expect(codes.filter((code) => code === 429).length).toBeGreaterThanOrEqual(32);
    expect(codes[30]).toBe(429);
    expect(codes).not.toContain(200);
    expect((await login('ali', DEFAULT_PASSWORD)).statusCode).toBe(200);
  });
});

describe('POST /auth/login', () => {
  it('counts a burst of guesses sent at once, so it cannot outrun the limit', async () => {
    await registerUser(h.app, 'ali');

    const guesses = Array.from({ length: 40 }, (_, i) => (i === 30 ? DEFAULT_PASSWORD : `yanlis${i}`));
    const codes = (await Promise.all(guesses.map((guess) => login('ali', guess)))).map((r) => r.statusCode);

    expect(codes.filter((code) => code === 429).length).toBeGreaterThanOrEqual(32);
    expect(codes[30]).toBe(429);
    expect(codes).not.toContain(200);
  });
});

describe('POST /auth/prove', () => {
  /** What the phone checks: HMAC(the token's own signature, nonce + origin). */
  function expectedProof(token: string, nonce: string, origin: string): string {
    const signature = Buffer.from(token.split('.')[2]!, 'base64url');
    return createHmac('sha256', signature).update(proveMessage(nonce, origin)).digest('base64url');
  }

  it('answers for its own address with a MAC keyed by the token signature, which it never sends', async () => {
    const ali = await registerUser(h.app, 'ali');
    const [head, claims, signature] = ali.token.split('.') as [string, string, string];
    const nonce = 'a'.repeat(32);

    // no Authorization header: the token itself does not travel
    const response = await h.app.inject({ method: 'POST', url: '/auth/prove', payload: { claims: `${head}.${claims}`, nonce } });
    expect(response.statusCode).toBe(200);
    const answer = response.json<{ origin: string; proof: string }>();
    expect(answer.origin).toBe('http://test.local');
    expect(answer.proof).toBe(expectedProof(ali.token, nonce, answer.origin));
    expect(response.body).not.toContain(signature);

    // another nonce, another answer: an old one cannot be replayed
    const again = await h.app.inject({ method: 'POST', url: '/auth/prove', payload: { claims: `${head}.${claims}`, nonce: 'b'.repeat(32) } });
    expect(again.json<{ proof: string }>().proof).not.toBe(answer.proof);
  });

  it('cannot be answered by a server with another secret', async () => {
    const ali = await registerUser(h.app, 'ali');
    const other = await makeApp({ config: { jwtSecret: 'baska-bir-sunucu' } });
    try {
      const [head, claims] = ali.token.split('.') as [string, string];
      const nonce = 'c'.repeat(32);
      const response = await other.app.inject({ method: 'POST', url: '/auth/prove', payload: { claims: `${head}.${claims}`, nonce } });
      const answer = response.json<{ origin: string; proof: string }>();
      expect(answer.proof).not.toBe(expectedProof(ali.token, nonce, answer.origin));
    } finally {
      await other.close();
    }
  });

  it('refuses anything that is not a token prefix and a nonce', async () => {
    const response = await h.app.inject({ method: 'POST', url: '/auth/prove', payload: { claims: 'x', nonce: 'kisa' } });
    expect(response.statusCode).toBe(400);
  });
});
