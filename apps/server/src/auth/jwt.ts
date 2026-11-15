/**
 * Minimal HS256 JWT over node:crypto — no jsonwebtoken dependency.
 *
 * `header.payload.signature`, all three base64url encoded. We only ever issue and
 * accept our own tokens, so the payload is `{ sub, ver, iat, exp }` and nothing
 * else. `ver` is the user's `token_version` at signing time (plugins/auth.ts).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** 90 days (SPEC 2: `exp 90d`). */
export const DEFAULT_TTL_SECONDS = 90 * 24 * 60 * 60;

const HEADER = { alg: 'HS256', typ: 'JWT' } as const;

export interface TokenPayload {
  sub: string;
  /** Absent on tokens signed before token versions existed; those read as 0. */
  ver?: number;
  iat: number;
  exp: number;
}

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

/**
 * The raw signature a token with this `header.payload` carries. Only for
 * `POST /auth/prove`, which keys a MAC with it and never hands it out.
 */
export function signatureBytes(claims: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(claims).digest();
}

/**
 * Issues a token for `payload.sub` at token version `payload.ver` (default 0),
 * valid for `ttlSeconds` (default 90 days).
 */
export function signToken(
  payload: { sub: string; ver?: number },
  secret: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
  now: Date = new Date(),
): string {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const body: TokenPayload = {
    sub: payload.sub,
    ver: payload.ver ?? 0,
    iat: issuedAt,
    exp: issuedAt + Math.max(1, Math.floor(ttlSeconds)),
  };
  const head = base64UrlEncode(JSON.stringify(HEADER));
  const claims = base64UrlEncode(JSON.stringify(body));
  const signature = sign(`${head}.${claims}`, secret);
  return `${head}.${claims}.${signature}`;
}

/**
 * Verifies signature, algorithm and expiry. Returns the subject and the token
 * version, or `null` for any problem at all (tampered, expired, malformed, wrong
 * secret) — callers turn that into a 401 with a Turkish message. Whether the
 * version is still the user's is the caller's check: it needs the database.
 */
export function verifyToken(token: string, secret: string, now: Date = new Date()): { sub: string; ver: number } | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, claims, signature] = parts as [string, string, string];
  if (!head || !claims || !signature) return null;

  let header: { alg?: unknown; typ?: unknown };
  try {
    header = JSON.parse(base64UrlDecode(head)) as { alg?: unknown; typ?: unknown };
  } catch {
    return null;
  }
  if (header.alg !== 'HS256') return null;

  const expected = sign(`${head}.${claims}`, secret);
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) return null;

  let payload: Partial<TokenPayload>;
  try {
    payload = JSON.parse(base64UrlDecode(claims)) as Partial<TokenPayload>;
  } catch {
    return null;
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null;
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null;
  if (payload.exp * 1000 <= now.getTime()) return null;

  // A token from before versions has no `ver`: it is a version-0 token, which is
  // what every account starts at, so nobody is signed out by the upgrade.
  const ver = Number.isSafeInteger(payload.ver) ? (payload.ver as number) : 0;
  return { sub: payload.sub, ver };
}

/** `Authorization: Bearer <token>` → token, or null. */
export function bearerToken(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}
