import { proveMessage, type Me, type ProveResponse } from '@koydum/shared';

import { ApiClient, ApiError, type HealthResponse } from '@/lib/api';
import { normalizeServerUrl } from '@/lib/config';
import { queryClient } from '@/lib/query';
import { flushQueue } from '@/services/offlineQueue';
import { useAuth } from '@/store/auth';
import { fromBase64Url, hmacSha256, toBase64Url, utf8 } from '@/utils/hmac';
import { uuidV4 } from '@/utils/ids';

/**
 * The same server at a new address.
 *
 * `npm run internet` puts the server behind a Cloudflare quick tunnel, and
 * every restart of that window hands out a new https://….trycloudflare.com
 * address. The database and the JWT secret stay where they were, so the tokens
 * everybody holds still work; only the address moved. Treating that as
 * "another server" logged every friend out and took the cache and the inbox
 * cursor with it, and background sync and notifications stayed dead until each
 * of them typed the password back in.
 *
 * moveSession carries the session over instead, once the new address has
 * shown it is the same server:
 *   1. /health answers. A `serverId` other than the one this session learned
 *      (store/auth) is another server, and nothing more is sent. The id is
 *      public (anybody who read /health or an invite link has it), so a match
 *      proves nothing; it is only a quick way to say no.
 *   2. /auth/prove: the address shows it holds the secret that signed our
 *      token, for this very address. The phone sends only the token's
 *      `header.payload` (not secret) and a fresh nonce; the answer has to be
 *      HMAC(the token's signature, nonce + the address it vouches for), and
 *      that address has to be the one we are moving to. A copycat without the
 *      secret cannot compute it, and one that relays the question to the real
 *      server gets an answer for the real server's address. Until this passes
 *      the token never leaves the phone.
 *   3. /me with the token answers as this very account.
 * It only ever runs on a tap: a link can come from anyone.
 */

export type MoveOutcome = 'moved' | 'different' | 'unreachable';

const TIMEOUT_MS = 8000;

/**
 * Whether /health's id proves a server is not the one this session belongs
 * to. With nothing stored nothing is proven. With an id stored, a server that
 * names none is not ours either: ours does name itself.
 */
export function isOtherServer(storedId: string | null, reportedId: string | null | undefined): boolean {
  return !!storedId && reportedId !== storedId;
}

/**
 * Step 2 of `moveSession`: does `url` hold the secret behind `token`, and say
 * so for `url` itself? Only the token's first two parts are sent.
 */
export async function provesSecret(url: string, token: string): Promise<'yes' | 'no' | 'unreachable'> {
  const [head, payload, signature] = token.split('.');
  const key = signature ? fromBase64Url(signature) : null;
  if (!head || !payload || !key || key.length === 0) return 'no';

  const nonce = uuidV4().replace(/-/g, '');
  let answer: ProveResponse;
  try {
    answer = await new ApiClient({ baseUrl: url, timeoutMs: TIMEOUT_MS }).prove({ claims: `${head}.${payload}`, nonce });
  } catch (error) {
    if (error instanceof ApiError && (error.isNetwork || error.status >= 500)) return 'unreachable';
    // an older server without /auth/prove, or one that cannot answer it
    return 'no';
  }
  if (!answer || typeof answer.origin !== 'string' || typeof answer.proof !== 'string') return 'no';
  // vouching for another address is somebody relaying the question
  if (normalizeServerUrl(answer.origin)?.toLowerCase() !== url.toLowerCase()) return 'no';
  const expected = toBase64Url(hmacSha256(key, utf8(proveMessage(nonce, answer.origin))));
  return expected === answer.proof ? 'yes' : 'no';
}

export async function moveSession(rawUrl: string): Promise<MoveOutcome> {
  const url = normalizeServerUrl(rawUrl);
  if (!url) return 'unreachable';
  const { token, me, serverId } = useAuth.getState();
  // nothing to carry over; the screens only offer this while signed in
  if (!token || !me) return 'different';

  let health: HealthResponse;
  try {
    health = await new ApiClient({ baseUrl: url, timeoutMs: TIMEOUT_MS }).health();
  } catch {
    return 'unreachable';
  }
  // A hotel Wi-Fi login page (or any site) answers 200 with HTML, which the
  // client hands back as null: that is not a KOYDUM server answering.
  if (!health || typeof health !== 'object') return 'unreachable';
  if (isOtherServer(serverId, health.serverId)) return 'different';

  const proven = await provesSecret(url, token);
  if (proven !== 'yes') return proven === 'unreachable' ? 'unreachable' : 'different';

  let who: Me;
  try {
    // A bare client on purpose: a 401 here means "this server did not issue
    // the token", and must not log anybody out through onUnauthorized.
    who = await new ApiClient({ baseUrl: url, token, timeoutMs: TIMEOUT_MS }).me();
  } catch (error) {
    if (error instanceof ApiError && (error.isNetwork || error.status >= 500)) return 'unreachable';
    return 'different';
  }
  if (!who || typeof who !== 'object') return 'unreachable';
  if (who.id !== me.id) return 'different';

  const auth = useAuth.getState();
  await auth.setServerUrl(url);
  await auth.rememberServerId(health.serverId, url);
  await auth.setMe(who);
  // everything on screen was fetched from the dead address, and entries
  // written while it was unreachable can finally go out
  void queryClient.invalidateQueries();
  void flushQueue(auth.client()).catch(() => {});
  return 'moved';
}
