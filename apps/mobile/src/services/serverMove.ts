import type { Me } from '@koydum/shared';

import { ApiClient, ApiError, type HealthResponse } from '@/lib/api';
import { normalizeServerUrl } from '@/lib/config';
import { queryClient } from '@/lib/query';
import { flushQueue } from '@/services/offlineQueue';
import { useAuth } from '@/store/auth';

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
 *   1. /health answers and names itself with the `serverId` this session
 *      learned (store/auth). Any other answer, and the token is never sent.
 *   2. With no id to compare (a phone that never heard one), /me with the
 *      token has to answer as this very account. A server that did not issue
 *      the token answers 401.
 * It only ever runs on a tap: a link can come from anyone, and step 2 hands
 * the token to the address in it. Fine among friends, never behind their back.
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
